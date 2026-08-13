import { D1Dialect } from 'kysely-d1'
import { Kysely } from 'kysely'
import { env } from 'cloudflare:workers'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'

export type CliAuthority =
  | { kind: 'unrestricted' }
  | {
      kind: 'bootstrap'
      preset: 'unrestricted' | 'agent'
      workspaceId: string | null
      projectId: string | null
      expiresAt: string
    }
  | {
      kind: 'agent'
      familyId: string
      workspaceId: string
      projectId: string
      projectNameSnapshot: string
      agentProfileId: string
    }

/**
 * Resolution result. `denied` is distinct from `null` ("no session"): bot
 * users may only authenticate through an active agent-preset family authority
 * whose family still holds a live (unrevoked, unexpired) refresh credential.
 * Anything else — a missing authority row, a bootstrap, an unrestricted
 * family, a revoked/superseded family, or a dead credential — is an explicit
 * denial. The human unrestricted fallback (no authority row → unrestricted)
 * is intentional legacy-CLI compatibility and stays.
 */
export type CliAuthorityResolution = CliAuthority | 'denied' | null

export async function resolveCliAuthorityBySessionToken(
  token: string,
): Promise<CliAuthorityResolution> {
  const db = new Kysely<DB>({ dialect: new D1Dialect({ database: env.DB }) })
  const now = nowIso()
  try {
    const row = await db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .leftJoin(
        'cli_session_authorities',
        'cli_session_authorities.session_id',
        'sessions.id',
      )
      .leftJoin(
        'cli_family_authorities',
        'cli_family_authorities.family_id',
        'cli_session_authorities.family_id',
      )
      .select(({ exists, selectFrom }) => [
        'sessions.user_agent',
        'users.kind as user_kind',
        'users.bot_stopped_at',
        'cli_session_authorities.kind',
        'cli_session_authorities.preset as session_preset',
        'cli_session_authorities.workspace_id as bootstrap_workspace_id',
        'cli_session_authorities.project_id as bootstrap_project_id',
        'cli_session_authorities.expires_at as bootstrap_expires_at',
        'cli_session_authorities.family_id',
        'cli_session_authorities.bearer_only',
        'cli_family_authorities.preset as family_preset',
        'cli_family_authorities.workspace_id',
        'cli_family_authorities.project_id',
        'cli_family_authorities.project_name_snapshot',
        'cli_family_authorities.agent_profile_id',
        'cli_family_authorities.status',
        // Bot sessions are re-validated on every request against the family's
        // credential liveness so a stopped or expired bot cannot keep using a
        // previously issued session.
        exists(
          selectFrom('cli_refresh_credentials')
            .select('cli_refresh_credentials.id')
            .whereRef(
              'cli_refresh_credentials.family_id',
              '=',
              'cli_session_authorities.family_id',
            )
            .where('cli_refresh_credentials.revoked_at', 'is', null)
            .where('cli_refresh_credentials.expires_at', '>', now),
        ).as('family_credential_live'),
      ])
      .where('sessions.token', '=', token)
      .where('sessions.expires_at', '>', now)
      .executeTakeFirst()
    if (!row) return null
    if (row.user_kind === 'bot') {
      // Positive conditions only: active agent family authority with a live
      // credential, on an active (non-stopped) bot. Never fall back to
      // unrestricted for bots — that fallback also fires for cookie sessions.
      if (
        row.bot_stopped_at !== null ||
        row.kind !== 'family' ||
        row.bearer_only !== 1 ||
        row.status !== 'active' ||
        row.family_preset !== 'agent' ||
        !row.family_id ||
        !row.workspace_id ||
        !row.project_id ||
        !row.project_name_snapshot ||
        !row.agent_profile_id ||
        !row.family_credential_live
      ) {
        return 'denied'
      }
      return {
        kind: 'agent',
        familyId: row.family_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        projectNameSnapshot: row.project_name_snapshot,
        agentProfileId: row.agent_profile_id,
      }
    }
    if (!row.kind) return { kind: 'unrestricted' }
    if (row.bearer_only !== 1) return null
    if (row.kind === 'bootstrap') {
      if (
        !row.bootstrap_expires_at ||
        row.bootstrap_expires_at <= nowIso() ||
        !row.session_preset
      ) {
        return null
      }
      return {
        kind: 'bootstrap',
        preset: row.session_preset,
        workspaceId: row.bootstrap_workspace_id,
        projectId: row.bootstrap_project_id,
        expiresAt: row.bootstrap_expires_at,
      }
    }
    if (row.status !== 'active') return null
    if (row.family_preset === 'unrestricted') return { kind: 'unrestricted' }
    if (
      !row.family_id ||
      !row.workspace_id ||
      !row.project_id ||
      !row.project_name_snapshot ||
      !row.agent_profile_id
    ) {
      return null
    }
    return {
      kind: 'agent',
      familyId: row.family_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      projectNameSnapshot: row.project_name_snapshot,
      agentProfileId: row.agent_profile_id,
    }
  } finally {
    await db.destroy()
  }
}

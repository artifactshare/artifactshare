import {
  isRecognizedCliPreset,
  isRecognizedCliSessionKind,
} from '~/lib/cli-authority-policy'
import { D1Dialect } from 'kysely-d1'
import { Kysely } from 'kysely'
import { env } from 'cloudflare:workers'
import { nowIso } from '~/lib/datetime'
import { d1CompatibilityPlugin } from '~/lib/d1-compatibility.server'
import type { DB } from '~/types/db'

export type CliAuthority =
  | { kind: 'unrestricted' }
  | {
      kind: 'bootstrap'
      preset: 'unrestricted' | 'agent' | 'publisher'
      publisherClientId?: string
      publisherClientName?: string
      workspaceId: string | null
      projectId: string | null
      expiresAt: string
    }
  | {
      kind: 'publisher'
      familyId: string
      workspaceId: string
      publisherClientId: string
      publisherClientName: string
    }
  | {
      kind: 'agent'
      familyId: string
      workspaceId: string
      projectId: string
      projectNameSnapshot: string
      agentProfileId: string
    }
  | {
      kind: 'bridge'
      familyId: string
      bridgeAuthorityId: string
      workspaceId: string
      fallbackProjectId: string
      agentProfileId: string
      sourceKind: string
      sourceInstallationId: string
      externalWorkspaceId: string
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
  const db = new Kysely<DB>({
    dialect: new D1Dialect({ database: env.DB }),
    plugins: [d1CompatibilityPlugin],
  })
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
      .leftJoin(
        'bridge_authorities',
        'bridge_authorities.id',
        'cli_family_authorities.bridge_authority_id',
      )
      .select(({ exists, selectFrom }) => [
        'sessions.user_agent',
        'users.id as user_id',
        'users.kind as user_kind',
        'users.bot_stopped_at',
        'cli_session_authorities.kind',
        'cli_session_authorities.session_id as authority_session_id',
        'cli_session_authorities.preset as session_preset',
        'cli_session_authorities.publisher_client_id as session_publisher_client_id',
        'cli_family_authorities.publisher_client_id',
        'cli_family_authorities.user_id as family_user_id',
        'cli_session_authorities.workspace_id as bootstrap_workspace_id',
        'cli_session_authorities.project_id as bootstrap_project_id',
        'cli_session_authorities.agent_profile_id as bootstrap_agent_profile_id',
        'cli_session_authorities.expires_at as bootstrap_expires_at',
        'cli_session_authorities.family_id',
        'cli_session_authorities.bearer_only',
        'cli_family_authorities.preset as family_preset',
        'cli_family_authorities.workspace_id',
        'cli_family_authorities.project_id',
        'cli_family_authorities.project_name_snapshot',
        'cli_family_authorities.agent_profile_id',
        'cli_family_authorities.bridge_authority_id',
        'cli_family_authorities.status',
        'bridge_authorities.workspace_id as bridge_workspace_id',
        'bridge_authorities.id as bridge_row_id',
        'bridge_authorities.bot_user_id as bridge_bot_user_id',
        'bridge_authorities.agent_profile_id as bridge_agent_profile_id',
        'bridge_authorities.source_kind as bridge_source_kind',
        'bridge_authorities.source_installation_id as bridge_source_installation_id',
        'bridge_authorities.external_workspace_id as bridge_external_workspace_id',
        'bridge_authorities.fallback_project_id as bridge_fallback_project_id',
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
        row.session_preset !== 'agent' ||
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
      if (row.bridge_authority_id !== null) {
        if (
          row.bridge_row_id !== row.bridge_authority_id ||
          row.bridge_workspace_id !== row.workspace_id ||
          row.bridge_bot_user_id !== row.user_id ||
          row.bridge_agent_profile_id !== row.agent_profile_id ||
          row.bridge_fallback_project_id !== row.project_id ||
          !row.bridge_source_kind ||
          !row.bridge_source_installation_id ||
          !row.bridge_external_workspace_id
        ) {
          return 'denied'
        }
        return {
          kind: 'bridge',
          familyId: row.family_id,
          bridgeAuthorityId: row.bridge_authority_id,
          workspaceId: row.workspace_id,
          fallbackProjectId: row.project_id,
          agentProfileId: row.agent_profile_id,
          sourceKind: row.bridge_source_kind,
          sourceInstallationId: row.bridge_source_installation_id,
          externalWorkspaceId: row.bridge_external_workspace_id,
        }
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
    if (row.authority_session_id === null) return { kind: 'unrestricted' }
    if (!isRecognizedCliSessionKind(row.kind)) return null
    if (!isRecognizedCliPreset(row.session_preset)) return null
    if (row.bearer_only !== 1) return null
    if (
      row.session_preset === 'publisher' ||
      row.family_preset === 'publisher'
    ) {
      const clientId = row.session_publisher_client_id
      const client = clientId
        ? await db
            .selectFrom('publisher_clients')
            .innerJoin('users', 'users.id', 'publisher_clients.user_id')
            .select([
              'publisher_clients.id',
              'publisher_clients.name',
              'publisher_clients.workspace_id',
            ])
            .where('publisher_clients.id', '=', clientId)
            .where('users.id', '=', row.user_id)
            .whereRef(
              'users.workspace_id',
              '=',
              'publisher_clients.workspace_id',
            )
            .where('users.kind', '=', 'human')
            .executeTakeFirst()
        : null
      if (
        !client ||
        row.session_preset !== 'publisher' ||
        row.bootstrap_workspace_id !== client.workspace_id ||
        row.bootstrap_project_id !== null ||
        row.bootstrap_agent_profile_id !== null
      )
        return 'denied'
      if (row.kind === 'bootstrap') {
        if (row.family_id !== null) return 'denied'
        if (!row.bootstrap_expires_at || row.bootstrap_expires_at <= now)
          return 'denied'
        return {
          kind: 'bootstrap',
          preset: 'publisher',
          workspaceId: client.workspace_id,
          projectId: null,
          publisherClientId: client.id,
          publisherClientName: client.name,
          expiresAt: row.bootstrap_expires_at,
        }
      }
      if (
        row.family_preset !== 'publisher' ||
        row.status !== 'active' ||
        !row.family_id ||
        !row.family_credential_live ||
        row.family_user_id !== row.user_id ||
        row.workspace_id !== client.workspace_id ||
        row.publisher_client_id !== client.id ||
        row.project_id !== null ||
        row.agent_profile_id !== null ||
        row.bridge_authority_id !== null ||
        row.project_name_snapshot !== null
      )
        return 'denied'
      const authority = {
        kind: 'publisher' as const,
        familyId: row.family_id,
        workspaceId: client.workspace_id,
        publisherClientId: client.id,
        publisherClientName: client.name,
      }
      const { publisherAuthoritySql } = await import('./publisher-scope.server')
      if (
        !(await db
          .selectFrom('users')
          .select('id')
          .where('id', '=', row.user_id)
          .where(publisherAuthoritySql(row.user_id, authority))
          .executeTakeFirst())
      )
        return 'denied'
      return authority
    }
    if (
      row.session_publisher_client_id !== null ||
      row.publisher_client_id != null
    )
      return 'denied'
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
    if (!isRecognizedCliPreset(row.family_preset)) return null
    if (row.family_preset === 'unrestricted') return { kind: 'unrestricted' }
    if (row.family_preset !== 'agent') return null
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

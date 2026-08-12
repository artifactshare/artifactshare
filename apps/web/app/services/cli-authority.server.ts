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

export async function resolveCliAuthorityBySessionToken(
  token: string,
): Promise<CliAuthority | null> {
  const db = new Kysely<DB>({ dialect: new D1Dialect({ database: env.DB }) })
  try {
    const row = await db
      .selectFrom('sessions')
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
      .select([
        'sessions.user_agent',
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
      ])
      .where('sessions.token', '=', token)
      .where('sessions.expires_at', '>', nowIso())
      .executeTakeFirst()
    if (!row) return null
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

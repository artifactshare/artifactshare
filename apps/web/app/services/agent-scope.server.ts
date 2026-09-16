import { sql, type Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'
import { lowerEmail } from '~/lib/grant-emails.server'

type AgentAuthority = Extract<CliAuthority, { kind: 'agent' }>

// Agent READ scope (approved contract): within the credential's workspace, an
// agent can read workspace-visible artifacts in any non-archived project, and
// private-project artifacts where the approver's email is in the project
// audience. Artifacts in inbox (home) containers stay unreadable — personal
// home is deliberately narrower than human read semantics. Link-only and
// private visibilities stay unreadable. WRITE scope for artifact
// create/update stays pinned to the approved destination project (see
// isAgentPublishableDestination), while COMMENTS deliberately follow read
// scope — the approved contract is commentable = readable.
export function agentReadableShareableSql(
  viewerAlias: string,
  authority: AgentAuthority,
) {
  const viewer = (column: string) => sql.ref(`${viewerAlias}.${column}`)
  return sql<boolean>`(
    ${viewer('id')} IS NOT NULL
    AND ${viewer('workspace_id')} = ${authority.workspaceId}
    AND shareables.workspace_id = ${authority.workspaceId}
    AND EXISTS (
      SELECT 1 FROM artifact_containers agent_ac
      WHERE agent_ac.id = shareables.container_id
        AND agent_ac.kind = 'project'
        AND agent_ac.archived_at IS NULL
        AND (
          shareables.visibility = 'workspace'
          OR (
            shareables.visibility = 'project'
            AND (
              agent_ac.base_visibility = 'workspace'
              OR (
                ${viewer('email_verified')} = 1
                AND EXISTS (
                  SELECT 1 FROM project_share_defaults agent_psd
                  WHERE agent_psd.project_container_id = agent_ac.id
                    AND ${lowerEmail('agent_psd.email')} = ${lowerEmail(
                      `${viewerAlias}.email`,
                    )}
                )
              )
            )
          )
        )
    )
  )`
}

export type AgentReadAuthorization = {
  kind: 'agent-read'
  artifactId: string
  viewerUserId: string
  viewerWorkspaceId: string
}

export type AgentReadAuthorizationResult =
  | { kind: 'authorized'; authorization: AgentReadAuthorization }
  | { kind: 'missing-viewer' }
  | { kind: 'denied' }

export async function authorizeAgentArtifactRead(
  db: Kysely<DB>,
  user: SessionUser,
  authority: AgentAuthority,
  artifactId: string,
): Promise<AgentReadAuthorizationResult> {
  const row = await db
    .selectFrom('users as access_viewer')
    .leftJoin('shareables', (join) =>
      join.on(sql<boolean>`${sql.ref('shareables.id')} = ${artifactId}`),
    )
    .select([
      'access_viewer.id as viewer_user_id',
      'access_viewer.workspace_id as viewer_workspace_id',
      sql<number>`CASE WHEN ${agentReadableShareableSql(
        'access_viewer',
        authority,
      )} THEN 1 ELSE 0 END`.as('allowed'),
    ])
    .where('access_viewer.id', '=', user.id)
    .executeTakeFirst()
  if (!row) return { kind: 'missing-viewer' }
  if (row.allowed !== 1) return { kind: 'denied' }
  return {
    kind: 'authorized',
    authorization: {
      kind: 'agent-read',
      artifactId,
      viewerUserId: row.viewer_user_id,
      viewerWorkspaceId: row.viewer_workspace_id,
    },
  }
}

export async function isAgentReadableArtifact(
  db: Kysely<DB>,
  user: SessionUser,
  authority: AgentAuthority,
  artifactId: string,
) {
  return (
    (await authorizeAgentArtifactRead(db, user, authority, artifactId)).kind ===
    'authorized'
  )
}

export async function isAgentPublishableDestination(
  db: Kysely<DB>,
  user: Pick<SessionUser, 'workspaceId' | 'email'>,
  authority: AgentAuthority,
  containerId: string | null,
) {
  if (user.workspaceId !== authority.workspaceId) return false
  if (containerId !== authority.projectId) return false
  const email = user.email.toLowerCase()
  const row = await db
    .selectFrom('artifact_containers as c')
    .select('c.id')
    .where('c.id', '=', authority.projectId)
    .where('c.workspace_id', '=', authority.workspaceId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('c.base_visibility', '=', 'workspace'),
        sql<boolean>`exists (
          select 1 from project_share_defaults psd
          where psd.project_container_id = c.id
            and lower(psd.email) = ${email}
            and psd.role in ('contributor', 'manager')
        )`,
      ]),
    )
    .executeTakeFirst()
  return Boolean(row)
}

export async function isAgentOwnedArtifact(
  db: Kysely<DB>,
  user: Pick<SessionUser, 'workspaceId' | 'email'>,
  authority: Extract<CliAuthority, { kind: 'agent' }>,
  artifactId: string,
): Promise<boolean> {
  if (
    !(await isAgentPublishableDestination(
      db,
      user,
      authority,
      authority.projectId,
    ))
  ) {
    return false
  }
  const row = await db
    .selectFrom('shareables')
    .select('id')
    .where('id', '=', artifactId)
    .where('workspace_id', '=', authority.workspaceId)
    .where('container_id', '=', authority.projectId)
    .where('created_by_agent_profile_id', '=', authority.agentProfileId)
    .executeTakeFirst()
  return Boolean(row)
}

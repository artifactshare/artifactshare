import { sql, type Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'

type AgentAuthority = Extract<CliAuthority, { kind: 'agent' }>

export async function isAgentReadableArtifact(
  db: Kysely<DB>,
  user: SessionUser,
  authority: AgentAuthority,
  artifactId: string,
) {
  if (user.workspaceId !== authority.workspaceId) return false
  const email = user.email.toLowerCase()
  const row = await db
    .selectFrom('shareables')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select('shareables.id')
    .where('shareables.id', '=', artifactId)
    .where('shareables.workspace_id', '=', authority.workspaceId)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('shareables.visibility', '=', 'workspace'),
          eb.or([
            eb('shareables.container_id', 'is', null),
            eb('c.archived_at', 'is', null),
          ]),
        ]),
        eb.and([
          eb('shareables.visibility', '=', 'project'),
          eb('c.kind', '=', 'project'),
          eb('c.archived_at', 'is', null),
          eb.or([
            eb('c.base_visibility', '=', 'workspace'),
            sql<boolean>`exists (
              select 1 from project_share_defaults psd
              where psd.project_container_id = shareables.container_id
                and lower(psd.email) = ${email}
            )`,
          ]),
        ]),
      ]),
    )
    .executeTakeFirst()
  return Boolean(row)
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
  authority: Extract<CliAuthority, { kind: 'agent' }>,
  artifactId: string,
): Promise<boolean> {
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

import { sql, type ExpressionBuilder, type Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'
import { grantMatchEmail } from './access.server'

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
export function agentReadableShareablePredicate(
  eb: ExpressionBuilder<DB, 'shareables'>,
  // grantMatchEmail(viewer): lowercase email when verified, null otherwise.
  // An unverified email must never match a private-project audience grant.
  matchEmail: string | null,
) {
  const inActiveProject = eb.exists(
    eb
      .selectFrom('artifact_containers as ac')
      .select('ac.id')
      .whereRef('ac.id', '=', 'shareables.container_id')
      .where('ac.kind', '=', 'project')
      .where('ac.archived_at', 'is', null),
  )
  return eb.or([
    eb.and([eb('shareables.visibility', '=', 'workspace'), inActiveProject]),
    eb.and([
      eb('shareables.visibility', '=', 'project'),
      eb.exists(
        eb
          .selectFrom('artifact_containers as ac')
          .select('ac.id')
          .whereRef('ac.id', '=', 'shareables.container_id')
          .where('ac.kind', '=', 'project')
          .where('ac.archived_at', 'is', null)
          .where((sub) =>
            sub.or([
              sub('ac.base_visibility', '=', 'workspace'),
              ...(matchEmail === null
                ? []
                : [
                    sql<boolean>`exists (
                      select 1 from project_share_defaults psd
                      where psd.project_container_id = ac.id
                        and lower(psd.email) = ${matchEmail}
                    )`,
                  ]),
            ]),
          ),
      ),
    ]),
  ])
}

export async function isAgentReadableArtifact(
  db: Kysely<DB>,
  user: SessionUser,
  authority: AgentAuthority,
  artifactId: string,
) {
  if (user.workspaceId !== authority.workspaceId) return false
  const row = await db
    .selectFrom('shareables')
    .select('shareables.id')
    .where('shareables.id', '=', artifactId)
    .where('shareables.workspace_id', '=', authority.workspaceId)
    .where((eb) => agentReadableShareablePredicate(eb, grantMatchEmail(user)))
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

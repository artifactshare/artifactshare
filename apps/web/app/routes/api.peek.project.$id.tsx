import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  countProjectParticipants,
  getProjectForPeek,
} from '~/services/project-membership.server'
import {
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
} from '~/services/projects.server'
import type { Route } from './+types/api.peek.project.$id'
import { sql } from 'kysely'
export const middleware = [requireUserApiMiddleware]
export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const p = await getProjectForPeek(db, params.id, user)
  if (!p) return new Response('Not found', { status: 404 })
  const files = await db
    .selectFrom('shareables')
    .select([
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.artifact_kind as kind',
    ])
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .where('shareables.container_id', '=', params.id)
    .where(
      sql<boolean>`((c.workspace_id=${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id<>${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)}))`,
    )
    .orderBy('shareables.updated_at', 'desc')
    .orderBy('shareables.id', 'desc')
    .limit(2)
    .execute()
  return Response.json({
    id: p.id,
    name: p.name,
    description: p.description,
    fileCount: Number(p.fileCount),
    participantCount: await countProjectParticipants(db, p.id),
    updatedAt: p.updatedAt,
    recentFiles: files.map((f) => ({
      id: f.id,
      title: f.title_override || f.derived_title || f.name,
      kind: f.kind,
    })),
  })
}

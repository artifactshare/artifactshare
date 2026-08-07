import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { visibleProjectContainerToViewerSql } from '~/services/project-membership.server'
import { visibleShareableToViewerSql } from '~/services/projects.server'
import type { Route } from './+types/api.peek.shareable.$id'
import { sql } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import { grantMatchEmail } from '~/services/access.server'
import { loadPreviewExcerpt } from '~/services/content.server'
export const middleware = [requireUserApiMiddleware]
export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const row = await db
    .selectFrom('shareables')
    .innerJoin('users as u', 'u.id', 'shareables.owner_user_id')
    .leftJoin('versions as v', 'v.id', 'shareables.current_version_id')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.description',
      'u.id as ownerId',
      sql<string>`coalesce(u.name, u.email)`.as('ownerName'),
      'u.image as ownerImage',
      'shareables.view_count as viewCount',
      'shareables.created_at as createdAt',
      'c.id as containerId',
      'c.name as containerName',
      'c.kind as containerKind',
      sql<number>`case when c.kind <> 'project' or ${visibleProjectContainerToViewerSql(user)} then 1 else 0 end`.as(
        'canSeeContainer',
      ),
      'v.published_at as publishedAt',
      'v.r2_key as r2Key',
      'v.artifact_kind as artifactKind',
      sql<number>`(select count(*) from versions vv where vv.shareable_id=shareables.id and vv.status='published')`.as(
        'versionCount',
      ),
      sql<number>`(select count(*) from comment_threads cm where cm.shareable_id=shareables.id)`.as(
        'commentCount',
      ),
    ])
    .where('shareables.id', '=', params.id)
    .where(
      // 別 workspace 側: project 可視は「現存する関係者 grant」を必須にし、
      // ファイル単位の個別共有 (shareable_grants) は grant 自体が資格なのでそのまま通す
      sql<boolean>`((c.workspace_id=${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id<>${user.workspaceId} and ((shareables.visibility = 'project' and exists(select 1 from project_share_defaults d where d.project_container_id=c.id and ${lowerEmail('d.email')} = ${grantMatchEmail(user)})) or exists(select 1 from shareable_grants where shareable_grants.shareable_id = shareables.id and ${lowerEmail('shareable_grants.granted_email')} = ${grantMatchEmail(user)}))))`,
    )
    .executeTakeFirst()
  if (!row) return new Response('Not found', { status: 404 })
  let excerpt =
    row.artifactKind === 'html_page' ? row.description?.trim() || null : null
  const isMarkdown = row.artifactKind === 'markdown_page'
  const isHtml = row.artifactKind === 'html_page'
  if (isMarkdown || (isHtml && !excerpt)) {
    try {
      if (row.r2Key && row.artifactKind) {
        excerpt = await loadPreviewExcerpt(row.r2Key, row.artifactKind)
      }
    } catch {
      excerpt = null
    }
  }
  return Response.json({
    id: row.id,
    title: row.title_override || row.derived_title || row.name,
    description: row.description,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    ownerImage: row.ownerImage,
    viewCount: Number(row.viewCount),
    commentCount: Number(row.commentCount),
    versionCount: Number(row.versionCount),
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    containerId: row.canSeeContainer ? row.containerId : null,
    containerName: row.canSeeContainer ? row.containerName : null,
    containerKind: row.canSeeContainer ? row.containerKind : null,
    excerpt,
  })
}

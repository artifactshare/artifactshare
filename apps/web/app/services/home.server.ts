import type { ExpressionBuilder, Kysely } from 'kysely'
import { expressionBuilder, sql } from 'kysely'
import type {
  FileRowData,
  ShareableFileRow,
} from '~/routes/_home/+components/file-data'
import type {
  HomeView,
  ProjectBlock,
} from '~/routes/_home/+components/home-view'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'
import { listJoinedProjectsForDropdown } from './project-membership.server'
import { listMyProjects } from './projects.server'
import {
  INBOX_CONTAINER_NAME,
  shareableLinkAccessToViewer,
  visibleShareableToViewerSql,
  type ShareableViewer,
} from './projects.server'
import { grantMatchEmail } from './access.server'
import { lowerEmail } from '~/lib/grant-emails.server'
import { nowIso } from '~/lib/datetime'
import { commentThreadWindowExpression } from './comment-thread-window.server'

// ファイル行のコメント数。ホームのレール 2 区画 (自分のファイル / 最近見た
// もの) が同じ画面に並ぶため、数え方は必ずこの 1 箇所で変える。
function commentCountSelect(eb: ExpressionBuilder<DB, 'shareables'>) {
  return eb
    .selectFrom('comment_threads')
    .select((sqb) => sqb.fn.count<number>('comment_threads.id').as('count'))
    .whereRef('comment_threads.shareable_id', '=', 'shareables.id')
    .as('comment_count')
}

function versionCountSelect(eb: ExpressionBuilder<DB, 'shareables'>) {
  return eb
    .selectFrom('versions')
    .select((sqb) => sqb.fn.count<number>('versions.id').as('value'))
    .whereRef('versions.shareable_id', '=', 'shareables.id')
    .where('versions.status', '=', 'published')
    .as('version_count')
}

function latestPublishedAtSelect(eb: ExpressionBuilder<DB, 'shareables'>) {
  return eb
    .selectFrom('versions')
    .select((sqb) =>
      sqb.fn.max<string | null>('versions.published_at').as('value'),
    )
    .whereRef('versions.shareable_id', '=', 'shareables.id')
    .where('versions.status', '=', 'published')
    .as('latest_published_at')
}

// 未読は「自分が見た後の他者の動き」。自分の版・自分のコメントは数えない
// (コメント側と揃える。自分の更新で自分の行にドットが立たない)
function unreadVersionCountSelect(
  eb: ExpressionBuilder<DB, 'shareables'>,
  userId: string,
) {
  return eb
    .selectFrom('versions')
    .select((sqb) => sqb.fn.count<number>('versions.id').as('value'))
    .where(sql<boolean>`(
      versions.shareable_id = shareables.id
      AND versions.status = 'published'
      AND (
        recency.version_seen_through_at IS NULL OR versions.published_at > recency.version_seen_through_at
      )
      AND versions.created_by_id <> ${userId}
    )`)
    .as('unread_version_count')
}

function unreadCommentSummarySelect(
  _eb: ExpressionBuilder<DB, 'shareables'>,
  userId: string,
) {
  return sql<string>`(
    SELECT json_object(
      'count', unread.total,
      'id', unread.id,
      'author_id', unread.created_by_id,
      'author_name', (SELECT name FROM users WHERE users.id = unread.created_by_id),
      'author_image', (SELECT image FROM users WHERE users.id = unread.created_by_id),
      'body', unread.body,
      'created_at', unread.created_at
    ) FROM (
      SELECT comment_messages.*, COUNT(*) OVER () AS total
      FROM comment_messages
      INNER JOIN comment_threads ON comment_threads.id = comment_messages.thread_id
      WHERE comment_threads.shareable_id = shareables.id
        AND ${commentThreadWindowExpression(sql.ref('shareables.id'))}
        AND (recency.comment_seen_through_at IS NULL OR comment_messages.created_at > recency.comment_seen_through_at)
        AND comment_messages.created_by_id <> ${userId}
      ORDER BY comment_messages.created_at DESC, comment_messages.id DESC
      LIMIT 1
    ) unread
  )`.as('unread_comment_summary')
}

function recentAttributeSelect(
  user: ShareableViewer,
  containerAlias = 'containers',
) {
  return recentAttributeExpression(user, containerAlias).as('recent_attribute')
}

function recentAttributeExpression(
  user: ShareableViewer,
  containerAlias = 'containers',
) {
  const containerId = sql.ref(`${containerAlias}.id`)
  const joinedProject = sql<boolean>`NOT EXISTS (SELECT 1 FROM artifact_containers archived WHERE archived.id = ${containerId} AND archived.archived_at IS NOT NULL) AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.container_id = ${containerId} AND pm.user_id = ${user.id}) OR EXISTS (SELECT 1 FROM project_share_defaults d WHERE d.project_container_id = ${containerId} AND ${lowerEmail('d.email')} = ${grantMatchEmail(user)}))`
  const direct = sql<boolean>`EXISTS (SELECT 1 FROM shareable_grants g WHERE g.shareable_id = shareables.id AND ${lowerEmail('g.granted_email')} = ${grantMatchEmail(user)})`
  return sql<'own' | 'joined-project' | 'direct-share' | null>`CASE
    WHEN shareables.owner_user_id = ${user.id} THEN 'own'
    WHEN ${joinedProject} THEN 'joined-project'
    WHEN ${direct} THEN 'direct-share'
    ELSE NULL END`
}

/** Recency rows are deliberately filtered without a workspace-first query. */
export function recentShareableAccessPredicate(
  user: ShareableViewer & { workspaceId: string },
  containerAlias = 'containers',
  now = nowIso(),
) {
  const containerWorkspace = sql.ref(`${containerAlias}.workspace_id`)
  const containerId = sql.ref(`${containerAlias}.id`)
  const activeContainer = sql<boolean>`NOT EXISTS (SELECT 1 FROM artifact_containers archived WHERE archived.id = ${containerId} AND archived.archived_at IS NOT NULL)`
  const activeLink = sql<boolean>`${shareableLinkAccessToViewer(
    expressionBuilder<DB, 'shareables'>(),
    now,
  )}`
  const direct = sql<boolean>`EXISTS (SELECT 1 FROM shareable_grants g WHERE g.shareable_id = shareables.id AND ${lowerEmail('g.granted_email')} = ${grantMatchEmail(user)})`
  const sameWorkspace = sql<boolean>`${containerWorkspace} = ${user.workspaceId}`
  const visible = visibleShareableToViewerSql(user, now)
  const sameWorkspaceAccess = sql<boolean>`${sameWorkspace} AND ${visible} AND (
    (shareables.visibility = 'workspace' AND ${activeContainer})
    OR shareables.visibility = 'private'
    OR (${activeLink})
    OR (shareables.visibility = 'project' AND ${activeContainer})
  )`
  const crossProject = sql<boolean>`shareables.visibility = 'project' AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.container_id = ${containerId} AND pm.user_id = ${user.id}) OR EXISTS (SELECT 1 FROM project_share_defaults d WHERE d.project_container_id = ${containerId} AND ${lowerEmail('d.email')} = ${grantMatchEmail(user)}))`
  return sql<boolean>`(
    shareables.owner_user_id = ${user.id}
    OR ${direct}
    OR ${sameWorkspaceAccess}
    OR (${containerWorkspace} <> ${user.workspaceId} AND (
      (${activeContainer} AND ${crossProject}) OR ${activeLink}
    ))
  )`
}

export type RecentRelation = 'all' | 'own' | 'project' | 'shared'

export function recentFilterPredicate(
  user: ShareableViewer,
  filters: { relation?: RecentRelation; unread?: boolean },
) {
  const relation = filters.relation ?? 'all'
  const attribute = recentAttributeExpression(user)
  const relationPredicate =
    relation === 'own'
      ? sql<boolean>`(${attribute}) = 'own'`
      : relation === 'project'
        ? sql<boolean>`(${attribute}) = 'joined-project'`
        : relation === 'shared'
          ? sql<boolean>`(${attribute}) = 'direct-share'`
          : sql<boolean>`1 = 1`
  if (!filters.unread) return relationPredicate
  const unread = sql<boolean>`(
    EXISTS (SELECT 1 FROM versions v WHERE v.shareable_id = shareables.id AND v.status = 'published' AND v.created_by_id <> ${user.id} AND (recency.version_seen_through_at IS NULL OR v.published_at > recency.version_seen_through_at))
    OR EXISTS (SELECT 1 FROM comment_messages cm INNER JOIN comment_threads ct ON ct.id = cm.thread_id WHERE ct.shareable_id = shareables.id AND ${commentThreadWindowExpression(sql.ref('shareables.id'), 'ct')} AND cm.created_by_id <> ${user.id} AND (recency.comment_seen_through_at IS NULL OR cm.created_at > recency.comment_seen_through_at))
  )`
  return sql<boolean>`(${relationPredicate}) AND ${unread}`
}

// `/recent` loader と listRecentArtifactsLimited で共有。
// **呼び出し側が `shareable_viewer_recency as recency` で join していることを前提にする**
// (未読 2 列の生 SQL が `recency.*_seen_through_at` を参照する)。別名で join している
// 箇所 (search-palette.server.ts は `as r`) から呼ぶと実行時に落ちる。
export function recentRowActivitySelects(
  eb: ExpressionBuilder<DB, 'shareables'>,
  userId: string,
  user?: ShareableViewer,
  containerAlias = 'containers',
) {
  return [
    versionCountSelect(eb),
    latestPublishedAtSelect(eb),
    unreadVersionCountSelect(eb, userId),
    unreadCommentSummarySelect(eb, userId),
    ...(user ? [recentAttributeSelect(user, containerAlias)] : []),
  ]
}

function artifactSelectQuery(db: Kysely<DB>, workspaceId: string) {
  return db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .innerJoin(
      'artifact_containers as containers',
      'containers.id',
      'shareables.container_id',
    )
    .leftJoin('workspaces', 'workspaces.id', 'containers.workspace_id')
    .select((eb) => [
      'shareables.id',
      'shareables.workspace_id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.created_at',
      'shareables.artifact_kind',
      'shareables.owner_user_id',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.image as owner_image',
      'shareables.visibility',
      'shareables.view_count',
      'shareables.updated_at as modified_at',
      'containers.id as project_id',
      'containers.name as project_name',
      'containers.kind as project_kind',
      'containers.workspace_id as project_workspace_id',
      'workspaces.name as project_workspace_name',
      commentCountSelect(eb),
    ])
    .where('shareables.workspace_id', '=', workspaceId)
    .where('containers.archived_at', 'is', null)
    .orderBy('shareables.updated_at', 'desc')
}

export async function listMyArtifacts(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
): Promise<{ rows: ShareableFileRow[]; total: number }> {
  const base = artifactSelectQuery(db, workspaceId).where(
    'shareables.owner_user_id',
    '=',
    userId,
  )
  const [rows, count] = await Promise.all([
    base.limit(100).execute(),
    base
      .clearSelect()
      .clearOrderBy()
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow(),
  ])
  return { rows, total: Number(count.total) }
}

export function listMyArtifactsLimited(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
  limit = 5,
) {
  return artifactSelectQuery(db, workspaceId)
    .where('shareables.owner_user_id', '=', userId)
    .clearOrderBy()
    .orderBy('shareables.created_at', 'desc')
    .limit(limit)
    .execute()
}

export async function listUnopenedOwnedArtifactsLimited(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
  limit = 5,
): Promise<{ rows: ShareableFileRow[]; hasMore: boolean }> {
  const rows = await artifactSelectQuery(db, workspaceId)
    .where('shareables.owner_user_id', '=', userId)
    .where('shareables.current_version_id', 'is not', null)
    .where((eb) =>
      eb(
        eb
          .selectFrom('versions as first_version')
          .select('first_version.created_by_id')
          .whereRef('first_version.shareable_id', '=', 'shareables.id')
          .orderBy('first_version.created_at', 'asc')
          .orderBy('first_version.id', 'asc')
          .limit(1),
        '=',
        userId,
      ),
    )
    .where('shareables.artifact_kind', 'in', [
      'markdown_page',
      'html_page',
      'static_site',
    ])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('shareable_viewer_recency as unopened_recency')
            .select('unopened_recency.shareable_id')
            .whereRef('unopened_recency.shareable_id', '=', 'shareables.id')
            .where('unopened_recency.viewer_user_id', '=', userId),
        ),
      ),
    )
    .clearOrderBy()
    .orderBy('shareables.created_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .limit(limit + 1)
    .execute()

  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

function recentArtifactsQuery(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
) {
  return db
    .selectFrom('shareable_viewer_recency as recency')
    .innerJoin('shareables', 'shareables.id', 'recency.shareable_id')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin(
      'artifact_containers as containers',
      'containers.id',
      'shareables.container_id',
    )
    .leftJoin('workspaces', 'workspaces.id', 'containers.workspace_id')
    .select((eb) => [
      recentShareableAccessPredicate(user).as('visible'),
      'shareables.id',
      'shareables.workspace_id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.artifact_kind',
      'shareables.owner_user_id',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.image as owner_image',
      'shareables.visibility',
      'shareables.view_count',
      'recency.last_viewed_at as modified_at',
      'recency.viewed_title',
      'recency.viewed_owner_name',
      'containers.id as project_id',
      'containers.name as project_name',
      'containers.kind as project_kind',
      'containers.workspace_id as project_workspace_id',
      'workspaces.name as project_workspace_name',
      commentCountSelect(eb),
      ...recentRowActivitySelects(eb, user.id, user),
    ])
    .where('recency.viewer_user_id', '=', user.id)
}

function recentScopePredicate(
  user: ShareableViewer & { id: string; workspaceId: string },
  filters: { relation?: RecentRelation; unread?: boolean } = {},
) {
  const relation = filters.relation ?? 'all'
  if (relation === 'all' && !filters.unread) return sql<boolean>`1 = 1`
  return sql<boolean>`${recentShareableAccessPredicate(user)} AND ${recentFilterPredicate(user, { relation, unread: filters.unread })}`
}

export function compileRecentArtifactsLimitedQuery(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
  limit: number,
): { sql: string; parameters: readonly unknown[] } {
  const compiled = recentArtifactsQuery(db, user)
    .where(recentScopePredicate(user))
    .orderBy('recency.last_viewed_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .limit(limit)
    .compile()
  return { sql: compiled.sql, parameters: compiled.parameters }
}

export function listRecentArtifactsLimited(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
  limit = 5,
  filters: { relation?: RecentRelation; unread?: boolean } = {},
) {
  const scoped = recentArtifactsQuery(db, user).where(
    recentScopePredicate(user, filters),
  )
  return scoped
    .orderBy('recency.last_viewed_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .limit(limit)
    .execute()
}

export function listRecentArtifactsPage(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
  page: number,
  filters: { relation?: RecentRelation; unread?: boolean } = {},
) {
  const scoped = recentArtifactsQuery(db, user).where(
    recentScopePredicate(user, filters),
  )
  return scoped
    .orderBy('recency.last_viewed_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .offset((page - 1) * 20)
    .limit(20)
    .execute()
}

export async function countRecentArtifacts(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
  filters: { relation?: RecentRelation; unread?: boolean } = {},
) {
  const row = await recentArtifactsQuery(db, user)
    .where(recentScopePredicate(user, filters))
    .clearSelect()
    .clearOrderBy()
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

export function compileRecentArtifactsCountQuery(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
  filters: { relation?: RecentRelation; unread?: boolean } = {},
): { sql: string; parameters: readonly unknown[] } {
  return recentArtifactsQuery(db, user)
    .where(recentScopePredicate(user, filters))
    .clearSelect()
    .clearOrderBy()
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .compile()
}

export async function recentHistoryCardinality(
  db: Kysely<DB>,
  user: ShareableViewer & { id: string; workspaceId: string },
) {
  const rows = await recentArtifactsQuery(db, user)
    .where(recentShareableAccessPredicate(user))
    .clearSelect()
    .clearOrderBy()
    .select('shareables.id')
    .limit(2)
    .execute()
  return rows.length
}

export function buildHomeView(
  files: FileRowData[],
  projects: { id: string; name: string }[],
  perProjectLimit = 3,
): HomeView {
  const nameById = new Map(projects.map((p) => [p.id, p.name]))
  const byProject = new Map<string, FileRowData[]>()
  const inboxFiles: FileRowData[] = []
  for (const f of files) {
    if (f.projectId == null) {
      inboxFiles.push(f)
    } else if (nameById.has(f.projectId)) {
      const list = byProject.get(f.projectId)
      if (list) list.push(f)
      else byProject.set(f.projectId, [f])
    }
  }
  const projectBlocks: ProjectBlock[] = [...byProject.entries()].map(
    ([id, pf]) => ({
      id,
      kind: 'project',
      name: nameById.get(id) ?? '',
      fileCount: pf.length,
      fileUpdatedAt: pf[0]?.modifiedTime ?? null,
      recentFiles: pf.slice(0, perProjectLimit),
    }),
  )
  projectBlocks.sort((a, b) =>
    (b.fileUpdatedAt ?? '').localeCompare(a.fileUpdatedAt ?? ''),
  )
  if (inboxFiles.length > 0) {
    projectBlocks.push({
      id: null,
      kind: 'inbox',
      name: INBOX_CONTAINER_NAME,
      fileCount: inboxFiles.length,
      fileUpdatedAt: inboxFiles[0]?.modifiedTime ?? null,
      recentFiles: inboxFiles.slice(0, perProjectLimit),
    })
  }
  return { recent: files, projectBlocks }
}

export { listMyProjects } from './projects.server'

export type RailProject = {
  id: string
  name: string
  joined: boolean
  updatedAt?: string
  fileCount?: number
  newCount?: number
}

// ホームのレール「プロジェクト」区画: 参加中を優先して最大 3 件。参加 0 件は
// 現行どおり自分が作成したプロジェクト名だけを返す。
export async function listRailProjects(
  db: Kysely<DB>,
  user: SessionUser,
): Promise<RailProject[]> {
  const joined = await listJoinedProjectsForDropdown(db, user, 3)
  if (joined.length > 0) return joined.map((p) => ({ ...p, joined: true }))
  const created = await listMyProjects(db, user.id, user.workspaceId, 3)
  return created.map((p) => ({ ...p, joined: false }))
}

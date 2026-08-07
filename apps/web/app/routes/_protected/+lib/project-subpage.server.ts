import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'
import type { EditableVisibility } from '~/lib/shareable-types'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
} from '~/lib/shareable-types'
import { isOrgWorkspace, toUserInfo, type SessionUser } from '~/lib/user'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import type { JoinedProjectNav } from '~/routes/_home/+components/primary-nav'
import { isLinkSharingAllowedByPolicy } from '~/services/link-sharing.server'
import {
  findSharedProjectForViewer,
  findWorkspaceProject,
  getProjectShareRoleForEmail,
  listProjectShareDefaults,
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
  type ProjectShareDefault,
} from '~/services/projects.server'

// プロジェクト詳細とサブページ (ファイル全件 / 動きの履歴) で共有する行クエリ。
// 絞り込み (where) だけ呼び出し側で変える。
export function projectFileRowsQuery(db: Kysely<DB>, containerId: string) {
  return db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .select((eb) => [
      'shareables.id',
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
      'shareables.updated_at as modified_at',
      'shareables.created_at as created_at',
      eb
        .selectFrom('versions')
        .select((sqb) => sqb.fn.count<number>('versions.id').as('value'))
        .whereRef('versions.shareable_id', '=', 'shareables.id')
        .where('versions.status', '=', 'published')
        .as('version_count'),
      eb
        .selectFrom('versions')
        .select((sqb) =>
          sqb.fn.max<string | null>('versions.published_at').as('value'),
        )
        .whereRef('versions.shareable_id', '=', 'shareables.id')
        .where('versions.status', '=', 'published')
        .as('latest_published_at'),
      eb
        .selectFrom('comment_threads')
        .select((sqb) => sqb.fn.count<number>('comment_threads.id').as('count'))
        .whereRef('comment_threads.shareable_id', '=', 'shareables.id')
        .as('comment_count'),
    ])
    .where('shareables.container_id', '=', containerId)
}

export type ProjectSubpageContext = {
  access: 'member' | 'shared'
  projectId: string
  projectName: string
  projectBaseVisibility: 'workspace' | 'private'
  projectWorkspaceId: string
  archived: boolean
  createdByEmail: string | null
  workspaceName: string
  workspaceHd: string | null
  user: ReturnType<typeof toUserInfo>
  canUpload: boolean
  defaultVisibility: EditableVisibility
  availableVisibilities: ReadonlyArray<EditableVisibility>
  linkSharingAvailable: boolean
  shareDefaults: ProjectShareDefault[]
  joinedNav: JoinedProjectNav[]
}

// サブページ共通のアクセス判定と Topbar / アップロードダイアログ用の文脈。
// アクセス権はプロジェクト詳細と同じ判定 (member または共有された関係者)。
export async function loadProjectSubpageContext(
  db: Kysely<DB>,
  user: SessionUser,
  projectId: string,
): Promise<ProjectSubpageContext> {
  const [workspace, joinedNav, own] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select(['name', 'hd'])
      .where('id', '=', user.workspaceId)
      .executeTakeFirst(),
    listJoinedProjectsForDropdown(db, user, 5)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          newCount: row.newCount,
          workspaceName: row.workspaceName,
        })),
      )
      .catch(() => []),
    findWorkspaceProject(db, user.workspaceId, projectId, user),
  ])
  const workspaceName = workspace?.name ?? workspace?.hd ?? 'Files'
  if (own) {
    const workspaceHd = workspace?.hd ?? user.hd
    const [linkSharingAvailable, shareDefaults] = await Promise.all([
      isLinkSharingAllowedByPolicy(db, user.workspaceId),
      listProjectShareDefaults(db, user.workspaceId, own.id, workspaceHd),
    ])
    return {
      access: 'member',
      projectId: own.id,
      projectName: own.name,
      projectBaseVisibility: own.baseVisibility,
      projectWorkspaceId: user.workspaceId,
      archived: Boolean(own.archivedAt),
      createdByEmail: own.createdByEmail,
      workspaceName,
      workspaceHd,
      user: toUserInfo(user),
      canUpload: !own.archivedAt,
      defaultVisibility: defaultVisibilityFor(isOrgWorkspace(user), 'project'),
      availableVisibilities: availableVisibilitiesFor(
        isOrgWorkspace(user),
        'project',
      ),
      linkSharingAvailable,
      shareDefaults,
      joinedNav,
    }
  }
  const shared = await findSharedProjectForViewer(db, projectId, user)
  if (!shared) throw new Response('Not found', { status: 404 })
  const role = await getProjectShareRoleForEmail(db, projectId, user.email)
  const canUpload = role === 'contributor' || role === 'manager'
  const sourceHd = shared.sourceWorkspaceHd
  const shareDefaults = canUpload
    ? await listProjectShareDefaults(
        db,
        shared.workspaceId,
        shared.id,
        sourceHd,
      )
    : []
  return {
    access: 'shared',
    projectId: shared.id,
    projectName: shared.name,
    projectBaseVisibility: shared.baseVisibility,
    projectWorkspaceId: shared.workspaceId,
    archived: false,
    createdByEmail: shared.createdByEmail,
    workspaceName,
    workspaceHd: sourceHd,
    user: toUserInfo(user),
    canUpload,
    defaultVisibility: 'project',
    availableVisibilities: ['project'],
    linkSharingAvailable: false,
    shareDefaults,
    joinedNav,
  }
}

export function projectSubpageVisibleFilter(
  ctx: ProjectSubpageContext,
  user: SessionUser,
) {
  return ctx.access === 'member'
    ? visibleShareableToViewerSql(user)
    : visibleSharedProjectShareableToViewerSql(user)
}

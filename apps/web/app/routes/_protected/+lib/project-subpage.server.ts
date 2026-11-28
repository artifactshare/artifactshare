import {
  directGrantsSelect,
  latestPublishedAtSelect,
  currentVersionNumberSelect,
} from '~/services/home.server'
import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'
import type { EditableVisibility } from '~/lib/shareable-types'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
} from '~/lib/shareable-types'
import { isOrgWorkspace, toUserInfo, type SessionUser } from '~/lib/user'
import { isLinkSharingAllowedByPolicy } from '~/services/link-sharing.server'
import {
  findSharedProjectForViewer,
  findWorkspaceProject,
  canPlaceIntoProject,
  listProjectShareDefaults,
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
  type ProjectShareDefault,
} from '~/services/projects.server'

export function projectFileRowsQuery(
  db: Kysely<DB>,
  containerId: string,
  user?: { id: string; email?: string | null },
) {
  return db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .select((eb) => [
      directGrantsSelect(user?.id ?? '', user?.email),
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
      'shareables.activity_at as modified_at',
      'shareables.created_at as created_at',
      eb
        .selectFrom('versions')
        .select((sqb) => sqb.fn.max<number>('versions.number').as('value'))
        .whereRef('versions.shareable_id', '=', 'shareables.id')
        .where('versions.status', '=', 'published')
        .as('version_count'),
      latestPublishedAtSelect(eb),
      currentVersionNumberSelect(eb),
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
  workspaceHd: string | null
  user: ReturnType<typeof toUserInfo>
  canUpload: boolean
  defaultVisibility: EditableVisibility
  availableVisibilities: ReadonlyArray<EditableVisibility>
  linkSharingAvailable: boolean
  shareDefaults: ProjectShareDefault[]
}

export async function loadProjectSubpageContext(
  db: Kysely<DB>,
  user: SessionUser,
  projectId: string,
): Promise<ProjectSubpageContext> {
  const [workspace, own] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select('hd')
      .where('id', '=', user.workspaceId)
      .executeTakeFirst(),
    findWorkspaceProject(db, user.workspaceId, projectId, user),
  ])
  if (own) {
    const workspaceHd = workspace?.hd ?? user.hd
    const [linkSharingAvailable, shareDefaults, canUpload] = await Promise.all([
      isLinkSharingAllowedByPolicy(db, user.workspaceId),
      listProjectShareDefaults(db, user.workspaceId, own.id, workspaceHd),
      canPlaceIntoProject(db, user, own.id),
    ])
    return {
      access: 'member',
      projectId: own.id,
      projectName: own.name,
      projectBaseVisibility: own.baseVisibility,
      projectWorkspaceId: user.workspaceId,
      archived: Boolean(own.archivedAt),
      createdByEmail: own.createdByEmail,
      workspaceHd,
      user: toUserInfo(user),
      canUpload,
      defaultVisibility: defaultVisibilityFor(isOrgWorkspace(user), 'project'),
      availableVisibilities: availableVisibilitiesFor(
        isOrgWorkspace(user),
        'project',
      ),
      linkSharingAvailable,
      shareDefaults,
    }
  }
  const shared = await findSharedProjectForViewer(db, projectId, user)
  if (!shared) throw new Response('Not found', { status: 404 })
  const canUpload = await canPlaceIntoProject(db, user, projectId)
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
    workspaceHd: sourceHd,
    user: toUserInfo(user),
    canUpload,
    defaultVisibility: 'project',
    availableVisibilities: ['project'],
    linkSharingAvailable: false,
    shareDefaults,
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

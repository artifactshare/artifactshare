import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { cn } from '~/lib/utils'
import {
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useNavigate,
  useNavigation,
  useSearchParams,
  useViewTransitionState,
} from 'react-router'
import { IconDots, IconPlus, IconStack2 as Layers } from '@tabler/icons-react'
import type { Route } from './+types/projects.$id'
import type { JoinedProjectNav } from '../_home/+components/primary-nav'
import { BottomTabBar } from '../_home/+components/bottom-tab-bar'
import { ProjectScopeChip } from '~/components/app/visibility-chip'
import { IconButton } from '~/components/app/icon-button'
import { ProjectScopeField } from '~/components/app/project-scope-field'
import { ProjectAudienceDialog } from '~/components/app/project-audience-dialog'
import { ProjectSlackDialog } from './+components/project-slack-dialog'
import { getContainerSlackChannel } from '~/services/slack-notifications.server'
import {
  ArchiveProjectDialog,
  DeleteProjectDialog,
} from '~/components/app/project-manage-dialogs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '~/components/ui/empty'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { displayTitle } from '~/lib/display-title'
import { formatRelative } from '~/lib/datetime'
import { useT } from '~/hooks/use-t'
import { toast } from 'sonner'
import type { TKey } from '~/lib/i18n'
import type {
  ArtifactKind,
  EditableVisibility,
  Visibility,
} from '~/lib/shareable-types'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
} from '~/lib/shareable-types'
import { isExternalPostingEnabledForWorkspace } from '~/lib/project-external-posting.server'
import {
  toUserInfo,
  isOrgWorkspace,
  type SessionUser,
  type UserInfo,
} from '~/lib/user'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { isLinkSharingAllowedByPolicy } from '~/services/link-sharing.server'
import { normalizeGrantEmail } from '~/lib/grant-emails'
import {
  canEditProjectContainer,
  countProjectVisibilityArtifacts,
  findSharedProjectForViewer,
  findWorkspaceProject,
  getProjectShareRoleForEmail,
  listProjectShareDefaults,
  normalizeProjectDescription,
  normalizeProjectName,
  parseProjectBaseVisibility,
  updateProjectContainer,
  visibleSharedProjectShareableToViewer,
  visibleSharedProjectShareableToViewerSql,
  visibleShareableToViewer,
  visibleShareableToViewerSql,
  type ProjectShareDefault,
  type ProjectSummary,
  type SharedProjectSummary,
} from '~/services/projects.server'
import { toFileRowData, type FileRowData } from '../_home/+components/file-data'
import { FileRow } from '../_home/+components/file-row'
import {
  fileTableColumns,
  fileTableHeadClassName,
  fileTableListClassName,
} from '../_home/+components/file-list-styles'
import { UploadArtifactDialog } from '../_home/+components/upload-artifact-dialog'
import {
  projectContextClassName,
  projectDetailActionsClassName,
  projectDetailDescClassName,
  projectDetailHeadClassName,
  projectDetailH1ClassName,
} from '~/components/app/project-detail-styles'
import { Topbar } from '../_home/+components/topbar'
import { listMainClassName } from '~/components/app/page-shell-styles'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderDescription,
  AppPageHeaderMain,
  AppPageHeaderMeta,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'
import { ProjectRedesignBody } from './+components/project-redesign-body'
import {
  ProjectMembershipControls,
  ProjectParticipantsSummary,
} from './+components/project-membership-controls'
import { projectFileRowsQuery } from './+lib/project-subpage.server'
import { getViewerTimezone } from '~/lib/viewer-timezone.server'
import {
  listProjectPins,
  pinShareable,
  unpinShareable,
} from '~/services/project-pins.server'
import {
  countProjectParticipants,
  joinProject,
  leaveProject,
  listJoinedProjectsForDropdown,
  listProjectParticipants,
  touchProjectSeen,
} from '~/services/project-membership.server'
import {
  listFeedEvents,
  listProjectViewRanking,
  type FeedEventRow,
} from '~/services/events.server'

const projectDetailTitleClassName =
  'flex items-start gap-[var(--spacing-2)] min-w-0 flex-1'

const projectDetailCopyClassName = 'min-w-0'

const projectMarkClassName =
  'shrink-0 mt-1 text-link max-stack:size-4 max-stack:mt-1.25'

const projectSummaryStripClassName =
  'text-xs flex flex-wrap items-center gap-y-[var(--spacing-2)] gap-x-[var(--spacing-4)] mt-[var(--spacing-2)] p-0 border-0 text-muted-foreground max-stack:gap-[var(--spacing-2)]'

const projectSummaryItemClassName =
  'flex items-center gap-[var(--spacing-2)] min-w-0'

const projectSummaryLabelClassName = 'text-faint font-medium'

const projectAudienceSummaryClassName = 'text-foreground font-medium'

const projectVisibilityClassName = 'text-xs py-1 px-2 leading-tight'

// 社内メンバー向け (フル) と、別組織から共有された関係者向け (閲覧専用) で
// loader の戻り値を分ける。閲覧専用では編集系のデータを一切引かない。
type MemberLoaderData = {
  access: 'member'
  project: ProjectSummary
  user: UserInfo
  workspaceId: string
  workspaceName: string
  workspaceHd: string | null
  defaultVisibility: EditableVisibility
  availableVisibilities: ReadonlyArray<EditableVisibility>
  linkSharingAvailable: boolean
  files: FileRowData[]
  shareDefaults: ProjectShareDefault[]
  slackChannel: Awaited<ReturnType<typeof getContainerSlackChannel>>
  canEditProject: boolean
  externalPostingEnabled: boolean
  projectArtifactCount: number
  projectActivity: ProjectActivityData
  joinedNav: JoinedProjectNav[]
}

type SharedLoaderData = {
  access: 'shared'
  project: SharedProjectSummary
  user: UserInfo
  workspaceId: string
  workspaceName: string
  canPost: boolean
  canManage: boolean
  projectWorkspaceHd: string | null
  audienceCount: number
  externalAudienceCount: number
  shareDefaults: ProjectShareDefault[]
  slackChannel: { requiresReauthorization: boolean } | null
  projectArtifactCount: number
  files: FileRowData[]
  projectActivity: ProjectActivityData
  joinedNav: JoinedProjectNav[]
}

type LoaderData = MemberLoaderData | SharedLoaderData
type ProjectActivityData = {
  pins: Awaited<ReturnType<typeof listProjectPins>>
  /** null は取得失敗 (レールを出さない)。空配列は動きなし。 */
  feed: FeedEventRow[] | null
  ranking: Awaited<ReturnType<typeof listProjectViewRanking>>
  now: string
  participants: {
    count: number
    top: {
      id: string
      name: string | null
      email: string
      image: string | null
    }[]
  }
  joined: boolean
}

async function loadProjectActivity(
  db: ReturnType<typeof createDb>,
  user: SessionUser,
  containerId: string,
  access: 'member' | 'shared',
  timeZone: string,
): Promise<ProjectActivityData> {
  const now = new Date().toISOString()
  const visibleTo =
    access === 'member'
      ? visibleShareableToViewerSql(user)
      : visibleSharedProjectShareableToViewerSql(user)
  const [
    pins,
    feedResult,
    ranking,
    participantCount,
    participantTop,
    joinedRow,
  ] = await Promise.all([
    listProjectPins(db, containerId, visibleTo).catch((error) => {
      console.error('project.pins-load-failed', error)
      return []
    }),
    listFeedEvents(db, {
      user,
      slice: 'project',
      containerId,
      timeZone,
      targetRows: 6,
      maxRawEvents: 1000,
    }).catch((error) => {
      console.error('project.feed-load-failed', error)
      return null
    }),
    listProjectViewRanking(db, {
      containerId,
      now,
      user,
    }).catch((error) => {
      console.error('project.ranking-load-failed', error)
      return []
    }),
    countProjectParticipants(db, containerId).catch(() => 0),
    listProjectParticipants(db, containerId, 4).catch(() => []),
    db
      .selectFrom('project_members')
      .select('user_id')
      .where('container_id', '=', containerId)
      .where('user_id', '=', user.id)
      .executeTakeFirst(),
  ])
  return {
    pins,
    feed: feedResult === null ? null : feedResult.rows,
    ranking,
    now,
    participants: { count: participantCount, top: participantTop },
    joined: Boolean(joinedRow),
  }
}

export async function loader({
  params,
  context,
  request,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)
  const projectId = params.id
  if (!projectId) throw new Response('Not found', { status: 404 })

  const db = createDb()
  const timeZone = getViewerTimezone(request)
  const project = await findWorkspaceProject(
    db,
    user.workspaceId,
    projectId,
    user,
  )
  if (!project) {
    // 自分のワークスペースに無いプロジェクトは、関係者として共有されている場合だけ
    // 閲覧専用で開ける。それ以外は 404。
    const shared = await findSharedProjectForViewer(db, projectId, user)
    if (!shared) throw new Response('Not found', { status: 404 })
    return loadSharedProject(db, user, shared, timeZone)
  }

  const managerRoleEnabled = await isExternalPostingEnabledForWorkspace(
    db,
    user.workspaceId,
  )

  const [
    workspace,
    rows,
    canEditProject,
    projectArtifactCount,
    linkSharingAvailable,
    slackChannel,
  ] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select(['name', 'hd'])
      .where('id', '=', user.workspaceId)
      .executeTakeFirst(),
    projectFileRowsQuery(db, project.id)
      .where('shareables.workspace_id', '=', user.workspaceId)
      .where('shareables.visibility', 'in', [
        'private',
        'workspace',
        'project',
        'link',
      ])
      .where((eb) => visibleShareableToViewer(eb, user))
      .orderBy('shareables.updated_at', 'desc')
      .execute(),
    canEditProjectContainer(db, user.workspaceId, project.id, user, {
      managerRoleEnabled,
    }),
    countProjectVisibilityArtifacts(db, project.id),
    isLinkSharingAllowedByPolicy(db, user.workspaceId),
    getContainerSlackChannel(db, project.id),
  ])
  const workspaceHd = workspace?.hd ?? user.hd
  const shareDefaults = await listProjectShareDefaults(
    db,
    user.workspaceId,
    project.id,
    workspaceHd,
  )

  return {
    access: 'member',
    project,
    user: toUserInfo(user),
    workspaceId: user.workspaceId,
    workspaceName: workspace?.name ?? workspace?.hd ?? 'Files',
    workspaceHd,
    defaultVisibility: defaultVisibilityFor(isOrgWorkspace(user), 'project'),
    availableVisibilities: availableVisibilitiesFor(
      isOrgWorkspace(user),
      'project',
    ),
    linkSharingAvailable,
    files: rows.map((row) =>
      toFileRowData(row, user.id, {
        externalContext: {
          workspaceHd,
          selfEmail: project.createdByEmail,
        },
      }),
    ),
    shareDefaults,
    slackChannel,
    canEditProject,
    externalPostingEnabled: managerRoleEnabled,
    projectArtifactCount,
    projectActivity: await loadProjectActivity(
      db,
      user,
      project.id,
      'member',
      timeZone,
    ),
    joinedNav: await listJoinedProjectsForDropdown(db, user, 5).catch(() => []),
  }
}

// Read-only project load for an audience member from another workspace. Only
// project-visibility and individually granted artifacts are listed; none of the
// management data (share defaults, edit rights, impact counts) is fetched.
async function loadSharedProject(
  db: ReturnType<typeof createDb>,
  user: SessionUser,
  project: SharedProjectSummary,
  timeZone = 'UTC',
): Promise<SharedLoaderData> {
  // external posting フラグは workspace / rows と独立なので同じ Promise.all で引く。
  const [workspace, rows, externalPostingEnabled, slackChannel] =
    await Promise.all([
      db
        .selectFrom('workspaces')
        .select(['name', 'hd'])
        .where('id', '=', user.workspaceId)
        .executeTakeFirst(),
      projectFileRowsQuery(db, project.id)
        .where((eb) => visibleSharedProjectShareableToViewer(eb, user))
        .orderBy('shareables.updated_at', 'desc')
        .execute(),
      isExternalPostingEnabledForWorkspace(db, project.workspaceId),
      getContainerSlackChannel(db, project.id),
    ])

  const role = externalPostingEnabled
    ? await getProjectShareRoleForEmail(db, project.id, user.email)
    : null
  const canPost = role === 'contributor' || role === 'manager'
  const canManage = role === 'manager'
  const defaults = canPost
    ? await listProjectShareDefaults(
        db,
        project.workspaceId,
        project.id,
        project.sourceWorkspaceHd,
      )
    : []
  // 投稿者自身は「共有先」に数えない (関係者リストには自分も含まれるため除く)。
  const viewerEmail = normalizeGrantEmail(user.email)
  const audienceOthers = defaults.filter((d) => d.email !== viewerEmail)
  const audienceCount = audienceOthers.length
  const externalAudienceCount = audienceOthers.filter(
    (d) => d.isExternal,
  ).length
  const projectArtifactCount = canManage
    ? await countProjectVisibilityArtifacts(db, project.id)
    : 0

  return {
    access: 'shared',
    project,
    user: toUserInfo(user),
    workspaceId: user.workspaceId,
    workspaceName: workspace?.name ?? workspace?.hd ?? 'Files',
    canPost,
    canManage,
    projectWorkspaceHd: project.sourceWorkspaceHd,
    audienceCount,
    externalAudienceCount,
    shareDefaults: canManage ? defaults : [],
    slackChannel: slackChannel
      ? { requiresReauthorization: slackChannel.requiresReauthorization }
      : null,
    projectArtifactCount,
    files: rows.map((row) =>
      toFileRowData(row, user.id, {
        externalContext: {
          workspaceHd: project.sourceWorkspaceHd,
          selfEmail: project.createdByEmail,
        },
      }),
    ),
    projectActivity: await loadProjectActivity(
      db,
      user,
      project.id,
      'shared',
      timeZone,
    ),
    joinedNav: await listJoinedProjectsForDropdown(db, user, 5).catch(() => []),
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const projectId = params.id
  if (!projectId) throw new Response('Not found', { status: 404 })

  const form = await request.formData()
  const intent = form.get('intent')
  if (
    intent === 'seen' ||
    intent === 'join-project' ||
    intent === 'leave-project'
  ) {
    const db = createDb()
    if (intent === 'seen') {
      await touchProjectSeen(db, { containerId: projectId, userId: user.id })
      return { intent, ok: true } as const
    }
    const result =
      intent === 'join-project'
        ? await joinProject(db, { containerId: projectId, user })
        : await leaveProject(db, { containerId: projectId, user })
    if (result === 'not-found') throw new Response('Not found', { status: 404 })
    return { intent, result } as const
  }
  if (intent === 'pin' || intent === 'unpin') {
    const db = createDb()
    // ピンは「そのプロジェクトへ投稿できる人」が操作できる (参加モデル導入
    // までの暫定条件)。member は workspace メンバー全員、共有された関係者は
    // contributor / manager のみ。アーカイブ済みは不可。
    const project = await findWorkspaceProject(
      db,
      user.workspaceId,
      projectId,
      user,
    )
    if (project) {
      if (project.archivedAt) throw new Response('Forbidden', { status: 403 })
    } else {
      const shared = await findSharedProjectForViewer(db, projectId, user)
      if (!shared) throw new Response('Not found', { status: 404 })
      // getProjectShareRoleForEmail はアーカイブ済みプロジェクトで null を返す
      const role = await getProjectShareRoleForEmail(db, projectId, user.email)
      if (role !== 'contributor' && role !== 'manager')
        throw new Response('Forbidden', { status: 403 })
    }
    const shareableId = String(form.get('shareableId') ?? '')
    // 読めないファイルはピン操作の対象にもしない (loader と同じ可視性で解決する)
    const target = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', shareableId)
      .where((eb) =>
        project
          ? visibleShareableToViewer(eb, user)
          : visibleSharedProjectShareableToViewer(eb, user),
      )
      .executeTakeFirst()
    if (!target || target.container_id !== projectId)
      throw new Response('Not found', { status: 404 })
    if (intent === 'pin') {
      const result = await pinShareable(db, {
        containerId: projectId,
        shareableId,
        userId: user.id,
      })
      if (result === 'not-added')
        throw new Response('Pin limit reached', { status: 400 })
    } else await unpinShareable(db, { containerId: projectId, shareableId })
    return { intent, ok: true } as const
  }
  if (intent !== 'update-project') {
    throw new Response('Unknown intent', { status: 400 })
  }

  const db = createDb()
  // 編集は自分のワークスペースのプロジェクトに限る。別組織から共有された
  // (閲覧専用の) プロジェクトは findWorkspaceProject が null を返すため 404 になり、
  // 書き込み経路へ進めない。プロジェクトの面の読み取り専用はここで担保する。
  const project = await findWorkspaceProject(
    db,
    user.workspaceId,
    projectId,
    user,
  )
  if (!project) throw new Response('Not found', { status: 404 })
  const managerRoleEnabled = await isExternalPostingEnabledForWorkspace(
    db,
    user.workspaceId,
  )
  const canEditProject = await canEditProjectContainer(
    db,
    user.workspaceId,
    projectId,
    user,
    { managerRoleEnabled },
  )
  if (!canEditProject) {
    return {
      intent,
      errorKey: 'project.errorEditForbidden',
    } as const
  }

  const name = normalizeProjectName(form.get('name'))
  if (!name) {
    return {
      intent: 'update-project',
      errorKey: 'project.errorNameRequired',
    } as const
  }
  const description = normalizeProjectDescription(form.get('description'))
  const baseVisibility = parseProjectBaseVisibility(form.get('base_visibility'))
  const updated = await updateProjectContainer(
    db,
    user.workspaceId,
    projectId,
    {
      name,
      description,
      baseVisibility,
    },
  )
  if (!updated) throw new Response('Not found', { status: 404 })
  return redirect(`/projects/${updated.id}`)
}

export default function ProjectDetail({ loaderData }: Route.ComponentProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useT()
  const seenFetcher = useFetcher()
  const { submit: submitSeen } = seenFetcher
  const projectId = loaderData.project.id
  // useT の t は render ごとに新しくなるため deps に入れると再発火する。
  // toast + query 除去は「query が現れた 1 回」だけ実行する。
  const announceSlackResult = useEffectEvent((status: string) => {
    if (status === 'connected') {
      toast(
        t('project.slack.toast', {
          channel: searchParams.get('channel') ?? '',
        }),
      )
    } else {
      toast.error(t('project.slack.error'))
    }
    setSearchParams(
      (current) => {
        current.delete('slack')
        current.delete('channel')
        return current
      },
      { replace: true },
    )
  })
  const slackStatus = searchParams.get('slack')
  useEffect(() => {
    if (slackStatus === 'connected' || slackStatus === 'error')
      announceSlackResult(slackStatus)
  }, [slackStatus])
  // projectId intentionally retriggers the client-only clear on in-place navigation;
  // doing this in the loader would also clear unread state during prefetch.
  useEffect(() => {
    submitSeen({ intent: 'seen' }, { method: 'post' })
  }, [submitSeen, projectId])
  if (loaderData.access === 'shared') {
    return <SharedProjectDetail loaderData={loaderData} />
  }
  return <MemberProjectDetail loaderData={loaderData} />
}

type DialogKind =
  | 'upload'
  | 'edit'
  | 'shareDefaults'
  | 'archive'
  | 'delete'
  | 'slack'

function MemberProjectDetail({ loaderData }: { loaderData: MemberLoaderData }) {
  const leaveFetcher = useFetcher()
  const [openDialog, setOpenDialog] = useState<DialogKind | null>(null)
  const [editErrorVisible, setEditErrorVisible] = useState(true)
  const submittedEditRef = useRef(false)
  const actionData = useActionData<typeof action>()
  const navigate = useNavigate()
  const navigation = useNavigation()
  const { t, locale } = useT()
  const { project, files } = loaderData
  const shareDefaults = loaderData.shareDefaults
  const externalShareDefaultCount = shareDefaults.filter(
    (entry) => entry.isExternal,
  ).length
  // いま誰がこのプロジェクトを見られるかを文章で示す。組織内では社内全員 (＋社外
  // の関係者)、プライベートでは関係者のみ (関係者ゼロなら自分だけ)。
  const audienceSummary =
    project.baseVisibility === 'workspace'
      ? externalShareDefaultCount > 0
        ? t('project.audience.workspacePlusExternal', {
            count: externalShareDefaultCount,
          })
        : t('project.audience.workspaceAll')
      : shareDefaults.length === 0
        ? t('project.audience.ownerOnly')
        : externalShareDefaultCount > 0
          ? t('project.audience.privateMembers', {
              count: shareDefaults.length,
              external: externalShareDefaultCount,
            })
          : t('project.audience.privateMembersInternal', {
              count: shareDefaults.length,
            })
  const showShareDefaultsAction =
    shareDefaults.length > 0 || loaderData.canEditProject
  const shareDefaultsActionLabel =
    shareDefaults.length > 0
      ? t('projectShareDefaults.actionWithCount', {
          count: shareDefaults.length,
        })
      : t('projectShareDefaults.actionEmpty')
  const title = project.name
  const isTransitioning = useViewTransitionState(`/projects/${project.id}`)
  const fileUpdatedAt = files[0]?.modifiedTime ?? null
  const fileUpdated = useMemo(
    () => (fileUpdatedAt ? formatRelative(fileUpdatedAt, locale) : null),
    [fileUpdatedAt, locale],
  )
  const uploadDestination = useMemo(
    () => ({
      containerId: project.id,
      label: project.name,
      baseVisibility: project.baseVisibility,
      hasSlackChannel: Boolean(loaderData.slackChannel),
      // 既存の保存済み行は # 付きのことがあるため表示前に正規化する。
      slackChannelName:
        loaderData.slackChannel?.channelName.replace(/^#/, '') ?? null,
      slackRequiresReauthorization:
        loaderData.slackChannel?.requiresReauthorization ?? false,
      shareDefaults,
    }),
    [
      project.id,
      project.name,
      project.baseVisibility,
      shareDefaults,
      loaderData.slackChannel,
    ],
  )
  const editErrorKey =
    actionData?.intent === 'update-project' ? actionData.errorKey : null

  useEffect(() => {
    const submittingEdit =
      navigation.state !== 'idle' &&
      navigation.formData?.get('intent') === 'update-project'
    if (submittingEdit) {
      submittedEditRef.current = true
      setEditErrorVisible(true)
      return
    }
    if (!submittedEditRef.current || navigation.state !== 'idle') return
    submittedEditRef.current = false
    if (editErrorKey) return
    setOpenDialog((current) => (current === 'edit' ? null : current))
  }, [editErrorKey, navigation.formData, navigation.state])

  const handleEditOpenChange = (open: boolean) => {
    setOpenDialog(open ? 'edit' : null)
    if (!open) setEditErrorVisible(false)
  }
  return (
    <>
      <Topbar
        workspaceName={loaderData.workspaceName}
        user={loaderData.user}
        joinedProjects={loaderData.joinedNav}
      />
      <main className={listMainClassName}>
        <PageBreadcrumb aria-label={t('project.location')}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">{t('tb.home')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/projects">{t('project.projects')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </PageBreadcrumb>
        <section
          className={projectContextClassName}
          style={{
            viewTransitionName: isTransitioning
              ? `project-${project.id}-surface`
              : 'none',
          }}
        >
          {
            <AppPageHeader>
              <AppPageHeaderMain>
                <AppPageHeaderTitleRow>
                  <Layers
                    className={projectMarkClassName}
                    size={16}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <AppPageHeaderTitle className="max-stack:pr-9">
                      {title}
                    </AppPageHeaderTitle>
                    {project.description ? (
                      <AppPageHeaderDescription>
                        {project.description}
                      </AppPageHeaderDescription>
                    ) : loaderData.canEditProject ? (
                      <AppPageHeaderMeta>
                        <button
                          type="button"
                          className="text-link block cursor-pointer border-0 bg-transparent p-0 text-left text-sm hover:underline"
                          onClick={() => setOpenDialog('edit')}
                        >
                          {t('project.addDescription')}
                        </button>
                      </AppPageHeaderMeta>
                    ) : null}
                  </div>
                </AppPageHeaderTitleRow>
              </AppPageHeaderMain>
              <AppPageHeaderActions>
                <MemberDetailActions
                  bare
                  loaderData={loaderData}
                  leaveFetcher={leaveFetcher}
                  setOpenDialog={setOpenDialog}
                  shareDefaultsActionLabel={shareDefaultsActionLabel}
                  showShareDefaultsAction={showShareDefaultsAction}
                />
              </AppPageHeaderActions>
            </AppPageHeader>
          }
          <MemberSummaryStrip
            baseVisibility={project.baseVisibility}
            audienceSummary={audienceSummary}
            fileCount={files.length}
            fileUpdated={fileUpdated}
            createdAt={project.createdAt}
          />
        </section>
        {loaderData.slackChannel?.requiresReauthorization &&
        !project.archivedAt ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('project.slack.reauthorizationWarning')}</span>
              {loaderData.canEditProject ||
              loaderData.projectActivity.joined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenDialog('slack')}
                >
                  {t('project.slack.reauthorize')}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <ProjectRedesignBody
          projectId={project.id}
          files={files}
          pins={loaderData.projectActivity.pins}
          feed={loaderData.projectActivity.feed}
          ranking={loaderData.projectActivity.ranking}
          now={loaderData.projectActivity.now}
          canPin
          canUpload
          archived={Boolean(project.archivedAt)}
          onUpload={() => setOpenDialog('upload')}
          homeOwnerName={loaderData.user.name ?? loaderData.user.email}
        />
      </main>
      <UploadArtifactDialog
        open={openDialog === 'upload'}
        onOpenChange={(v) => setOpenDialog(v ? 'upload' : null)}
        defaultVisibility={loaderData.defaultVisibility}
        workspaceHd={loaderData.workspaceHd}
        availableVisibilities={loaderData.availableVisibilities}
        linkSharingAvailable={loaderData.linkSharingAvailable}
        user={loaderData.user}
        destination={uploadDestination}
      />
      <EditProjectDialog
        open={openDialog === 'edit'}
        onOpenChange={handleEditOpenChange}
        project={project}
        workspaceName={loaderData.workspaceName}
        errorKey={editErrorVisible ? editErrorKey : null}
      />
      <ProjectAudienceDialog
        open={openDialog === 'shareDefaults'}
        onOpenChange={(v) => setOpenDialog(v ? 'shareDefaults' : null)}
        projectId={project.id}
        canEdit={loaderData.canEditProject}
        externalPostingEnabled={loaderData.externalPostingEnabled}
        viewerEmail={loaderData.user.email}
        workspaceHd={loaderData.workspaceHd}
        defaults={shareDefaults}
        artifactCount={loaderData.projectArtifactCount}
      />
      <ArchiveProjectDialog
        open={openDialog === 'archive'}
        onOpenChange={(v) => setOpenDialog(v ? 'archive' : null)}
        projectId={project.id}
        projectName={project.name}
        onSuccess={() => navigate('/projects')}
      />
      <DeleteProjectDialog
        open={openDialog === 'delete'}
        onOpenChange={(v) => setOpenDialog(v ? 'delete' : null)}
        projectId={project.id}
        projectName={project.name}
        isEmpty={files.length === 0}
        onSuccess={() => navigate('/projects')}
      />
      <ProjectSlackDialog
        open={openDialog === 'slack'}
        onOpenChange={(open) => setOpenDialog(open ? 'slack' : null)}
        projectId={project.id}
      />
      <BottomTabBar />
    </>
  )
}

// 新詳細ではメタ行を「チップ + ファイル N 件 · X更新」の 1 本に畳む。
// 現行はラベル + 値の 3 項目のまま。

export function MemberDetailActions({
  bare = false,
  loaderData,
  leaveFetcher,
  setOpenDialog,
  shareDefaultsActionLabel,
  showShareDefaultsAction,
}: {
  bare?: boolean
  loaderData: MemberLoaderData
  leaveFetcher: ReturnType<typeof useFetcher>
  setOpenDialog: (dialog: DialogKind | null) => void
  shareDefaultsActionLabel: string
  showShareDefaultsAction: boolean
}) {
  const { t } = useT()
  const actions = (
    <>
      <>
        <ProjectParticipantsSummary
          participants={loaderData.projectActivity.participants}
        />
        {!loaderData.projectActivity.joined || !loaderData.canEditProject ? (
          <ProjectMembershipControls
            joined={loaderData.projectActivity.joined}
          />
        ) : null}
      </>
      {showShareDefaultsAction ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpenDialog('shareDefaults')}
        >
          {shareDefaultsActionLabel}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpenDialog('upload')}
      >
        <IconPlus size={14} aria-hidden="true" />
        {t('tb.addFile')}
      </Button>
      {loaderData.canEditProject || loaderData.projectActivity.joined ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              type="button"
              icon={IconDots}
              size="md"
              className="max-stack:absolute max-stack:top-2.5 max-stack:right-2.5"
              aria-label={t('project.menu')}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!loaderData.project.archivedAt ? (
              <DropdownMenuItem onSelect={() => setOpenDialog('slack')}>
                {t('project.slack.title')}
              </DropdownMenuItem>
            ) : null}
            {loaderData.canEditProject ? (
              <DropdownMenuItem onSelect={() => setOpenDialog('edit')}>
                {t('project.edit')}
              </DropdownMenuItem>
            ) : null}
            {loaderData.projectActivity.joined ? (
              <DropdownMenuItem
                onSelect={() =>
                  leaveFetcher.submit(
                    { intent: 'leave-project' },
                    { method: 'post' },
                  )
                }
              >
                {t('project.leave')}
              </DropdownMenuItem>
            ) : null}
            {loaderData.canEditProject ? (
              <DropdownMenuItem onSelect={() => setOpenDialog('archive')}>
                {t('project.archive')}
              </DropdownMenuItem>
            ) : null}
            {loaderData.canEditProject ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setOpenDialog('delete')}
                >
                  {t('project.delete')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  )

  return bare ? (
    actions
  ) : (
    <div className={projectDetailActionsClassName}>{actions}</div>
  )
}

function MemberSummaryStrip({
  baseVisibility,
  audienceSummary,
  fileCount,
  fileUpdated,
  createdAt,
}: {
  baseVisibility: ProjectSummary['baseVisibility']
  audienceSummary: string
  fileCount: number
  fileUpdated: string | null
  createdAt: string
}) {
  const { t, locale } = useT()
  return (
    <div className={projectSummaryStripClassName}>
      <>
        <span className={projectSummaryItemClassName}>
          <ProjectScopeChip
            baseVisibility={baseVisibility}
            className={projectVisibilityClassName}
          />
        </span>
        <span className={projectSummaryItemClassName}>
          {t('project.fileCount', { count: fileCount })}
          {' · '}
          {fileUpdated
            ? t('project.fileUpdated', { time: fileUpdated })
            : t('project.created', {
                time: formatRelative(createdAt, locale),
              })}
        </span>
      </>
    </div>
  )
}

function ProjectFileTable({ files }: { files: FileRowData[] }) {
  const { t } = useT()
  return (
    <div className={fileTableListClassName}>
      <div
        className={cn(fileTableHeadClassName, fileTableColumns)}
        aria-hidden="true"
      >
        <span>{t('table.name')}</span>
        <span>{t('table.visibility')}</span>
        <span>{t('table.modified')}</span>
        <span>{t('table.activity')}</span>
        <span>{t('table.owner')}</span>
        <span />
      </div>
      {files.map((file) => (
        <FileRow key={file.id} data={file} />
      ))}
    </div>
  )
}

function SharedProjectDetail({ loaderData }: { loaderData: SharedLoaderData }) {
  const [openDialog, setOpenDialog] = useState<
    'upload' | 'shareDefaults' | null
  >(null)
  const { t, locale } = useT()
  const { project, files, canPost, canManage, shareDefaults } = loaderData
  const title = project.name
  const shareDefaultsActionLabel =
    shareDefaults.length > 0
      ? t('projectShareDefaults.actionWithCount', {
          count: shareDefaults.length,
        })
      : t('projectShareDefaults.actionEmpty')
  const fileUpdatedAt = files[0]?.modifiedTime ?? null
  const fileUpdated = useMemo(
    () => (fileUpdatedAt ? formatRelative(fileUpdatedAt, locale) : null),
    [fileUpdatedAt, locale],
  )
  const uploadDestination = useMemo(
    () => ({
      containerId: project.id,
      label: project.name,
      baseVisibility: project.baseVisibility,
      externalPosting: {
        audienceCount: loaderData.audienceCount,
        externalCount: loaderData.externalAudienceCount,
        workspaceName: project.sourceWorkspaceName,
      },
    }),
    [
      project.id,
      project.name,
      project.baseVisibility,
      project.sourceWorkspaceName,
      loaderData.audienceCount,
      loaderData.externalAudienceCount,
    ],
  )
  return (
    <>
      <Topbar
        workspaceName={loaderData.workspaceName}
        user={loaderData.user}
        joinedProjects={loaderData.joinedNav}
      />
      <main className={listMainClassName}>
        <PageBreadcrumb aria-label={t('project.location')}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">{t('tb.home')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/projects">{t('project.projects')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </PageBreadcrumb>
        <section className={projectContextClassName}>
          <AppPageHeader>
            <AppPageHeaderMain>
              <AppPageHeaderTitleRow>
                <Layers
                  className={projectMarkClassName}
                  size={16}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <AppPageHeaderTitle>{title}</AppPageHeaderTitle>
                  {project.description ? (
                    <AppPageHeaderDescription>
                      {project.description}
                    </AppPageHeaderDescription>
                  ) : null}
                </div>
              </AppPageHeaderTitleRow>
            </AppPageHeaderMain>
            <AppPageHeaderActions>
              <ProjectParticipantsSummary
                participants={loaderData.projectActivity.participants}
              />
              <ProjectMembershipControls
                joined={loaderData.projectActivity.joined}
              />
              {canManage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenDialog('shareDefaults')}
                >
                  {shareDefaultsActionLabel}
                </Button>
              ) : null}
              {canPost ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenDialog('upload')}
                >
                  <IconPlus size={14} aria-hidden="true" />
                  {t('tb.addFile')}
                </Button>
              ) : null}
              {!canPost && !canManage ? (
                <span className="text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs">
                  {t('project.sharedReadOnly')}
                </span>
              ) : null}
            </AppPageHeaderActions>
          </AppPageHeader>
          <div className={projectSummaryStripClassName}>
            <span className={projectSummaryItemClassName}>
              <strong className={projectSummaryLabelClassName}>
                {t('project.sharedLabel')}
              </strong>
              <span className={projectAudienceSummaryClassName}>
                {project.sourceWorkspaceName}
              </span>
            </span>
            <span className={projectSummaryItemClassName}>
              {t('project.fileCount', { count: files.length })}
              {' · '}
              {fileUpdated
                ? t('project.fileUpdated', { time: fileUpdated })
                : t('project.created', {
                    time: formatRelative(project.createdAt, locale),
                  })}
            </span>
          </div>
        </section>
        {loaderData.slackChannel?.requiresReauthorization ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t('project.slack.reauthorizationWarning')}
            </AlertDescription>
          </Alert>
        ) : null}
        <ProjectRedesignBody
          projectId={project.id}
          files={files}
          pins={loaderData.projectActivity.pins}
          feed={loaderData.projectActivity.feed}
          ranking={loaderData.projectActivity.ranking}
          now={loaderData.projectActivity.now}
          canPin={canPost}
          canUpload={canPost}
          archived={false}
          onUpload={() => setOpenDialog('upload')}
          homeOwnerName={loaderData.user.name ?? loaderData.user.email}
        />
      </main>
      {canPost ? (
        <UploadArtifactDialog
          open={openDialog === 'upload'}
          onOpenChange={(v) => setOpenDialog(v ? 'upload' : null)}
          defaultVisibility="project"
          workspaceHd={loaderData.projectWorkspaceHd}
          availableVisibilities={['project']}
          user={loaderData.user}
          destination={uploadDestination}
        />
      ) : null}
      {canManage ? (
        <ProjectAudienceDialog
          open={openDialog === 'shareDefaults'}
          onOpenChange={(v) => setOpenDialog(v ? 'shareDefaults' : null)}
          projectId={project.id}
          canEdit={true}
          externalPostingEnabled={true}
          viewerEmail={loaderData.user.email}
          workspaceHd={loaderData.projectWorkspaceHd}
          defaults={loaderData.shareDefaults}
          artifactCount={loaderData.projectArtifactCount}
        />
      ) : null}
      <BottomTabBar />
    </>
  )
}

function EditProjectDialog({
  open,
  onOpenChange,
  project,
  workspaceName,
  errorKey,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: ProjectSummary
  workspaceName: string
  errorKey: TKey | null
}) {
  const navigation = useNavigation()
  const { t } = useT()
  const saving = navigation.state !== 'idle'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('project.editTitle')}</DialogTitle>
          <DialogDescription>
            {t('project.editDescription', { workspaceName })}
          </DialogDescription>
        </DialogHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="update-project" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-project-name">
                {t('project.name')}
              </FieldLabel>
              <Input
                id="edit-project-name"
                name="name"
                required
                maxLength={120}
                defaultValue={project.name}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-project-description">
                {t('project.description')}
              </FieldLabel>
              <Textarea
                id="edit-project-description"
                name="description"
                rows={4}
                maxLength={500}
                defaultValue={project.description ?? ''}
              />
            </Field>
            <ProjectScopeField defaultValue={project.baseVisibility} />
            {errorKey ? (
              <Alert variant="destructive">
                <AlertDescription>{t(errorKey)}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('project.cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {t('project.save')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

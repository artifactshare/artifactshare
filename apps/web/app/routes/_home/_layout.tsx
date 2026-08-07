import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import type { ShouldRevalidateFunctionArgs } from 'react-router'
import type { Route } from './+types/_layout'
import { Landing } from './+components/landing'
import { Topbar } from './+components/topbar'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import { UploadArtifactDialog } from './+components/upload-artifact-dialog'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
  type EditableVisibility,
} from '~/lib/shareable-types'
import { toUserInfo, isOrgWorkspace, type UserInfo } from '~/lib/user'
import { userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { isLinkSharingAllowedByPolicy } from '~/services/link-sharing.server'
import { listMainClassName } from '~/components/app/page-shell-styles'
import { hasUploadQuery, uploadReturnTo } from '~/lib/home-upload-query'
import { BottomTabBar } from './+components/bottom-tab-bar'

type HomeLayoutData =
  | { signedIn: false }
  | {
      signedIn: true
      workspaceId: string
      workspaceName: string
      user: UserInfo
      defaultVisibility: EditableVisibility
      workspaceHd: string | null
      availableVisibilities: ReadonlyArray<EditableVisibility>
      linkSharingAvailable: boolean
      selfUploadEnabled: boolean
      joinedProjects: JoinedProjectNav[]
    }

export type JoinedProjectNav =
  import('./+components/primary-nav').JoinedProjectNav

export type HomeLayoutContext = HomeLayoutData & {
  openUploadDialog: () => void
}

export async function loader({
  context,
}: Route.LoaderArgs): Promise<HomeLayoutData> {
  const user = context.get(userContext)
  if (!user) return { signedIn: false }

  const db = createDb()
  const [workspace, linkSharingAvailable, joinedProjects] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select(['id', 'name', 'hd'])
      .where('id', '=', user.workspaceId)
      .executeTakeFirst(),
    isLinkSharingAllowedByPolicy(db, user.workspaceId),
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
  ])

  return {
    signedIn: true,
    joinedProjects,
    workspaceId: user.workspaceId,
    workspaceName: workspace?.name ?? workspace?.hd ?? 'Files',
    user: toUserInfo(user),
    defaultVisibility: defaultVisibilityFor(isOrgWorkspace(user)),
    workspaceHd: user.hd,
    availableVisibilities: availableVisibilitiesFor(
      isOrgWorkspace(user),
      'inbox',
    ),
    linkSharingAvailable,
    selfUploadEnabled: user.selfUploadEnabled === true,
  }
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formAction,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search !== nextUrl.search
  ) {
    const currentParams = new URLSearchParams(currentUrl.search)
    const nextParams = new URLSearchParams(nextUrl.search)
    currentParams.delete('tab')
    nextParams.delete('tab')
    if (currentParams.toString() === nextParams.toString()) return false
  }
  return defaultShouldRevalidate
}

export default function HomeLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [uploadOpen, setUploadOpen] = useState(false)
  const uploadRequested = hasUploadQuery(location.search)

  if (!loaderData.signedIn) {
    return <Landing />
  }

  const context: HomeLayoutContext = {
    ...loaderData,
    openUploadDialog: () => {
      if (loaderData.selfUploadEnabled) setUploadOpen(true)
    },
  }

  return (
    <>
      <Topbar
        workspaceName={loaderData.workspaceName || '—'}
        user={loaderData.user}
        joinedProjects={loaderData.joinedProjects}
      />
      <main className={listMainClassName} tabIndex={-1}>
        <Outlet context={context} />
      </main>
      <BottomTabBar />
      <UploadArtifactDialog
        open={(uploadOpen || uploadRequested) && loaderData.selfUploadEnabled}
        onOpenChange={(open) => {
          setUploadOpen(open)
          if (!open && new URLSearchParams(location.search).has('upload')) {
            void navigate(uploadReturnTo(location), { replace: true })
          }
        }}
        defaultVisibility={loaderData.defaultVisibility}
        workspaceHd={loaderData.workspaceHd}
        availableVisibilities={loaderData.availableVisibilities}
        linkSharingAvailable={loaderData.linkSharingAvailable}
        user={loaderData.user}
      />
    </>
  )
}

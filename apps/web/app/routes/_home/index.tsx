import { useEffect, useRef } from 'react'
import {
  data,
  redirect,
  type ShouldRevalidateFunctionArgs,
  useLocation,
  useOutletContext,
  useRouteLoaderData,
} from 'react-router'
import type { Route } from './+types/index'
import { toFileRowData, type ShareableFileRow } from './+components/file-data'
import type { RecentRow } from '~/lib/recent-row'
import { Landing } from './+components/landing'
import { sectionClassName } from './+components/file-list-styles'
import type { HomeLayoutContext } from './_layout'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { landingMeta } from '~/lib/landing-meta'
import { shouldFocusGalleryFallback } from '~/lib/viewer-return'
import { linkDomainContext, userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { IconPlus } from '@tabler/icons-react'
import {
  listMyArtifactsLimited,
  listUnopenedOwnedArtifactsLimited,
  listRecentArtifactsLimited,
  countRecentArtifacts,
  listRailProjects,
  recentHistoryCardinality,
  type RailProject,
} from '~/services/home.server'
import { HomeRail } from './+components/home-rail'
import {
  AppPageHeader,
  AppPageHeaderActions,
  AppPageHeaderMain,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'
import { AppSectionHeader } from '~/components/app/app-section-header'
import { AppMoreLink } from '~/components/app/app-more-link'
import { recentQuery, recentUrl } from '~/lib/recent-query'
import { getLocale } from '~/lib/i18n.server'
import { t as translate } from '~/lib/i18n'
import { RecentListBody } from './+components/recent-content'
import { focusReturnTargetClassName } from '~/components/app/page-shell-styles'
import { HomeUnopenedFiles } from './+components/home-unopened-files'

import ViewerRoute, {
  meta as viewerMeta,
  ErrorBoundary as ViewerErrorBoundary,
} from '../a.$id/+viewer'
import type { LoaderData as ViewerLoaderData } from '../a.$id/+loader.server'

type LinkViewerData = {
  signedIn: false
  linkViewer: ViewerLoaderData
}

type ViewerLoaderResult =
  | ViewerLoaderData
  | {
      type: 'DataWithResponseInit'
      data: ViewerLoaderData
      init: ResponseInit | null
    }

type LoaderData =
  | { signedIn: false }
  | {
      signedIn: true
      rail?: {
        files: ReturnType<typeof toFileRowData>[]
        projects: RailProject[]
        errors: { files: boolean; projects: boolean }
      }
      unopened?: {
        files: ReturnType<typeof toFileRowData>[]
        hasMore: boolean
        error: boolean
      }
      recent?: {
        rows: RecentRow[]
        relation: 'all' | 'own' | 'project' | 'shared'
        unread: boolean
        total: number
        historyCardinality: number
        error: boolean
        now: string
      }
      total?: number
    }

export function meta(
  { loaderData }: Pick<Route.MetaArgs, 'loaderData'> = {
    loaderData: undefined,
  },
) {
  if (loaderData && 'linkViewer' in loaderData) {
    return viewerMeta({ loaderData: loaderData.linkViewer })
  }
  return landingMeta('en')
}

// The route only serves the current Home data contract.
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
    const a = new URLSearchParams(currentUrl.search)
    const b = new URLSearchParams(nextUrl.search)
    a.delete('tab')
    b.delete('tab')
    if (a.toString() === b.toString()) return false
  }
  return defaultShouldRevalidate
}

export async function loader(
  args: Route.LoaderArgs,
): Promise<LoaderData | LinkViewerData> {
  const { request, context } = args
  const linkDomain = context.get(linkDomainContext)
  if (linkDomain) {
    const { loader: viewerLoader } = await import('../a.$id/+loader.server')
    const viewerResult = (await viewerLoader({
      ...args,
      params: { id: linkDomain.shareableId },
    })) as ViewerLoaderResult
    if (isDataWithResponseInit(viewerResult)) {
      return data(
        { signedIn: false, linkViewer: viewerResult.data },
        viewerResult.init ?? undefined,
      ) as unknown as LinkViewerData
    }
    return {
      signedIn: false,
      linkViewer: viewerResult,
    }
  }
  const user = context.get(userContext)
  if (!user) return { signedIn: false }
  const unavailableTitle = translate(
    getLocale(request, user.locale),
    'recent.unavailableTitle',
  )

  const db = createDb()
  const now = new Date().toISOString()
  const { relation, unread } = recentQuery(new URL(request.url).searchParams)
  const [
    filesResult,
    unopenedResult,
    recentRowsResult,
    projectsResult,
    recentCountResult,
    recentCardinalityResult,
  ] = await Promise.all([
    listMyArtifactsLimited(db, user.id, user.workspaceId).catch(() => null),
    listUnopenedOwnedArtifactsLimited(db, user.id, user.workspaceId).catch(
      () => null,
    ),
    listRecentArtifactsLimited(db, user, 20, { relation, unread }).catch(
      () => null,
    ),
    listRailProjects(db, user).catch(() => null),
    countRecentArtifacts(db, user, { relation, unread }).catch(() => null),
    recentHistoryCardinality(db, user).catch(() => null),
  ])
  const convert = (rows: ShareableFileRow[]) =>
    rows.map((r) =>
      toFileRowData(r, user.id, {
        includeProject: true,
        currentWorkspaceId: user.workspaceId,
        externalContext: { workspaceHd: user.hd, selfEmail: user.email },
      }),
    )
  return {
    signedIn: true,
    rail: {
      files: convert(filesResult ?? []),
      projects: projectsResult ?? [],
      errors: { files: !filesResult, projects: !projectsResult },
    },
    unopened: {
      files: convert(unopenedResult?.rows ?? []),
      hasMore: unopenedResult?.hasMore ?? false,
      error: !unopenedResult,
    },
    recent: {
      rows: (recentRowsResult ?? []).map((r) =>
        r.visible
          ? {
              kind: 'file',
              file: toFileRowData(r, user.id, {
                includeProject: true,
                currentWorkspaceId: user.workspaceId,
                externalContext: {
                  workspaceHd: user.hd,
                  selfEmail: user.email,
                },
              }),
            }
          : {
              kind: 'restricted',
              shareableId: r.id,
              title: r.viewed_title ?? unavailableTitle,
              ownerName: r.viewed_owner_name,
              ownerImage: null,
              lastViewedAt: r.modified_at,
            },
      ),
      relation,
      unread,
      total: recentCountResult ?? 0,
      historyCardinality: recentCardinalityResult ?? 0,
      error:
        !recentRowsResult ||
        recentCountResult == null ||
        recentCardinalityResult == null,
      now,
    },
  }
}

function isDataWithResponseInit(
  result: ViewerLoaderResult,
): result is Exclude<ViewerLoaderResult, ViewerLoaderData> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    result.type === 'DataWithResponseInit'
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const rootData = useRouteLoaderData<{ linkDomain: boolean }>('root')
  if (rootData?.linkDomain) return <ViewerErrorBoundary error={error} />
  throw error
}

export default function HomeRoute({ loaderData }: Route.ComponentProps) {
  if ('linkViewer' in loaderData) {
    return <ViewerRoute loaderData={loaderData.linkViewer} />
  }
  return <Home loaderData={loaderData} />
}

function Home({ loaderData }: { loaderData: LoaderData }) {
  const mainRef = useRef<HTMLDivElement | null>(null)
  const location = useLocation()
  const locationState = location.state
  const layoutData = useOutletContext<HomeLayoutContext>()
  const { t } = useT()

  useEffect(() => {
    if (!shouldFocusGalleryFallback(locationState)) return
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      mainRef.current?.focus({ preventScroll: true })
    })
  }, [locationState])

  if (!layoutData.signedIn) {
    return <Landing />
  }

  const recent = loaderData.signedIn ? loaderData.recent : undefined
  const unopened = loaderData.signedIn ? loaderData.unopened : undefined
  const showsUnopened =
    unopened != null && (unopened.error || unopened.files.length > 0)

  if (loaderData.signedIn && loaderData.rail && recent) {
    const { openUploadDialog, selfUploadEnabled } = layoutData
    return (
      <div ref={mainRef} className={focusReturnTargetClassName} tabIndex={-1}>
        <AppPageHeader>
          <AppPageHeaderMain>
            <AppPageHeaderTitleRow>
              <AppPageHeaderTitle>{t('tb.home')}</AppPageHeaderTitle>
            </AppPageHeaderTitleRow>
          </AppPageHeaderMain>
          {selfUploadEnabled ? (
            <AppPageHeaderActions>
              <Button size="sm" onClick={openUploadDialog}>
                <IconPlus size={14} aria-hidden="true" />
                {t('tb.addFile')}
              </Button>
            </AppPageHeaderActions>
          ) : null}
        </AppPageHeader>
        <p className="text-muted-foreground mb-6 text-sm">
          {t(showsUnopened ? 'home.unopenedPurpose' : 'home.recentPurpose')}
        </p>
        <div className="max-stack:grid-cols-1 mx-auto grid grid-cols-[minmax(0,1fr)_300px] gap-8">
          <div>
            {unopened ? (
              <HomeUnopenedFiles
                files={unopened.files}
                hasMore={unopened.hasMore}
                error={unopened.error}
                now={recent.now}
              />
            ) : null}
            <section className={sectionClassName}>
              <AppSectionHeader
                titleId="home-recent-heading"
                title={t('home.recentViewed')}
                meta={t('recent.order')}
                actions={
                  <AppMoreLink
                    className="text-xs"
                    to={recentUrl({
                      relation: recent.relation,
                      unread: recent.unread,
                    })}
                  >
                    {t('home.seeAll')}
                  </AppMoreLink>
                }
              />
              <RecentListBody
                files={recent.rows}
                relation={recent.relation}
                unread={recent.unread}
                total={recent.total}
                historyCardinality={recent.historyCardinality}
                now={recent.now}
                unreadEnabled
                homeCompact
                singleLineTitle
                dateRail
                olderHistoryLink
                error={recent.error}
              />
            </section>
          </div>
          <HomeRail {...loaderData.rail} variant="without-recent" />
        </div>
      </div>
    )
  }

  return null
}

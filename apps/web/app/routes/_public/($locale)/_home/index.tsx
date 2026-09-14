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
import {
  toFileRowData,
  type ShareableFileRow,
} from '../../../_home/+components/file-data'
import type { RecentRow } from '~/lib/recent-row'
import { Landing } from '../../../_home/+components/landing'
import { sectionClassName } from '../../../_home/+components/file-list-styles'
import type { HomeLayoutContext } from '../../../_home/_layout'
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
import { HomeRail } from '../../../_home/+components/home-rail'
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
import { RecentListBody } from '../../../_home/+components/recent-content'
import { focusReturnTargetClassName } from '~/components/app/page-shell-styles'
import { HomeUnopenedFiles } from '../../../_home/+components/home-unopened-files'

import ViewerRoute, {
  meta as viewerMeta,
  ErrorBoundary as ViewerErrorBoundary,
} from '../../../a.$id/+viewer'
import type { LoaderData as ViewerLoaderData } from '../../../a.$id/+loader.server'
import type { ScreenSpec } from '~/types/screen'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { Locale } from '~/i18n/messages'

export const screen = {
  id: 'home',
  route: {
    en: '/',
    ja: '/ja',
  },
  auth: 'free-owner',
  loop: 'react',
  metric: '動きへの再訪を高める',
  role: '反応とワークスペースの動きを確認する',
  primaryAction: '動きを確認する',
  captureConcurrency: 1,
  ready: {
    selector: '[data-recent-hydrated]',
    description: 'home recent calendar resolved',
    timeoutMs: 30_000,
  },
  states: [
    {
      id: 'default',
      description: '新ホーム (ファイルあり)',
      setup: {
        scenario: 'home/content-rich',
      },
    },
    {
      id: 'access-request-detail',
      description: 'Homeヘッダーから閲覧リクエストの承認詳細を開いた状態',
      setup: {
        auth: 'team-owner',
        scenario: 'viewer/access-requests',
        interactions: [
          {
            action: 'click',
            selector: '[data-avatar-menu-trigger]',
          },
          {
            action: 'click',
            selector: '[data-access-requests-menu-item]',
          },
          {
            action: 'click',
            selector: '[data-access-request-id="dev-screen-access-request"]',
          },
        ],
      },
    },
    {
      id: 'unopened-file',
      description: '自分が作成し、まだ開いていないファイルがある状態',
      setup: {
        scenario: 'home/unopened-file',
      },
    },
    {
      id: 'empty',
      description: 'ファイルが空の状態',
      setup: {
        scenario: 'home/empty',
      },
    },
    {
      id: 'first-file',
      description: '最初の成果物だけがある状態',
      setup: {
        scenario: 'home/first-file',
      },
    },
    {
      id: 'upload-dialog',
      description: 'Web アップロードダイアログを開いた状態',
      setup: {
        scenario: 'home/empty',
        interactions: [
          {
            action: 'click',
            selector:
              'button:has-text("Add a file"), button:has-text("ファイルを追加")',
          },
          {
            action: 'hover',
            selector: '[data-slot="dialog-title"]',
          },
        ],
      },
    },
    {
      id: 'upload-progress',
      description: 'Web アップロードの処理中状態',
      setup: {
        scenario: 'home/empty',
        interactions: [
          {
            action: 'click',
            selector:
              'button:has-text("Add a file"), button:has-text("ファイルを追加")',
          },
          {
            action: 'setInputFiles',
            selector: 'input[type="file"]:not([multiple])',
            name: 'walkthrough.html',
            mimeType: 'text/html',
            content: '<!doctype html><h1>Upload walkthrough</h1>',
            captureImmediately: true,
            readySelector: '[data-sonner-toast][data-type="loading"]',
          },
        ],
      },
    },
    {
      id: 'upload-error',
      description: '対応していない形式を選んだアップロード失敗状態',
      setup: {
        scenario: 'home/empty',
        interactions: [
          {
            action: 'click',
            selector:
              'button:has-text("Add a file"), button:has-text("ファイルを追加")',
          },
          {
            action: 'setInputFiles',
            selector: 'input[type="file"]:not([multiple])',
            name: 'unsupported.txt',
            mimeType: 'text/plain',
            content: 'unsupported',
          },
        ],
      },
    },
    {
      id: 'updates-menu-open',
      description: '新着の更新情報をアバターメニューで確認した状態',
      setup: {
        scenario: 'home/updates-menu-open',
        interactions: [
          {
            action: 'click',
            selector: '[aria-label$="New updates are available"]',
          },
        ],
      },
    },
    {
      id: 'landing-default',
      description: '通常のマーケティング LP (MCP タブ・リビール完了後)',
      setup: {
        auth: 'anonymous',
        ready: {
          selector: 'main h1',
          description: 'landing heading rendered',
        },
      },
    },
    {
      id: 'landing-cli-tab',
      description: 'ヒーローの接続手段を CLI タブへ切り替えた状態',
      setup: {
        auth: 'anonymous',
        ready: {
          selector: 'main h1',
          description: 'landing heading rendered',
        },
        interactions: [
          {
            action: 'click',
            selector: '[role="tab"]:has-text("CLI")',
          },
        ],
      },
    },
    {
      id: 'landing-focused-sign-in',
      description: '行き先つきリダイレクト (?next=) が出す集中サインイン表示',
      setup: {
        auth: 'anonymous',
        ready: {
          selector: 'main h1',
          description: 'landing heading rendered',
        },
        query: '?next=/projects/example',
      },
    },
    {
      id: 'landing-invite',
      description: '招待リンク (?next=/a/…) が出す招待向けサインイン表示',
      setup: {
        auth: 'anonymous',
        ready: {
          selector: 'main h1',
          description: 'landing heading rendered',
        },
        query: '?next=/a/example',
      },
    },
  ],
} satisfies ScreenSpec

type LinkViewerData = {
  signedIn: false
  locale: Locale
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
  | { signedIn: false; locale: Locale }
  | {
      signedIn: true
      locale: Locale
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
  return landingMeta(loaderData?.locale ?? 'en')
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
  const { request, context, params } = args
  const locale = resolvePublicRouteLocale(params.locale)
  const linkDomain = context.get(linkDomainContext)
  if (linkDomain) {
    const { loader: viewerLoader } =
      await import('../../../a.$id/+loader.server')
    const viewerResult = (await viewerLoader({
      ...args,
      params: { id: linkDomain.shareableId },
    })) as ViewerLoaderResult
    if (isDataWithResponseInit(viewerResult)) {
      return data(
        { signedIn: false, locale, linkViewer: viewerResult.data },
        viewerResult.init ?? undefined,
      ) as unknown as LinkViewerData
    }
    return {
      signedIn: false,
      locale,
      linkViewer: viewerResult,
    }
  }
  const user = context.get(userContext)
  if (!user) return { signedIn: false, locale }
  const unavailableTitle = translate(
    params.locale ? locale : getLocale(request, user.locale),
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
    locale,
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

import { useMemo, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import type { Route } from './+types/projects.$id.activity'
import { IconStack2 as Layers } from '@tabler/icons-react'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { Topbar } from '../_home/+components/topbar'
import { BottomTabBar } from '../_home/+components/bottom-tab-bar'
import { FeedList } from '../_home/+components/feed-list'
import {
  listMainClassName,
  focusReturnTargetClassName,
} from '~/components/app/page-shell-styles'
import {
  loadProjectSubpageContext,
  type ProjectSubpageContext,
} from './+lib/project-subpage.server'
import {
  listFeedEvents,
  type FeedCursor,
  type FeedEventRow,
} from '~/services/events.server'
import { mergeFeedRows } from '~/lib/feed-merge'
import { getViewerTimezone } from '~/lib/viewer-timezone.server'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import { AppEmptyState } from '~/components/app/app-empty-state'
import { AppMoreLink } from '~/components/app/app-more-link'
import {
  AppPageHeader,
  AppPageHeaderMain,
  AppPageHeaderMeta,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'

type LoaderData = {
  ctx: ProjectSubpageContext
  rows: FeedEventRow[]
  nextCursor: FeedCursor | null
  hasMore: boolean
  timeZone: string
  now: string
  error?: boolean
}

export async function loader({
  params,
  request,
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)
  const projectId = params.id
  if (!projectId) throw new Response('Not found', { status: 404 })
  const db = createDb()
  const ctx = await loadProjectSubpageContext(db, user, projectId)
  let cursor: FeedCursor | undefined
  const raw = new URL(request.url).searchParams.get('cursor')
  if (raw) {
    try {
      cursor = JSON.parse(raw) as FeedCursor
    } catch {
      cursor = undefined
    }
  }
  try {
    const timeZone = getViewerTimezone(request)
    const now = new Date().toISOString()
    const result = await listFeedEvents(db, {
      user,
      slice: 'project',
      containerId: ctx.projectId,
      cursor,
      timeZone,
      targetRows: 20,
      maxRawEvents: 1000,
    })
    return { ctx, ...result, timeZone, now }
  } catch (error) {
    console.error('project.activity-load-failed', error)
    return {
      ctx,
      rows: [],
      nextCursor: cursor ?? null,
      hasMore: Boolean(cursor),
      timeZone: getViewerTimezone(request),
      now: new Date().toISOString(),
      error: true,
    }
  }
}

const EMPTY_PAGES: LoaderData[] = []

export default function ProjectActivity({ loaderData }: Route.ComponentProps) {
  const { t } = useT()
  const fetcher = useFetcher<LoaderData>()
  const busy = fetcher.state !== 'idle'
  const [acc, setAcc] = useState<{ base: LoaderData; pages: LoaderData[] }>({
    base: loaderData,
    pages: [],
  })
  if (acc.base !== loaderData) setAcc({ base: loaderData, pages: [] })
  if (
    fetcher.state === 'idle' &&
    fetcher.data &&
    acc.base === loaderData &&
    !acc.pages.includes(fetcher.data)
  ) {
    setAcc((current) => ({
      ...current,
      pages: [...current.pages, fetcher.data!],
    }))
  }
  const pages = acc.base === loaderData ? acc.pages : EMPTY_PAGES
  const rows = useMemo(
    () => mergeFeedRows([loaderData, ...pages].map((page) => page.rows)),
    [loaderData, pages],
  )
  const lastPage = pages.at(-1)
  const hasMore = lastPage ? lastPage.hasMore : loaderData.hasMore
  const cursor = hasMore ? (lastPage ?? loaderData).nextCursor : null
  const error = loaderData.error || lastPage?.error
  const { ctx } = loaderData
  const loadMore = () => {
    if (busy || !cursor) return
    fetcher.load(
      `/projects/${ctx.projectId}/activity?cursor=${encodeURIComponent(
        JSON.stringify(cursor),
      )}`,
    )
  }
  return (
    <>
      <Topbar
        workspaceName={ctx.workspaceName}
        user={ctx.user}
        joinedProjects={ctx.joinedNav}
      />
      <main
        className={cn(listMainClassName, focusReturnTargetClassName)}
        tabIndex={-1}
        aria-busy={busy}
      >
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
              <BreadcrumbLink asChild>
                <Link to={`/projects/${ctx.projectId}`}>{ctx.projectName}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t('project.activityHistory')}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </PageBreadcrumb>
        <AppPageHeader>
          <AppPageHeaderMain>
            <AppPageHeaderTitleRow>
              <Layers size={16} className="text-link" aria-hidden="true" />
              <AppPageHeaderTitle>
                {t('project.activityHistory')}
              </AppPageHeaderTitle>
            </AppPageHeaderTitleRow>
            <AppPageHeaderMeta>{t('project.newestOrder')}</AppPageHeaderMeta>
          </AppPageHeaderMain>
        </AppPageHeader>
        {error ? (
          <p className="rounded border p-4 text-sm">
            {t('home.feedError')}{' '}
            <Link
              className="underline"
              to={`/projects/${ctx.projectId}/activity`}
            >
              {t('home.reload')}
            </Link>
          </p>
        ) : rows.length === 0 ? (
          <AppEmptyState
            icon={<Layers size={16} />}
            title={t('project.noActivity')}
          />
        ) : (
          <FeedList
            rows={rows}
            timeZone={loaderData.timeZone}
            now={loaderData.now}
          />
        )}
        {cursor ? (
          <AppMoreLink
            as="button"
            type="button"
            className="mt-5 cursor-pointer border-0 bg-transparent p-0"
            disabled={busy}
            onClick={loadMore}
          >
            {busy ? t('home.loadingActivity') : t('home.seeOlderActivity')}
          </AppMoreLink>
        ) : null}
      </main>
      <BottomTabBar />
    </>
  )
}

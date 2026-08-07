import { useEffect, useRef } from 'react'
import {
  redirect,
  useLocation,
  useNavigation,
  useOutletContext,
} from 'react-router'
import type { Route } from './+types/recent'
import { toFileRowData, type FileRowData } from '../+components/file-data'
import { RecentContent } from '../+components/recent-content'
import type { RecentRow } from '~/lib/recent-row'
import type { HomeLayoutContext } from '../_layout'
import { shouldFocusGalleryFallback } from '~/lib/viewer-return'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  listRecentArtifactsPage,
  countRecentArtifacts,
  recentHistoryCardinality,
} from '~/services/home.server'
import { recentQuery, recentUrl } from '~/lib/recent-query'
import { getLocale } from '~/lib/i18n.server'
import { t } from '~/lib/i18n'

type LoaderData = {
  recentFiles: RecentRow[]
  total: number
  page: number
  relation: 'all' | 'own' | 'project' | 'shared'
  unread: boolean
  hasHiddenHistory: boolean
  historyCardinality: number
  now: string
}

export async function loader({
  request,
  url,
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)
  const locale = getLocale(request, user.locale)
  const unavailableTitle = t(locale, 'recent.unavailableTitle')
  const now = new Date().toISOString()
  // `url` has the framework's own bits removed. `request.url` keeps the `.data`
  // suffix that client navigations carry, and never equals the canonical path.
  const {
    relation,
    unread,
    page: requestedPage,
  } = recentQuery(url.searchParams)
  const canonicalUrl = recentUrl({
    page: requestedPage,
    relation,
    unread,
  })
  if (`${url.pathname}${url.search}` !== canonicalUrl) {
    throw redirect(canonicalUrl)
  }
  const db = createDb()
  {
    const filters = { relation, unread }
    const [total, historyCardinality] = await Promise.all([
      countRecentArtifacts(db, user, filters),
      recentHistoryCardinality(db, user),
    ])
    const lastPage = Math.max(1, Math.ceil(total / 20))
    if (requestedPage > lastPage) {
      throw redirect(
        recentUrl({
          page: lastPage,
          relation,
          unread,
        }),
      )
    }
    const rows = await listRecentArtifactsPage(db, user, requestedPage, filters)
    return {
      recentFiles: rows.map((r: (typeof rows)[number]) =>
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
      total,
      page: requestedPage,
      relation,
      unread,
      hasHiddenHistory: false,
      historyCardinality,
      now,
    }
  }
}

const EMPTY: FileRowData[] = []

export default function Recent({ loaderData }: Route.ComponentProps) {
  const mainRef = useRef<HTMLDivElement | null>(null)
  const location = useLocation()
  const navigation = useNavigation()
  const locationState = location.state
  const layoutData = useOutletContext<HomeLayoutContext>()
  useEffect(() => {
    if (!shouldFocusGalleryFallback(locationState)) return
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return
      mainRef.current?.focus({ preventScroll: true })
    })
  }, [locationState])

  if (!layoutData.signedIn) {
    return null
  }

  return (
    <RecentContent
      mainRef={mainRef}
      layoutData={layoutData}
      files={loaderData.recentFiles ?? EMPTY}
      relation={loaderData.relation}
      unread={loaderData.unread}
      total={loaderData.total}
      page={loaderData.page}
      isBusy={navigation.state !== 'idle'}
      hasHiddenHistory={loaderData.hasHiddenHistory}
      historyCardinality={loaderData.historyCardinality}
      now={loaderData.now}
      unreadEnabled
    />
  )
}

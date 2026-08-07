import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
  useOutletContext,
} from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import Home from './index'
import { RecentListBody } from './+components/recent-content'
import { recentQuery } from '~/lib/recent-query'
import '~/app.css'

vi.mock('~/services/db.server', () => ({ createDb: vi.fn() }))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useOutletContext: vi.fn(),
  }
})

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, number>) =>
      ({
        'home.recentPurpose': 'Recent files',
        'home.recentViewed': 'Recently viewed',
        'home.seeAll': 'See all',
        'home.continueOlder': `Continue to ${vars?.n ?? 0} older files`,
        'recent.order': 'Order',
        'recent.filters': 'Recent filters',
        'recent.unread': 'Unread',
        'recent.relation.all': 'All',
        'recent.relation.own': 'Own',
        'recent.relation.project': 'Project',
        'recent.relation.shared': 'Shared',
      })[key] ?? key,
    tPlural: (key: string, count: number) => `${key}:${count}`,
  }),
}))

vi.mock('./+components/home-rail', () => ({ HomeRail: () => null }))
vi.mock('./+components/recent-activity', () => ({ RecentActivity: () => null }))
vi.mock('./+components/file-row-dialogs', () => ({
  FileRowDialogs: () => null,
  useFileRowActions: () => ({ active: null, open: vi.fn(), close: vi.fn() }),
}))
vi.mock('./+hooks/use-bulk-actions', () => ({ useBulkActions: () => ({}) }))
vi.mock('./+components/home-tabs', () => ({ HomeTabs: () => null }))
vi.mock('~/components/app/page-breadcrumb', () => ({
  PageBreadcrumb: ({ children, ...props }: { children: ReactNode }) =>
    createElement('nav', props, children),
}))

const file = {
  id: 'cross-flow-file',
  fileName: 'cross-flow.html',
  derivedTitle: 'Cross-flow file',
  titleOverride: null,
  renderType: 'html' as const,
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: false,
  visibility: 'workspace' as const,
  viewCount: 1,
  commentCount: 1,
  modifiedTime: '2026-07-31T11:00:00.000Z',
  unreadVersionCount: 1,
  unreadCommentCount: 1,
  unreadCommentRemainingCount: 0,
  latestUnreadComment: null,
  projectName: 'Cross-workspace project',
}

const layoutContext = {
  signedIn: true,
  user: { id: 'owner', email: 'owner@example.com', name: 'Owner', image: null },
  openUploadDialog: vi.fn(),
  selfUploadEnabled: true,
}

const cases = [
  { relation: 'all', expected: '?unread=1' },
  { relation: 'own', expected: '?relation=own&unread=1' },
  { relation: 'project', expected: '?relation=project&unread=1' },
  { relation: 'shared', expected: '?relation=shared&unread=1' },
] as const

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

function HomeRoute() {
  const { search } = useLocation()
  const { relation, unread } = recentQuery(new URLSearchParams(search))
  return createElement(Home, {
    loaderData: {
      signedIn: true,
      view: { recent: [], projectBlocks: [] },
      rail: {
        files: [],
        projects: [],
        errors: { files: false, projects: false },
      },
      recent: {
        rows: [file],
        relation,
        unread,
        total: 1,
        historyCardinality: 1,
        error: false,
        now: '2026-07-31T12:00:00.000Z',
      },
    },
  } as never)
}

function RecentRoute() {
  const { search } = useLocation()
  const { relation, unread } = recentQuery(new URLSearchParams(search))
  return (
    <RecentListBody
      files={[file]}
      relation={relation}
      unread={unread}
      unreadEnabled
      now="2026-07-31T12:00:00.000Z"
    />
  )
}

function HomeWithOlderHistoryRoute() {
  return createElement(Home, {
    loaderData: {
      signedIn: true,
      view: { recent: [], projectBlocks: [] },
      rail: {
        files: [],
        projects: [],
        errors: { files: false, projects: false },
      },
      recent: {
        rows: [file],
        relation: 'project',
        unread: true,
        total: 25,
        historyCardinality: 25,
        error: false,
        now: '2026-07-31T12:00:00.000Z',
      },
    },
  } as never)
}

describe('home recent flow', () => {
  test.each(cases)(
    '$relation + unread follows Home see-all to Recent',
    async ({ relation, expected }) => {
      vi.mocked(useOutletContext).mockReturnValue(layoutContext)
      await page.viewport(1440, 900)
      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const router = createMemoryRouter(
        [
          { path: '/', element: <HomeRoute /> },
          { path: '/recent', element: <RecentRoute /> },
        ],
        { initialEntries: [`/?relation=${relation}&unread=1`] },
      )
      root.render(<RouterProvider router={router} />)
      await vi.waitFor(() => expect(host.textContent).toContain('See all'))

      const link = Array.from(host.querySelectorAll('a')).find(
        (a) => a.textContent === 'See all',
      )
      expect(link).not.toBeUndefined()
      await link!.click()
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe('/recent'),
      )
      expect(router.state.location.search).toBe(expected)
      expect(
        host.querySelector(
          '[aria-label="Recent filters"] [aria-current="page"]',
        )?.textContent,
      ).toBe(relation[0].toUpperCase() + relation.slice(1))
      expect(
        host.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
      ).toBe('true')
    },
  )

  test('project + unread preserves the query through back and forward', async () => {
    vi.mocked(useOutletContext).mockReturnValue(layoutContext)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        { path: '/', element: <HomeRoute /> },
        { path: '/recent', element: <RecentRoute /> },
      ],
      { initialEntries: ['/?relation=project&unread=1'] },
    )
    root.render(<RouterProvider router={router} />)
    await vi.waitFor(() => expect(host.textContent).toContain('See all'))
    const link = Array.from(host.querySelectorAll('a')).find(
      (a) => a.textContent === 'See all',
    )
    expect(link).not.toBeUndefined()
    await link!.click()
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/recent'),
    )
    router.navigate(-1)
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(router.state.location.search).toBe('?relation=project&unread=1')
    router.navigate(1)
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/recent'),
    )
    expect(router.state.location.search).toBe('?relation=project&unread=1')
  })

  test('footer continues filtered Home history on Recent page two', async () => {
    vi.mocked(useOutletContext).mockReturnValue(layoutContext)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        { path: '/', element: <HomeWithOlderHistoryRoute /> },
        { path: '/recent', element: <RecentRoute /> },
      ],
      { initialEntries: ['/?relation=project&unread=1'] },
    )
    root.render(<RouterProvider router={router} />)
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Continue to 5 older files'),
    )
    const link = Array.from(host.querySelectorAll('a')).find((candidate) =>
      candidate.textContent?.includes('Continue to 5 older files'),
    )
    expect(link).not.toBeUndefined()
    await link!.click()
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/recent'),
    )
    expect(router.state.location.search).toBe(
      '?page=2&relation=project&unread=1',
    )
  })
})

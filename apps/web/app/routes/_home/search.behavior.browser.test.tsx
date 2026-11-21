import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryRouter,
  createBrowserRouter,
  Link,
  useLocation,
  Outlet,
  ScrollRestoration,
  RouterProvider,
  useLoaderData,
} from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import {
  SearchResults,
  type SearchResponse,
} from '~/components/app/search-results'
import { Topbar } from '~/routes/_home/+components/topbar'
import { TooltipProvider } from '~/components/ui/tooltip'
import { SearchPalette } from '~/components/app/search-palette'
import { parseSearchQuery } from '~/lib/search-query'
import { continueReturnedSearch } from '~/lib/search-view-state'
import { viewerReturnTo, viewerReturnState } from '~/lib/viewer-return'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

const result: Exclude<SearchResponse, { error: unknown }> = {
  items: [
    {
      id: 'file-a',
      title: 'Alpha report',
      ownerId: 'owner',
      ownerName: 'Alex',
      project: null,
      visibility: 'workspace',
      updatedAt: '2026-09-15T00:00:00Z',
      lastViewedAt: '2026-09-16T00:00:00Z',
      path: 'index.html',
      excerpt: '<img src=x onerror=alert(1)> alpha',
      artifactKind: 'html_page',
      hasBody: true,
      matchedKeywords: ['alpha'],
      tier: 'all',
      rank: 1,
      groupSize: 2,
      groupSizeRelation: 'eq',
      receipt: 'receipt-a',
    },
  ],
  total: { value: 1, relation: 'eq' },
  tier: 'all',
  relaxations: [],
  nextCursor: null,
  searchLogId: 'log-a',
  facets: {
    owners: [{ id: 'owner', name: 'Alex', count: 1 }],
    projects: [{ id: 'home', name: '', count: 1 }],
  },
}
let root: Root | undefined
let historyRouter: ReturnType<typeof createBrowserRouter> | undefined
const originalUrl = window.location.href
const originalState = window.history.state
afterEach(() => {
  root?.unmount()
  historyRouter?.dispose()
  historyRouter = undefined
  window.history.replaceState(originalState, '', originalUrl)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('authorized metadata renders with inert excerpts and same-title expansion without delaying opens', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/opens'))
        return new Promise<Response>(() => {})
      return Response.json({
        items: [
          {
            id: 'file-b',
            title: 'Alpha report 2',
            updatedAt: '2026-09-17T00:00:00Z',
            lastViewedAt: null,
            receipt: 'receipt-b',
          },
        ],
        total: { value: 2, relation: 'eq' },
        searchLogId: 'log-a',
        nextCursor: null,
      })
    }),
  )
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults result={result} actor="viewer" />
          </>
        ),
      },
      { path: '/a/:id', element: <h1>Opened file</h1> },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await expect
    .element(page.getByRole('link', { name: 'Alpha report', exact: true }))
    .toBeVisible()
  expect(document.querySelector('img')).toBeNull()
  expect(
    [...document.querySelectorAll('mark')]
      .map((node) => node.textContent)
      .join(''),
  ).toBe('Alphaalpha')
  expect(document.body.textContent).toContain('Alex')
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await expect
    .element(page.getByRole('link', { name: 'Alpha report 2' }))
    .toBeVisible()
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await expect
    .element(page.getByRole('link', { name: 'Alpha report 2' }))
    .not.toBeInTheDocument()
  await page.getByRole('link', { name: 'Alpha report', exact: true }).click()
  await expect
    .element(page.getByRole('heading', { name: 'Opened file' }))
    .toBeVisible()
  expect(fetch).toHaveBeenCalledWith(
    '/api/search-logs/log-a/opens',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ receipt: 'receipt-a' }),
      keepalive: true,
    }),
  )
})

test.each([667, 480])(
  'mobile sheet keeps live filters open, updates count, clears and restores focus at height %i',
  async (height) => {
    await page.viewport(599, height)
    let finishOwner: ((value: SearchResponse) => void) | undefined
    const router = createMemoryRouter(
      [
        {
          path: '/search',
          loader: ({ request }) =>
            new URL(request.url).searchParams.has('owner')
              ? new Promise<SearchResponse>((resolve) => {
                  finishOwner = resolve
                })
              : result,
          Component: () => {
            const data = useLoaderData<SearchResponse>()
            return (
              <>
                <TooltipProvider>
                  <Topbar
                    workspaceName="Example workspace"
                    user={{
                      id: 'viewer',
                      name: 'Viewer',
                      email: 'viewer@example.com',
                      image: null,
                      initial: 'V',
                    }}
                  />
                </TooltipProvider>
                <SearchResults result={data} actor="viewer" />
              </>
            )
          },
        },
      ],
      {
        initialEntries: [
          { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
        ],
      },
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
    await expect.element(cancel).toBeVisible()
    await waitForBrowserLayout()
    const cancelBounds = cancel.element().getBoundingClientRect()
    expect(cancelBounds.right).toBeLessThanOrEqual(window.innerWidth)
    expect(
      cancel
        .element()
        .contains(
          document.elementFromPoint(
            cancelBounds.left + cancelBounds.width / 2,
            cancelBounds.top + cancelBounds.height / 2,
          ),
        ),
    ).toBe(true)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      window.innerWidth,
    )
    await page.getByRole('button', { name: 'Filters', exact: true }).click()
    const sheet = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )
    if (!sheet) throw new Error('missing sheet')
    await waitForBrowserLayout()
    await Promise.all(
      sheet.getAnimations().map((animation) => animation.finished),
    )
    expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(
      height * 0.85 + 1,
    )
    expect(sheet.getBoundingClientRect().top).toBeGreaterThan(0)
    const show = page.getByRole('button', {
      name: 'Show 1 result',
      exact: true,
    })
    await expect.element(show).toBeVisible()
    const liveCount = page.elementLocator(sheet).getByRole('status')
    await expect.element(liveCount).toHaveAttribute('aria-live', 'polite')
    await expect.element(liveCount).toHaveTextContent('1 result')
    // Observe the persistent footer before input helpers can scroll the sheet.
    const button = show.element(),
      bounds = button.getBoundingClientRect()
    expect(
      button.contains(
        document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        ),
      ),
    ).toBe(true)
    const ownerField = page
      .elementLocator(sheet)
      .getByRole('textbox', { name: 'Owner', exact: true })
    await expect
      .element(ownerField)
      .toHaveAttribute('placeholder', 'Find owners by name')
    const projectField = page
      .elementLocator(sheet)
      .getByRole('textbox', { name: 'Project', exact: true })
    await expect
      .element(projectField)
      .toHaveAttribute('placeholder', 'Find projects by name')
    const projectChoices = page
      .elementLocator(sheet)
      .getByRole('radiogroup', { name: 'Project', exact: true })
      .element()
    const archive = page
      .elementLocator(sheet)
      .getByRole('checkbox', { name: 'Include archived projects' })
      .element()
    expect(
      projectChoices.compareDocumentPosition(archive) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Check the initial field before any input helper can auto-scroll it.
    const fieldBounds = ownerField.element().getBoundingClientRect()
    const scrollRegion = sheet.querySelector('[data-search-filter-scroll]')
    if (!scrollRegion) throw new Error('missing filter scroll region')
    const scrollBounds = scrollRegion.getBoundingClientRect()
    expect(fieldBounds.top).toBeGreaterThanOrEqual(scrollBounds.top)
    expect(fieldBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom)
    expect(
      ownerField
        .element()
        .contains(
          document.elementFromPoint(
            fieldBounds.left + fieldBounds.width / 2,
            fieldBounds.top + fieldBounds.height / 2,
          ),
        ),
    ).toBe(true)

    await ownerField.click()
    await projectField.click()
    await waitForBrowserLayout()
    const projectBounds = projectField.element().getBoundingClientRect()
    expect(projectBounds.top).toBeGreaterThanOrEqual(scrollBounds.top)
    expect(projectBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom)
    expect(
      projectField
        .element()
        .contains(
          document.elementFromPoint(
            projectBounds.left + projectBounds.width / 2,
            projectBounds.top + projectBounds.height / 2,
          ),
        ),
    ).toBe(true)

    await page
      .elementLocator(sheet)
      .getByRole('checkbox', { name: 'Alex (1)' })
      .click()
    await expect.element(liveCount).toHaveTextContent('Searching…')
    expect(document.querySelector('[data-slot="sheet-content"]')).toBe(sheet)
    if (!finishOwner) throw new Error('owner request not started')
    finishOwner({ ...result, items: [], total: { value: 0, relation: 'eq' } })
    await expect.element(liveCount).toHaveTextContent('0 results')
    await expect
      .element(
        page.getByRole('button', { name: 'Show 0 results', exact: true }),
      )
      .toBeVisible()
    await page
      .elementLocator(sheet)
      .getByRole('button', { name: 'Clear all' })
      .click()
    await expect
      .element(page.getByRole('button', { name: 'Show 1 result', exact: true }))
      .toBeVisible()
    await page
      .getByRole('button', { name: 'Show 1 result', exact: true })
      .click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull(),
    )
    await expect
      .element(page.getByRole('button', { name: 'Filters', exact: true }))
      .toHaveFocus()
  },
)

test('failed continuation retains old results and retry appends once', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        ...result,
        items: [
          { ...result.items[0], id: 'file-b', title: 'Beta report', rank: 2 },
        ],
        nextCursor: null,
      }),
    )
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults
              result={{ ...result, nextCursor: 'cursor-a' }}
              actor="viewer"
            />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await expect
    .element(page.getByRole('button', { name: 'Retry', exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('link', { name: 'Alpha report', exact: true }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect
    .element(page.getByRole('link', { name: 'Beta report', exact: true }))
    .toBeVisible()
  expect(document.querySelectorAll('a[href="/a/file-a"]')).toHaveLength(1)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('Back and viewer return reload later pages before restoring their visible anchor; only a new Enter focuses the heading', async () => {
  await page.viewport(1000, 700)
  const rows = Array.from({ length: 40 }, (_, index) => ({
    ...result.items[0],
    id: `file-${index}`,
    title: `Row ${index}`,
    rank: index + 1,
    groupSize: index === 30 ? 26 : 1,
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/opens')) return new Response(null, { status: 204 })
      if (url.includes('/search-suggestions'))
        return Response.json({
          files: [],
          recent: [],
          owners: [],
          projects: [],
        })
      if (url.includes('/search-logs')) return Response.json({ searches: [] })
      if (url.includes('/search-groups')) {
        const second = url.includes('cursor=')
        return Response.json({
          items: Array.from({ length: second ? 5 : 20 }, (_, i) => ({
            id: `member-${i + (second ? 20 : 0)}`,
            title: `Member ${i + (second ? 20 : 0)}`,
            updatedAt: '2026-09-15T00:00:00Z',
            lastViewedAt: null,
            receipt: 'member-receipt',
          })),
          total: { value: 26, relation: 'eq' },
          nextCursor: second ? null : 'group-page-2',
          searchLogId: 'group-log',
        })
      }
      return Response.json({
        ...result,
        items: rows.slice(20),
        nextCursor: null,
      })
    }),
  )
  window.history.replaceState(
    { key: crypto.randomUUID() },
    '',
    '/search?q=alpha',
  )
  window.scrollTo(0, 0)
  const router = createBrowserRouter([
    {
      path: '/',
      element: (
        <>
          <Outlet />
          <ScrollRestoration />
        </>
      ),
      children: [
        {
          path: 'search',
          loader: () => ({
            ...result,
            items: rows.slice(0, 20),
            total: { value: 40, relation: 'eq' },
            nextCursor: 'page-2',
            searchLogId: crypto.randomUUID(),
          }),
          Component: () => {
            const data = useLoaderData<SearchResponse>()
            return (
              <>
                <SearchPalette />
                <SearchResults result={data} actor="viewer" />
              </>
            )
          },
        },
        {
          path: 'a/:id',
          // Like the real Viewer route, opening a file waits for a loader, so
          // the results re-render in the loading state before they unmount.
          loader: () => new Promise((resolve) => setTimeout(resolve, 150)),
          Component: () => {
            const location = useLocation()
            return (
              <Link
                to={viewerReturnTo(location.state)}
                state={viewerReturnState()}
              >
                Return to search
              </Link>
            )
          },
        },
      ],
    },
  ])
  historyRouter = router
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await expect
    .element(page.getByRole('link', { name: 'Row 19', exact: true }))
    .toBeInTheDocument()
  await waitForBrowserLayout()
  page
    .getByRole('button', { name: 'Load more', exact: true })
    .element()
    .scrollIntoView({ block: 'end' })
  await expect
    .element(page.getByRole('link', { name: 'Row 30', exact: true }))
    .toBeInTheDocument()
  page
    .getByRole('link', { name: 'Row 30', exact: true })
    .element()
    .scrollIntoView({ block: 'center' })
  await waitForBrowserLayout()
  await router.navigate('/search?q=alpha&sort=newest', {
    preventScrollReset: true,
  })
  await vi.waitFor(() =>
    expect(window.location.search).toContain('sort=newest'),
  )
  window.history.back()
  await vi.waitFor(() => {
    expect(window.location.search).toBe('?q=alpha')
    const anchor = document.getElementById('search-file-file-30')
    if (!anchor) throw new Error('later page missing after condition Back')
    expect(anchor.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(anchor.getBoundingClientRect().top).toBeLessThan(window.innerHeight)
  })
  await page.getByRole('link', { name: 'Row 30', exact: true }).click()
  await expect
    .element(page.getByRole('link', { name: 'Return to search' }))
    .toBeVisible()
  window.history.back()
  await vi.waitFor(() => {
    expect(window.location.pathname + window.location.search).toBe(
      '/search?q=alpha',
    )
    const anchor = document.getElementById('search-file-file-30')
    expect(anchor).not.toBeNull()
    if (!anchor) throw new Error('missing restored anchor')
    const bounds = anchor.getBoundingClientRect()
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.top).toBeLessThan(window.innerHeight)
    expect(document.activeElement?.tagName).not.toBe('H1')
  })
  await page.getByRole('link', { name: 'Row 30', exact: true }).click()
  await page.getByRole('link', { name: 'Return to search' }).click()
  await vi.waitFor(() => {
    const anchor = document.getElementById('search-file-file-30')
    if (!anchor) throw new Error('missing returned anchor')
    expect(anchor.getBoundingClientRect().top).toBeLessThan(window.innerHeight)
    expect(anchor.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(document.activeElement?.tagName).not.toBe('H1')
  })
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await page.getByRole('button', { name: 'Show 5 more files' }).click()
  await expect
    .element(page.getByRole('link', { name: 'Member 23', exact: true }))
    .toBeInTheDocument()
  page
    .getByRole('link', { name: 'Member 23', exact: true })
    .element()
    .scrollIntoView({ block: 'center' })
  await waitForBrowserLayout()
  await page.getByRole('link', { name: 'Member 23', exact: true }).click()
  await expect
    .element(page.getByRole('link', { name: 'Return to search' }))
    .toBeVisible()
  window.history.back()
  await vi.waitFor(() => {
    const member = document.getElementById('search-file-member-23')
    if (!member) throw new Error('second group page not restored')
    expect(member.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(member.getBoundingClientRect().top).toBeLessThan(window.innerHeight)
    expect(document.activeElement?.tagName).not.toBe('H1')
    // Keyboard focus continues from the opened file.
    expect(document.activeElement?.textContent).toBe('Member 23')
  })
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  await page.getByRole('combobox', { name: 'Keywords' }).fill('beta')
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('H1'))
  // Closing the search must not hand focus back to the header afterwards.
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  )
  await waitForBrowserLayout()
  expect(document.activeElement?.tagName).toBe('H1')
  expect(window.location.search).toBe('?q=beta')
})

// A document load leaves the first entry without a router key unless the
// server-rendered scroll script adds one; both entries must continue.
test.each([
  ['a keyed entry', { key: 'first-entry' }],
  ['an entry without a key', null],
])(
  'Back to results continues the shown search from %s; a new search for the same words starts over',
  async (_, state) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/opens')) return new Response(null, { status: 204 })
      if (url.includes('/search-suggestions'))
        return Response.json({
          files: [],
          recent: [],
          owners: [],
          projects: [],
        })
      if (url.includes('/search-logs')) return Response.json({ searches: [] })
      if (url.startsWith('/api/search?'))
        return Response.json({ ...result, resume: 'resume-a' })
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    const server = vi.fn(async () => ({
      result: { ...result, resume: 'resume-a' },
      actor: 'viewer',
    }))
    window.history.replaceState(state, '', '/search?q=alpha')
    const router = createBrowserRouter([
      {
        path: '/',
        element: <Outlet />,
        children: [
          {
            path: 'search',
            loader: ({ request }) => continueReturnedSearch(request, server),
            Component: () => {
              const data = useLoaderData<{
                result: SearchResponse
                actor: string
              }>()
              return <SearchResults result={data.result} actor={data.actor} />
            },
          },
          { path: 'a/:id', Component: () => <p>Viewer</p> },
        ],
      },
    ])
    historyRouter = router
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    await expect
      .element(page.getByRole('link', { name: 'Alpha report', exact: true }))
      .toBeInTheDocument()
    expect(server).toHaveBeenCalledTimes(1)
    await page.getByRole('link', { name: 'Alpha report', exact: true }).click()
    await expect.element(page.getByText('Viewer')).toBeVisible()
    window.history.back()
    await expect
      .element(page.getByRole('link', { name: 'Alpha report', exact: true }))
      .toBeInTheDocument()
    // Back continues the search through its token instead of a new search.
    expect(
      fetcher.mock.calls.some(
        ([url]) =>
          String(url).startsWith('/api/search?') &&
          String(url).includes('resume=resume-a'),
      ),
    ).toBe(true)
    expect(server).toHaveBeenCalledTimes(1)
    // Searching again for the same words is a new search.
    await router.navigate('/search?q=alpha')
    await vi.waitFor(() => expect(server).toHaveBeenCalledTimes(2))
  },
)

test('custom date replay displays inclusive days and clear filters reconciles the editor', async () => {
  await page.viewport(1000, 700)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults result={result} actor="viewer" />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        '/search?q=alpha&period=custom&from=2026-09-01T00:00:00.000Z&to=2026-09-03T00:00:00.000Z',
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: 'Period', exact: true }).click()
  await expect.element(page.getByLabelText('From')).toHaveValue('2026-09-01')
  await expect.element(page.getByLabelText('To')).toHaveValue('2026-09-02')
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect
    .element(page.getByRole('button', { name: 'Clear filters', exact: true }))
    .not.toBeInTheDocument()
  await expect.element(page.getByLabelText('From')).not.toBeInTheDocument()
  expect(router.state.location.search).toBe('?q=alpha')
  await router.navigate('/search?q=alpha&period=custom&from=2026-09-04')
  await page.getByRole('button', { name: 'Period', exact: true }).click()
  await expect.element(page.getByLabelText('From')).toHaveValue('2026-09-04')
})

test('facet lookups keep independent names and expose failed stale choices with retry', async () => {
  await page.viewport(1000, 700)
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const q = new URL(String(url), window.location.origin).searchParams.get('q')
    if (q === 'broken') return new Response(null, { status: 503 })
    return Response.json({
      owners: [{ id: 'alex', name: 'Alex lookup' }],
      projects: [{ id: 'launch', name: 'Launch lookup' }],
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults result={result} actor="viewer" />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByText('Owner', { exact: true }).click()
  await page.getByRole('textbox', { name: 'Owner', exact: true }).fill('Alex')
  await expect
    .element(page.getByRole('checkbox', { name: 'Alex lookup' }))
    .toBeVisible()
  await page.getByRole('textbox', { name: 'Owner', exact: true }).fill('broken')
  await expect
    .element(page.getByText('Could not search names.', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText('Showing previous choices.', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByRole('checkbox', { name: 'Alex lookup' }))
    .toBeVisible()
  const attempts = fetcher.mock.calls.length
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await vi.waitFor(() => expect(fetcher.mock.calls.length).toBe(attempts + 1))
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await expect
    .element(page.getByRole('textbox', { name: 'Project', exact: true }))
    .toHaveValue('')
  await page
    .getByRole('textbox', { name: 'Project', exact: true })
    .fill('Launch')
  await expect
    .element(page.getByRole('radio', { name: 'Launch lookup' }))
    .toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Owner', exact: true }).click()
  await expect
    .element(page.getByRole('textbox', { name: 'Owner', exact: true }))
    .toHaveValue('broken')
})

test('group continuation appends members, keeps lower-bound labels and retains earlier members on failure', async () => {
  await page.viewport(1000, 700)
  let fail = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('cursor=members-next') && fail) {
        fail = false
        return new Response(null, { status: 503 })
      }
      const later = String(url).includes('cursor=members-next')
      return Response.json({
        items: [
          {
            id: later ? 'member-c' : 'member-b',
            title: later ? 'Member C' : 'Member B',
            updatedAt: '2026-09-15T00:00:00Z',
            lastViewedAt: null,
            receipt: 'member-receipt',
          },
        ],
        total: { value: 3, relation: later ? 'eq' : 'gte' },
        nextCursor: later ? null : 'members-next',
        searchLogId: 'log-a',
      })
    }),
  )
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults result={result} actor="viewer" />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await expect
    .element(page.getByRole('link', { name: 'Member B' }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Show at least 1 more files' }).click()
  await expect.element(page.getByRole('alert')).toBeVisible()
  await expect
    .element(page.getByRole('link', { name: 'Member B' }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect
    .element(page.getByRole('link', { name: 'Member C' }))
    .toBeVisible()
  expect(document.querySelectorAll('a[href="/a/member-b"]')).toHaveLength(1)
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await expect
    .element(page.getByRole('link', { name: 'Member C' }))
    .not.toBeInTheDocument()
})

test('each filter updates URL and loader results immediately and preserves the other conditions', async () => {
  await page.viewport(1000, 700)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        loader: ({ request }) => {
          const params = new URL(request.url).searchParams
          return {
            ...result,
            items: [
              {
                ...result.items[0],
                title:
                  params.get('sort') === 'newest'
                    ? 'Newest response'
                    : params.has('owner')
                      ? 'Owner response'
                      : 'Alpha report',
              },
            ],
          }
        },
        Component: () => (
          <>
            <SearchPalette />
            <SearchResults
              result={useLoaderData<SearchResponse>()}
              actor="viewer"
            />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByText('Owner', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Alex (1)' }).click()
  await expect
    .element(page.getByRole('link', { name: 'Owner response' }))
    .toBeVisible()
  expect(router.state.location.search).toContain('owner=owner')
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('radio', { name: 'Home (no project) (1)' }).click()
  await vi.waitFor(() =>
    expect(router.state.location.search).toContain('project=home'),
  )
  await page
    .getByRole('checkbox', { name: 'Include archived projects' })
    .click()
  await vi.waitFor(() =>
    expect(router.state.location.search).toContain('includeArchived=true'),
  )
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Period', exact: true }).click()
  await page.getByRole('radio', { name: 'Past 7 days', exact: true }).click()
  await vi.waitFor(() =>
    expect(router.state.location.search).toContain('period=7'),
  )
  await page
    .getByRole('radio', { name: 'Last viewed by me', exact: true })
    .click()
  await vi.waitFor(() =>
    expect(router.state.location.search).toContain('dateField=viewed'),
  )
  await userEvent.keyboard('{Escape}')
  await page.getByRole('button', { name: 'Most relevant', exact: true }).click()
  await page.getByRole('radio', { name: 'Newest', exact: true }).click()
  await expect
    .element(page.getByRole('link', { name: 'Newest response' }))
    .toBeVisible()
  const params = new URLSearchParams(router.state.location.search)
  expect(Object.fromEntries(params)).toEqual({
    q: 'alpha',
    owner: 'owner',
    project: 'home',
    includeArchived: 'true',
    period: '7',
    dateField: 'viewed',
    sort: 'newest',
  })
  expect(document.activeElement?.tagName).not.toBe('H1')
})

test('changing filters rejects a completed continuation from the previous conditions', async () => {
  await page.viewport(1000, 700)
  let release: ((response: Response) => void) | undefined
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        loader: ({ request }) => {
          const filtered = new URL(request.url).searchParams.has('owner')
          return {
            ...result,
            items: [
              {
                ...result.items[0],
                title: filtered ? 'Current owner response' : 'Alpha report',
              },
            ],
            nextCursor: filtered ? null : 'old-cursor',
          }
        },
        Component: () => (
          <>
            <SearchPalette />
            <SearchResults
              result={useLoaderData<SearchResponse>()}
              actor="viewer"
            />
          </>
        ),
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: crypto.randomUUID() },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  await page.getByText('Owner', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Alex (1)' }).click()
  await expect
    .element(page.getByRole('link', { name: 'Current owner response' }))
    .toBeVisible()
  if (!release) throw new Error('continuation never requested')
  release(
    Response.json({
      ...result,
      items: [
        { ...result.items[0], id: 'obsolete', title: 'Obsolete continuation' },
      ],
    }),
  )
  await waitForBrowserLayout()
  await waitForBrowserLayout()
  await expect
    .element(page.getByRole('link', { name: 'Current owner response' }))
    .toBeVisible()
  expect(document.body.textContent).not.toContain('Obsolete continuation')
})

test('error recovery keeps all conditions and allows invalid dates to be corrected', async () => {
  const query =
    '?q=alpha&owner=owner&owner=second&project=p&includeArchived=true&period=custom&dateField=viewed&from=2026-09-30&to=2026-09-01&sort=newest'
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults
              actor="viewer"
              result={{
                error: { code: 'validation_error', fields: ['from', 'to'] },
              }}
            />
          </>
        ),
      },
    ],
    { initialEntries: ['/search' + query] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page
    .getByRole('button', { name: 'Search with different keywords' })
    .click()
  await page.getByRole('combobox', { name: 'Keywords' }).fill('beta')
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() =>
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe(
      'beta',
    ),
  )
  const expected = new URLSearchParams(query)
  expected.set('q', 'beta')
  const actual = new URLSearchParams(router.state.location.search)
  actual.sort()
  expected.sort()
  expect([...actual]).toEqual([...expected])
  await page.getByRole('button', { name: 'Period', exact: true }).click()
  await page.getByLabelText('From').fill('2026-08-01')
  await vi.waitFor(() =>
    expect(new URLSearchParams(router.state.location.search).get('from')).toBe(
      '2026-08-01',
    ),
  )
  expect(
    new URLSearchParams(router.state.location.search).getAll('owner'),
  ).toEqual(['owner', 'second'])
})

test('empty results reduce keywords for editing and name owner-only scope without empty quotes', async () => {
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults
              actor="viewer"
              result={{
                ...result,
                items: [],
                total: { value: 0, relation: 'eq' },
              }}
            />
          </>
        ),
      },
    ],
    { initialEntries: ['/search?q=Alpha+Beta&owner=owner'] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: 'Search with fewer keywords' }).click()
  await expect
    .element(page.getByRole('combobox', { name: 'Keywords' }))
    .toHaveValue('Alpha')
  await expect
    .element(page.getByRole('combobox', { name: 'Keywords' }))
    .toHaveFocus()
  expect(router.state.location.search).toContain('Alpha+Beta')
  await userEvent.keyboard('{Escape}')
  await router.navigate(
    `/search?q=${encodeURIComponent('東京の請求書')}&owner=owner`,
  )
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  await expect
    .element(page.getByRole('combobox', { name: 'Keywords' }))
    .toHaveValue('東京の請求書')
  await userEvent.keyboard('{Escape}')
  await expect
    .element(page.getByRole('button', { name: 'Search with fewer keywords' }))
    .not.toBeInTheDocument()
  await router.navigate('/search?owner=owner')
  await expect
    .element(
      page.getByRole('heading', {
        name: /^No files owned by Alex match these filters\./,
      }),
    )
    .toBeVisible()
  expect(
    document.querySelector('[data-search-zero]')?.textContent,
  ).not.toContain('“”')
})

test('any-word rows label matched terms and capped notice follows explicit sort', async () => {
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults
              actor="viewer"
              result={{
                ...result,
                tier: 'any',
                items: [{ ...result.items[0], tier: 'any' }],
                total: { value: 1000, relation: 'gte' },
              }}
            />
          </>
        ),
      },
    ],
    { initialEntries: ['/search?q=alpha+beta&sort=newest'] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await expect
    .element(page.getByText('Matched: alpha', { exact: true }))
    .toBeVisible()
  await expect
    .element(page.getByText(/Up to 1,000 results are shown newest first/))
    .toBeVisible()
  await router.navigate('/search?q=alpha+beta&sort=relevance')
  await expect
    .element(page.getByText(/Up to 1,000 results are shown in relevance order/))
    .toBeVisible()
})

test.each(['results', 'error'])(
  '%s reject IME confirmation keyCode 229 and accept the next ordinary Enter',
  async (state) => {
    const router = createMemoryRouter(
      [
        {
          path: '/search',
          element: (
            <>
              <SearchPalette />
              <SearchResults
                actor="viewer"
                result={
                  state === 'error'
                    ? { error: { code: 'validation_error', fields: ['from'] } }
                    : result
                }
              />
            </>
          ),
        },
      ],
      { initialEntries: ['/search?q=alpha'] },
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
    const field = page.getByRole('combobox', { name: 'Keywords' })
    await field.fill('日本語')
    const input = field.element()
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    const duringComposition = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(duringComposition)
    expect(duringComposition.defaultPrevented).toBe(true)
    const form = input.closest('form')
    if (!form) throw new Error('missing search form')
    const submit = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(submit)
    expect(submit.defaultPrevented).toBe(true)
    expect(router.state.location.search).toBe('?q=alpha')
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    )
    const confirmation = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(confirmation)
    expect(confirmation.defaultPrevented).toBe(true)
    expect(router.state.location.search).toBe('?q=alpha')
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('q')).toBe(
        '日本語',
      ),
    )
  },
)

test('expired group cursors restart with fresh receipts and retain members through pending or failed recovery', async () => {
  const recoveries: Array<(response: Response) => void> = []
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === '/api/search')
      return new Promise<Response>((resolve) => recoveries.push(resolve))
    if (url.searchParams.has('cursor'))
      return Promise.resolve(
        Response.json({ error: { code: 'invalid_cursor' } }, { status: 400 }),
      )
    const fresh = url.searchParams.get('receipt') === 'fresh-receipt'
    return Promise.resolve(
      Response.json({
        items: [
          {
            id: 'member-b',
            title: fresh ? 'Fresh member' : 'Member B',
            updatedAt: '2026-09-15T00:00:00Z',
            lastViewedAt: null,
            receipt: 'member-receipt',
          },
        ],
        total: { value: 3, relation: 'eq' },
        nextCursor: fresh ? null : 'expired-cursor',
        searchLogId: fresh ? 'fresh-log' : 'log-a',
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: (
          <>
            <SearchPalette />
            <SearchResults actor="viewer" result={result} />
          </>
        ),
      },
    ],
    { initialEntries: ['/search?q=alpha&owner=owner'] },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: /Files with the same title/ }).click()
  await expect
    .element(page.getByRole('link', { name: 'Member B', exact: true }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Show 1 more files' }).click()
  await page.getByRole('button', { name: 'Restart search' }).click()
  await vi.waitFor(() => expect(recoveries).toHaveLength(1))
  await expect
    .element(page.getByRole('link', { name: 'Member B', exact: true }))
    .toBeVisible()
  recoveries[0](new Response(null, { status: 503 }))
  await expect
    .element(page.getByRole('button', { name: 'Restart search' }))
    .toBeEnabled()
  await expect
    .element(page.getByRole('link', { name: 'Member B', exact: true }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Restart search' }).click()
  await vi.waitFor(() => expect(recoveries).toHaveLength(2))
  await expect
    .element(page.getByRole('link', { name: 'Member B', exact: true }))
    .toBeVisible()
  recoveries[1](
    Response.json({
      ...result,
      searchLogId: 'fresh-log',
      items: [{ ...result.items[0], receipt: 'fresh-receipt' }],
    }),
  )
  await expect
    .element(page.getByRole('button', { name: /Files with the same title/ }))
    .toHaveAttribute('aria-expanded', 'true')
  await expect
    .element(page.getByRole('link', { name: 'Fresh member', exact: true }))
    .toBeVisible()
  const requests = fetcher.mock.calls.map(
    ([input]) => new URL(String(input), window.location.origin),
  )
  expect(requests.filter((url) => url.searchParams.has('cursor'))).toHaveLength(
    1,
  )
  expect(
    requests
      .filter((url) => url.pathname === '/api/search')
      .map((url) => url.search),
  ).toEqual(['?q=alpha&owner=owner', '?q=alpha&owner=owner'])
  expect(requests.at(-1)?.searchParams.get('receipt')).toBe('fresh-receipt')
})

test.each([1000, 599])(
  'date field can be selected before a period without losing results or the open controls at width %i',
  async (width) => {
    await page.viewport(width, 700)
    const router = createMemoryRouter(
      [
        {
          path: '/search',
          loader: ({ request }) => {
            const parsed = parseSearchQuery(new URL(request.url).searchParams)
            return 'error' in parsed ? parsed : result
          },
          Component: () => (
            <SearchResults
              result={useLoaderData<SearchResponse>()}
              actor="viewer"
            />
          ),
        },
      ],
      { initialEntries: ['/search?q=alpha'] },
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    await expect
      .element(page.getByRole('link', { name: 'Alpha report', exact: true }))
      .toBeVisible()
    await page
      .getByRole('button', {
        name: width < 600 ? 'Filters' : 'Period',
        exact: true,
      })
      .click()
    await page
      .getByRole('radio', { name: 'Last viewed by me', exact: true })
      .click()
    await vi.waitFor(() => {
      expect(router.state.navigation.state).toBe('idle')
      expect(router.state.location.search).toContain('dateField=viewed')
    })
    await expect
      .element(
        page.getByRole('radio', { name: 'Last viewed by me', exact: true }),
      )
      .toBeChecked()
    await expect
      .element(page.getByRole('radio', { name: 'All time', exact: true }))
      .toBeChecked()
    expect(router.state.loaderData).toEqual({ '0': result })
    await page.getByRole('radio', { name: 'Past 7 days', exact: true }).click()
    await vi.waitFor(() => {
      expect(router.state.navigation.state).toBe('idle')
      expect(
        parseSearchQuery(new URLSearchParams(router.state.location.search)),
      ).toMatchObject({ filters: { date: { field: 'viewed' } } })
    })
    await page.getByRole('radio', { name: 'All time', exact: true }).click()
    await vi.waitFor(() => {
      expect(router.state.navigation.state).toBe('idle')
      expect(router.state.location.search).toBe('?q=alpha&dateField=viewed')
    })
    await expect
      .element(
        page.getByRole('radio', { name: 'Last viewed by me', exact: true }),
      )
      .toBeChecked()
    expect(router.state.loaderData).toEqual({ '0': result })
  },
)

test('daily group refusal keeps visible results and retries on deliberate re-expansion only at reset', async () => {
  const now = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse('2026-11-20T23:59:59.999Z'))
  const fetcher = vi.fn(async () =>
    Response.json(
      {
        error: {
          code: 'search_daily_limit_exceeded',
          retry_at: '2026-11-21T00:00:00.000Z',
        },
      },
      { status: 429 },
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter(
    [
      {
        path: '/search',
        element: <SearchResults result={result} actor="viewer" />,
      },
    ],
    {
      initialEntries: [
        { pathname: '/search', search: '?q=alpha', key: 'daily-group-limit' },
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  const group = page.getByRole('button', { name: /1 more/ })
  const limitMessage =
    'Daily search limit reached. Search resumes at Nov 21, 2026, 00:00 UTC. Please wait until then.'
  await group.click()
  await expect.element(page.getByRole('alert')).toHaveTextContent(limitMessage)
  await expect
    .element(page.getByRole('button', { name: 'Retry', exact: true }))
    .not.toBeInTheDocument()
  await expect
    .element(page.getByRole('link', { name: 'Alpha report' }))
    .toBeVisible()
  await group.click()
  await group.click()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(router.state.location.search).toBe('?q=alpha')

  now.mockReturnValue(Date.parse('2026-11-21T00:00:00.000Z'))
  await waitForBrowserLayout()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect.element(page.getByRole('alert')).toHaveTextContent(limitMessage)
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      items: [
        {
          id: 'file-b',
          title: 'Alpha report 2',
          updatedAt: '2026-09-17T00:00:00Z',
          lastViewedAt: null,
          receipt: 'receipt-b',
        },
      ],
      total: { value: 2, relation: 'eq' },
      nextCursor: null,
    }),
  )
  await group.click()
  await group.click()
  await expect
    .element(page.getByRole('link', { name: 'Alpha report 2', exact: true }))
    .toBeVisible()
  await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(router.state.location.search).toBe('?q=alpha')
})

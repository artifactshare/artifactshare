import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SearchPalette } from './search-palette'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Topbar } from '~/routes/_home/+components/topbar'
import { AppTopbar } from './app-topbar'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

let root: Root | undefined
const empty = { files: [], owners: [], projects: [], recent: [] }
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

test('unselected Enter searches, while arrow-selected Enter opens an authorized file', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes('search-logs')
        ? { searches: [] }
        : {
            ...empty,
            files: [
              {
                id: 'file-a',
                title: 'Healthy file',
                ownerName: 'Owner',
                project: null,
                excerpt: 'alpha',
                visibility: 'workspace',
                lastViewedAt: null,
                updatedAt: '2026-09-15T00:00:00Z',
                ownerId: 'owner',
              },
            ],
          },
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter([
    {
      id: 'root',
      path: '/',
      loader: () => ({ locale: 'ja' }),
      element: (
        <AppTopbar>
          <SearchPalette />
        </AppTopbar>
      ),
    },
    { path: '/search', element: <p>Results screen</p> },
    { path: '/a/:id', element: <p>Opened file</p> },
  ])
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  await page.getByRole('button', { name: /^検索(?::|$)/ }).click()
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('alpha')
  await expect
    .element(page.getByRole('option', { name: /Healthy file/ }))
    .toBeVisible()
  expect(document.querySelector('[aria-selected="true"]')).toBeNull()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/search'))
  await router.navigate('/')
  await page.getByRole('button', { name: /^検索(?::|$)/ }).click()
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('alpha')
  await expect
    .element(page.getByRole('option', { name: /Healthy file/ }))
    .toBeVisible()
  await userEvent.keyboard('{ArrowDown}{Enter}')
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe('/a/file-a'),
  )
})

test('project scope is removable and composition confirmation does not navigate', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      String(input).includes('search-logs') ? { searches: [] } : empty,
    ),
  )
  vi.stubGlobal('fetch', fetcher)
  const router = createMemoryRouter([
    {
      id: 'root',
      path: '/',
      loader: () => ({ locale: 'ja' }),
      element: (
        <Topbar
          workspaceName="Workspace"
          user={{
            id: 'viewer',
            name: 'Viewer',
            email: 'viewer@example.com',
            image: null,
            initial: 'V',
          }}
          searchProject={{ id: 'project-a', name: 'Project A' }}
        />
      ),
    },
    { path: '/search', element: <p>Results</p> },
  ])
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  await page.getByRole('button', { name: /^検索(?::|$)/ }).click()
  await page.getByRole('button', { name: /プロジェクト: Project A/ }).click()
  const field = page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
  await field.fill('日本語')
  const input = document.querySelector('input[role="combobox"]')
  if (!input) throw new Error('missing combobox')
  input.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  )
  await waitForBrowserLayout()
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
    }),
  )
  expect(router.state.location.pathname).toBe('/')
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }),
  )
  expect(router.state.location.pathname).toBe('/')
  await vi.waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes(encodeURIComponent('日本語')),
      ),
    ).toBe(true),
  )
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/search'))
  expect(router.state.location.search).not.toContain('project=')
})

// Real Dialog focus, keyboard defaults and viewport CSS require the browser runtime.
function mountPalette() {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <>
          <AppTopbar>
            <SearchPalette />
          </AppTopbar>
          <input aria-label="Outside input" />
          <textarea aria-label="Outside textarea" />
          <select aria-label="Outside select">
            <option>One</option>
          </select>
          <div contentEditable suppressContentEditableWarning data-editable>
            <span>Editable child</span>
          </div>
        </>
      ),
    },
    { path: '/search', element: <p>Results screen</p> },
  ])
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  )
  return router
}

test('shortcuts focus keywords immediately and slash ignores editable ancestors and composition', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs') ? { searches: [] } : empty,
      ),
    ),
  )
  mountPalette()
  await expect
    .element(page.getByRole('button', { name: /^Search(?::|$)/ }))
    .toBeVisible()
  for (const shortcut of ['{Meta>}k{/Meta}', '{Control>}k{/Control}', '/']) {
    document.body.focus()
    await userEvent.keyboard(shortcut)
    await expect
      .element(page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }))
      .toHaveFocus()
    await userEvent.keyboard('alpha')
    await expect
      .element(page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }))
      .toHaveValue('alpha')
    await userEvent.keyboard('{Escape}')
    await expect
      .element(page.getByRole('button', { name: /^Search(?::|$)/ }))
      .toHaveFocus()
  }
  for (const selector of [
    'input[aria-label="Outside input"]',
    'textarea',
    'select',
    '[data-editable] span',
  ]) {
    const target = document.querySelector(selector)
    if (!target) throw new Error('missing editable control')
    const event = new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    await waitForBrowserLayout()
    expect(event.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  }
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: '/',
      isComposing: true,
      bubbles: true,
    }),
  )
  await waitForBrowserLayout()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test.each(['end-before-enter', 'enter-before-end'])(
  'composition suppresses requests for the full debounce window and confirmation (%s)',
  async (order) => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs') ? { searches: [] } : empty,
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const router = mountPalette()
    await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) =>
          String(url).includes('search-suggestions'),
        ),
      ).toBe(true),
    )
    await waitForBrowserLayout()
    fetcher.mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    try {
      const field = page.getByRole('combobox', {
        name: /^(Keywords|キーワード)$/,
      })
      const input = field.element()
      input.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      await field.fill('日本語')
      await waitForBrowserLayout()
      await vi.advanceTimersByTimeAsync(300)
      expect(fetcher).not.toHaveBeenCalled()
      const end = () =>
        input.dispatchEvent(
          new CompositionEvent('compositionend', { bubbles: true }),
        )
      const enter = () =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            isComposing: order === 'enter-before-end',
            keyCode: 229,
          }),
        )
      if (order === 'end-before-enter') {
        end()
        enter()
      } else {
        enter()
        end()
      }
      await waitForBrowserLayout()
      expect(router.state.location.pathname).toBe('/')
      await vi.advanceTimersByTimeAsync(149)
      expect(fetcher).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0][0])).toContain(
        encodeURIComponent('日本語'),
      )
    } finally {
      vi.useRealTimers()
    }
    await waitForBrowserLayout()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/search'),
    )
  },
)

test('newer suggestions win out-of-order completion while previous candidates remain during loading', async () => {
  const pending = new Map<string, (value: Response) => void>()
  const suggestion = (name: string) => ({
    ...empty,
    owners: [{ id: name, name }],
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url)
      if (value.includes('search-logs')) return Response.json({ searches: [] })
      const q =
        new URL(value, window.location.origin).searchParams.get('q') ?? ''
      if (q === 'A' || q === 'B')
        return new Promise<Response>((resolve) => pending.set(q, resolve))
      return Response.json(suggestion('Healthy'))
    }),
  )
  mountPalette()
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('healthy')
  await expect
    .element(page.getByRole('option', { name: 'Healthy Owner' }))
    .toBeVisible()
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('A')
  await vi.waitFor(() => expect(pending.has('A')).toBe(true))
  await expect
    .element(page.getByRole('option', { name: 'Healthy Owner' }))
    .toBeVisible()
  await expect.element(page.getByRole('status')).toHaveTextContent('Searching…')
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('B')
  await vi.waitFor(() => expect(pending.has('B')).toBe(true))
  pending.get('B')!(Response.json(suggestion('Current')))
  await expect
    .element(page.getByRole('option', { name: 'Current Owner' }))
    .toBeVisible()
  pending.get('A')!(Response.json(suggestion('Obsolete')))
  // Flush the actual released response and React task before the negative assertion.
  await waitForBrowserLayout()
  await waitForBrowserLayout()
  await expect
    .element(page.getByRole('option', { name: 'Current Owner' }))
    .toBeVisible()
  expect(document.body.textContent).not.toContain('Obsolete')
})

test('idle history shows distinct conditions and replays them; person/project choices remove only matching names', async () => {
  const filters = {
    ownerUserIds: ['alex'],
    location: { kind: 'project', id: 'launch' },
    date: { field: 'updated', days: 7 },
    includeArchived: false,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs')
          ? {
              searches: [
                {
                  id: 'log',
                  query: 'report',
                  filters_json: JSON.stringify({
                    query: 'report',
                    sort: 'newest',
                    filters,
                  }),
                  selectedScope: {
                    owners: [{ id: 'alex', name: 'Alex' }],
                    projects: [{ id: 'launch', name: 'Launch' }],
                  },
                },
              ],
            }
          : {
              ...empty,
              owners: [{ id: 'alex', name: 'Alex' }],
              projects: [{ id: 'launch', name: 'Launch' }],
              recent: [
                { id: 'recent', title: 'Recently viewed', ownerName: 'Alex' },
              ],
            },
      ),
    ),
  )
  const router = mountPalette()
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  await expect
    .element(page.getByRole('option', { name: /Recently viewed/ }))
    .toBeVisible()
  const history = page.getByRole('option', {
    name: /report.*Owner: Alex.*Project: Launch/,
  })
  await expect.element(history).toBeVisible()
  await expect
    .element(page.getByRole('option', { name: /Show all results/ }))
    .not.toBeInTheDocument()
  await history.click()
  expect(router.state.location.search).toContain('period=7')
  expect(router.state.location.search).toContain('owner=alex')
  await router.navigate('/')
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  await page
    .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
    .fill('Alex Launch budget')
  await page.getByRole('option', { name: 'Alex Owner', exact: true }).click()
  await expect
    .element(page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }))
    .toHaveValue('Launch budget')
  await page
    .getByRole('option', { name: 'Launch Project', exact: true })
    .click()
  await expect
    .element(page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }))
    .toHaveValue('budget')
  await page.getByRole('button', { name: /Owner: Alex/ }).click()
  await page.getByRole('button', { name: /Project: Launch/ }).click()
  await page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }).click()
  await userEvent.keyboard('{Enter}')
  expect(router.state.location.search).toBe('?q=budget')
})

test.each([599, 600])(
  'search dialog follows the 600px boundary and Cancel restores focus (%i)',
  async (width) => {
    await page.viewport(width, 480)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        Response.json(
          String(url).includes('search-logs') ? { searches: [] } : empty,
        ),
      ),
    )
    const router = mountPalette()
    const trigger = page.getByRole('button', { name: /^Search(?::|$)/ })
    await trigger.click()
    const field = page.getByRole('combobox', {
      name: /^(Keywords|キーワード)$/,
    })
    await expect.element(field).toHaveFocus()
    await waitForBrowserLayout()
    const dialog = page.getByRole('dialog').element()
    await Promise.all(
      dialog.getAnimations().map((animation) => animation.finished),
    )
    const bounds = dialog.getBoundingClientRect()
    const hint = page.getByText('↑↓ Select · Enter All results · Esc Close', {
      exact: true,
    })
    if (width === 599) {
      await expect.element(hint).not.toBeVisible()
      expect(bounds.width).toBe(width)
      expect(bounds.height).toBe(window.innerHeight)
    } else {
      await expect.element(hint).toBeVisible()
      expect(bounds.width).toBeLessThanOrEqual(width)
      expect(bounds.top).toBeGreaterThanOrEqual(
        field.element().getBoundingClientRect().bottom,
      )
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
    expect(field.element().getAttribute('enterkeyhint')).toBe('search')
    if (width === 599)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    else await userEvent.keyboard('{Escape}')
    await expect.element(trigger).toHaveFocus()
    await trigger.click()
    await field.fill('query')
    await userEvent.keyboard('{Enter}')
    expect(router.state.location.pathname).toBe('/search')
  },
)

test.each(['owners', 'projects'] as const)(
  'arrow-selected %s applies a chip and removes only its name',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        Response.json(
          String(url).includes('search-logs')
            ? { searches: [] }
            : { ...empty, [kind]: [{ id: 'alex', name: 'Alex' }] },
        ),
      ),
    )
    const router = mountPalette()
    await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
    await page
      .getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
      .fill('Alex report')
    await expect
      .element(
        page.getByRole('option', {
          name: kind === 'owners' ? 'Alex Owner' : 'Alex Project',
          exact: true,
        }),
      )
      .toBeVisible()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect
      .element(page.getByRole('button', { name: /Remove the Alex filter/ }))
      .toBeVisible()
    await expect
      .element(page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ }))
      .toHaveValue('report')
    expect(router.state.location.pathname).toBe('/')
  },
)

test('IME keyCode 229 blocks confirmation while immediate ordinary Enter searches', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs') ? { searches: [] } : empty,
      ),
    ),
  )
  const router = mountPalette()
  await page.getByRole('button', { name: /^Search(?::|$)/ }).click()
  const field = page.getByRole('combobox', { name: /^(Keywords|キーワード)$/ })
  await field.fill('日本語')
  const input = field.element()
  input.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  )
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    }),
  )
  expect(router.state.location.pathname).toBe('/')
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  )
  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/search'))
})

test.each(['owner', 'project'] as const)(
  'clearing replacement %s chips never restores inherited URL scope',
  async (kind) => {
    await page.viewport(600, 480)
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs')
          ? { searches: [] }
          : {
              ...empty,
              [kind === 'owner' ? 'owners' : 'projects']: [
                { id: 'replacement', name: 'Replacement' },
              ],
            },
      ),
    )
    vi.stubGlobal('fetch', fetcher)
    const router = createMemoryRouter(
      [
        {
          id: 'routes/_home/_protected/search',
          path: '/search',
          loader: () => ({
            result: {
              selectedScope: {
                owners: [{ id: 'inherited', name: 'Alex' }],
                projects: [{ id: 'inherited', name: 'Launch' }],
              },
            },
          }),
          element: <SearchPalette />,
        },
      ],
      { initialEntries: ['/search?q=report&' + kind + '=inherited'] },
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    await page.getByRole('button', { name: /^Search:/ }).click()
    const option = page.getByRole('option', {
      name: kind === 'owner' ? 'Replacement Owner' : 'Replacement Project',
      exact: true,
    })
    await expect.element(option).toBeVisible()
    await expect
      .element(
        page.getByRole('button', {
          name: kind === 'owner' ? /Owner: Alex/ : /Project: Launch/,
        }),
      )
      .toBeVisible()
    const inherited = new URL(
      String(fetcher.mock.calls.at(-1)?.[0]),
      window.location.origin,
    ).searchParams
    expect(inherited.get(kind === 'owner' ? 'owner' : 'projectId')).toBe(
      'inherited',
    )
    await option.click()
    await expect
      .element(
        page.getByRole('button', { name: /Remove the Replacement filter/ }),
      )
      .toBeVisible()
    if (kind === 'owner') {
      await page.getByRole('button', { name: /Owner: Alex/ }).click()
    }
    await page
      .getByRole('button', { name: /Remove the Replacement filter/ })
      .click()
    await vi.waitFor(() => {
      const last = new URL(
        String(fetcher.mock.calls.at(-1)?.[0]),
        window.location.origin,
      ).searchParams
      expect(last.has(kind === 'owner' ? 'owner' : 'projectId')).toBe(false)
    })
    await page.getByRole('combobox').click()
    await userEvent.keyboard('{Enter}')
    expect(new URLSearchParams(router.state.location.search).has(kind)).toBe(
      false,
    )
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe(
      'report',
    )
  },
)

test.each([false, true])(
  'mobile results Cancel uses only a known app predecessor (%s)',
  async (searchFromApp) => {
    await page.viewport(599, 480)
    const router = createMemoryRouter(
      [
        { path: '/', element: <p>Home destination</p> },
        { path: '/files', element: <p>Files destination</p> },
        { path: '/search', element: <SearchPalette /> },
      ],
      {
        initialEntries: [
          '/files',
          { pathname: '/search', state: { searchFromApp } },
        ],
      },
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(<RouterProvider router={router} />)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(
        searchFromApp ? '/files' : '/',
      ),
    )
  },
)

test('unresolved inherited IDs keep neutral labels without borrowing another selection name', async () => {
  await page.viewport(1280, 800)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) =>
      Response.json(
        String(url).includes('search-logs') ? { searches: [] } : empty,
      ),
    ),
  )
  const router = createMemoryRouter(
    [
      {
        id: 'routes/_home/_protected/search',
        path: '/search',
        loader: () => ({
          result: {
            selectedScope: {
              owners: [{ id: 'known', name: 'Alex' }],
              projects: [{ id: 'other-project', name: 'Launch' }],
            },
          },
        }),
        element: (
          <TooltipProvider>
            <Topbar
              workspaceName="Workspace"
              user={{
                id: 'viewer',
                name: 'Viewer',
                email: 'viewer@example.com',
                image: null,
                initial: 'V',
              }}
            />
          </TooltipProvider>
        ),
      },
    ],
    {
      initialEntries: [
        '/search?q=report&owner=known&owner=missing&project=missing',
      ],
    },
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await page.getByRole('button', { name: /^Search:/ }).click()
  await expect
    .element(page.getByRole('button', { name: /Owner: Alex/ }))
    .toBeVisible()
  await expect
    .element(page.getByRole('button', { name: /Owner: Unavailable selection/ }))
    .toBeVisible()
  await expect
    .element(
      page.getByRole('button', { name: /Project: Unavailable selection/ }),
    )
    .toBeVisible()
  await userEvent.keyboard('{Escape}')
  await router.navigate('/search?project=home')
  await page.getByRole('button', { name: /^Search:/ }).click()
  await expect
    .element(page.getByRole('button', { name: /Project: Home \(no project\)/ }))
    .toBeVisible()
})

import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AvatarMenu } from './avatar-menu'
import { TooltipProvider } from '~/components/ui/tooltip'
import { ViewerFixture } from '~/routes/dev.scenarios.$scenario/+components/viewer-fixture'
import { AppTopbar } from './app-topbar'
import '~/app.css'

const submitMock = vi.hoisted(() => vi.fn())
const navigateMock = vi.hoisted(() => vi.fn())

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useFetcher: () => ({ formData: null, submit: submitMock }),
  useNavigate: () => navigateMock,
  useRouteLoaderData: () => ({
    appTheme: 'system',
    accessRequestNotice: { count: 0 },
  }),
}))

vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({ openBanner: vi.fn() }),
}))

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('ja') }
})

let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  navigateMock.mockReset()
})

describe('AvatarMenu access requests', () => {
  test.each([
    { name: 'app avatar', variant: undefined, accessRequestsTopbar: undefined },
    {
      name: 'viewer-styled avatar in an app-height error topbar',
      variant: 'viewer' as const,
      accessRequestsTopbar: 'app' as const,
    },
  ])('keeps the sheet below the $name', async (menuProps) => {
    await page.viewport(1440, 900)
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/access-requests/count') {
          return Promise.resolve(Response.json({ count: 0 }))
        }
        if (url === '/api/access-requests') {
          return Promise.resolve(
            Response.json({
              received: [],
              sent: [],
              receivedPendingCount: 0,
            }),
          )
        }
        return Promise.resolve(new Response(null))
      }),
    )

    const host = document.createElement('div')
    const onAccessRequestsOpen = vi.fn()
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <TooltipProvider>
        <AppTopbar>
          <button type="button" data-home-header-action>
            Home action
          </button>
          <AvatarMenu
            user={{
              id: 'user-1',
              email: 'user@example.com',
              name: 'User',
              image: null,
              initial: 'U',
            }}
            variant={menuProps.variant}
            accessRequestsTopbar={menuProps.accessRequestsTopbar}
            onAccessRequestsOpen={onAccessRequestsOpen}
          />
        </AppTopbar>
      </TooltipProvider>,
    )

    await page.getByRole('button', { name: 'user@example.com' }).click()
    await page.getByRole('menuitem', { name: '閲覧リクエスト' }).click()

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        '未対応のリクエストはありません。',
      ),
    )
    await new Promise((resolve) => window.setTimeout(resolve, 600))

    const sheet = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )
    const topbar = document.querySelector<HTMLElement>('header')
    expect(sheet).not.toBeNull()
    expect(sheet?.getBoundingClientRect().top).toBe(
      topbar?.getBoundingClientRect().bottom,
    )
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
    expect(onAccessRequestsOpen).toHaveBeenCalledOnce()
    const headerAction = document.querySelector<HTMLButtonElement>(
      '[data-home-header-action]',
    )!
    const headerClick = vi.fn()
    headerAction.addEventListener('click', headerClick)
    headerAction.click()
    expect(headerClick).toHaveBeenCalledOnce()
    expect(sheet?.contains(document.activeElement)).toBe(true)
    expect(document.body.textContent).toContain(
      '未対応のリクエストはありません。',
    )
  })

  test.each([
    { viewport: 'desktop', width: 1440, height: 900 },
    { viewport: 'mobile', width: 390, height: 844 },
  ])(
    'keeps the sheet open from the actual Viewer chrome on $viewport',
    async ({ width, height }) => {
      await page.viewport(width, height)
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/access-requests/count') {
            return Promise.resolve(Response.json({ count: 0 }))
          }
          if (url === '/api/access-requests') {
            return Promise.resolve(
              Response.json({
                received: [],
                sent: [],
                receivedPendingCount: 0,
              }),
            )
          }
          return Promise.resolve(new Response(null))
        }),
      )

      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const router = createMemoryRouter(
        [
          {
            path: '*',
            element: (
              <TooltipProvider>
                <ViewerFixture tooltipOpen />
              </TooltipProvider>
            ),
          },
        ],
        { initialEntries: ['/a/fixture-viewer'] },
      )
      root.render(<RouterProvider router={router} />)

      await page.getByRole('button', { name: 'viewer@example.test' }).click()
      await page.getByRole('menuitem', { name: '閲覧リクエスト' }).click()

      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          '未対応のリクエストはありません。',
        ),
      )
      await new Promise((resolve) => window.setTimeout(resolve, 600))

      const sheet = document.querySelector('[data-slot="sheet-content"]')
      expect(sheet).not.toBeNull()
      if (width > 820) {
        const topbar = document.querySelector('#viewer-topbar')
        expect(sheet?.getBoundingClientRect().top).toBe(
          topbar?.getBoundingClientRect().bottom,
        )
      }
      expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
      expect(sheet?.contains(document.activeElement)).toBe(true)
      expect(document.body.textContent).toContain(
        '未対応のリクエストはありません。',
      )
    },
  )

  test.each([
    { viewport: 'desktop', width: 1440, height: 900 },
    { viewport: 'mobile', width: 390, height: 844 },
  ])(
    'opens a linked request over the actual Viewer on $viewport',
    async ({ width, height }) => {
      await page.viewport(width, height)
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/access-requests?request=request-1') {
            return Promise.resolve(
              Response.json({
                received: [
                  {
                    id: 'request-1',
                    requesterName: 'Requester',
                    requesterEmail: 'requester@example.com',
                    shareableId: 'fixture-viewer',
                    shareableTitle: 'Review notes',
                    projectId: 'fixture-project',
                    projectName: 'Fixture project',
                    canGrantArtifact: true,
                    canGrantProject: true,
                    createdAt: '2026-09-01T00:00:00.000Z',
                  },
                ],
                sent: [],
                receivedPendingCount: 1,
              }),
            )
          }
          return Promise.resolve(new Response(null))
        }),
      )

      const host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      const router = createMemoryRouter(
        [
          {
            path: '*',
            element: (
              <TooltipProvider>
                <ViewerFixture tooltipOpen />
              </TooltipProvider>
            ),
          },
        ],
        {
          initialEntries: ['/a/fixture-viewer?access-request=request-1'],
        },
      )
      root.render(<RouterProvider router={router} />)

      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          'Requester (requester@example.com)',
        ),
      )

      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).not.toBeNull()
      expect(document.body.textContent).toContain('Review notes')
      expect(document.querySelector('iframe')).not.toBeNull()

      await page.getByRole('button', { name: '閉じる' }).click()
      expect(navigateMock).toHaveBeenCalledWith(
        { pathname: '/a/fixture-viewer', search: '' },
        { replace: true },
      )
    },
  )

  test('shows a safe state when a linked request is no longer reviewable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === '/api/access-requests?request=processed') {
          return Promise.resolve(
            Response.json({
              received: [],
              sent: [],
              receivedPendingCount: 0,
            }),
          )
        }
        return Promise.resolve(new Response(null))
      }),
    )

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <TooltipProvider>
              <ViewerFixture tooltipOpen />
            </TooltipProvider>
          ),
        },
      ],
      { initialEntries: ['/a/fixture-viewer?access-request=processed'] },
    )
    root.render(<RouterProvider router={router} />)

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'このリクエストは処理済みか、現在は確認できません。',
      ),
    )

    expect(document.querySelector('iframe')).not.toBeNull()
    expect(document.body.textContent).not.toContain(
      '未対応のリクエストはありません。',
    )
  })
})

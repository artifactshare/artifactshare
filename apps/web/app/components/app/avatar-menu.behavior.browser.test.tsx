import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AvatarMenu } from './avatar-menu'
import { TooltipProvider } from '~/components/ui/tooltip'
import { ViewerFixture } from '~/routes/dev.scenarios.$scenario/+components/viewer-fixture'
import '~/app.css'

const submitMock = vi.hoisted(() => vi.fn())

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useFetcher: () => ({ formData: null, submit: submitMock }),
  useNavigate: () => vi.fn(),
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
})

describe('AvatarMenu access requests', () => {
  test('keeps the sheet open after selecting it when there are no requests', async () => {
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
    root.render(
      <TooltipProvider>
        <AvatarMenu
          variant="viewer"
          user={{
            id: 'user-1',
            email: 'user@example.com',
            name: 'User',
            image: null,
            initial: 'U',
          }}
        />
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

    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
    expect(document.activeElement).not.toBe(
      document.querySelector('button[aria-label="user@example.com"]'),
    )
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

      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).not.toBeNull()
      expect(document.body.textContent).toContain(
        '未対応のリクエストはありません。',
      )
    },
  )
})

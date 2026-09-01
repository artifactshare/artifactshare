import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AvatarMenu } from './avatar-menu'
import { TooltipProvider } from '~/components/ui/tooltip'
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
    await new Promise((resolve) => window.setTimeout(resolve, 250))

    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull()
    expect(document.body.textContent).toContain(
      '未対応のリクエストはありません。',
    )
  })
})

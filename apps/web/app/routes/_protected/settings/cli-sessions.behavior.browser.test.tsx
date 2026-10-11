import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import type { Locale } from '~/i18n/messages'
import '~/app.css'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  revokeAllCliRefreshCredentialFamilies: vi.fn(),
  revokeCliRefreshCredentialFamily: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'current-user' }),
}))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: vi.fn(),
  revokeAllCliRefreshCredentialFamilies:
    services.revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily: services.revokeCliRefreshCredentialFamily,
}))

const language = vi.hoisted(() => ({ locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useActionData: () => null,
  useNavigation: () => ({ state: 'idle' }),
  Form: ({ children }: { children: import('react').ReactNode }) => (
    <form>{children}</form>
  ),
}))
import CliSessionsPage from './cli-sessions'

test.each(['light', 'dark'])(
  'publisher access wraps while long names truncate and Revoke stays visible on phones (%s)',
  async (theme) => {
    await page.viewport(390, 844)
    document.documentElement.classList.toggle('dark', theme === 'dark')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const name = 'Dashboard '.repeat(10).trim()
    try {
      await act(async () =>
        root.render(
          <CliSessionsPage
            {...({
              params: {},
              matches: [] as never,
              loaderData: {
                cliFamilies: [
                  {
                    familyId: 'family-publisher',
                    preset: 'publisher',
                    publisherClientName: name,
                    deviceName: null,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    lastUsedAt: null,
                  },
                ],
              },
            } as Parameters<typeof CliSessionsPage>[0])}
          />,
        ),
      )
      const label =
        container.querySelector<HTMLElement>('[title]')!.parentElement!
      expect(label.textContent).toBe(name)
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth)
      expect(getComputedStyle(label).textOverflow).toBe('ellipsis')
      const access = label.parentElement!.nextElementSibling as HTMLElement
      expect(access.textContent).toContain(
        'Access: Create files and update its own',
      )
      expect(getComputedStyle(access).whiteSpace).toBe('normal')
      expect(access.scrollWidth).toBeLessThanOrEqual(access.clientWidth)
      expect(access.scrollHeight).toBeLessThanOrEqual(access.clientHeight)
      expect(access.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(getComputedStyle(access).lineHeight),
      )
      const revoke = page.getByRole('button', { name: 'Revoke', exact: true })
      await expect.element(revoke).toBeVisible()
      expect(
        revoke.element().getBoundingClientRect().right,
      ).toBeLessThanOrEqual(390)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      document.documentElement.classList.remove('dark')
      await page.viewport(1280, 800)
    }
  },
)

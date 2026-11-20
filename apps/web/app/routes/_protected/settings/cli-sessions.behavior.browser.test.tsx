import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import en from '~/i18n/en.json'
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
  useSubmit: () => vi.fn(),
  useNavigation: () => ({ state: 'idle' }),
  Form: ({ children }: { children: import('react').ReactNode }) => (
    <form>{children}</form>
  ),
}))
import { CliSessionsSection } from './+components/cli-sessions-section'
function CliSessionsPage({
  loaderData,
}: {
  loaderData: {
    cliFamilies: import('~/services/cli-refresh-credentials.server').CliRefreshCredentialFamily[]
  }
}) {
  return <CliSessionsSection cliFamilies={loaderData.cliFamilies} />
}

test.each(['light', 'dark'])(
  'publisher access wraps while long names wrap and Revoke stays visible on phones (%s)',
  async (theme) => {
    await page.viewport(390, 844)
    const previousTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
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
      const label = container.querySelector<HTMLElement>('td .font-medium')!
      expect(label.textContent).toContain(name)
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
      const access = label.parentElement!.lastElementChild as HTMLElement
      expect(access.textContent).toBe(
        `${en['team.tokens.cli.preset']}: ${en['team.tokens.cli.preset.publisher']}`,
      )
      expect(getComputedStyle(access).whiteSpace).toBe('normal')
      expect(access.scrollWidth).toBeLessThanOrEqual(access.clientWidth)
      expect(access.scrollHeight).toBeLessThanOrEqual(access.clientHeight)
      expect(access.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(getComputedStyle(access).lineHeight),
      )
      const revoke = page.getByRole('button', {
        name: `Revoke ${name} · ublisher`,
        exact: true,
      })
      await expect.element(revoke).toBeVisible()
      expect(
        revoke.element().getBoundingClientRect().right,
      ).toBeLessThanOrEqual(390)
      await revoke.click()
      await expect.element(page.getByRole('alertdialog')).toBeVisible()
      const dialog = document.querySelector('[role="alertdialog"]')!
      expect(dialog.textContent).toContain(name)
      await vi.waitFor(() =>
        expect(dialog.contains(document.activeElement)).toBe(true),
      )
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
      )
      await vi.waitFor(() =>
        expect(document.activeElement).toBe(revoke.element()),
      )
    } finally {
      await act(async () => root.unmount())
      container.remove()
      if (previousTheme === undefined)
        delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previousTheme
      await page.viewport(1280, 800)
    }
  },
)

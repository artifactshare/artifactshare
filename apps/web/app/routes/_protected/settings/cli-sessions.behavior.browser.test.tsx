import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import en from '~/i18n/en.json'
import type { Locale } from '~/i18n/messages'
import { fits, waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

import { settingsSingleFetch } from '~/test/settings-single-fetch'
import { action as tokensAction, clientAction } from './_content/tokens'

const services = vi.hoisted(() => ({
  revoke: vi.fn(),
  'revoke-cli-family': vi.fn(),
  'revoke-all-cli-families': vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'current-user' }),
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/dev-screen-state.server', () => ({
  isDevScreenStateRequest: vi.fn(),
}))
vi.mock('~/services/api-tokens.server', () => ({
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: services.revoke,
}))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: vi.fn(),
  revokeCliRefreshCredentialFamily: services['revoke-cli-family'],
  revokeAllCliRefreshCredentialFamilies: services['revoke-all-cli-families'],
}))

const language = vi.hoisted(() => ({ locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
import { CliSessionsSection } from './+components/cli-sessions-section'
test.each(['light', 'dark'])(
  'publisher access wraps while long names wrap and Revoke stays visible on phones (%s)',
  async (theme) => {
    await page.viewport(390, 844)
    const previousTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const name = 'DashboardX'.repeat(10)
    try {
      const router = createMemoryRouter(
        [
          {
            path: '/settings/tokens',
            element: (
              <CliSessionsSection
                onRevoked={vi.fn()}
                cliFamilies={[
                  {
                    familyId: 'family-publisher',
                    preset: 'publisher',
                    publisherClientName: name,
                    deviceName: null,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    lastUsedAt: null,
                  },
                ]}
              />
            ),
          },
        ],
        { initialEntries: ['/settings/tokens'] },
      )
      await act(async () => root.render(<RouterProvider router={router} />))
      const label = container.querySelector<HTMLElement>('td .font-medium')!
      expect(label.textContent).toContain(name)
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
      const access = label.parentElement!.lastElementChild as HTMLElement
      expect(access.textContent).toBe(
        `${en['team.tokens.cli.preset']}: ${en['team.tokens.cli.preset.publisher']}`,
      )
      expect(getComputedStyle(access).whiteSpace).toBe('normal')
      expect(access.scrollWidth).toBeLessThanOrEqual(access.clientWidth)
      // Firefox can report one extra pixel of visible glyph overflow.
      expect(getComputedStyle(access).overflowY).toBe('visible')
      expect(fits(access.scrollHeight, access.clientHeight)).toBe(true)
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
      await expect
        .element(page.getByRole('alertdialog'))
        .toHaveAccessibleName(`Revoke “${name} · ublisher”?`)
      await waitForBrowserLayout()
      const panel = dialog.getBoundingClientRect()
      for (const element of dialog.querySelectorAll('h2, p, button')) {
        const range = document.createRange()
        range.selectNodeContents(element)
        const bounds = range.getBoundingClientRect()
        expect(bounds.left).toBeGreaterThanOrEqual(panel.left)
        expect(bounds.right).toBeLessThanOrEqual(panel.right)
        if (element instanceof HTMLButtonElement) {
          const rect = element.getBoundingClientRect()
          expect(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          ).toBe(element)
        }
      }
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

import ApiTokensPage from './+components/ai-tools-page'
import { userEvent } from 'vitest/browser'
import ja from '~/i18n/ja.json'

test.each(['en', 'ja'] as const)(
  'token Name labels the filled input visibly (%s)',
  async (locale) => {
    language.locale = locale
    const copy = locale === 'en' ? en : ja
    const router = createMemoryRouter(
      [
        {
          path: '/settings/tokens',
          element: (
            <ApiTokensPage
              loaderData={{ tokens: [], cliFamilies: [], createdToken: null }}
            />
          ),
        },
      ],
      { initialEntries: ['/settings/tokens'] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      const input = page.getByRole('textbox', {
        name: copy['team.tokens.name'],
      })
      await input.fill('Daily')
      const label = container.querySelector<HTMLLabelElement>(
        'label[for="token-name"]',
      )!
      expect(label.control).toBe(input.element())
      await expect.element(input).toHaveValue('Daily')
      await expect.element(page.elementLocator(label)).toBeVisible()
      expect(label.getBoundingClientRect().width).toBeGreaterThan(1)
      expect(label.getBoundingClientRect().height).toBeGreaterThan(1)
      expect(getComputedStyle(label).clipPath).toBe('none')
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
      language.locale = 'en'
    }
  },
)

for (const locale of ['en', 'ja'] as const)
  test.each([
    'revoke',
    'revoke-cli-family',
    'revoke-all-cli-families',
  ] as const)(
    '%s keeps the confirmation through failure, retry and reload (' +
      locale +
      ')',
    async (intent) => {
      language.locale = locale
      const copy = locale === 'en' ? en : ja
      const tokenName = 'W'.repeat(100)
      const data = {
        tokens: [
          {
            id: 'api',
            name: tokenName,
            createdAt: '2026-01-01',
            lastUsedAt: null,
          },
        ],
        cliFamilies: [
          {
            familyId: 'family-12345678',
            deviceName: 'Reports',
            publisherClientName: null,
            preset: 'unrestricted' as const,
            createdAt: '2026-01-01',
            lastUsedAt: null,
            expiresAt: '2099-01-01',
          },
        ],
        createdToken: null,
      }
      if (intent !== 'revoke')
        data.cliFamilies.push({
          ...data.cliFamilies[0],
          familyId: 'family-87654321',
          deviceName: 'Laptop',
        })
      const targetedRows =
        intent === 'revoke'
          ? []
          : (intent === 'revoke-cli-family'
              ? data.cliFamilies.slice(0, 1)
              : data.cliFamilies
            ).map((family) =>
              page.getByText(
                `${family.deviceName} · ${family.familyId.slice(-8)}`,
                { exact: true },
              ),
            )
      let currentData = data
      let reloadStarted = false
      let release!: () => void
      const service = services[intent].mockReset()
      service.mockImplementation(async (_db, _user, id) => {
        const attempt = service.mock.calls.length
        await new Promise<void>((resolve) => {
          release = resolve
        })
        if (attempt === 1) return intent === 'revoke' ? true : 'ok'
        if (intent === 'revoke') {
          if (attempt === 2) return false
          currentData = {
            ...data,
            tokens: data.tokens.filter((token) => token.id !== id),
          }
          return true
        }
        currentData = {
          ...data,
          cliFamilies:
            intent === 'revoke-all-cli-families'
              ? []
              : data.cliFamilies.filter((family) => family.familyId !== id),
        }
        return 'ok'
      })
      const expectedIds =
        intent === 'revoke'
          ? ['api']
          : intent === 'revoke-cli-family'
            ? ['family-12345678']
            : []
      const expectDispatch = (attempt: number) =>
        vi.waitFor(() =>
          expect(service).toHaveBeenNthCalledWith(
            attempt,
            {},
            'current-user',
            ...expectedIds,
          ),
        )
      let releaseLoader!: () => void
      const loaderGate = new Promise<void>((resolve) => {
        releaseLoader = resolve
      })
      let router: ReturnType<typeof createMemoryRouter>
      let responses = 0
      const { routes, dataStrategy } = settingsSingleFetch({
        path: '/settings/tokens',
        Component: () => (
          <ApiTokensPage loaderData={useLoaderData<typeof data>()} />
        ),
        clientAction,
        action: (args) =>
          tokensAction({ ...args, pattern: '/settings/tokens' }),
        getRouter: () => router,
        fetchResponse: async (request, handle) => {
          const response = await handle(request)
          if (++responses === 1)
            throw new TypeError('Connection lost after dispatch')
          return response
        },
      })
      routes[0].loader = async () => {
        if (currentData !== data) {
          reloadStarted = true
          await loaderGate
        }
        return currentData
      }
      router = createMemoryRouter(routes, {
        initialEntries: ['/settings/tokens'],
        dataStrategy,
      })
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      try {
        if (intent === 'revoke') await page.viewport(390, 400)
        await act(async () => root.render(<RouterProvider router={router} />))
        const trigger = page.getByRole('button', {
          name:
            intent === 'revoke-all-cli-families'
              ? copy['team.tokens.cli.revokeAll']
              : `${copy['team.tokens.revoke']} ${intent === 'revoke' ? tokenName : 'Reports · 12345678'}`,
          exact: true,
        })
        for (const row of targetedRows)
          await expect.element(row).toBeInTheDocument()
        await trigger.click()
        const dialog = page.getByRole('alertdialog')
        if (intent !== 'revoke-all-cli-families') {
          const targetName =
            intent === 'revoke' ? tokenName : 'Reports · 12345678'
          await expect
            .element(dialog)
            .toHaveAccessibleName(
              locale === 'en'
                ? `Revoke “${targetName}”?`
                : `「${targetName}」を失効させますか？`,
            )
        }
        const consequences =
          locale === 'en'
            ? {
                revoke: `Apps using “${tokenName}” will lose API access.`,
                'revoke-cli-family':
                  'Revoking this session requires signing in again on that device or publisher client.',
                'revoke-all-cli-families':
                  'Sign in again on every CLI device and publisher client to restore access.',
              }
            : {
                revoke: `「${tokenName}」を使った API リクエストは認証に失敗します。`,
                'revoke-cli-family':
                  'このセッションを失効させると、その端末または投稿用クライアントで再ログインが必要になります。',
                'revoke-all-cli-families':
                  '再び利用するには、すべての CLI 端末と投稿用クライアントでログインし直してください。',
              }
        const consequence = consequences[intent]
        if (intent === 'revoke-all-cli-families') {
          const button = dialog
            .element()
            .querySelector('[data-slot="alert-dialog-action"]')!
          for (const width of [390, 1280]) {
            await page.viewport(width, 800)
            await waitForBrowserLayout()
            const label = document.createRange()
            label.selectNodeContents(button)
            const textBounds = label.getBoundingClientRect()
            const bounds = button.getBoundingClientRect()
            expect(textBounds.width).toBeGreaterThan(0)
            expect(textBounds.left).toBeGreaterThanOrEqual(bounds.left)
            expect(textBounds.right).toBeLessThanOrEqual(bounds.right)
          }
        }
        const action = dialog.getByRole('button', {
          name:
            intent === 'revoke-all-cli-families'
              ? copy['team.tokens.cli.revokeAllConfirm.action']
              : copy['team.tokens.revoke'],
          exact: true,
        })
        const busy = dialog.getByRole('button', {
          name: locale === 'en' ? 'Revoking…' : '失効中…',
          exact: true,
        })
        await action.click()
        await expectDispatch(1)
        await expect.element(dialog).toHaveAttribute('data-state', 'open')
        await expect.element(dialog).toBeVisible()
        await expect.element(busy).toBeDisabled()
        await expect
          .element(dialog.getByText(consequence, { exact: true }))
          .toBeVisible()
        expect(busy.element().className).toContain('bg-destructive')
        await expect
          .element(
            dialog.getByRole('button', {
              name: copy['confirm.cancel'],
              exact: true,
            }),
          )
          .toBeDisabled()
        await userEvent.keyboard('{Escape}')
        await expect.element(dialog).toHaveAttribute('data-state', 'open')
        await expect.element(dialog).toBeVisible()
        await act(async () => release())
        await expect
          .element(dialog.getByRole('alert'))
          .toHaveTextContent(
            bindI18n(locale).t('settings.submissionInterrupted'),
          )
        const retry = dialog.getByRole('button', { name: copy['dialog.retry'] })
        if (intent === 'revoke') {
          await waitForBrowserLayout()
          const panel = dialog.element().getBoundingClientRect()
          expect(panel.top).toBeGreaterThanOrEqual(0)
          expect(panel.bottom).toBeLessThanOrEqual(window.innerHeight)
          for (const target of [
            dialog.getByRole('heading'),
            dialog.getByText(consequence, { exact: true }),
            dialog.getByRole('alert'),
            dialog.getByRole('button', { name: copy['confirm.cancel'] }),
            retry,
          ]) {
            const element = target.element()
            element.scrollIntoView({ block: 'nearest' })
            const bounds = element.getBoundingClientRect()
            expect(bounds.top).toBeGreaterThanOrEqual(panel.top)
            expect(bounds.bottom).toBeLessThanOrEqual(panel.bottom)
            expect(
              element.contains(
                document.elementFromPoint(
                  bounds.x + bounds.width / 2,
                  bounds.y + bounds.height / 2,
                ),
              ),
            ).toBe(true)
          }
        }
        await retry.click()
        await expectDispatch(2)
        await expect.element(busy).toBeDisabled()
        await expect.element(dialog.getByRole('alert')).not.toBeInTheDocument()
        await act(async () => release())
        if (intent === 'revoke') {
          await expect
            .element(dialog.getByRole('alert'))
            .toHaveTextContent(
              locale === 'en'
                ? 'This token is unavailable.'
                : 'このトークンは利用できません。',
            )
          const close = dialog.getByRole('button', {
            name: copy['common.close'],
            exact: true,
          })
          await expect.element(close).toBeVisible()
          expect(dialog.getByRole('button').all()).toHaveLength(1)
          await expect.element(close).toHaveFocus()
          await userEvent.keyboard('{Escape}')
          await expect.element(dialog).not.toBeInTheDocument()
          expect(service).toHaveBeenCalledTimes(2)
          await trigger.click()
          await action.click()
          await expectDispatch(3)
          await act(async () => release())
        }
        await vi.waitFor(() => expect(reloadStarted).toBe(true))
        for (const row of targetedRows)
          await expect.element(row).toBeInTheDocument()
        await expect.element(dialog).toHaveAttribute('data-state', 'open')
        await expect.element(busy).toBeDisabled()
        await act(async () => releaseLoader())
        for (const row of targetedRows)
          await expect.element(row).not.toBeInTheDocument()
        await expect.element(dialog).not.toBeInTheDocument()
        await expect.element(trigger).not.toBeInTheDocument()
        await expect
          .element(
            page.getByRole('heading', {
              name:
                intent === 'revoke'
                  ? copy['team.tokens.api.title']
                  : copy['settings.cli.title'],
              exact: true,
            }),
          )
          .toHaveFocus()
        if (intent === 'revoke-cli-family') {
          const alreadyRevoked = page.getByText(
            copy['team.tokens.cli.alreadyRevoked'],
            { exact: true },
          )
          await expect.element(alreadyRevoked).not.toBeInTheDocument()

          // The remaining session was revoked elsewhere before this confirmation.
          service.mockImplementationOnce(() => {
            currentData = { ...data, cliFamilies: [] }
            return 'noop'
          })
          await page
            .getByRole('button', {
              name: `${copy['team.tokens.revoke']} Laptop · 87654321`,
              exact: true,
            })
            .click()
          await action.click()
          await vi.waitFor(() =>
            expect(service).toHaveBeenNthCalledWith(
              3,
              {},
              'current-user',
              'family-87654321',
            ),
          )
          await expect.element(dialog).not.toBeInTheDocument()
          await expect.element(alreadyRevoked).toBeVisible()
        }
      } finally {
        await act(async () => root.unmount())
        router.dispose()
        container.remove()
        language.locale = 'en'
        await page.viewport(1280, 800)
      }
    },
  )

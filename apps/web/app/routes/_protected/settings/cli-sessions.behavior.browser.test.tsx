import { createMemoryRouter, RouterProvider, useLoaderData } from 'react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import en from '~/i18n/en.json'
import type { Locale } from '~/i18n/messages'
import { fits } from '~/test/browser-layout'
import '~/app.css'

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
    const name = 'Dashboard '.repeat(10).trim()
    try {
      const router = createMemoryRouter(
        [
          {
            path: '/settings/tokens',
            element: (
              <CliSessionsSection
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
      const data = {
        tokens: [
          {
            id: 'api',
            name: 'Weekly reports',
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
      let attempts = 0
      let reloading = false
      let release: () => void
      let markReloadStarted!: () => void
      const reloadStarted = new Promise<void>((resolve) => {
        markReloadStarted = resolve
      })
      let releaseLoader!: () => void
      const loaderGate = new Promise<void>((resolve) => {
        releaseLoader = resolve
      })
      const router = createMemoryRouter(
        [
          {
            path: '/settings/tokens',
            Component: () => (
              <ApiTokensPage loaderData={useLoaderData<typeof data>()} />
            ),
            loader: async () => {
              if (reloading) {
                markReloadStarted()
                await loaderGate
                return { ...data, tokens: [], cliFamilies: [] }
              }
              return data
            },
            action: async ({ request }) => {
              expect((await request.formData()).get('intent')).toBe(intent)
              attempts++
              await new Promise<void>((resolve) => {
                release = resolve
              })
              if (attempts === 1) return { kind: 'revoke-failed', intent }
              if (intent === 'revoke' && attempts === 2)
                return { kind: 'revoke-unavailable', intent }
              reloading = true
              return { kind: 'revoked', intent }
            },
          },
        ],
        { initialEntries: ['/settings/tokens'] },
      )
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      try {
        await act(async () => root.render(<RouterProvider router={router} />))
        const trigger = page.getByRole('button', {
          name:
            intent === 'revoke-all-cli-families'
              ? copy['team.tokens.cli.revokeAll']
              : `${copy['team.tokens.revoke']} ${intent === 'revoke' ? 'Weekly reports' : 'Reports · 12345678'}`,
          exact: true,
        })
        await trigger.click()
        const dialog = page.getByRole('alertdialog')
        const consequences =
          locale === 'en'
            ? {
                revoke: 'Apps using “Weekly reports” will lose API access.',
                'revoke-cli-family':
                  'To use “Reports · 12345678” again, sign in again on that device or publisher client.',
                'revoke-all-cli-families':
                  'Sign in again on every CLI device and publisher client to restore access.',
              }
            : {
                revoke:
                  '「Weekly reports」を使った API リクエストは認証に失敗します。',
                'revoke-cli-family':
                  '「Reports · 12345678」を再び使うには、その端末または投稿用クライアントでログインし直してください。',
                'revoke-all-cli-families':
                  '再び利用するには、すべての CLI 端末と投稿用クライアントでログインし直してください。',
              }
        const consequence = consequences[intent]
        const action = dialog.getByRole('button', {
          name:
            intent === 'revoke-all-cli-families'
              ? copy['team.tokens.cli.revokeAll']
              : copy['team.tokens.revoke'],
          exact: true,
        })
        const busy = dialog.getByRole('button', {
          name: copy['confirm.pending'],
          exact: true,
        })
        await action.click()
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
        await vi.waitFor(() => {
          expect(attempts).toBe(1)
          expect(release).toBeDefined()
        })
        await act(async () => release())
        const failureMessage =
          locale === 'en'
            ? 'Could not revoke access. Try again.'
            : 'アクセスを失効できませんでした。もう一度お試しください。'
        await expect
          .element(dialog.getByRole('alert'))
          .toHaveTextContent(failureMessage)
        const retry = dialog.getByRole('button', { name: copy['dialog.retry'] })
        await retry.click()
        await vi.waitFor(() => expect(attempts).toBe(2))
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
          expect(attempts).toBe(2)
          await trigger.click()
          await action.click()
          await vi.waitFor(() => expect(attempts).toBe(3))
          await act(async () => release())
        }
        await reloadStarted
        await expect.element(dialog).toHaveAttribute('data-state', 'open')
        await expect.element(busy).toBeDisabled()
        await act(async () => releaseLoader())
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
      } finally {
        await act(async () => root.unmount())
        router.dispose()
        container.remove()
        language.locale = 'en'
      }
    },
  )

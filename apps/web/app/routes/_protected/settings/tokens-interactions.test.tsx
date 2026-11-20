// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
import { ConfirmActionDialog } from './+components/confirm-action-dialog'
import ApiTokensPage from './+components/ai-tools-page'

test.each(['token', 'session', 'session-noop'] as const)(
  'single %s revoke names its target and dispatches only after confirmation',
  async (kind) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const data = {
      tokens: [
        {
          id: 'token-a',
          name: 'Report automation',
          createdAt: '2026-01-01',
          lastUsedAt: null,
        },
      ],
      createdToken: null,
      cliFamilies: [
        {
          familyId: 'session-12345678',
          preset: 'unrestricted' as const,
          deviceName: null,
          publisherClientName: null,
          createdAt: '2026-01-01',
          lastUsedAt: null,
          expiresAt: '2099-01-01',
        },
      ],
    }
    const submissions: FormData[] = []
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData()
      submissions.push(form)
      if (form.get('intent') === 'revoke') data.tokens = []
      else data.cliFamilies = []
      return kind === 'session-noop' ? { kind: 'cli-revoke-noop' } : null
    })
    const router = createMemoryRouter(
      [
        {
          path: '/settings/tokens',
          loader: () => data,
          action,
          Component: () => <ApiTokensPage loaderData={data} />,
        },
      ],
      { initialEntries: ['/settings/tokens'] },
    )
    const name =
      kind === 'token' ? 'Report automation' : 'CLI session · 12345678'
    const button = () => {
      const element = container.querySelector<HTMLButtonElement>(
        `button[aria-label="Revoke ${name}"]`,
      )
      expect(element).not.toBeNull()
      return element!
    }
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await vi.waitFor(() => expect(button()).toBeTruthy())
      await act(async () => button().click())
      expect(
        document.querySelector('[role="alertdialog"]')?.textContent,
      ).toContain(name)
      expect(action).not.toHaveBeenCalled()
      const cancel = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((b) => b.textContent === 'Cancel')!
      await act(async () => cancel.click())
      expect(action).not.toHaveBeenCalled()
      await act(async () => button().click())
      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((b) => b.textContent === 'Revoke')!
      await act(async () => confirm.click())
      await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1))
      expect(Object.fromEntries(submissions[0])).toEqual(
        kind === 'token'
          ? { intent: 'revoke', tokenId: 'token-a' }
          : { intent: 'revoke-cli-family', familyId: 'session-12345678' },
      )
      await vi.waitFor(() =>
        expect(
          container.querySelector(`button[aria-label="Revoke ${name}"]`),
        ).toBeNull(),
      )
      expect(
        kind === 'token' ? data.cliFamilies.length : data.tokens.length,
      ).toBe(1)
      if (kind === 'session-noop')
        expect(container.textContent).toContain(
          bindI18n('en').t('team.tokens.cli.alreadyRevoked'),
        )
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

test('shared confirmation labels pending work even without a caller label', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const render = (pending: boolean, pendingLabel?: string) =>
    root.render(
      <ConfirmActionDialog
        open
        onOpenChange={() => {}}
        onConfirm={() => {}}
        title="Confirm change"
        description="Apply this change."
        action="Apply"
        awaitResult
        pending={pending}
        pendingLabel={pendingLabel}
      />,
    )
  try {
    await act(async () => render(false))
    const button = document.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] button[aria-busy]',
    )!
    expect(button.textContent).toBe('Apply')
    expect(button.disabled).toBe(false)
    await act(async () => render(true))
    expect(button.textContent).toBe('Processing…')
    expect(button.disabled).toBe(true)
    await act(async () => render(true, 'Saving…'))
    expect(button.textContent).toBe('Saving…')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  RouterProvider,
  RouterContextProvider,
  useLoaderData,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
const services = vi.hoisted(() => ({
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
  revokeCliRefreshCredentialFamily: vi.fn(),
}))
vi.mock('~/services/api-tokens.server', () => services)
vi.mock('~/services/cli-refresh-credentials.server', () => services)
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner' }),
}))
import { action as tokenAction } from './tokens'
import { ConfirmActionDialog } from '../+components/confirm-action-dialog'
import ApiTokensPage from '../+components/ai-tools-page'

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
    let releaseAction!: () => void
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve
    })
    let releaseLoader!: () => void
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve
    })
    let serverData = data
    const submissions: FormData[] = []
    services.revokeApiToken.mockImplementation(() => {
      serverData = { ...data, tokens: [] }
      return true
    })
    services.revokeCliRefreshCredentialFamily.mockImplementation(async () => {
      if (kind === 'session-noop') await actionGate
      serverData = { ...data, cliFamilies: [] }
      return kind === 'session-noop' ? 'noop' : 'ok'
    })
    const action = vi.fn(async ({ request }: { request: Request }) => {
      submissions.push(await request.clone().formData())
      return tokenAction({
        request,
        context: new RouterContextProvider(),
        params: {},
        url: new URL(request.url),
        pattern: '/settings/tokens',
      })
    })
    const router = createMemoryRouter(
      [
        {
          path: '/settings/tokens',
          loader: async () => {
            if (kind === 'session-noop' && serverData !== data) await loaderGate
            return serverData
          },
          action,
          Component: () => (
            <ApiTokensPage loaderData={useLoaderData<typeof data>()} />
          ),
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
      if (kind === 'session-noop') {
        expect(confirm.closest('[role="alertdialog"]')?.isConnected).toBe(true)
        expect(confirm.disabled).toBe(true)
        await act(async () => releaseAction())
        expect(
          [...router.state.fetchers.values()].map((f) => f.state),
        ).toContain('loading')
        expect(confirm.closest('[role="alertdialog"]')?.isConnected).toBe(true)
        expect(confirm.disabled).toBe(true)
        expect(button().isConnected).toBe(true)
        await act(async () => releaseLoader())
      }
      await vi.waitFor(() =>
        expect(
          container.querySelector(`button[aria-label="Revoke ${name}"]`),
        ).toBeNull(),
      )
      expect(
        container.querySelector(
          `button[aria-label="Revoke ${kind === 'token' ? 'CLI session · 12345678' : 'Report automation'}"]`,
        ),
      ).not.toBeNull()
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
      )
      if (kind === 'session-noop')
        expect(
          container.querySelector('[role="status"]')?.textContent,
        ).toContain(bindI18n('en').t('team.tokens.cli.alreadyRevoked'))
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

test('create then revoke replaces the success notice and keeps the created credential', async () => {
  services.createApiToken.mockResolvedValue({
    name: 'New credential',
    token: 'example-token-value',
  })
  services.revokeApiToken.mockResolvedValue(true)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const router = createMemoryRouter(
    [
      {
        path: '/settings/tokens',
        action: (args) =>
          tokenAction({
            ...args,
            context: new RouterContextProvider(),
            url: new URL(args.request.url),
            pattern: '/settings/tokens',
          }),
        element: (
          <TooltipProvider>
            <ApiTokensPage
              loaderData={{
                tokens: [
                  {
                    id: 'old',
                    name: 'Old credential',
                    createdAt: '2026-01-01',
                    lastUsedAt: null,
                  },
                ],
                cliFamilies: [],
                createdToken: null,
              }}
            />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: ['/settings/tokens'] },
  )
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const input = container.querySelector<HTMLInputElement>('#token-name')!
    input.value = 'New credential'
    await act(async () =>
      input
        .form!.querySelector<HTMLButtonElement>('button[type=submit]')!
        .click(),
    )
    const notices = () =>
      container.querySelectorAll('[data-settings-status="ok"]')
    await vi.waitFor(() => expect(notices()).toHaveLength(1))
    const createdNotice = notices()[0]
    expect(container.textContent).toContain('example-token-value')
    // The secret is marked so capture diagnostics never copy it.
    const secret = container.querySelector('code[data-gap-audit-redact]')
    expect(secret?.textContent).toBe('example-token-value')
    // The secret wraps instead of scrolling past a narrow viewport's edge.
    expect(secret?.className).toContain('whitespace-pre-wrap')
    expect(secret?.closest('pre')?.className).not.toContain('overflow-x-auto')
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Revoke Old credential"]',
        )!
        .click(),
    )
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="alertdialog"] button',
      ),
    ].find((button) => button.textContent === 'Revoke')!
    await act(async () => confirm.click())
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
    )
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).not.toBe(createdNotice)
    expect(container.textContent).toContain('example-token-value')
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

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

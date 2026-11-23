import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  RouterContextProvider,
  useLoaderData,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import IntegrationsPage, { action as disconnect } from './integrations'
import '~/app.css'

const services = vi.hoisted(() => ({ deleteWorkspaceSlackConnection: vi.fn() }))
vi.mock('~/services/slack.server', () => services)
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner' }),
}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

// Real dialog/form boundary; the controlled action never contacts Slack.
test.each(['retry', 'dismiss and reopen'] as const)(
  'Slack disconnect submits the named connection again after a failed action (%s)',
  async (recovery) => {
    const submissions: {
      method: string
      fields: Record<string, FormDataEntryValue>
    }[] = []
    // The service is reached after the action reads its form, so each
    // release waits for its own call instead of a shared variable.
    const calls: ((result: { kind: string }) => void)[] = []
    services.deleteWorkspaceSlackConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          calls.push(resolve)
        }),
    )
    const release = async (call: number, result: { kind: string }) => {
      await vi.waitFor(() => expect(calls).toHaveLength(call))
      await act(async () => calls[call - 1](result))
    }
    const router = createMemoryRouter(
      [
        {
          element: <Outlet context={{ currentUserIsAdmin: true }} />,
          children: [
            {
              path: '/settings/integrations',
              element: (
                <IntegrationsPage
                  loaderData={{
                    connections: [
                      {
                        id: 'slack',
                        teamName: 'Example team',
                        installedAt: '2026-01-01T00:00:00.000Z',
                        installedByName: 'Owner',
                        needsReauthorization: false,
                      },
                    ],
                  }}
                />
              ),
              action: async ({ request }) => {
                submissions.push({
                  method: request.method,
                  fields: Object.fromEntries(await request.clone().formData()),
                })
                return disconnect({
                  request,
                  context: new RouterContextProvider(),
                  params: {},
                  url: new URL(request.url),
                  pattern: '/settings/integrations',
                })
              },
            },
          ],
        },
      ],
      { initialEntries: ['/settings/integrations'] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      const trigger = page.getByRole('button', {
        name: 'Disconnect',
        exact: true,
      })
      await trigger.click()
      const dialog = page.getByRole('alertdialog')
      await expect
        .element(dialog)
        .toMatchTextContent(/Disconnect Example team\?/)
      await expect.element(dialog).toMatchTextContent(/authorize Slack again/)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions).toHaveLength(0)
      await trigger.click()
      const confirm = dialog.getByRole('button', {
        name: 'Disconnect',
        exact: true,
      })
      expect(confirm.element().className).toContain('bg-destructive')
      await confirm.click()
      await vi.waitFor(() => expect(submissions).toHaveLength(1))
      const expectedPost = {
        method: 'POST',
        fields: { intent: 'disconnect-slack', connectionId: 'slack' },
      }
      expect(submissions).toEqual([expectedPost])
      await expect.element(dialog).toHaveAttribute('data-state', 'open')
      const busyAction = dialog.getByRole('button', {
        name: 'Disconnecting…',
        exact: true,
      })
      await expect.element(busyAction).toBeDisabled()
      await expect.element(busyAction).toHaveAttribute('aria-busy', 'true')
      await expect
        .element(dialog.getByRole('button', { name: 'Cancel', exact: true }))
        .toBeDisabled()
      const disabledTrigger = busyAction.element()
      if (!(disabledTrigger instanceof HTMLButtonElement))
        throw new Error('Expected disconnect button')
      disabledTrigger.click()
      expect(submissions).toHaveLength(1)
      await release(1, { kind: 'external-failed' })
      await expect
        .element(dialog.getByRole('alert'))
        .toHaveTextContent(bindI18n('en').t('team.status.externalFailed'))
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      const retry = dialog.getByRole('button', { name: 'Retry', exact: true })
      await expect.element(retry).toBeEnabled()
      if (recovery === 'retry') {
        await retry.click()
      } else {
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click()
        await expect.element(dialog).not.toBeInTheDocument()
        // Dismissing ends the attempt; the page does not repeat its failure.
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
        await trigger.click()
        await expect.element(dialog.getByRole('alert')).not.toBeInTheDocument()
        await confirm.click()
      }
      await vi.waitFor(() => expect(submissions).toHaveLength(2))
      await expect.element(dialog).toHaveAttribute('data-state', 'open')
      await expect.element(busyAction).toBeDisabled()
      await release(2, { kind: 'ok' })
      await vi.waitFor(() =>
        expect(
          container.querySelector(
            '[data-settings-status="slack-disconnected"]',
          ),
        ).not.toBeNull(),
      )
      await expect.element(dialog).not.toBeInTheDocument()
      expect(submissions).toEqual([expectedPost, expectedPost])
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

// Revalidation can remove the permission-dependent controls after a submission.
// A real router/browser is needed to observe the dialog unmount and surviving alert.
test.each(['forbidden', 'not-found'] as const)(
  'Slack action %s remains visible outside permission-dependent controls',
  async (error) => {
    let canManage = true
    let release!: (result: { kind: string }) => void
    services.deleteWorkspaceSlackConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    function SettingsContext() {
      const currentUserIsAdmin = useLoaderData<boolean>()
      return (
        <TooltipProvider>
          <Outlet context={{ currentUserIsAdmin }} />
        </TooltipProvider>
      )
    }
    const connections = [
      {
        id: 'slack',
        teamName: 'Example team',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByName: 'Owner',
        needsReauthorization: false,
      },
    ]
    let removed = false
    function ConnectionPage() {
      const data = useLoaderData<{ connections: typeof connections }>()
      return <IntegrationsPage loaderData={data} />
    }
    const router = createMemoryRouter(
      [
        {
          loader: () => canManage,
          Component: SettingsContext,
          children: [
            {
              path: '/settings/integrations',
              loader: () => ({ connections: removed ? [] : connections }),
              Component: ConnectionPage,
              action: ({ request }) =>
                disconnect({
                  request,
                  context: new RouterContextProvider(),
                  params: {},
                  url: new URL(request.url),
                  pattern: '/settings/integrations',
                }),
            },
          ],
        },
      ],
      { initialEntries: ['/settings/integrations'] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      const trigger = page.getByRole('button', {
        name: 'Disconnect',
        exact: true,
      })
      await expect.element(trigger).toBeEnabled()
      await trigger.click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Disconnect', exact: true })
        .click()
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      await act(async () => release({ kind: error }))
      await expect
        .element(page.getByRole('alertdialog').getByRole('alert'))
        .toBeVisible()
      if (error === 'forbidden') canManage = false
      else removed = true
      await act(async () => {
        await router.revalidate()
      })
      await expect
        .element(page.getByRole('alertdialog'))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('alert'))
        .toHaveTextContent(
          'Could not disconnect Example team from Slack.' +
            bindI18n('en').t(
              error === 'forbidden'
                ? 'team.status.forbidden'
                : 'team.status.notFound',
            ),
        )
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      if (error === 'forbidden') {
        await expect
          .element(page.getByRole('alert'))
          .toMatchTextContent(/Example team/)
        await expect.element(trigger).toBeDisabled()
      }
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  useLoaderData,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import IntegrationsPage from './integrations'
import '~/app.css'

vi.mock('~/services/slack.server', () => ({}))
vi.mock('~/services/db.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

// Real dialog/form boundary; the controlled action never contacts Slack.
test.each(['retry', 'dismiss and reopen'] as const)(
  'Slack disconnect submits the named connection again after a failed action (%s)',
  async (recovery) => {
    const submissions: {
      method: string
      fields: Record<string, FormDataEntryValue>
    }[] = []
    let release!: (result: Response) => void
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
                  fields: Object.fromEntries(await request.formData()),
                })
                return new Promise<Response>((resolve) => {
                  release = resolve
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
      await act(async () =>
        release(
          Response.json({ error: 'external-failed', connectionId: 'slack' }),
        ),
      )
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
        await expect
          .element(page.getByRole('alert'))
          .toMatchTextContent(/Example team/)
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
        await trigger.click()
        await expect.element(dialog.getByRole('alert')).not.toBeInTheDocument()
        await confirm.click()
      }
      await vi.waitFor(() => expect(submissions).toHaveLength(2))
      await expect.element(dialog).toHaveAttribute('data-state', 'open')
      await expect.element(busyAction).toBeDisabled()
      await act(async () =>
        release(
          new Response(null, {
            status: 302,
            headers: {
              Location: '/settings/integrations?status=slack-disconnected',
            },
          }),
        ),
      )
      await vi.waitFor(() =>
        expect(router.state.location.search).toBe('?status=slack-disconnected'),
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
test.each(['forbidden', 'invalid', 'not-found'] as const)(
  'Slack action %s remains visible outside permission-dependent controls',
  async (error) => {
    let canManage = true
    let release:
      | ((result: { error: string; connectionId?: string }) => void)
      | undefined
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
              action: () =>
                new Promise<{ error: string; connectionId?: string }>(
                  (resolve) => {
                    release = resolve
                  },
                ),
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
      if (error !== 'invalid') {
        await trigger.click()
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Disconnect', exact: true })
          .click()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        await expect.element(page.getByRole('alertdialog')).toBeInTheDocument()
        if (error === 'forbidden') canManage = false
        else removed = true
      } else {
        // Invalid submissions need an error even without a submitted dialog.
        void router.navigate('/settings/integrations', {
          formMethod: 'post',
          formData: new FormData(),
        })
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      }
      await act(async () =>
        release!({
          error,
          ...(error !== 'invalid' ? { connectionId: 'slack' } : {}),
        }),
      )
      await vi.waitFor(() => expect(router.state.navigation.state).toBe('idle'))
      await expect
        .element(page.getByRole('alertdialog'))
        .not.toBeInTheDocument()
      await expect
        .element(page.getByRole('alert'))
        .toHaveTextContent(
          (error !== 'invalid'
            ? 'Could not disconnect Example team from Slack.'
            : '') +
            bindI18n('en').t(
              error === 'forbidden'
                ? 'team.status.forbidden'
                : error === 'not-found'
                  ? 'team.status.notFound'
                  : 'team.status.invalid',
            ),
        )
      expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      if (error === 'forbidden') {
        await expect
          .element(page.getByRole('alert'))
          .toMatchTextContent(/Example team/)
        await expect.element(trigger).toBeDisabled()
        release = undefined
        void router.navigate('/settings/integrations', {
          formMethod: 'post',
          formData: new FormData(),
        })
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        await act(async () => release!({ error: 'invalid' }))
        await expect
          .element(page.getByRole('alert'))
          .toHaveTextContent(bindI18n('en').t('team.status.invalid'))
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
      }
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { expect, test } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { SettingsOutlet } from './+components/settings-outlet'
import type { SettingsLoaderData } from './_layout'

const shell: SettingsLoaderData = {
  kind: 'team',
  user: {
    id: 'owner',
    email: 'owner@example.test',
    name: 'Owner',
    image: null,
    initial: 'O',
  },
  currentUserIsAdmin: true,
  currentUserRole: 'owner',
  joinedProjects: [],
  workspace: {
    id: 'workspace',
    name: 'Example workspace',
    hd: null,
    plan: 'team',
    storageUsedBytes: 0,
    storageQuotaBytes: 100000,
  },
}

test('a Checkout return notice leaves history even when the user moves on before loaders finish', async () => {
  window.history.replaceState(
    null,
    '',
    '/settings/billing?status=checkout-success',
  )
  let loads = 0
  let release = () => {}
  const held = new Promise<null>((resolve) => {
    release = () => resolve(null)
  })
  const router = createBrowserRouter([
    {
      element: (
        <TooltipProvider>
          <SettingsOutlet shell={shell} />
        </TooltipProvider>
      ),
      children: [
        {
          path: '/settings/billing',
          // The first load renders the return; the cleanup's revalidation is held.
          loader: () => (loads++ === 0 ? null : held),
          element: <p>Billing</p>,
        },
        { path: '/settings/general', element: <p>General</p> },
      ],
    },
  ])
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await act(async () => {})
    expect(container.querySelector('[data-settings-status]')).not.toBeNull()
    // The cleanup is waiting for Billing's loader; the user leaves first.
    await act(async () => router.navigate('/settings/general'))
    expect(container.textContent).toContain('General')
    await act(async () => {
      router.navigate(-1)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    // The entry Back returns to no longer carries the return parameter.
    expect(window.location.search).toBe('')
    release()
    await act(async () => {})
    expect(container.textContent).toContain('Billing')
    expect(container.querySelector('[data-settings-status]')).toBeNull()
  } finally {
    release()
    await act(async () => root.unmount())
    container.remove()
    router.dispose()
  }
})

test('a Checkout return notice stays on its own entry when the user opens Billing again', async () => {
  let loads = 0
  let reopening = false
  window.history.replaceState(
    null,
    '',
    '/settings/billing?status=checkout-success',
  )
  const router = createBrowserRouter([
    {
      element: (
        <TooltipProvider>
          <SettingsOutlet shell={shell} />
        </TooltipProvider>
      ),
      children: [
        {
          path: '/settings/billing',
          // Until the user opens Billing again, any later load (such as a
          // cleanup navigation) stays loading.
          loader: () =>
            loads++ === 0 || reopening ? null : new Promise<null>(() => {}),
          element: <p>Billing</p>,
        },
      ],
    },
  ])
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await act(async () => {})
    expect(window.location.search).toBe('')
    expect(container.querySelector('[data-settings-status]')).not.toBeNull()
    // The same page opened again from the navigation is a new entry.
    reopening = true
    await act(async () => router.navigate('/settings/billing'))
    expect(container.querySelector('[data-settings-status]')).toBeNull()
    await act(async () => {
      router.navigate(-1)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(window.location.search).toBe('')
    expect(container.querySelector('[data-settings-status]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    router.dispose()
  }
})

test('a Slack return notice stays while the router location drops the parameter', async () => {
  window.history.replaceState(
    null,
    '',
    '/settings/integrations?connected=slack&view=list#slack',
  )
  const router = createBrowserRouter([
    {
      element: (
        <TooltipProvider>
          <SettingsOutlet shell={shell} />
        </TooltipProvider>
      ),
      children: [{ path: '/settings/integrations', element: <p>Slack</p> }],
    },
  ])
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await act(async () => {})
    // Later submissions use the router's location; it no longer carries the
    // consumed parameter, and the rest of the URL is kept.
    expect(router.state.location.search).toBe('?view=list')
    expect(router.state.location.hash).toBe('#slack')
    expect(window.location.search).toBe('?view=list')
    expect(
      container.querySelector('[data-settings-status="slack-connected"]'),
    ).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    router.dispose()
  }
})

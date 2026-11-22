// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { useSettingsEntryChange } from './use-settings-entry-change'

test('another entry of the page clears feedback; a replace of this entry keeps it', async () => {
  const clear = vi.fn()
  function Page() {
    useSettingsEntryChange(clear)
    return null
  }
  const router = createMemoryRouter(
    [{ path: '/settings/integrations', element: <Page /> }],
    { initialEntries: ['/settings/integrations?connected=slack'] },
  )
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await act(async () =>
      router.navigate('/settings/integrations', { replace: true }),
    )
    expect(clear).not.toHaveBeenCalled()
    await act(async () => router.navigate('/settings/integrations?view=all'))
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    router.dispose()
  }
})

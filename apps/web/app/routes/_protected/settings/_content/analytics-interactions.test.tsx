// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router'
import { expect, test, vi } from 'vitest'
import AnalyticsPage from './analytics'

test('consent controls submit the existing flow and reflect the revalidated browser choice', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let on = false
  const submit = vi.fn(async ({ request }: { request: Request }) => {
    on = (await request.formData()).get('consent') === 'granted'
    return null
  })
  const router = createMemoryRouter(
    [
      {
        id: 'root',
        loader: () => ({
          locale: 'en',
          analyticsConsent: { shouldLoadAnalytics: on },
        }),
        Component: Outlet,
        children: [
          { path: '/settings/analytics', Component: AnalyticsPage },
          { path: '/set-analytics-consent', action: submit },
        ],
      },
    ],
    { initialEntries: ['/settings/analytics'] },
  )
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await vi.waitFor(() =>
      expect(container.querySelectorAll('button')).toHaveLength(2),
    )
    const [enable, disable] =
      container.querySelectorAll<HTMLButtonElement>('button')
    expect(enable.getAttribute('aria-pressed')).toBe('false')
    await act(async () => enable.click())
    await vi.waitFor(() =>
      expect(enable.getAttribute('aria-pressed')).toBe('true'),
    )
    expect(disable.getAttribute('aria-pressed')).toBe('false')
    await act(async () => disable.click())
    await vi.waitFor(() =>
      expect(disable.getAttribute('aria-pressed')).toBe('true'),
    )
    expect(enable.getAttribute('aria-pressed')).toBe('false')
    expect(submit).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
})

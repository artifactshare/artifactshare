import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { SettingsNav } from './+components/settings-nav'
import '~/app.css'
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

test('390px settings sheet exposes all groups, closes on selection, and contains and returns focus', async () => {
  await page.viewport(390, 667)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const router = createMemoryRouter(
    [
      {
        path: '/settings',
        element: (
          <SettingsNav currentUserIsAdmin workspaceKind="team">
            <h1>Settings</h1>
          </SettingsNav>
        ),
        children: [{ path: '*' }],
      },
    ],
    { initialEntries: ['/settings/tokens'] },
  )
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await waitForBrowserLayout()
    const trigger = page.getByRole('button', {
      name: 'AI tools and CLI Your settings',
      exact: true,
    })
    await expect.element(trigger).toBeVisible()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
    await trigger.click()
    await expect.element(page.getByRole('dialog')).toBeVisible()
    const sheet = document.querySelector<HTMLElement>(
      '[data-slot="sheet-content"]',
    )!
    await vi.waitFor(() =>
      expect(sheet.contains(document.activeElement)).toBe(true),
    )
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(sheet.contains(document.activeElement)).toBe(true)
    expect(sheet.querySelector('[aria-current="page"]')?.textContent).toBe(
      'AI tools and CLI',
    )
    const paths = [...sheet.querySelectorAll<HTMLAnchorElement>('a')].map((a) =>
      a.getAttribute('href')!,
    )
    expect(paths).toEqual([
      '/settings/tokens',
      '/settings/analytics',
      '/settings',
      '/settings/bots',
      '/settings/external-access',
      '/settings/integrations',
      '/settings/activity',
      '/settings/inventory',
      '/settings/billing',
      '/settings/general',
    ])
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull(),
    )
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(trigger.element()),
    )
    for (const path of paths) {
      await page
        .getByRole('button')
        .filter({ hasText: /Your settings|Workspace|Review|Plan/ })
        .click()
      await expect.element(page.getByRole('dialog')).toBeVisible()
      const link = document.querySelector<HTMLAnchorElement>(
        `[data-slot="sheet-content"] a[href="${path}"]`,
      )!
      await userEvent.click(link)
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(path))
      await vi.waitFor(() =>
        expect(
          document.querySelector('[data-slot="sheet-content"]'),
        ).toBeNull(),
      )
    }
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
    await page.viewport(1280, 800)
  }
})

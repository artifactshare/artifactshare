import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string) => key,
    locale: 'en',
  }),
}))

import InventoryLayout from './_layout'

/** The layout as the inventory route under the shell at `shell` renders it. */
function renderInventory(path: string, shell = 'settings') {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={shell}>
          <Route path="inventory" element={<InventoryLayout />}>
            <Route path="*" element={null} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('inventory layout tabs', () => {
  test('renders navigable links without tab semantics', () => {
    const html = renderInventory('/settings/inventory/artifacts')
    expect(html).toContain('href="/settings/inventory/projects"')
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/settings\/inventory\/artifacts"/,
    )
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('aria-controls')
  })

  test('links the tabs under the route that mounts the shell', () => {
    const html = renderInventory(
      '/dev/settings/team-subscribed/inventory/projects',
      'dev/settings/:state',
    )
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/dev\/settings\/team-subscribed\/inventory\/projects"/,
    )
    expect(html).toContain(
      'href="/dev/settings/team-subscribed/inventory/artifacts"',
    )
  })
})

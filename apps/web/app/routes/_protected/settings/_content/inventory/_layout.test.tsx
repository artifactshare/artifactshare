import { renderToString } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    NavLink: ({
      to,
      children,
      ...props
    }: {
      to: string
      children: ReactNode
    }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string) => key,
    locale: 'en',
  }),
}))

import InventoryLayout from './_layout'

describe('inventory layout tabs', () => {
  test('renders navigable links without tab semantics', () => {
    const html = renderToString(<InventoryLayout />)
    expect(html).toContain('href="/settings/inventory/projects"')
    expect(html).toContain('href="/settings/inventory/artifacts"')
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('aria-controls')
  })
})

import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { VersionRows } from './version-rows'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
})

for (const density of ['panel', 'popover'] as const) {
  test(`${density} wraps an unbroken label on mobile and includes it in keyboard-accessible links`, async () => {
    await page.viewport(375, 812)
    const host = document.createElement('div')
    host.style.width = '280px'
    document.body.appendChild(host)
    root = createRoot(host)
    const label = 'Restructured'.repeat(6)
    root.render(
      <VersionRows
        density={density}
        locale="en"
        t={(key) => key}
        versions={[
          {
            id: 'v2',
            ordinal: 2,
            createdAt: '2026-09-01T00:00:00Z',
            sizeBytes: 100,
            isCurrent: true,
          },
          {
            id: 'v1',
            ordinal: 1,
            createdAt: '2026-09-01T00:00:00Z',
            sizeBytes: 100,
            isCurrent: false,
            createdByLabel: 'Author',
            label,
          },
        ]}
      />,
    )
    await vi.waitFor(() => expect(host.querySelectorAll('a')).toHaveLength(2))
    await waitForBrowserLayout()
    const links = host.querySelectorAll('a')
    const line = Array.from(links[1]!.children).find(
      (node) => node.textContent === label,
    ) as HTMLElement
    expect(line.getBoundingClientRect().height).toBeGreaterThan(
      parseFloat(getComputedStyle(line).lineHeight),
    )
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth)
    await userEvent.tab()
    expect(document.activeElement).toBe(links[0])
    await userEvent.tab()
    expect(document.activeElement).toBe(links[1])
    await expect
      .element(page.getByRole('link', { name: new RegExp(label) }))
      .toHaveAttribute('href', '?version=v1')
    expect(links[0]!.textContent).not.toContain(label)
  })
}

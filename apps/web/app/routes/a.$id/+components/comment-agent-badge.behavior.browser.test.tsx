import { afterEach, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { CommentMessageItem } from './comment-message-item'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))
let root: Root | undefined
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
})

test.each([390, 1280])(
  'agent badge uses constrained CSS ellipsis at %s px',
  async (width) => {
    await page.viewport(width, 800)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const agent =
      'Research Assistant for Q4 Data with a very long original agent name'
    root = createRoot(host)
    root.render(
      <CommentMessageItem
        message={{
          id: 'message-1',
          body: 'Review this file',
          agent,
          createdAt: '2026-07-29T00:00:00Z',
          updatedAt: '2026-07-29T00:00:00Z',
          author: {
            id: 'u1',
            name: 'Owner',
            email: 'owner@example.com',
            image: null,
          },
          canEdit: false,
          canDelete: false,
        }}
        locale="en"
        pending={false}
        onUpdate={async () => true}
        onDelete={async () => true}
      />,
    )
    const badgeLocator = page.getByTitle(agent)
    await expect.element(badgeLocator).toBeVisible()
    await waitForBrowserLayout()
    // The full name stays reachable through the badge title while the drawn
    // text is clipped inside the meta row it shares with the timestamp.
    const badge = badgeLocator.element() as HTMLElement
    const text = badge.firstElementChild as HTMLElement
    expect(text.textContent).toBe(agent)
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth)
    expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
      badge.getBoundingClientRect().right,
    )
    const row = badge.parentElement!
    expect(badge.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right + 1,
    )
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1)
  },
)

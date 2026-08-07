import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { page } from 'vitest/browser'
import { FileRow } from './+components/file-row'
import type { FileRowData } from './+components/file-data'
import '~/app.css'

const file = (overrides: Partial<FileRowData> = {}): FileRowData => ({
  id: 'quarterly-report',
  fileName: 'Quarterly report.html',
  derivedTitle: 'Quarterly report',
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  visibility: 'private',
  viewCount: 1,
  commentCount: 1,
  modifiedTime: '2026-07-31T11:00:00.000Z',
  unreadCommentCount: 1,
  ...overrides,
})

let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
afterEach(() => {
  root?.unmount()
  root = undefined
  router?.dispose()
  router = undefined
  document.body.replaceChildren()
})

async function mount(data: FileRowData) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <FileRow data={data} unreadBadges now="2026-07-31T12:00:00.000Z" />
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() =>
    expect(host.querySelector('a[aria-label]')).not.toBeNull(),
  )
  return host
}

describe('FileRow unread browser structure', () => {
  test('shows the derived title, decorative dot, and desktop/mobile motion structure', async () => {
    await page.viewport(1440, 900)
    const host = await mount(
      file({
        derivedTitle:
          'Quarterly report with a deliberately long title for ellipsis',
      }),
    )
    const link = host.querySelector<HTMLAnchorElement>('a[aria-label]')!
    expect(link.getAttribute('aria-label')).toBe(
      'Quarterly report with a deliberately long title for ellipsis · Unread updates',
    )
    expect(host.querySelectorAll('[aria-hidden="true"].bg-link')).toHaveLength(
      1,
    )
    const desktopMotion = [...host.querySelectorAll<HTMLElement>('span')].find(
      (node) =>
        node.className.includes('max-wide:hidden') &&
        node.textContent === '1 new comment',
    )!
    const mobileMeta = host.querySelector<HTMLElement>(
      '[data-regression-responsive="mobile-only"]',
    )!
    const mobileMotion = [...mobileMeta.children].find(
      (node) => node.textContent === '1 new comment',
    ) as HTMLElement
    expect(getComputedStyle(desktopMotion).display).not.toBe('none')
    expect(getComputedStyle(mobileMeta).display).toBe('none')

    await page.viewport(390, 844)
    expect(getComputedStyle(desktopMotion).display).toBe('none')
    expect(getComputedStyle(mobileMeta).display).toBe('grid')
    expect(getComputedStyle(mobileMotion).display).not.toBe('none')
    const title = [...host.querySelectorAll('span')].find(
      (node) =>
        node.textContent ===
        'Quarterly report with a deliberately long title for ellipsis',
    )!
    expect(title.className).toContain('truncate')
    expect(title.parentElement?.className).toContain('overflow-hidden')
    expect(getComputedStyle(title).textOverflow).toBe('ellipsis')
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
  })

  test('has no unread UI when read', async () => {
    const host = await mount(file({ unreadCommentCount: 0 }))
    const link = host.querySelector<HTMLAnchorElement>('a[aria-label]')!
    expect(link.getAttribute('aria-label')).toBe('Quarterly report')
    expect(host.querySelectorAll('[aria-hidden="true"].bg-link')).toHaveLength(
      0,
    )
    expect(host.textContent).not.toContain('new comment')
  })
})

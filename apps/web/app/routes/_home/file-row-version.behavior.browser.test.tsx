import { afterEach, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { page } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { HomeUnopenedFiles } from './+components/home-unopened-files'
import { FileRow } from './+components/file-row'
import type { FileRowData } from './+components/file-data'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'ja',
    t: (key: string, vars?: { version: number }) =>
      key.startsWith('home.')
        ? bindI18n('ja').t(key as 'home.unopenedTitle')
        : vars?.version
          ? `Updated to v${vars.version}`
          : ({
              'vw.more': 'More actions',
              'fileRowMenu.copyUrl': 'Copy link',
              'fileRowMenu.rename': 'Rename',
              'fileRowMenu.move': 'Move',
              'fileRowMenu.visibility': 'Visibility',
              'fileRowMenu.remove': 'Remove',
              'author.external': 'External',
            }[key] ?? key),
    tPlural: (key: string, count: number) =>
      key === 'home.unopenedMore'
        ? bindI18n('ja').tPlural('home.unopenedMore', count)
        : `${key}:${count}`,
  }),
}))

vi.mock('./+hooks/use-file-labels', () => ({
  useFileLabels: () => ({
    owner: 'A deliberately long owner name for compact layout',
    modified: '2026-07-31',
    activity: 'Viewed',
    visibility: 'Workspace',
  }),
}))

const file: FileRowData = {
  id: 'home-compact-file',
  fileName: 'home-compact-file.html',
  derivedTitle:
    'A deliberately long home title that must wrap only twice in a compact row',
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'A deliberately long owner name for compact layout',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  visibility: 'workspace',
  viewCount: 42,
  commentCount: 7,
  modifiedTime: '2026-07-31T11:00:00.000Z',
  projectName: 'Content-rich project',
}

let root: Root | undefined
afterEach(() => {
  root?.unmount()
  document.body.replaceChildren()
})

test.each([390, 1280])(
  'My files distinguishes recent v2 from same-name v1 at %s px',
  async (width) => {
    await page.viewport(width, 800)
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            element: (
              <>
                {[2, 1].map((versionCount) => (
                  <FileRow
                    key={versionCount}
                    data={{
                      ...file,
                      id: `file-v${versionCount}`,
                      versionCount,
                      latestPublishedAt: '2026-07-31T00:00:00Z',
                      unreadCommentCount: 0,
                      commentCount: 0,
                    }}
                    versionDisplay="recent"
                    showOwner={false}
                    hideMobileOwner
                    hideMobileVisibility
                    richStats
                    now="2026-07-31T12:00:00Z"
                  />
                ))}
              </>
            ),
          },
        ])}
      />,
    )
    await vi.waitFor(() =>
      expect(host.querySelectorAll('a[aria-label]')).toHaveLength(2),
    )
    await waitForBrowserLayout()
    const labels = [...host.querySelectorAll<HTMLElement>('span')].filter(
      (el) => el.textContent === 'Updated to v2' && !el.querySelector('span'),
    )
    expect(labels.filter((el) => el.checkVisibility())).toHaveLength(1)
    expect(host.textContent).not.toContain('Updated to v1')
    expect(host.querySelector('.bg-link.size-2')).toBeNull()
    expect(host.textContent).not.toContain('newComments')
  },
)

test.each([390, 1280])(
  'inline owner keeps motion on a separate mobile line at %s px',
  async (width) => {
    await page.viewport(width, 800)
    const host = document.createElement('div')
    host.style.containerType = 'inline-size'
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            element: (
              <FileRow
                data={{
                  ...file,
                  projectName: null,
                  ownerIsExternal: true,
                  versionCount: 2,
                  latestPublishedAt: '2026-07-31T00:00:00Z',
                  unreadCommentCount: 2,
                }}
                inlineOwner
                homeCompact
                unreadBadges
                hideMobileOwner
                recencyPresentation="grouped"
                now="2026-07-31T12:00:00Z"
              />
            ),
          },
        ])}
      />,
    )
    await vi.waitFor(() => expect(host.textContent).toContain('Updated to v2'))
    await waitForBrowserLayout()
    const motions = [...host.querySelectorAll<HTMLElement>('span')].filter(
      (el) =>
        el.textContent?.includes('Updated to v2') &&
        el.textContent.includes('row.newComments') &&
        ![...el.children].some((child) =>
          child.textContent?.includes('Updated to v2'),
        ) &&
        el.checkVisibility(),
    )
    expect(motions).toHaveLength(1)
    const motion = motions[0]
    const external = [...host.querySelectorAll<HTMLElement>('span')].find(
      (el) => el.textContent === 'External' && el.checkVisibility(),
    )!
    expect(external).toBeDefined()
    if (width === 390) {
      expect(motion.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        external.getBoundingClientRect().bottom,
      )
      expect(
        motion.closest('[data-regression-responsive="mobile-only"]'),
      ).not.toBeNull()
      expect(getComputedStyle(motion).gridColumn).toBe('span 2 / span 2')
    } else {
      expect(
        Math.abs(
          motion.getBoundingClientRect().top -
            external.getBoundingClientRect().top,
        ),
      ).toBeLessThan(4)
    }
  },
)

test.each([6, 12])(
  'Japanese unopened header stays on one line with total %s at 390 px',
  async (total) => {
    await page.viewport(390, 800)
    const host = document.createElement('div')
    host.style.width = '358px'
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            element: (
              <HomeUnopenedFiles
                files={Array.from({ length: 5 }, (_, i) => ({
                  ...file,
                  id: `unopened-${i}`,
                }))}
                total={total}
                error={false}
                now="2026-07-31T12:00:00Z"
              />
            ),
          },
        ])}
      />,
    )
    await vi.waitFor(() =>
      expect(host.querySelector('a[href="/files"]')).not.toBeNull(),
    )
    await waitForBrowserLayout()
    const link = host.querySelector<HTMLElement>('a[href="/files"]')!
    const heading = host.querySelector<HTMLElement>('h2')!
    expect(link.textContent).toBe(`すべて見る（未確認ほか${total - 5}件）`)
    for (const element of [link, heading]) {
      expect(element.getBoundingClientRect().height).toBeLessThanOrEqual(
        parseFloat(getComputedStyle(element).lineHeight) + 1,
      )
    }
    expect(heading.getBoundingClientRect().right).toBeLessThanOrEqual(
      link.getBoundingClientRect().left,
    )
  },
)

import { afterEach, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { page } from 'vitest/browser'
import { FileRow } from './+components/file-row'
import type { FileRowData } from './+components/file-data'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, vars?: { version: number }) =>
      vars?.version
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
    tPlural: (key: string, count: number) => `${key}:${count}`,
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

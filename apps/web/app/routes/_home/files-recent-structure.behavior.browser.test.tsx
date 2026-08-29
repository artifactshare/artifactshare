import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'
import type { ComponentType, ReactNode } from 'react'
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  type RouteObject,
} from 'react-router'
import { FileRow } from './+components/file-row'
import type { FileRowData } from './+components/file-data'
import { fileDateHeadingClassName } from './+components/file-list-styles'
import { RecentContent } from './+components/recent-content'
import Files from './_protected/files'
import { listMainClassName } from '~/components/app/page-shell-styles'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

type FilesTestProps = {
  loaderData: {
    files: FileRowData[]
    total: number
    page: number
    query: string
  }
}
const FilesForTest = Files as unknown as ComponentType<FilesTestProps>

const longTitle =
  'A deliberately long file title that must truncate on a mobile viewport'
const longProject = 'Quarterly reports for the international leadership team'
const longMeta = `Owner · 2 new comments · ${longProject}`
const data: FileRowData = {
  id: 'structure-file',
  fileName: 'long-file.html',
  derivedTitle: longTitle,
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'owner',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: true,
  registeredByMe: true,
  visibility: 'workspace',
  viewCount: 3,
  commentCount: 2,
  modifiedTime: '2026-07-31T11:00:00.000Z',
  unreadCommentCount: 2,
  unreadCommentRemainingCount: 1,
  latestUnreadComment: {
    id: 'comment-2',
    authorId: 'commenter',
    authorName: 'Commenter',
    authorImage: null,
    body: 'A deliberately long comment that must wrap without widening the file row on either desktop or mobile.',
    createdAt: '2026-07-31T11:30:00.000Z',
  },
  projectName: longProject,
}
let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
function resetMountedRoute() {
  root?.unmount()
  router?.dispose()
  document.body.replaceChildren()
  root = undefined
  router = undefined
}
afterEach(() => {
  resetMountedRoute()
})

async function mount(
  props: Partial<React.ComponentProps<typeof FileRow>> = {},
) {
  return mountRoute(<FileRow data={data} {...props} />)
}

async function mountRoute(
  element: ReactNode,
  parent?: ReactNode,
  productionShell = false,
) {
  const host = document.createElement('div')
  if (productionShell) host.className = listMainClassName
  document.body.appendChild(host)
  root = createRoot(host)
  const routes: RouteObject[] = parent
    ? [{ element: parent, children: [{ path: '/', element }] }]
    : [{ path: '/', element }]
  router = createMemoryRouter(routes, { initialEntries: ['/'] })
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() => expect(host.firstElementChild).not.toBeNull())
  await waitForBrowserLayout()
  return host
}

test('rows keep short visibility vocabulary, owner/activity/location order, and accessible long text', async () => {
  await page.viewport(1440, 900)
  const host = await mount({
    inlineOwner: true,
    showOwner: false,
    hideMobileVisibility: true,
    richStats: true,
    menuEnabled: true,
    unreadBadges: true,
    recencyPresentation: 'grouped-with-preview',
    now: '2026-07-31T12:00:00.000Z',
  })
  expect(host.textContent).toContain('Company')
  const rowText = host.textContent!
  expect(rowText.indexOf('Owner')).toBeLessThan(
    rowText.indexOf('2 new comments'),
  )
  expect(rowText.indexOf('2 new comments')).toBeLessThan(
    rowText.indexOf(longProject),
  )
  expect(host.querySelector(`[title="${longMeta}"]`)).not.toBeNull()
  expect(rowText).toContain(longTitle)
  expect(host.querySelector(`[title="${longTitle}"]`)).not.toBeNull()
  const previewLabel = [...host.querySelectorAll<HTMLElement>('span')].find(
    (node) => node.textContent === 'New comment',
  )
  const preview = previewLabel?.parentElement?.parentElement
  expect(preview).not.toBeNull()
  expect(preview?.textContent).toContain(
    'Commenter: A deliberately long comment',
  )
  expect(preview?.textContent).toContain('1 more')
  expect(preview?.getBoundingClientRect().right).toBeLessThanOrEqual(
    host.getBoundingClientRect().right,
  )
  const heading = document.createElement('h2')
  heading.className = fileDateHeadingClassName
  heading.textContent = 'Today'
  host.insertBefore(heading, host.firstChild)
  expect(getComputedStyle(heading).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(heading.className).not.toContain('border-')
  await page.viewport(390, 844)
  await waitForBrowserLayout()
  expect(getComputedStyle(preview!).flexDirection).toBe('column')
  expect(preview?.getBoundingClientRect().right).toBeLessThanOrEqual(
    host.getBoundingClientRect().right,
  )
  expect(host.textContent?.match(/Owner/g)).toHaveLength(1)
  expect(host.textContent?.match(/External/g)).toHaveLength(1)
  const mobileTitle = host.querySelector<HTMLElement>(`[title="${longTitle}"]`)!
  const mobileMeta = host.querySelector<HTMLElement>(`[title="${longMeta}"]`)!
  expect(mobileTitle.scrollWidth).toBeGreaterThan(mobileTitle.clientWidth)
  expect(
    [...mobileMeta.querySelectorAll<HTMLElement>('.truncate')].some(
      (segment) => segment.scrollWidth > segment.clientWidth,
    ),
  ).toBe(true)
})

test('mobile rows hide visibility and keep view/meta affordances', async () => {
  await page.viewport(390, 844)
  const host = await mount({
    hideMobileVisibility: true,
    richStats: true,
    menuEnabled: true,
  })
  const mobile = host.querySelector(
    '[data-regression-responsive="mobile-only"]',
  ) as HTMLElement
  expect(getComputedStyle(mobile).display).toBe('grid')
  const visibility = mobile.querySelector<HTMLElement>('.max-wide\\:hidden')!
  expect(getComputedStyle(visibility).display).toBe('none')
  expect(mobile.textContent).toContain('3')
  const commentCount = host.querySelector<HTMLElement>(
    '[aria-label="2 comments"]',
  )!
  expect(
    getComputedStyle(
      commentCount.closest(
        '[data-regression-responsive="desktop-only"]',
      ) as HTMLElement,
    ).display,
  ).toBe('none')
  const buttons = [...host.querySelectorAll<HTMLElement>('button')]
  const copy = buttons.find((button) =>
    button.getAttribute('aria-label')?.toLowerCase().includes('copy'),
  )!
  const menu = buttons.find((button) =>
    button.getAttribute('aria-label')?.toLowerCase().includes('more'),
  )!
  expect(getComputedStyle(copy).display).toBe('none')
  expect(getComputedStyle(menu).display).not.toBe('none')
})

test('files and recent use the current page chrome', async () => {
  await page.viewport(1440, 900)
  const layout = {
    signedIn: true,
    user: {
      id: 'owner',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
    },
    selfUploadEnabled: true,
    openUploadDialog: () => undefined,
  }
  const files = (
    <FilesForTest
      loaderData={{ files: [data], total: 1, page: 1, query: '' }}
    />
  )
  let host = await mountRoute(files, <Outlet context={layout} />, true)
  const columnHeader = () =>
    [...host.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find(
      (node) =>
        node.textContent?.includes('Name') &&
        node.textContent.includes('Who can view'),
    )
  expect(host.querySelector('input[type="search"]')).toBeNull()
  expect(host.textContent).not.toContain(
    'View all files you created, sorted by creation date.',
  )
  expect(columnHeader()).toBeUndefined()
  expect(host.textContent).toContain(longProject)
  await page.viewport(390, 844)
  await waitForBrowserLayout()
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
  expect(
    [...host.querySelectorAll('span')].filter(
      (node) => node.textContent === 'Owner' && node.offsetParent !== null,
    ),
  ).toHaveLength(0)

  const recentLayout = {
    signedIn: true,
    workspaceName: 'Fixture workspace',
    selfUploadEnabled: true,
    openUploadDialog: () => undefined,
  }
  const recent = (
    <RecentContent
      layoutData={recentLayout}
      files={[data]}
      unreadEnabled
      now="2026-07-31T12:00:00.000Z"
    />
  )
  await page.viewport(1440, 900)
  host = await mountRoute(recent, undefined, true)
  expect(host.querySelector('input[type="search"]')).toBeNull()
  expect(host.textContent).not.toContain(
    'Review recently opened files with their project context.',
  )
  expect(columnHeader()).toBeUndefined()
})

test('restricted recent rows expose only owner and unavailable state', async () => {
  const host = await mountRoute(
    <RecentContent
      layoutData={{
        signedIn: true,
        workspaceName: 'Fixture workspace',
        selfUploadEnabled: true,
        openUploadDialog: () => undefined,
      }}
      files={[
        {
          kind: 'restricted',
          shareableId: 'restricted-file',
          title: 'Secret title',
          ownerName: 'Other Owner',
          ownerImage: null,
          lastViewedAt: '2026-07-31T11:00:00.000Z',
        },
      ]}
      now="2026-07-31T12:00:00.000Z"
    />,
  )
  expect(host.textContent).toContain('Other Owner')
  expect(host.textContent).toContain('No access')
  expect(
    host.querySelector(
      '[title="You do not have permission to view this file"]',
    ),
  ).not.toBeNull()
  expect(host.textContent).toContain('Secret title')
  expect(host.querySelector('a[href="/a/restricted-file"]')).toBeNull()
  expect(host.querySelector('button')).toBeNull()
})

import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { listMainClassName } from '~/components/app/page-shell-styles'
import '~/app.css'
import Home from './index'
import Files from './_protected/files'
import type { FileRowData } from './+components/file-data'

const openUploadDialog = vi.fn()
const layoutContext = {
  signedIn: true,
  user: {
    id: 'u-owner',
    email: 'owner@example.com',
    name: 'Owner',
    image: null,
  },
  openUploadDialog,
  selfUploadEnabled: true,
}

vi.mock('~/services/db.server', () => ({ createDb: vi.fn() }))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useLocation: () => ({ hash: '', state: null }),
    useNavigate: () => vi.fn(),
    useNavigation: () => ({ state: 'idle' }),
    useOutletContext: () => layoutContext,
    useViewTransitionState: () => false,
  }
})

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      key === 'tb.addFile'
        ? 'ファイルを追加'
        : key === 'upload.cta.primary'
          ? 'アップロード'
          : key,
    tPlural: (key: string, count: number) => `${key}:${count}`,
  }),
}))

vi.mock('~/components/app/page-breadcrumb', () => ({
  PageBreadcrumb: ({ children, ...props }: { children: ReactNode }) =>
    createElement('nav', props, children),
}))

vi.mock('~/components/app/app-more-link', () => ({
  AppMoreLink: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}))

vi.mock('./+components/home-rail', () => ({
  HomeRail: () => createElement('aside', { 'data-testid': 'rail' }),
}))

vi.mock('./+components/file-row-dialogs', () => ({
  FileRowDialogs: () => null,
  useFileRowActions: () => ({ active: null, close: vi.fn() }),
}))

vi.mock('./+hooks/use-bulk-actions', () => ({
  useBulkActions: () => ({}),
}))

vi.mock('./+components/bulk-bar', () => ({
  BulkBar: () => null,
}))

vi.mock('./+components/empty-state', () => ({
  EmptyState: ({
    showUploadAction = true,
    variant = 'files',
  }: {
    showUploadAction?: boolean
    variant?: 'files' | 'recent'
  }) =>
    createElement(
      'div',
      { 'data-testid': 'empty' },
      showUploadAction && variant === 'files'
        ? createElement('button', { type: 'button' }, 'アップロード')
        : null,
    ),
}))

vi.mock('~/hooks/use-viewer-calendar', () => ({
  useViewerCalendar: () => ({
    hydrated: true,
    timeZone: 'UTC',
    now: '2026-01-01T00:00:00.000Z',
  }),
}))

let root: Root | undefined

const recentFile: FileRowData = {
  id: 'recent-file',
  fileName: 'recent.html',
  derivedTitle: 'Recent file',
  titleOverride: null,
  renderType: 'html',
  ownerEmail: 'owner@example.com',
  ownerId: 'u-owner',
  ownerName: 'Owner',
  ownerImage: null,
  ownerInitial: 'O',
  ownerIsExternal: false,
  registeredByMe: true,
  visibility: 'private',
  viewCount: 0,
  commentCount: 0,
  modifiedTime: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  root?.unmount()
  root = undefined
  openUploadDialog.mockReset()
  document.body.replaceChildren()
})

async function mount(element: ReactNode) {
  const host = document.createElement('div')
  host.className = listMainClassName
  document.body.replaceChildren(host)
  root = createRoot(host)
  root.render(
    createElement(MemoryRouter, { initialEntries: ['/'] }, element) as never,
  )
  await vi.waitFor(() => expect(host.querySelector('h1')).not.toBeNull())
  return {
    heading: host.querySelector('h1')!.getBoundingClientRect(),
    shellPadding: getComputedStyle(host).padding,
  }
}

function home(rows: FileRowData[] = []) {
  return createElement(Home, {
    loaderData: {
      signedIn: true,
      rail: {
        files: [],
        projects: [],
        errors: { files: false, projects: false },
      },
      recent: {
        rows,
        relation: 'all',
        unread: false,
        total: 0,
        historyCardinality: 0,
        error: false,
        now: '2026-01-01T00:00:00.000Z',
      },
    },
  } as never)
}

function files() {
  return createElement(Files, {
    loaderData: { files: [], total: 0, page: 1, query: '' },
  } as never)
}

describe('home page shell spacing', () => {
  test('wires compact date-heading padding through the rendered Home list', async () => {
    await page.viewport(779, 900)
    await mount(home([recentFile]))
    const dateHeading = [...document.querySelectorAll('h2')].find((heading) =>
      heading.parentElement?.className.includes('text-faint'),
    )?.parentElement as HTMLElement

    expect(getComputedStyle(dateHeading).paddingInline).toBe('0px')

    await page.viewport(780, 900)
    expect(getComputedStyle(dateHeading).paddingInline).toBe('12px')
  })

  test('renders an empty home without the retired feed', async () => {
    await mount(home())

    const rail = document.querySelector('[data-testid="rail"]')
    expect(rail).not.toBeNull()
    expect(document.querySelector('[data-testid="feed"]')).toBeNull()
    expect(rail?.parentElement?.classList.contains('grid')).toBe(true)
    expect(document.querySelector('[data-testid="home-tabs"]')).toBeNull()
    expect(document.querySelector('[data-testid="empty"]')).not.toBeNull()
    expect(
      Array.from(document.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'ファイルを追加',
      ),
    ).toHaveLength(1)
  })

  test('keeps Home breadcrumb-free and aligns the Home and Files left edge', async () => {
    const homeLayout = await mount(home())

    expect(
      document.querySelector('nav[aria-label="project.location"]'),
    ).toBeNull()
    expect(document.querySelectorAll('h1')).toHaveLength(1)

    const grid = document.querySelector('[data-testid="rail"]')
      ?.parentElement as HTMLElement

    expect(grid.classList.contains('grid')).toBe(true)
    expect(getComputedStyle(grid).padding).toBe('0px')
    expect(homeLayout.shellPadding).not.toBe('0px')

    root?.unmount()
    root = undefined
    const filesLayout = await mount(files())

    expect(homeLayout.heading.left).toBe(filesLayout.heading.left)
  })

  test('offers the same file-add action from Home and Files', async () => {
    await mount(home())

    const homeButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'ファイルを追加',
    )
    expect(homeButton).toBeDefined()
    homeButton?.click()
    expect(openUploadDialog).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('button')).toHaveLength(1)

    root?.unmount()
    root = undefined
    await mount(files())

    const filesButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'ファイルを追加',
    )
    expect(filesButton).toBeDefined()
    filesButton?.click()
    expect(openUploadDialog).toHaveBeenCalledTimes(2)
    expect(document.querySelectorAll('button')).toHaveLength(1)
  })
})

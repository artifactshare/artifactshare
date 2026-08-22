import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const hydration = vi.hoisted(() => ({ value: false }))

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: () => null }))
vi.mock('~/middleware/context', () => ({ requireUser: () => ({ id: 'u1' }) }))
vi.mock('~/services/link-sharing.server', () => ({
  isLinkSharingAllowedByPolicy: async () => false,
  loadWorkspaceLinkPolicy: async () => null,
}))
vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => hydration.value }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}))
vi.mock('~/components/app/page-breadcrumb', () => ({
  PageBreadcrumb: ({ children }: { children: ReactNode }) => (
    <nav>{children}</nav>
  ),
}))
vi.mock('~/components/ui/breadcrumb', () => ({
  BreadcrumbList: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  BreadcrumbItem: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  BreadcrumbLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  BreadcrumbPage: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  BreadcrumbSeparator: () => <span>/</span>,
}))
vi.mock('../_home/+components/file-row', () => ({
  FileRow: ({ data }: { data: { id: string } }) => (
    <div data-file-id={data.id} />
  ),
}))
vi.mock('../_home/+components/file-row-dialogs', () => ({
  FileRowDialogs: () => null,
  useFileRowActions: () => ({ active: null, open: vi.fn(), close: vi.fn() }),
}))
vi.mock('../_home/+components/bulk-bar', () => ({ BulkBar: () => null }))
vi.mock('../_home/+hooks/use-bulk-actions', () => ({
  useBulkActions: () => ({ selected: [], toggle: vi.fn() }),
}))
vi.mock('../_home/+components/topbar', () => ({ Topbar: () => null }))
vi.mock('../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => <div data-bottom-tab-bar />,
}))
vi.mock('../_home/+components/upload-artifact-dialog', () => ({
  UploadArtifactDialog: () => null,
}))
vi.mock('~/components/ui/button', () => ({ Button: () => null }))
vi.mock('~/components/ui/empty', () => ({
  Empty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EmptyHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EmptyMedia: () => null,
  EmptyTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  EmptyDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  EmptyContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('../../_home/+components/feed-item', () => ({ FeedItem: () => null }))
vi.mock('~/components/app/file-type-icon', () => ({ FileTypeIcon: () => null }))
vi.mock('~/components/app/author-avatar', () => ({ AuthorAvatar: () => null }))
vi.mock('~/components/app/icon-button', () => ({ IconButton: () => null }))
vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    useFetcher: () => ({
      state: 'idle',
      data: undefined,
      load: vi.fn(),
      submit: vi.fn(),
    }),
  }
})

import ProjectFiles from './projects.$id.files'
import { ProjectRedesignBody } from './+components/project-redesign-body'
import { fileTableListClassName } from '../_home/+components/file-list-styles'

const file = (id: string, createdTime: string | null) => ({
  id,
  fileName: `${id}.md`,
  derivedTitle: null,
  titleOverride: null,
  renderType: 'md',
  visibility: 'workspace',
  ownerId: 'u1',
  ownerImage: null,
  ownerInitial: 'U',
  ownerIsExternal: false,
  ownerEmail: 'u1@example.com',
  ownerName: 'User One',
  registeredByMe: true,
  viewCount: 0,
  commentCount: 0,
  projectName: 'Project',
  modifiedTime: createdTime,
  createdTime,
})

const files = [
  file('same-new', '2020-01-15T12:00:00Z'),
  file('missing', null),
  file('same-old', '2020-01-15T08:00:00Z'),
] as unknown as import('../_home/+components/file-data').FileRowData[]
const ctx = {
  projectId: 'proj1',
  projectName: 'Project',
  workspaceName: 'Workspace',
  user: { name: 'User', email: 'u1@example.com' },
  joinedNav: [],
  canUpload: false,
} as never
const loaderData = {
  ctx,
  files,
  total: files.length,
  nextCursor: null,
  now: '2026-07-29T00:00:00Z',
} as never
const emptyLoaderData = {
  ctx,
  files: [],
  total: 0,
  nextCursor: null,
  now: '2026-07-29T00:00:00Z',
} as never

function renderProjectFiles() {
  return renderToStaticMarkup(
    createElement(ProjectFiles, { loaderData } as never),
  )
}

function renderProjectBody() {
  return renderToStaticMarkup(
    <ProjectRedesignBody
      projectId="proj1"
      files={files}
      pins={[]}
      feed={[]}
      ranking={[]}
      now="2026-07-29T00:00:00Z"
      canPin={false}
      canUpload={false}
      archived={false}
      onUpload={() => {}}
      homeOwnerName="User"
    />,
  )
}

beforeEach(() => {
  hydration.value = false
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('project file date-group hydration rendering', () => {
  test('files subpage keeps the mobile primary navigation', () => {
    expect(renderProjectFiles()).toContain('data-bottom-tab-bar')
  })
  test.each([
    ['files subpage', renderProjectFiles],
    ['project overview', renderProjectBody],
  ])(
    'before hydration shows all rows without date headings (%s)',
    (_, render) => {
      const html = render()
      expect(html.match(/data-file-id=/g)).toHaveLength(3)
      expect(html).not.toContain('Jan 15, 2020')
    },
  )

  test.each([
    ['files subpage', renderProjectFiles],
    ['project overview', renderProjectBody],
  ])('after hydration shows the local date heading (%s)', (_, render) => {
    hydration.value = true
    const html = render()
    expect(html).toContain('Jan 15, 2020')
    expect(html.match(/data-file-id=/g)).toHaveLength(3)
  })

  test('empty createdTime between same-day rows remains ordered and warning-free', () => {
    hydration.value = true
    const html = renderProjectFiles()
    expect(
      [...html.matchAll(/data-file-id="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(['same-new', 'missing', 'same-old'])
    expect(html).not.toMatch(/<(?:h2|h3)[^>]*><\//)
    expect(html.split(fileTableListClassName)).toHaveLength(4)
  })

  test.each([
    [
      'files subpage',
      () =>
        renderToStaticMarkup(
          createElement(ProjectFiles, { loaderData: emptyLoaderData } as never),
        ),
    ],
    [
      'project overview',
      () =>
        renderToStaticMarkup(
          <ProjectRedesignBody
            projectId="proj1"
            files={[]}
            pins={[]}
            feed={[]}
            ranking={[]}
            now="2026-07-29T00:00:00Z"
            canPin={false}
            canUpload={false}
            archived={false}
            onUpload={() => {}}
            homeOwnerName="User"
          />,
        ),
    ],
  ])('zero files keeps the existing empty state (%s)', (_, render) => {
    expect(render()).toContain('project.noFilesTitle')
  })
})

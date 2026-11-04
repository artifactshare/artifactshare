import { bindI18n } from '~/lib/i18n'
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
let locale: 'en' | 'ja' = 'en'
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(locale),
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
    useActionData: () => undefined,
    useRevalidator: () => ({ revalidate: vi.fn() }),
    useNavigate: () => vi.fn(),
    useNavigation: () => ({ state: 'idle' }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    useViewTransitionState: () => false,
    Form: ({ children }: { children: ReactNode }) => <form>{children}</form>,

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

import ProjectDetail from './projects.$id'
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
  locale = 'en'
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
    expect(render()).toContain(bindI18n('en').t('project.noFilesTitle'))
  })
})

test.each(['en', 'ja'] as const)(
  'project files count uses singular and plural forms (%s)',
  (language) => {
    locale = language
    for (const count of [0, 1, 2]) {
      const html = renderToStaticMarkup(
        createElement(ProjectFiles, {
          loaderData: {
            ctx,
            files: files.slice(0, count),
            total: count,
            nextCursor: null,
            now: '2026-07-29T00:00:00Z',
          },
        } as never),
      )
      const label =
        language === 'ja'
          ? `${count} ファイル`
          : count === 1
            ? '1 file'
            : `${count} files`
      expect(html).toContain(`>${label} · `)
    }
  },
)

test.each([
  ['member', 'en'],
  ['shared', 'en'],
  ['member', 'ja'],
  ['shared', 'ja'],
] as const)(
  'project detail counts use singular and plural forms (%s, %s)',
  (access, language) => {
    locale = language
    for (const count of [0, 1, 2]) {
      const html = renderToStaticMarkup(
        createElement(ProjectDetail, {
          loaderData: {
            access,
            project: {
              id: 'proj1',
              name: 'Project',
              baseVisibility: 'private',
              createdAt: '2026-01-01T00:00:00Z',
              archivedAt: null,
            },
            files: files.slice(0, count),
            user: { id: 'u1', name: 'User', email: 'u1@example.com' },
            workspaceName: 'Workspace',
            joinedNav: [],
            shareDefaults: [],
            canUpload: false,
            canPost: false,
            canManage: false,
            canEditProject: false,
            projectActivity: {
              participants: { total: 0, top: [] },
              joined: false,
              pins: [],
              feed: [],
              ranking: [],
              now: '2026-07-29T00:00:00Z',
            },
          },
        } as never),
      )
      const label =
        language === 'ja'
          ? `${count} ファイル`
          : count === 1
            ? '1 file'
            : `${count} files`
      expect(html).toContain(`>${label} · `)
    }
  },
)

import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { RecentContent, RecentListBody } from './recent-content'
import type { FileRowData } from './file-data'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key, locale: 'en' }),
}))
const hydration = vi.hoisted(() => ({ value: true }))
vi.mock('~/hooks/use-hydrated', () => ({
  useHydrated: () => hydration.value,
}))
vi.mock('./empty-state', () => ({
  EmptyState: () => <div data-slot="empty" />,
}))
vi.mock('./file-row', () => ({
  FileRow: ({
    unreadBadges,
    showOwner,
  }: {
    unreadBadges?: boolean
    showOwner?: boolean
  }) => (
    <div
      data-slot="file-row"
      data-unread-badges={String(unreadBadges)}
      data-show-owner={String(showOwner)}
    />
  ),
}))

const file = {
  id: 'f1',
  fileName: 'Report.html',
  derivedTitle: 'Report',
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
  viewCount: 0,
  commentCount: 0,
  modifiedTime: '2026-01-15T00:00:00.000Z',
} satisfies FileRowData

test('renders recent content inside a real router', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RecentContent
        layoutData={{
          signedIn: true,
          workspaceName: 'Fixture workspace',
          selfUploadEnabled: true,
          openUploadDialog: () => undefined,
        }}
        files={[]}
      />
    </MemoryRouter>,
  )
  expect(html).toContain('data-slot="empty"')
  expect(html).toContain('href="/">tb.home</a>')
  expect(html).toContain('>home.recentViewed</span>')
})

test('passes unreadEnabled to file rows', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RecentContent
        layoutData={{
          signedIn: true,
          workspaceName: 'Fixture',
          selfUploadEnabled: true,
          openUploadDialog: () => undefined,
        }}
        files={[file]}
        unreadEnabled
      />
    </MemoryRouter>,
  )
  expect(html).toContain('data-unread-badges="true"')
  expect(html).toContain('data-show-owner="undefined"')
})

test('renders recent rows before viewer calendar hydration', () => {
  hydration.value = false
  try {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecentListBody files={[file]} />
      </MemoryRouter>,
    )
    expect(html).toContain('data-slot="file-row"')
  } finally {
    hydration.value = true
  }
})

test('renders restricted rows without links or action buttons and with a day heading', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
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
            shareableId: 'r1',
            title: 'Secret title',
            ownerName: 'Other Owner',
            ownerImage: null,
            lastViewedAt: '2026-01-15T00:00:00.000Z',
          },
        ]}
      />
    </MemoryRouter>,
  )
  expect(html).toContain('Secret title')
  const restrictedMarkup = html.slice(
    html.indexOf('Secret title') - 300,
    html.indexOf('Secret title') + 300,
  )
  expect(restrictedMarkup).not.toContain('<a ')
  expect(restrictedMarkup).not.toContain('<button')
  expect(html).toMatch(/<h2>[^<]+<\/h2>/)
})

test('recent restricted rows preserve the existing two-column layout', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
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
            shareableId: 'r1',
            title: 'Secret title',
            ownerName: 'Other Owner',
            ownerImage: null,
            lastViewedAt: '2026-01-15T00:00:00.000Z',
          },
        ]}
      />
    </MemoryRouter>,
  )
  expect(html).toContain('max-wide:grid-cols-[minmax(0,1fr)_auto]')
  expect(html).not.toContain('max-stack:px-0')
})

test('home restricted rows use the same compact edge alignment as file rows', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RecentListBody
        files={[
          {
            kind: 'restricted',
            shareableId: 'r1',
            title: 'Secret title',
            ownerName: 'Other Owner',
            ownerImage: null,
            lastViewedAt: '2026-01-15T00:00:00.000Z',
          },
        ]}
        homeCompact
      />
    </MemoryRouter>,
  )
  expect(html).toContain('max-stack:px-0')
  expect(html).toContain('grid-cols-[minmax(0,1fr)]')
  expect(html).toContain('Other Owner · recent.restricted')
})

test.each([0, 1, 3, 5, 20])(
  'home omits the older-history footer when total is %i',
  (total) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <RecentListBody files={[file]} total={total} olderHistoryLink />
      </MemoryRouter>,
    )
    expect(html).not.toContain('home.continueOlder')
    expect(html).not.toContain('href="/recent?page=2"')
  },
)

test.each([
  { total: 23, older: 3 },
  { total: 25, older: 5 },
])('home footer continues to page two for $older older files', ({ total }) => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/?relation=project&unread=1']}>
      <RecentListBody
        files={[file]}
        relation="project"
        unread
        total={total}
        olderHistoryLink
      />
    </MemoryRouter>,
  )
  expect(html).toContain('home.continueOlder')
  expect(html).toContain(
    'href="/recent?page=2&amp;relation=project&amp;unread=1"',
  )
  expect(html).toContain('whitespace-nowrap')
})

test('home hides the older-history footer when recent loading failed', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <RecentListBody files={[file]} total={25} olderHistoryLink error />
    </MemoryRouter>,
  )
  expect(html).not.toContain('home.continueOlder')
})

test('shared body exposes selected relation pills and an accessible unread switch', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/recent']}>
      <RecentListBody
        files={[file]}
        relation="project"
        unread
        historyCardinality={2}
      />
    </MemoryRouter>,
  )
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('href="/recent?relation=project&amp;unread=1"')
  expect(html).toContain('role="switch"')
  expect(html).toContain('aria-checked="true"')
  expect(html).toContain('max-phone:overflow-x-auto')
  expect(html).not.toContain('aria-current="page" class="max-phone:')

  const homeHtml = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <RecentListBody files={[file]} relation="project" unread />
    </MemoryRouter>,
  )
  expect(homeHtml).toContain('href="/?relation=project&amp;unread=1"')
})

test('shared body distinguishes filtered empty from the unfiltered one-item hint', () => {
  const filtered = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/recent']}>
      <RecentListBody
        files={[]}
        relation="shared"
        unread
        historyCardinality={2}
      />
    </MemoryRouter>,
  )
  expect(filtered).not.toContain('recent.filteredEmpty')
  expect(filtered).toContain('recent.reset')
  expect(filtered).toContain('href="/recent"')

  const one = renderToStaticMarkup(
    <MemoryRouter>
      <RecentListBody files={[file]} historyCardinality={1} />
    </MemoryRouter>,
  )
  expect(one).toContain('recent.oneItemHint')
  expect(one).not.toContain('recent.filteredEmpty')
})

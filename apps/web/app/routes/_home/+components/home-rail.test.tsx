import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { HomeRail } from './home-rail'
import type { FileRowData } from './file-data'

const { viewerCalendar } = vi.hoisted(() => ({
  viewerCalendar: {
    hydrated: true,
    timeZone: 'UTC',
    now: new Date('2026-07-29T12:00:00.000Z'),
  },
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'ja',
    t: (key: string, vars: Record<string, string> = {}) => {
      if (vars.version != null) return `${key}:${vars.version}`
      if (vars.count != null) return `${key}:${vars.count}`
      return vars.day ? `${key}:${vars.day}` : key
    },
    tPlural: (key: string, n: number, vars: Record<string, string> = {}) => {
      if (key === 'row.newComments') {
        return `${key}${n === 1 ? 'One' : 'Other'}:${vars.count ?? n}`
      }
      return `${key}:${n}`
    },
  }),
}))
vi.mock('~/hooks/use-viewer-calendar', () => ({
  useViewerCalendar: () => viewerCalendar,
}))
vi.mock('~/components/app/author-avatar', () => ({
  AuthorAvatar: () => <span>avatar</span>,
}))
vi.mock('~/components/app/file-type-icon', () => ({
  FileTypeIcon: () => <span>kind-icon</span>,
}))

const file = (over: Partial<FileRowData> = {}): FileRowData =>
  ({
    id: 'f1',
    fileName: 'doc.md',
    derivedTitle: null,
    titleOverride: null,
    renderType: 'md',
    visibility: 'workspace',
    ownerId: 'u1',
    ownerImage: null,
    ownerInitial: 'A',
    ownerIsExternal: false,
    ownerEmail: 'a@example.com',
    ownerName: 'Alice',
    registeredByMe: true,
    viewCount: 0,
    commentCount: 0,
    projectName: null,
    createdTime: '2000-07-10T00:00:00.000Z',
    modifiedTime: '2000-07-22T00:00:00.000Z',
    ...over,
  }) as FileRowData

const noErrors = { files: false, recent: false, projects: false }

describe('HomeRail density', () => {
  test('keeps files, projects, and recently viewed files in that order', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[file()]}
          recent={[file({ id: 'recent-file' })]}
          projects={[{ id: 'p1', name: 'Metrics', joined: false }]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html.indexOf('home.myFiles')).toBeLessThan(
      html.indexOf('home.projects'),
    )
    expect(html.indexOf('home.projects')).toBeLessThan(
      html.indexOf('home.recentViewed'),
    )
    expect(html).not.toContain('home.recentActivity')
  })

  test('uses the viewer timezone for calendar labels', () => {
    viewerCalendar.timeZone = 'Asia/Tokyo'
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[file({ createdTime: '2026-07-29T15:30:00.000Z' })]}
          recent={[]}
          projects={[]}
          errors={noErrors}
          now="2026-07-30T01:00:00.000Z"
        />
      </MemoryRouter>,
    )
    viewerCalendar.timeZone = 'UTC'

    expect(html).toContain('今日')
  })

  test('my files rows keep the link details without a shareable peek', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[file()]}
          recent={[]}
          projects={[]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('kind-icon')
    expect(html).toContain('7月10日')
    expect(html).toContain('card.viewCount:0')
    expect(html).toContain('href="/a/f1"')
    expect(html).not.toContain('data-peek="shareable"')
    expect(html).not.toContain('card.commentCount')
  })

  test('recent rows keep their file link without a hover preview', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[file({ id: 'recent-file' })]}
          projects={[]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/a/recent-file"')
    expect(html).not.toContain('hover-card-trigger')
  })

  test('recent rows show avatar, owner, viewed-on label, and hide zero comments', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[file()]}
          projects={[]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('avatar')
    expect(html).toContain('Alice')
    expect(html).toContain('rail.viewedOn:')
    expect(html).toContain('7月22日')
    expect(html).toContain('card.viewCount:0')
  })

  test('comment counts appear only above zero', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[file({ commentCount: 2 })]}
          recent={[]}
          projects={[]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('card.commentCount:2')
  })

  test('joined projects show counts, updated label, new badge, and a plain link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[]}
          projects={[
            {
              id: 'p1',
              name: 'Metrics',
              joined: true,
              updatedAt: '2000-07-15T00:00:00.000Z',
              fileCount: 27,
              newCount: 2,
            },
          ]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/projects/p1"')
    expect(html).not.toContain('hover-card-trigger')
    expect(html).toContain('tb.fileCount:27')
    expect(html).toContain('rail.updatedOn:')
    expect(html).toContain('7月15日')
    expect(html).toContain('project.newBadge')
  })

  test('non-joined fallback keeps the plain name-only row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[]}
          projects={[{ id: 'p2', name: 'Mine', joined: false }]}
          errors={noErrors}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('Mine')
    expect(html).not.toContain('hover-card-trigger')
    expect(html).not.toContain('tb.fileCount')
  })
})

const railNow = '2026-07-29T12:00:00.000Z'

describe('HomeRail unread motion (recent only)', () => {
  test('recent rows show unread dot and aria-label', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[
            file({
              unreadVersionCount: 1,
              versionCount: 2,
              latestPublishedAt: '2026-07-28T00:00:00.000Z',
            }),
          ]}
          projects={[]}
          errors={noErrors}
          now={railNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('bg-link size-2')
    expect(html).toContain('aria-label="doc.md · row.unread"')
  })

  test('recent rows show new-comment copy', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[file({ unreadCommentCount: 2 })]}
          projects={[]}
          errors={noErrors}
          now={railNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('row.newCommentsOther:2')
  })

  test('recent rows show version badge within seven days', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[]}
          recent={[
            file({
              versionCount: 4,
              latestPublishedAt: '2026-07-27T00:00:00.000Z',
            }),
          ]}
          projects={[]}
          errors={noErrors}
          now={railNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('project.versionBadge:4')
  })

  test('my files rows do not show unread motion UI', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeRail
          files={[
            file({
              unreadVersionCount: 3,
              unreadCommentCount: 2,
              versionCount: 5,
              latestPublishedAt: '2026-07-28T00:00:00.000Z',
            }),
          ]}
          recent={[]}
          projects={[]}
          errors={noErrors}
          now={railNow}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('bg-link size-2')
    expect(html).not.toContain('row.unread')
    expect(html).not.toContain('row.newComments')
    expect(html).not.toContain('project.versionBadge')
  })
})

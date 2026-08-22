import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { FileRow } from './file-row'
import { fileTableHeadClassName } from './file-list-styles'

vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router')
  return { ...actual, useViewTransitionState: () => false }
})

vi.mock('../+hooks/use-file-labels', () => ({
  useFileLabels: () => ({
    owner: 'Alice',
    modified: '2026-07-29',
    activity: 'Viewed',
    visibility: 'Public',
  }),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, vars: Record<string, string | number> = {}) => {
      if (vars.version != null) return `${key}:${vars.version}`
      if (vars.count != null) return `${key}:${vars.count}`
      return key
    },
    tPlural: (
      key: string,
      n: number,
      vars: Record<string, string | number> = {},
    ) => `${key}${n === 1 ? 'One' : 'Other'}:${vars.count ?? n}`,
  }),
}))
vi.mock('~/components/app/author-avatar', () => ({
  AuthorAvatar: () => <span>avatar</span>,
}))
vi.mock('~/components/app/ext-tag', () => ({
  ExtTag: () => <span>external</span>,
}))
vi.mock('~/components/app/file-type-icon', () => ({
  FileTypeIcon: () => <span>icon</span>,
}))
vi.mock('~/components/app/visibility-chip', () => ({
  VisibilityChip: () => <span>visibility</span>,
}))
vi.mock('./copy-url-button', () => ({ CopyUrlButton: () => <span>copy</span> }))

const data = {
  id: 'abc',
  fileName: 'photo.png',
  derivedTitle: null,
  titleOverride: null,
  renderType: 'md',
  visibility: 'link',
  ownerId: 'user',
  ownerImage: null,
  ownerInitial: 'A',
  ownerIsExternal: false,
  ownerEmail: 'alice@example.com',
  ownerName: 'Alice',
  registeredByMe: true,
  viewCount: 0,
  commentCount: 0,
  projectName: null,
  modifiedTime: '2026-07-29T00:00:00.000Z',
} as const

describe('FileRow', () => {
  test.each([
    [false, 'grid-cols-[minmax(280px,1fr)_112px_90px_120px_36px]', false],
    [
      true,
      'grid-cols-[minmax(280px,1fr)_112px_90px_120px_minmax(120px,0.35fr)_36px]',
      true,
    ],
  ])(
    'keeps the %s column definition and cells aligned',
    (showOwner, columns, hasOwner) => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <FileRow data={data} showOwner={showOwner} />
        </MemoryRouter>,
      )
      expect(html).toContain(columns)
      expect(html).toContain('2026-07-29')
      expect(
        (html.match(/data-regression-responsive="desktop-only"/g) ?? []).length,
      ).toBe(hasOwner ? 3 : 2)
    },
  )
})

describe('file table header', () => {
  test('carries no grid column definition of its own', () => {
    // The caller pairs fileTableHeadClassName with fileTableColumns or
    // filesTableColumns; a second definition here would fight the rows.
    expect(fileTableHeadClassName).not.toContain('grid-cols-')
  })

  test('shows a contextual workspace beside a project name only when supplied', () => {
    const crossWorkspace = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...data,
            projectName: 'A very long project name',
            contextualWorkspaceLabel: 'A very long workspace name',
          }}
          showOwner={false}
        />
      </MemoryRouter>,
    )
    expect(crossWorkspace).toContain('A very long project name')
    expect(crossWorkspace).toContain('A very long workspace name')
    expect(crossWorkspace).toContain('text-faint')

    const sameWorkspace = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...data, projectName: 'A very long project name' }}
          showOwner={false}
        />
      </MemoryRouter>,
    )
    expect(sameWorkspace).not.toContain('A very long workspace name')
  })
})

describe('FileRow row actions', () => {
  test('menuEnabled widens the action column and shows the kebab', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={data} showOwner={false} menuEnabled />
      </MemoryRouter>,
    )
    expect(html).toContain(
      'grid-cols-[minmax(280px,1fr)_112px_90px_120px_76px]',
    )
    expect(html).toContain('vw.more')
  })

  test('the default action zone keeps copy-only behavior without a hover preview', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={data} showOwner={false} />
      </MemoryRouter>,
    )
    expect(html).not.toContain('vw.more')
    expect(html).not.toContain('hover-card-trigger')
  })

  test('lost-access rows render neither copy nor menu', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...data, lostAccess: true }}
          showOwner={false}
          menuEnabled
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('vw.more')
    expect(html).not.toContain('copy')
  })
})

describe('FileRow unread motion layout', () => {
  test('the desktop subline hides at narrow widths so the mobile meta row is not duplicated', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...data, unreadCommentCount: 1 }}
          showOwner={false}
          unreadBadges
          now="2026-07-29T00:00:00.000Z"
        />
      </MemoryRouter>,
    )
    // デスクトップ側のサブ行は max-wide:hidden を持ち、狭幅ではモバイルメタ行だけが残る
    expect(html).toContain('min-w-0 truncate max-wide:hidden')
  })
})

describe('FileRow richStats', () => {
  test('rich shows the view count even at zero and hides zero comments', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={data} showOwner={false} richStats />
      </MemoryRouter>,
    )
    expect(html).toContain('card.viewCount')
    expect(html).not.toContain('card.commentCount')
    expect(html).toContain('2026-07-29')
  })

  test('rich keeps the view count on the mobile-only meta row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={data} showOwner={false} richStats />
      </MemoryRouter>,
    )
    const mobile = html.split('data-regression-responsive="mobile-only"')[1]
    expect(mobile).toContain('card.viewCount')
  })

  test('without richStats the compact joined string remains', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={data} showOwner={false} />
      </MemoryRouter>,
    )
    expect(html).toContain('Viewed')
    expect(html).not.toContain('card.viewCount')
  })

  test('rich shows comment count when above zero', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...data, commentCount: 3 }}
          showOwner={false}
          richStats
        />
      </MemoryRouter>,
    )
    expect(html).toContain('card.commentCount')
  })
})

const motionNow = '2026-07-29T12:00:00.000Z'

const motionBase = {
  ...data,
  versionCount: 3,
  latestPublishedAt: '2026-07-28T00:00:00.000Z',
}

describe('FileRow unreadBadges', () => {
  test('does not render unread owner motion or preview for own files', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...motionBase,
            latestUnreadComment: {
              id: 'c',
              authorId: 'other',
              authorName: 'Other',
              authorImage: null,
              body: 'hidden',
              createdAt: motionNow,
            },
          }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('hidden「')
    expect(html).not.toContain('row.newComment')
  })

  test('renders latest unread comment preview and remaining count', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...motionBase,
            unreadCommentCount: 3,
            unreadCommentRemainingCount: 2,
            latestUnreadComment: {
              id: 'comment-1',
              authorId: 'author-1',
              authorName: 'Bob',
              authorImage: null,
              body: 'A long comment https://example.com/a very long continuation',
              createdAt: '2026-07-29T11:00:00.000Z',
            },
          }}
          showOwner={false}
          inlineOwner
          unreadBadges
          recencyPresentation="grouped-with-preview"
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('row.newComment')
    expect(html).toContain('Bob</span>: A long comment')
    expect(html).toContain('row.moreComments:2')
    expect(html).toContain('line-clamp-2')
  })

  test('does not render preview when comment body is unavailable', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...motionBase, unreadCommentCount: 2 }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('row.newComment</span>')
    expect(html).toContain('row.newCommentsOther:2')
  })

  test('hides row-level modified time when a day heading owns recency', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow data={motionBase} recencyPresentation="grouped" />
      </MemoryRouter>,
    )
    expect(html).not.toContain('2026-07-29')
  })

  test('shows unread dot and aria-label when there is unread motion', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...motionBase,
            unreadVersionCount: 1,
          }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('bg-link size-2')
    expect(html).toContain('aria-label="photo.png · row.unread"')
  })

  test('hides dot and unread aria suffix when there is no unread motion', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...motionBase, unreadVersionCount: 0, unreadCommentCount: 0 }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('bg-link size-2')
    expect(html).toContain('aria-label="photo.png"')
  })

  test('shows plural new-comment copy for three unread comments', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...motionBase, unreadCommentCount: 3 }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('row.newCommentsOther:3')
  })

  test('caps unread comment label at 99+', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{ ...motionBase, unreadCommentCount: 100 }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('row.newCommentsOther:99+')
  })

  test('shows version badge within seven days even with zero unread', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...motionBase,
            unreadVersionCount: 0,
            unreadCommentCount: 0,
          }}
          showOwner={false}
          unreadBadges
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('project.versionBadge:3')
  })

  test('does not show unread UI when unreadBadges is omitted', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FileRow
          data={{
            ...motionBase,
            unreadVersionCount: 2,
            unreadCommentCount: 5,
          }}
          showOwner={false}
          now={motionNow}
        />
      </MemoryRouter>,
    )
    expect(html).not.toContain('bg-link size-2')
    expect(html).not.toContain('row.unread')
    expect(html).not.toContain('row.newComments')
    expect(html).not.toContain('project.versionBadge')
  })
})

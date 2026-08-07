import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { FeedEventRow } from '~/services/events.server'

const state = vi.hoisted(() => ({ locale: 'ja' }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: state.locale,
    t: (key: string, vars: Record<string, string> = {}) => {
      const labels: Record<string, string> =
        state.locale === 'ja'
          ? {
              'home.actorPublished': `${vars.actor}さんが v${vars.version} に更新しました`,
              'home.actorPublishedRange': `${vars.actor}さんが v${vars.start}〜v${vars.end} に更新しました`,
              'home.publishedRange': `v${vars.start}〜v${vars.end} に更新されました`,
              'home.actorCommented': `${vars.actor}さんがコメントしました`,
              'home.actorCommentedCount': `${vars.actor}さんが ${vars.count} 件コメントしました`,
              'home.actorAdded': `${vars.actor}さんが追加しました`,
              'home.actorAddedToProjectCount': `${vars.actor}さんが${vars.project}に${vars.count}件追加しました`,
              'home.anonymousViewsInline_one': `${vars.title} がリンク経由で${vars.count}回閲覧されました`,
              'home.anonymousViewsInline_other': `${vars.title} がリンク経由で${vars.count}回閲覧されました`,
              'home.actorPublishedInline': `${vars.actor}さんが ${vars.title} を v${vars.version} に更新しました`,
              'home.actorPublishedRangeInline': `${vars.actor}さんが ${vars.title} を v${vars.start}〜v${vars.end} に更新しました`,
              'home.publishedRangeInline': `${vars.title} が v${vars.start}〜v${vars.end} に更新されました`,
              'home.actorCommentedInline': `${vars.actor}さんが ${vars.title} にコメントしました`,
              'home.actorCommentedCountInline': `${vars.actor}さんが ${vars.title} に ${vars.count} 件コメントしました`,
              'home.actorAddedInline': `${vars.actor}さんが ${vars.title} を追加しました`,
              'home.viewedByInline_one': `${vars.title} が ${vars.count}人に閲覧されました`,
              'home.viewedByInline_other': `${vars.title} が ${vars.count}人に閲覧されました`,
            }
          : {
              'home.actorPublished': `${vars.actor} updated v${vars.version}`,
              'home.actorPublishedRange': `${vars.actor} updated v${vars.start}–v${vars.end}`,
              'home.publishedRange': `Updated v${vars.start}–v${vars.end}`,
              'home.actorCommented': `${vars.actor} commented`,
              'home.actorCommentedCount': `${vars.actor} commented ${vars.count} times`,
              'home.viewDigest_one': `${vars.files} of your files viewed by ${vars.count} person`,
              'home.viewDigest_other': `${vars.files} of your files viewed by ${vars.count} people`,
              'home.viewDigestAnonymous_one': `${vars.files} files viewed anonymously`,
              'home.viewDigestAnonymous_other': `${vars.files} files viewed anonymously (${vars.count})`,
              'home.anonymousViewsSuffix_one': `${vars.count} anonymous`,
              'home.anonymousViewsSuffix_other': `${vars.count} anonymous`,
              'home.viewDigestTop': 'Top:',
              'home.listSeparator': ', ',
              'home.actorPublishedInline': `${vars.actor} updated ${vars.title} as v${vars.version}`,
              'home.actorPublishedRangeInline': `${vars.actor} updated ${vars.title} from v${vars.start}–v${vars.end}`,
              'home.publishedRangeInline': `${vars.title} updated from v${vars.start}–v${vars.end}`,
              'home.actorCommentedInline': `${vars.actor} commented on ${vars.title}`,
              'home.actorCommentedCountInline': `${vars.actor} commented on ${vars.title} ${vars.count} times`,
              'home.actorAddedInline': `${vars.actor} added ${vars.title}`,
              'home.viewedByInline_one': `${vars.title} viewed by ${vars.count} person`,
              'home.viewedByInline_other': `${vars.title} viewed by ${vars.count} people`,
            }
      return labels[key] ?? key
    },
  }),
}))
vi.mock('react-router', () => ({
  // data-slot 等の注入 props (Radix asChild) を落とさないよう rest を通す
  Link: ({
    children,
    to,
    ...rest
  }: {
    children: string
    to: string
  } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/' }),
}))
vi.mock('~/lib/datetime', () => ({ formatRelative: () => 'now' }))

import { FeedItem } from './feed-item'

const row = (overrides: Partial<FeedEventRow>): FeedEventRow => ({
  id: 'event',
  type: 'version_published',
  shareableId: 'share-1',
  shareableTitle: 'Title',
  actorId: 'actor-1',
  actorName: 'Alice',
  versionNumber: 2,
  versionStart: null,
  versionEnd: null,
  versionAuthorCount: null,
  commentBody: null,
  commentCount: null,
  viewUniqueCount: null,
  anonymousViewCount: null,
  viewedFileCount: null,
  viewTopItems: null,
  createdAt: '2026-01-02T00:00:00Z',
  dayKey: '2026-01-02',
  isViewerInbox: false,
  ...overrides,
})

describe('FeedItem version copy', () => {
  test.each([
    ['ja', 'Aliceさんが '],
    ['en', 'Alice updated '],
  ])('renders the single-version copy in %s', (locale, expected) => {
    state.locale = locale
    expect(renderToStaticMarkup(<FeedItem row={row({})} />)).toContain(expected)
  })

  test.each([
    ['ja', 'Aliceさんが ', 'v2〜v3 に更新されました'],
    ['en', 'Alice updated ', 'updated from v2–v3'],
  ])('renders named and anonymous ranges in %s', (locale, named, anonymous) => {
    state.locale = locale
    expect(
      renderToStaticMarkup(
        <FeedItem
          row={row({ versionStart: 2, versionEnd: 3, versionAuthorCount: 1 })}
        />,
      ),
    ).toContain(named)
    expect(
      renderToStaticMarkup(
        <FeedItem
          row={row({ versionStart: 2, versionEnd: 3, versionAuthorCount: 2 })}
        />,
      ),
    ).toContain(anonymous)
  })

  test('links to the artifact', () => {
    expect(renderToStaticMarkup(<FeedItem row={row({})} />)).toContain(
      'href="/a/share-1"',
    )
  })

  test.each([
    ['ja', 'Aliceさんが '],
    ['en', 'Alice commented on '],
  ])('renders aggregated comment copy and quote in %s', (locale, expected) => {
    state.locale = locale
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'comment_posted',
          commentCount: 3,
          commentBody: 'quoted text',
        })}
      />,
    )
    expect(html).toContain(expected)
    expect(html).toContain('quoted text')
  })

  test('renders individual comment copy when count is null', () => {
    state.locale = 'ja'
    expect(
      renderToStaticMarkup(
        <FeedItem row={row({ type: 'comment_posted', commentCount: null })} />,
      ),
    ).toContain('Aliceさんが ')
  })

  test.each([
    [
      { viewUniqueCount: 2, anonymousViewCount: 0 },
      '3 of your files viewed by 2 people',
    ],
    [
      { viewUniqueCount: 0, anonymousViewCount: 1 },
      '3 files viewed anonymously',
    ],
    [
      { viewUniqueCount: 1, anonymousViewCount: 2 },
      '3 of your files viewed by 1 person · 2 anonymous',
    ],
  ])('renders digest copy and links top items', (counts, expected) => {
    state.locale = 'en'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [
            { shareableId: 'top-1', title: 'First', count: 4 },
            { shareableId: 'top-2', title: 'Second', count: 2 },
          ],
          ...counts,
        })}
      />,
    )
    expect(html).toContain(expected)
    expect(html).toContain('href="/a/top-1"')
    expect(html).toContain('href="/a/top-2"')
    expect(html).toContain(
      'First</a><span class="text-muted-foreground"> (4)</span>',
    )
    expect(html).toContain('First</a>')
    expect(html).not.toContain('First (4)</a>')
    expect(html).toContain(' (4)</span></span><span>, <a href="/a/top-2"')
  })

  test('digest rows carry no place meta even with showLocation', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [{ shareableId: 'top-1', title: 'First', count: 4 }],
          isViewerInbox: true,
        })}
      />,
    )
    expect(html).not.toContain('tabler-icon-home')
    expect(html).not.toContain('tb.home')
  })
})

describe('FeedItem event icon semantics', () => {
  function iconMarkup(html: string) {
    const match = html.match(/(<span aria-hidden="true"[^>]*>.*?<\/span>)/)
    return match?.[1] ?? ''
  }

  test.each([
    ['artifact_viewed', 'tabler-icon-eye', 'bg-link-soft text-link'],
    ['comment_posted', 'tabler-icon-message', 'text-link'],
    [
      'version_published',
      'tabler-icon-git-branch',
      'bg-warning-soft text-warning',
    ],
    ['artifact_created', 'tabler-icon-plus', 'bg-muted text-muted-foreground'],
  ] as const)(
    '%s uses the intended icon and meaning color',
    (type, icon, color) => {
      state.locale = 'en'
      const markup = iconMarkup(
        renderToStaticMarkup(<FeedItem row={row({ type })} />),
      )
      expect(markup).not.toBe('')
      expect(markup).toContain(icon)
      expect(markup).toContain(
        `class="flex size-6 shrink-0 items-center justify-center rounded ${color}"`,
      )
      if (type === 'comment_posted') {
        expect(markup).not.toContain('bg-success')
        expect(markup).not.toContain('text-success')
      }
    },
  )

  test('comments use the same blue as views but remain distinguishable by icon and background', () => {
    state.locale = 'en'
    const comment = iconMarkup(
      renderToStaticMarkup(<FeedItem row={row({ type: 'comment_posted' })} />),
    )
    const view = iconMarkup(
      renderToStaticMarkup(<FeedItem row={row({ type: 'artifact_viewed' })} />),
    )
    expect(comment).toContain('tabler-icon-message')
    expect(comment).not.toContain('bg-link-soft')
    expect(comment).toContain('text-link')
    expect(view).toContain('tabler-icon-eye')
    expect(view).toContain('bg-link-soft text-link')
  })

  test.each(['comment_posted', 'artifact_viewed'] as const)(
    '%s keeps the same icon semantics in compact mode',
    (type) => {
      state.locale = 'en'
      const regular = iconMarkup(
        renderToStaticMarkup(<FeedItem row={row({ type })} />),
      )
      const compact = iconMarkup(
        renderToStaticMarkup(<FeedItem compact row={row({ type })} />),
      )
      expect(compact).toBe(regular)
    },
  )
})

describe('FeedItem add bundle', () => {
  test('bundled additions show the count text and link to the project files page', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_created',
          addCount: 3,
          containerId: 'proj1',
          containerName: 'Project One',
        })}
      />,
    )
    expect(html).toContain('Aliceさんが')
    expect(html).toContain('3件追加しました')
    expect(html).toContain('href="/projects/proj1/files"')
    expect(html).not.toContain('href="/a/share-1"')
  })

  test('a single addition keeps the individual row and artifact link', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem row={row({ type: 'artifact_created', addCount: null })} />,
    )
    expect(html).toContain('Aliceさんが ')
    expect(html).toContain('href="/a/share-1"')
  })
})

describe('FeedItem location meta', () => {
  test('project rows show the project mark and name with showLocation', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({ containerKind: 'project', containerName: 'Metrics' })}
      />,
    )
    expect(html).toContain('tabler-icon-stack-2')
    expect(html).toContain('Metrics')
  })

  test('own inbox rows show home icon and label', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({ containerKind: 'inbox', isViewerInbox: true })}
      />,
    )
    expect(html).toContain('tabler-icon-home')
    expect(html).toContain('tb.home')
  })

  test("someone else's inbox rows show time only", () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          containerKind: 'inbox',
          containerName: '未整理',
          isViewerInbox: false,
        })}
      />,
    )
    expect(html).not.toContain('tabler-icon-home')
    expect(html).not.toContain('tabler-icon-stack-2')
    expect(html).not.toContain('未整理')
  })

  test('without showLocation (project context) no place renders', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({ containerKind: 'project', containerName: 'Metrics' })}
      />,
    )
    expect(html).not.toContain('tabler-icon-stack-2')
  })

  test('add bundles keep time only and no trailing title link line', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        showLocation
        row={row({
          type: 'artifact_created',
          addCount: 3,
          containerId: 'p1',
          containerKind: 'project',
          containerName: 'Metrics',
        })}
      />,
    )
    const meta = html.split('<time')[1] ?? ''
    expect(meta).not.toContain('tabler-icon-stack-2')
  })

  test('the meta line uses a machine-readable time element', () => {
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    expect(html).toContain('dateTime="2026-01-02T00:00:00Z"')
  })

  test('comment rows carry no peek trigger on the inline title', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem row={row({ type: 'comment_posted', commentBody: 'quote' })} />,
    )
    expect(html).not.toContain('hover-card-trigger')
    // 正の対照: 版更新行のインラインリンクには peek トリガが付く
    expect(renderToStaticMarkup(<FeedItem row={row({})} />)).toContain(
      'hover-card-trigger',
    )
  })

  test('single anonymous view rows keep the inline title link', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewUniqueCount: null,
          anonymousViewCount: 3,
        })}
      />,
    )
    expect(html).toContain('href="/a/share-1"')
  })
})

describe('FeedItem title line wrapping', () => {
  function firstLineClassName(html: string) {
    const match = html.match(
      /<div class="min-w-0 flex-1">\s*<div class="([^"]*)"/,
    )
    return match?.[1] ?? ''
  }

  test('first line does not use truncate', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    // 正の対照: className を取り出せていることを先に確かめる。取り出しに
    // 失敗すると '' が返り、not.toContain が無条件に通ってしまう。
    expect(firstLineClassName(html)).not.toBe('')
    expect(firstLineClassName(html)).not.toContain('truncate')
  })

  test('first line uses wrap-anywhere', () => {
    state.locale = 'ja'
    const html = renderToStaticMarkup(<FeedItem row={row({})} />)
    expect(firstLineClassName(html)).toContain('wrap-anywhere')
  })

  test('view digest top list clamps only below the stack breakpoint', () => {
    state.locale = 'en'
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'artifact_viewed',
          viewedFileCount: 3,
          viewTopItems: [{ shareableId: 'top-1', title: 'First', count: 4 }],
          viewUniqueCount: 2,
          anonymousViewCount: 0,
        })}
      />,
    )
    const match = html.match(/<div class="text-muted-foreground ([^"]*)">Top:/)
    const className = match?.[1] ?? ''
    // desktop で clamp すると 3 件目が隠れるため、前置修飾ごと固定する。
    // toContain('line-clamp-2') では無条件の clamp でも通ってしまう。
    expect(className).toContain('max-stack:line-clamp-2')
    expect(className).toContain('wrap-anywhere')
  })

  test('aggregated comment row renders full copy including count', () => {
    state.locale = 'ja'
    const longActor = 'あ'.repeat(32)
    const longTitle = 'い'.repeat(80)
    const html = renderToStaticMarkup(
      <FeedItem
        row={row({
          type: 'comment_posted',
          actorName: longActor,
          shareableTitle: longTitle,
          commentCount: 3,
        })}
      />,
    )
    expect(html).toContain(`${longActor}さんが`)
    expect(html).toContain(longTitle)
    expect(html).toContain('3 件コメントしました')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FeedList, feedDayHeadingClassName } from './feed-list'

function TestFeedList(
  props: Omit<ComponentProps<typeof FeedList>, 'timeZone' | 'now'>,
) {
  return <FeedList {...props} timeZone="UTC" now="2026-01-15T12:00:00.000Z" />
}
import type { FeedEventRow } from '~/services/events.server'
import { mergeFeedRows } from '~/lib/feed-merge'

const hydratedState = vi.hoisted(() => ({ value: true }))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'ja' }),
}))
vi.mock('~/hooks/use-hydrated', () => ({
  useHydrated: () => hydratedState.value,
}))
vi.mock('./feed-item', () => ({
  FeedItem: ({ row }: { row: FeedEventRow }) => (
    <li data-slot="feed-item" data-id={row.id} />
  ),
}))

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const feedRow = (
  id: string,
  createdAt: string,
  dayKey: string,
): FeedEventRow => ({
  id,
  type: 'comment_posted',
  shareableId: 's1',
  shareableTitle: 'Title',
  actorId: 'u1',
  actorName: 'Alice',
  versionNumber: null,
  versionStart: null,
  versionEnd: null,
  versionAuthorCount: null,
  commentBody: null,
  viewUniqueCount: null,
  anonymousViewCount: null,
  viewedFileCount: null,
  viewTopItems: null,
  commentCount: null,
  createdAt,
  dayKey,
  isViewerInbox: false,
})

function countHeadings(html: string, tag: 'h2' | 'h3', label: string) {
  const re = new RegExp(
    `<${tag} class="${escapeRegExp(feedDayHeadingClassName)}">${escapeRegExp(label)}</${tag}>`,
    'g',
  )
  return (html.match(re) ?? []).length
}

function countHeadingTags(html: string, tag: 'h2' | 'h3') {
  const re = new RegExp(
    `<${tag} class="${escapeRegExp(feedDayHeadingClassName)}">`,
    'g',
  )
  return (html.match(re) ?? []).length
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
  hydratedState.value = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('FeedList day headings (hydrated)', () => {
  test('groups same-day rows by dayKey and shows 今日 then 昨日 once each', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[
          feedRow('a', '2026-01-15T01:00:00.000Z', '2026-01-15'),
          feedRow('b', '2026-01-15T23:00:00.000Z', '2026-01-15'),
          feedRow('c', '2026-01-14T12:00:00.000Z', '2026-01-14'),
        ]}
      />,
    )
    expect(countHeadings(html, 'h2', '今日')).toBe(1)
    expect(countHeadings(html, 'h2', '昨日')).toBe(1)
    expect(html).toContain('data-id="a"')
    expect(html).toContain('data-id="b"')
    expect(html).toContain('data-id="c"')
  })

  test('uses ja day heading for an older day in the same year', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[feedRow('old', '2026-01-10T00:00:00.000Z', '2026-01-10')]}
      />,
    )
    expect(html).toContain(
      `<h2 class="${feedDayHeadingClassName}">1月10日(土)</h2>`,
    )
  })

  test('shows one heading when the same dayKey continues across merged pages', () => {
    const page1 = [
      feedRow('p1a', '2026-01-15T02:00:00.000Z', '2026-01-15'),
      feedRow('p1b', '2026-01-15T01:00:00.000Z', '2026-01-15'),
    ]
    const page2 = [
      feedRow('p2a', '2026-01-15T00:30:00.000Z', '2026-01-15'),
      feedRow('p2b', '2026-01-14T12:00:00.000Z', '2026-01-14'),
    ]
    const rows = mergeFeedRows([page1, page2])
    const html = renderToStaticMarkup(<TestFeedList rows={rows} />)
    expect(countHeadings(html, 'h2', '今日')).toBe(1)
    expect(countHeadings(html, 'h2', '昨日')).toBe(1)
    expect(countHeadingTags(html, 'h2')).toBe(2)
  })

  test('shows a heading when only one day is present', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[feedRow('only', '2026-01-15T10:00:00.000Z', '2026-01-15')]}
      />,
    )
    expect(countHeadings(html, 'h2', '今日')).toBe(1)
    expect(countHeadingTags(html, 'h2')).toBe(1)
  })

  test('uses dayKey for the heading when it differs from the UTC calendar day of createdAt', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[feedRow('jst-night', '2026-01-14T14:00:00.000Z', '2026-01-15')]}
      />,
    )
    expect(countHeadings(html, 'h2', '今日')).toBe(1)
    expect(countHeadings(html, 'h2', '昨日')).toBe(0)
  })
})

describe('FeedList before hydration', () => {
  test('renders a flat list without day headings or sections', () => {
    hydratedState.value = false
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[
          feedRow('a', '2026-01-15T10:00:00.000Z', '2026-01-15'),
          feedRow('b', '2026-01-14T12:00:00.000Z', '2026-01-14'),
        ]}
      />,
    )
    expect(html).not.toContain('<h2')
    expect(html).not.toContain('<section')
    expect(html).not.toContain('今日')
    expect(html).not.toContain('昨日')
    expect(countHeadingTags(html, 'h2')).toBe(0)
    expect(html).toContain('data-id="a"')
    expect(html).toContain('data-id="b"')
  })
})

describe('FeedList heading level', () => {
  test('uses h2 by default', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        rows={[feedRow('a', '2026-01-15T10:00:00.000Z', '2026-01-15')]}
      />,
    )
    expect(html).toContain('<h2 class="')
    expect(html).not.toContain('<h3 class="')
  })

  test('uses h3 when headingAs is h3', () => {
    const html = renderToStaticMarkup(
      <TestFeedList
        headingAs="h3"
        rows={[feedRow('a', '2026-01-15T10:00:00.000Z', '2026-01-15')]}
      />,
    )
    expect(html).toContain('<h3 class="')
    expect(html).not.toContain('<h2 class="')
  })
})

describe('FeedList empty', () => {
  test('renders nothing when rows is empty', () => {
    const html = renderToStaticMarkup(<TestFeedList rows={[]} />)
    expect(html).toBe('')
  })
})

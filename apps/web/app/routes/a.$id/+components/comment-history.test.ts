import { describe, expect, test } from 'vitest'
import type { CommentMessageView, CommentThreadView } from '~/lib/comments'
import {
  commentGapRequests,
  mergeCommentWindow,
  patchCommentThreads,
  revalidateCommentPage,
} from './comment-history'

const at = '2026-05-01T00:00:00.000Z'
const message = (i: number): CommentMessageView => ({
  id: `message-${String(i).padStart(4, '0')}`,
  body: `Reply ${i}`,
  createdAt: at,
  updatedAt: at,
  agent: null,
  author: {
    id: 'reviewer',
    name: 'Reviewer',
    email: 'reviewer@example.com',
    image: null,
  },
  canEdit: true,
  canDelete: true,
})
const cursor = (i: number) =>
  btoa(JSON.stringify([1, 'thread', at, message(i).id])).replace(/=+$/, '')
function window(
  indices: number[],
  total = 104,
  olderCursor: string | null = cursor(101),
): CommentThreadView {
  return {
    id: 'thread',
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    canResolve: true,
    messageCount: total,
    replyCount: total - 1,
    olderCursor,
    messages: indices.map(message),
  }
}

describe('bounded comment page cache', () => {
  test('merges older pages in tuple order and retains expanded replies across a latest refresh', () => {
    const latest = window([0, 101, 102, 103])
    const page = { before: cursor(101), limit: 50 }
    const expanded = mergeCommentWindow(
      latest,
      window([0, 98, 99, 100], 104, cursor(98)),
      page,
    )
    expect(expanded.messages.map((item) => item.id)).toEqual(
      [0, 98, 99, 100, 101, 102, 103].map((i) => message(i).id),
    )
    const refreshed = mergeCommentWindow(
      expanded,
      window([0, 102, 103, 104], 105, cursor(102)),
    )
    expect(refreshed.messages).toHaveLength(8)
    expect(refreshed.olderCursor).toBe(cursor(98))
    expect(refreshed.loadedPages).toEqual([
      { ...page, coverageStart: cursor(98) },
      { through: cursor(103), limit: 3, coverageStart: cursor(101) },
    ])
  })

  test('revalidates displaced latest replies after edits and deletion of the boundary row', () => {
    const initial = window([0, 101, 102, 103])
    const shifted = mergeCommentWindow(
      initial,
      window([0, 104, 105, 106], 107, cursor(104)),
    )
    const coverage = { through: cursor(103), limit: 3 }
    expect(shifted.loadedPages).toEqual([
      { ...coverage, coverageStart: cursor(101) },
    ])
    expect(shifted.messages.map((item) => item.id)).toEqual(
      [0, 101, 102, 103, 104, 105, 106].map((i) => message(i).id),
    )
    const page = window([0, 99, 100, 102], 105, cursor(99))
    page.messages[3] = { ...message(102), body: 'Edited remotely' }
    const refreshed = mergeCommentWindow(shifted, page, coverage)
    expect(refreshed.messages.map((item) => item.id)).toEqual(
      [0, 99, 100, 102, 104, 105, 106].map((i) => message(i).id),
    )
    expect(
      refreshed.messages.find((item) => item.id === message(102).id)?.body,
    ).toBe('Edited remotely')
    expect(refreshed.olderCursor).toBe(cursor(104))
    expect(refreshed.loadedPages).toEqual([
      { ...coverage, coverageStart: cursor(99) },
    ])
  })

  test('covers a displaced tail beside an expanded page without losing its older cursor', () => {
    const older = { before: cursor(101), limit: 50 }
    const expanded = mergeCommentWindow(
      window([0, 101, 102, 103]),
      window([0, 98, 99, 100], 104, cursor(98)),
      older,
    )
    const shifted = mergeCommentWindow(
      expanded,
      window([0, 102, 103, 104], 105, cursor(102)),
    )
    const coverage = shifted.loadedPages![1]!
    expect(coverage).toEqual({
      through: cursor(103),
      limit: 3,
      coverageStart: cursor(101),
    })
    const refreshed = mergeCommentWindow(
      shifted,
      window([0, 100, 102, 103], 104, cursor(100)),
      coverage,
    )
    expect(refreshed.messages.map((item) => item.id)).toEqual(
      [0, 98, 99, 100, 102, 103, 104].map((i) => message(i).id),
    )
    expect(refreshed.olderCursor).toBe(cursor(98))
    expect(
      mergeCommentWindow(
        refreshed,
        window([0, 102, 103, 104], 104, cursor(102)),
      ).loadedPages,
    ).toEqual([
      { ...older, coverageStart: cursor(98) },
      { ...coverage, coverageStart: cursor(100) },
    ])
  })

  test.each([false, true])(
    'compacts consecutive equal-timestamp tails into bounded nonoverlapping requests (expanded=%s)',
    (expanded) => {
      let current = window([0, 101, 102, 103])
      if (expanded)
        current = mergeCommentWindow(
          current,
          window(
            [0, ...Array.from({ length: 50 }, (_, i) => i + 51)],
            104,
            cursor(51),
          ),
          { before: cursor(101), limit: 50 },
        )
      for (let last = 104; last <= 223; last++) {
        current = mergeCommentWindow(
          current,
          window([0, last - 2, last - 1, last], last + 1, cursor(last - 2)),
        )
        const pages = current.loadedPages!
        expect(pages.length).toBeLessThanOrEqual(
          Math.ceil((last - 101) / 50) + (expanded ? 1 : 0),
        )
        const requested = new Set<string>()
        for (const page of pages) {
          expect(page.limit).toBeLessThanOrEqual(50)
          const edge = JSON.parse(
            atob((page.through ?? page.before)!),
          )[3] as string
          const rows = current.messages
            .slice(1)
            .filter((item) => (page.before ? item.id < edge : item.id <= edge))
            .slice(-page.limit!)
          for (const row of rows) {
            expect(requested.has(row.id)).toBe(false)
            requested.add(row.id)
          }
        }
      }
      // A remote edit and deletion in displaced coverage must still be authoritative.
      const stored = Array.from({ length: 224 }, (_, i) => i).filter(
        (i) => i !== 150,
      )
      for (const page of current.loadedPages!) {
        const edge = JSON.parse(
          atob((page.through ?? page.before)!),
        )[3] as string
        const rows = stored
          .filter(
            (i) =>
              i > 0 &&
              (page.before ? message(i).id < edge : message(i).id <= edge),
          )
          .slice(-page.limit!)
        const incoming = window([0, ...rows], 223, cursor(rows[0]))
        incoming.messages = incoming.messages.map((item) =>
          item.id === message(151).id ? { ...item, body: 'Remote edit' } : item,
        )
        current = mergeCommentWindow(current, incoming, page)
      }
      expect(current.messages.some((item) => item.id === message(150).id)).toBe(
        false,
      )
      expect(
        current.messages.find((item) => item.id === message(151).id)?.body,
      ).toBe('Remote edit')
      expect(current.messages.at(-1)?.id).toBe(message(223).id)
    },
  )

  test('keeps disjoint displaced tails covered across coalesced jumps and remote changes', () => {
    let current = window([0, 101, 102, 103])
    for (const last of [113, 123])
      current = mergeCommentWindow(
        current,
        window([0, last - 2, last - 1, last], last + 1, cursor(last - 2)),
      )
    expect(current.loadedPages).toEqual([
      { through: cursor(103), limit: 3, coverageStart: cursor(101) },
      { through: cursor(113), limit: 3, coverageStart: cursor(111) },
    ])
    const stored = Array.from({ length: 124 }, (_, i) => i).filter(
      (i) => i !== 102,
    )
    for (const page of current.loadedPages!) {
      const edge = JSON.parse(atob(page.through!))[3] as string
      const rows = stored
        .filter((i) => i > 0 && message(i).id <= edge)
        .slice(-page.limit!)
      const incoming = window([0, ...rows], 123, cursor(rows[0]))
      incoming.messages = incoming.messages.map((item) =>
        item.id === message(101).id
          ? { ...item, body: 'Edited across gap' }
          : item,
      )
      current = mergeCommentWindow(current, incoming, page)
    }
    expect(current.messages.some((item) => item.id === message(102).id)).toBe(
      false,
    )
    expect(
      current.messages.find((item) => item.id === message(101).id)?.body,
    ).toBe('Edited across gap')
    expect(current.messages.some((item) => item.id === message(111).id)).toBe(
      true,
    )
  })

  test('a short around page never joins retained rows across an unloaded gap', () => {
    let current = window([0, 101, 102, 103])
    // The server returned only two replies for a request of 50 near the tail.
    current = mergeCommentWindow(
      current,
      window([0, 151, 152], 153, cursor(151)),
      {
        through: cursor(152),
        limit: 50,
      },
    )
    expect(current.loadedPages).toEqual([
      {
        through: cursor(152),
        limit: 50,
        coverageStart: cursor(151),
      },
    ])
    current = mergeCommentWindow(
      current,
      window([0, 161, 162, 163], 164, cursor(161)),
    )
    expect(current.loadedPages).toEqual([
      { through: cursor(103), limit: 3, coverageStart: cursor(101) },
      { through: cursor(152), limit: 2, coverageStart: cursor(151) },
    ])
    // Return real server keysets, including deletion and an edit in the old tail.
    const stored = Array.from({ length: 164 }, (_, i) => i).filter(
      (i) => i !== 102,
    )
    for (const page of current.loadedPages!) {
      const edge = JSON.parse(atob(page.through!))[3] as string
      const rows = stored
        .filter((i) => i > 0 && message(i).id <= edge)
        .slice(-page.limit!)
      const incoming = window([0, ...rows], 163, cursor(rows[0]))
      incoming.messages = incoming.messages.map((item) =>
        item.id === message(101).id
          ? { ...item, body: 'Edited old tail' }
          : item,
      )
      current = mergeCommentWindow(current, incoming, page)
    }
    expect(current.messages.some((item) => item.id === message(102).id)).toBe(
      false,
    )
    expect(
      current.messages.find((item) => item.id === message(101).id)?.body,
    ).toBe('Edited old tail')
    expect(current.messages.some((item) => item.id === message(151).id)).toBe(
      true,
    )
    expect(current.loadedPages).toHaveLength(2)
  })

  test.each([3, 50])(
    'revalidates displaced rows across a %i-reply interval with tied timestamps',
    async (size) => {
      const start = size === 3 ? 101 : 51
      const indices = Array.from({ length: size }, (_, i) => start + i)
      const page =
        size === 3
          ? { through: cursor(103), limit: 3, coverageStart: cursor(start) }
          : { before: cursor(101), limit: 50, coverageStart: cursor(start) }
      let current = {
        ...window([0, ...indices, 201, 202, 203]),
        latestReplyIds: [201, 202, 203].map((i) => message(i).id),
        loadedPages: [page],
      }
      const inserted = { ...message(start), id: `${message(start).id}a` }
      const shifted = {
        ...window([0, ...indices.slice(1)]),
        messages: [message(0), inserted, ...indices.slice(1).map(message)],
        olderCursor: btoa(
          JSON.stringify([1, 'thread', at, inserted.id]),
        ).replace(/=+$/, ''),
      }
      current = mergeCommentWindow(current, shifted, page) as typeof current
      expect(current.messages.some((m) => m.id === message(start).id)).toBe(
        true,
      )
      expect(current.loadedPages[0].coverageStart).toBe(cursor(start))
      let deleted = false
      const requests: Array<{ limit?: number }> = []
      const load = async (request: { before?: string; limit?: number }) => {
        requests.push(request)
        if (request.before === shifted.olderCursor)
          return {
            ...window([0, start - 1], 250, cursor(start - 1)),
            messages: [
              message(0),
              deleted
                ? message(start - 1)
                : { ...message(start), body: 'Authoritative edit' },
            ],
          }
        return shifted
      }
      current = (await revalidateCommentPage(
        current,
        current.loadedPages[0],
        load,
      )) as typeof current
      expect(
        current.messages.find((m) => m.id === message(start).id)?.body,
      ).toBe('Authoritative edit')
      deleted = true
      current = (await revalidateCommentPage(
        current,
        current.loadedPages[0],
        load,
      )) as typeof current
      expect(current.messages.some((m) => m.id === message(start).id)).toBe(
        false,
      )
      expect(
        indices
          .slice(1)
          .every((i) => current.messages.some((m) => m.id === message(i).id)),
      ).toBe(true)
      expect(requests).toHaveLength(4)
      expect(
        requests.every(
          (request) => request.limit! >= 1 && request.limit! <= 50,
        ),
      ).toBe(true)
      expect(current.loadedPages).toHaveLength(1)
    },
  )

  test('authoritative range replacement removes remote deletions but leaves other ranges and threads intact', () => {
    const page = { before: cursor(101), limit: 50 }
    const current = mergeCommentWindow(
      window([0, 101, 102, 103]),
      window([0, 98, 99, 100], 104, cursor(98)),
      page,
    )
    const unrelated = { ...window([0, 1], 2, null), id: 'unrelated' }
    const next = patchCommentThreads(
      [unrelated, current],
      [window([0, 97, 98, 100], 103, cursor(97))],
      { threadId: 'thread', page },
    )
    expect(next[0]).toBe(unrelated)
    expect(next[1].messages.map((item) => item.id)).toEqual(
      [0, 97, 98, 100, 101, 102, 103].map((i) => message(i).id),
    )
    expect(next[1].messages.some((item) => item.id === message(99).id)).toBe(
      false,
    )
  })

  test('promotes the current first message and removes a deleted thread explicitly', () => {
    const current = window([0, 1, 2, 3], 4, null)
    const promoted = patchCommentThreads(
      [current],
      [window([1, 2, 3], 3, null)],
      { threadId: 'thread', deletedMessageId: message(0).id },
    )
    expect(promoted[0].messages[0].id).toBe(message(1).id)
    expect(
      patchCommentThreads(promoted, [], {
        threadId: 'thread',
        deletedThreadId: 'thread',
      }),
    ).toEqual([])
  })

  test('a selected disjoint around page does not skip the contiguous older cursor', () => {
    const current = window([0, 101, 102, 103])
    const next = mergeCommentWindow(
      current,
      window([0, 30, 31], 104, cursor(30)),
      { aroundMessageId: message(30).id, limit: 2 },
    )
    expect(next.olderCursor).toBe(current.olderCursor)
    expect(next.messages.map((item) => item.id)).toEqual(
      [0, 30, 31, 101, 102, 103].map((i) => message(i).id),
    )
  })
})

test('marks disjoint around ranges and fills the interior with bounded pages', () => {
  const tail = window([0, 298, 299, 300], 301, cursor(298))
  let current = mergeCommentWindow(
    tail,
    window(
      [0, ...Array.from({ length: 50 }, (_, i) => 100 + i)],
      301,
      cursor(100),
    ),
    { through: cursor(149), limit: 50 },
  )
  expect([...commentGapRequests(current).keys()]).toEqual([message(298).id])
  for (const start of [248, 198, 148]) {
    const request = [...commentGapRequests(current).values()][0]
    expect(request.limit).toBe(50)
    current = mergeCommentWindow(
      current,
      window(
        [0, ...Array.from({ length: 50 }, (_, i) => start + i)],
        301,
        cursor(start),
      ),
      request,
    )
    expect(current.olderCursor).toBe(tail.olderCursor)
    expect(current.messages.some((row) => row.id === message(100).id)).toBe(
      true,
    )
    expect(new Set(current.messages.map((row) => row.id)).size).toBe(
      current.messages.length,
    )
  }
  expect(commentGapRequests(current).size).toBe(0)
  expect(current.messages).toHaveLength(202)
})

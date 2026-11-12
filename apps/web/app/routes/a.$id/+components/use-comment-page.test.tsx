// @vitest-environment happy-dom
import { act, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { commentFixture } from '~/test/comment-fixtures'
import { messageCursor } from '~/lib/comment-cursor'
import { useCommentPage, CommentPageSessionContext } from './use-comment-page'
import { createCommentSession, type CommentSession } from './comment-session'
import { withCommentRuntime } from './comment-runtime-browser'
import { renderToString } from 'react-dom/server'

let page: ReturnType<typeof useCommentPage>
let session: CommentSession
const authError = vi.fn()
const base = commentFixture('thread')
const initial = {
  ...base,
  messages: [{ ...base.messages[0], id: 'message-0' }],
}
const reply = (id: number) => ({
  ...initial.messages[0],
  id: `message-${id}`,
  body: `Reply ${id}`,
})
const before = messageCursor('thread', reply(3))
function Consumer({
  target,
  missing,
}: {
  target?: string
  missing?: (id: string) => void
}) {
  page = useCommentPage('thread', target, missing)
  return null
}
function Harness(props: Parameters<typeof Consumer>[0]) {
  const [owner] = useState(() =>
    createCommentSession({
      artifactId: 'synthetic-artifact',
      initialThreads: [initial],
      currentUserId: 'reviewer',
      getSelectedThreadId: () => null,
      onPageAuthError: authError,
    }),
  )
  session = owner
  useLayoutEffect(() => owner.attach(), [owner])
  return (
    <CommentPageSessionContext value={owner}>
      <Consumer {...props} />
    </CommentPageSessionContext>
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test.each([1, 2])(
  'records the actual %i replies returned by a short around-page',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const through = messageCursor('thread', reply(count))
    const incoming = {
      ...initial,
      messageCount: count + 1,
      replyCount: count,
      messages: [
        initial.messages[0],
        ...Array.from({ length: count }, (_, i) => reply(i + 1)),
      ],
    }
    const fetch = vi.fn(async () =>
      Response.json({ threads: [incoming], page: { through } }),
    )
    vi.stubGlobal('fetch', fetch)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      await act(async () => {
        expect(
          await page.load({ aroundMessageId: 'message-1', limit: 50 }),
        ).toBe(true)
      })
      expect(fetch).toHaveBeenCalledOnce()
      const row = session.getSnapshot().threads[0]
      expect(row.messages).toEqual(incoming.messages)
      expect(row.loadedPages).toEqual([
        {
          through,
          limit: count,
          coverageStart: messageCursor('thread', reply(1)),
        },
      ])
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test.each(['thread', 'all', 'other'] as const)(
  '%s changes merge in-flight pages and request affected-range revalidation',
  async (scope) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let resolvePage!: (response: Response) => void
    const incoming = {
      ...initial,
      messageCount: 3,
      replyCount: 2,
      messages: [initial.messages[0], reply(1), reply(2)],
    }
    const fetch = vi.fn((url: string) => {
      if (fetch.mock.calls.length === 1)
        return new Promise<Response>((resolve) => {
          resolvePage = resolve
        })
      return Promise.resolve(
        Response.json({
          threads: [url.includes('before=') ? incoming : initial],
        }),
      )
    })
    vi.stubGlobal('fetch', fetch)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      let completed!: Promise<boolean>
      await act(async () => {
        completed = page.load({ before, limit: 50 })
      })
      withCommentRuntime('synthetic-artifact', (lease) =>
        lease.invalidate(scope === 'all' ? undefined : scope),
      )
      await act(async () => {
        resolvePage(Response.json({ threads: [incoming] }))
        expect(await completed).toBe(true)
      })
      if (scope !== 'other') {
        await waitForRealTaskCondition(async () => {
          await act(async () => {})
          return fetch.mock.calls.length === 3
        }, 'affected retained range revalidated')
      }
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        `/api/shareables/synthetic-artifact/comments?thread_id=thread&before=${encodeURIComponent(before)}&limit=50`,
        ...(scope === 'other'
          ? []
          : [
              '/api/shareables/synthetic-artifact/comments',
              `/api/shareables/synthetic-artifact/comments?thread_id=thread&before=${encodeURIComponent(before)}&limit=50`,
            ]),
      ])
      expect(session.getSnapshot().threads[0].messages).toEqual(
        incoming.messages,
      )
      expect(page.failed).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test.each([401, 403, 404, 410])(
  'a missing target does not advance unread navigation when its thread returns %i',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const missing = vi.fn()
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        {},
        {
          status: url.includes('around_message_id=') ? 404 : status,
        },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () =>
        root.render(<Harness target="gone" missing={missing} />),
      )
      await waitForRealTaskCondition(async () => {
        await act(async () => {})
        return fetch.mock.calls.length === 2 && !page.pending
      }, 'thread access checked')
      expect(missing).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(2)
      if (status === 404 || status === 410) {
        expect(session.getSnapshot().threads).toEqual([])
        expect(session.getSnapshot().deletedThreadId).toBe('thread')
        expect(authError).not.toHaveBeenCalled()
        expect(page.failed).toBe(false)
      } else {
        expect(session.getSnapshot().threads).toEqual([initial])
        expect(authError).toHaveBeenCalledOnce()
        expect(page.failed).toBe(true)
      }
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test('a page consumer without its display provider fails instead of starting another data owner', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(() => renderToString(<Consumer />)).toThrow(
    'Comment pages require a display Session',
  )
  expect(fetch).not.toHaveBeenCalled()
})

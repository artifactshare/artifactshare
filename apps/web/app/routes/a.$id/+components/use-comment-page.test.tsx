// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { useCommentPage } from './use-comment-page'
import { advanceCommentEpoch } from './use-comment-mutations'

let load: ReturnType<typeof useCommentPage>['load']
const change = vi.fn()
function Harness() {
  load = useCommentPage('synthetic-artifact', 'thread', change).load
  return null
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

test.each([1, 2])(
  'records the actual %i replies returned by a short around-page',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const at = '2026-05-01T00:00:00.000Z'
    const through = btoa(
      JSON.stringify([1, 'thread', at, `message-${count}`]),
    ).replace(/=+$/, '')
    const fetch = vi.fn(async () =>
      Response.json({
        threads: [
          {
            id: 'thread',
            messages: Array.from({ length: count + 1 }, (_, i) => ({
              id: `message-${i}`,
            })),
          },
        ],
        page: { through },
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => root.render(<Harness />))
      let completed = false
      await act(async () => {
        void load({ aroundMessageId: 'message-1', limit: 50 }).then(() => {
          completed = true
        })
        await waitForRealTaskCondition(() => completed, 'around page consumed')
      })
      expect(fetch).toHaveBeenCalledOnce()
      expect(change).toHaveBeenCalledExactlyOnceWith(expect.any(Array), {
        threadId: 'thread',
        page: { through, limit: count },
      })
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test.each(['thread', 'all', 'other'] as const)(
  '%s message changes invalidate only affected in-flight pages',
  async (scope) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let resolvePage!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvePage = resolve
          }),
      ),
    )
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<Harness />))
      let result: boolean | undefined
      await act(async () => {
        void load({ before: 'cursor', limit: 50 }).then((value) => {
          result = value
        })
      })
      advanceCommentEpoch(
        'synthetic-artifact',
        scope === 'all' ? undefined : scope,
      )
      resolvePage(Response.json({ threads: [{ id: 'thread', messages: [] }] }))
      await act(async () => {
        await waitForRealTaskCondition(
          () => result !== undefined,
          'page settlement',
        )
      })
      expect(result).toBe(scope === 'other')
      expect(change).toHaveBeenCalledTimes(scope === 'other' ? 1 : 0)
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
    function TargetHarness() {
      useCommentPage('synthetic-artifact', 'thread', change, 'gone', missing)
      return null
    }
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        {},
        { status: url.includes('around_message_id=') ? 404 : status },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const root = createRoot(document.createElement('div'))
    try {
      await act(async () => root.render(<TargetHarness />))
      await act(async () => {
        await waitForRealTaskCondition(
          () => fetch.mock.calls.length === 2,
          'thread access checked',
        )
      })
      expect(missing).not.toHaveBeenCalled()
      expect(change).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
    }
  },
)

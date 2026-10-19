// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { useCommentPage } from './use-comment-page'

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

import { act, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import { waitForRealTaskCondition } from './wait-for-real-task-condition'
import type { useViewerComments } from '~/routes/a.$id/+components/viewer-shell'
import { useCommentMutations } from '~/routes/a.$id/+components/use-comment-mutations'
import { withCommentRuntime } from '~/routes/a.$id/+components/comment-runtime-browser'
import {
  commentReplyReducer,
  createCommentReplyState,
} from '~/routes/a.$id/+components/comment-reply-state'

/** Both engines implement the public viewer hook; never mount them together. */
export type CommentSyncEngine = typeof useViewerComments
type Display = ReturnType<CommentSyncEngine>
type Writer = ReturnType<typeof useCommentMutations>
type Request = {
  method: string
  path: string
  settled: boolean
  respond: (body: unknown, status?: number) => void
}
const timestamp = '2026-05-01T00:00:00.000Z'
export function commentFixture(id: string, body = id): CommentThreadView {
  return {
    id,
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    canResolve: true,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [
      {
        id: `${id}-message`,
        body,
        createdAt: timestamp,
        updatedAt: timestamp,
        agent: null,
        canEdit: true,
        canDelete: true,
        author: {
          id: 'reviewer',
          name: 'Reviewer',
          email: 'reviewer@example.com',
          image: null,
        },
      },
    ],
  }
}

/** Per-run React roots, HTTP gates and traces. No production reset API. */
export async function runCommentSyncScenario<T>(
  useEngine: CommentSyncEngine,
  scenario: (driver: ReturnType<typeof createDriver>) => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch
  const driver = createDriver(useEngine)
  vi.stubGlobal('fetch', driver.fetch)
  let result!: T
  let scenarioFailure: { error: unknown } | undefined
  try {
    result = await scenario(driver)
  } catch (error) {
    scenarioFailure = { error }
  }
  let cleanupFailure: { error: unknown } | undefined
  try {
    await driver.dispose()
  } catch (error) {
    cleanupFailure = { error }
  } finally {
    vi.stubGlobal('fetch', previousFetch)
  }
  if (scenarioFailure && cleanupFailure)
    throw new AggregateError(
      [scenarioFailure.error, cleanupFailure.error],
      'Comment scenario and cleanup failed',
    )
  if (scenarioFailure) throw scenarioFailure.error
  if (cleanupFailure) throw cleanupFailure.error
  return result
}

function createDriver(useEngine: CommentSyncEngine) {
  let root: Root | null = null
  let display: Display
  let writers: Writer[]
  let reply: ReturnType<typeof createCommentReplyState>
  let changeDraft: (value: string) => void
  let settleDraft: (submittedBody: string, success: boolean) => void
  const requests: Request[] = []
  const trace: string[] = []
  const artifacts = new Set<string>()
  const posts = new Set<Promise<boolean>>()
  let disposing = false
  const lateRequests: string[] = []
  function Harness({
    artifact,
    target,
  }: {
    artifact: string
    target: string | null
  }) {
    display = useEngine({
      framePresent: false,
      artifactId: artifact,
      currentUserId: 'reviewer',
      currentVersionId: null,
      initialThreads:
        artifact === 'b'
          ? [commentFixture('b-only', 'B original')]
          : [commentFixture('selected'), commentFixture('other')],
      targetCommentId: target,
      liveEnabled: false,
    })
    const options = {
      shareableId: artifact,
      isCurrentShareableId: display.isCurrentArtifactId,
      onThreadsChange: display.replaceThreads,
    }
    // The panel and inline popover use independent hook instances in production.
    writers = [useCommentMutations(options), useCommentMutations(options)]
    const [state, dispatch] = useReducer(
      commentReplyReducer,
      undefined,
      createCommentReplyState,
    )
    reply = state
    changeDraft = (value) =>
      dispatch({ type: 'change', threadId: 'selected', value })
    settleDraft = (submittedBody, success) =>
      dispatch({
        type: 'settled',
        threadId: 'selected',
        submittedBody,
        success,
      })
    return null
  }
  async function unmount() {
    if (root) await act(() => root!.unmount())
    root = null
  }
  return {
    trace,
    requests,
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const path = String(input)
      const method = init?.method ?? 'GET'
      trace.push(`${method} ${path}`)
      if (disposing) {
        lateRequests.push(`${method} ${path}`)
        return Promise.reject(
          new Error('Comment request after scenario disposal'),
        )
      }
      return new Promise<Response>((resolve, reject) => {
        const abort = () => {
          if (request.settled) return
          request.settled = true
          trace.push(`cancel ${method} ${path}`)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        const request: Request = {
          method,
          path,
          settled: false,
          respond(body, status = 200) {
            if (request.settled) throw new Error('Request already settled')
            request.settled = true
            init?.signal?.removeEventListener('abort', abort)
            resolve(Response.json(body, { status }))
          },
        }
        requests.push(request)
        init?.signal?.addEventListener('abort', abort, { once: true })
        if (init?.signal?.aborted) abort()
      })
    },
    async mount(artifact = 'a', target: string | null = null) {
      artifacts.add(artifact)
      root ??= createRoot(document.createElement('div'))
      await act(() =>
        root!.render(<Harness artifact={artifact} target={target} />),
      )
    },
    unmount,
    async retryTarget() {
      await act(() => display.retryTargetFetch())
    },
    async draft(value: string) {
      await act(() => changeDraft(value))
    },
    async post(writer = 0, body = 'submitted') {
      let pending!: Promise<boolean>
      const onSettled = settleDraft
      await act(() => {
        pending = writers[writer]
          .mutate(
            { intent: 'reply', threadId: 'selected', body },
            'reply:selected',
          )
          .then((success) => {
            if (writer === 0) onSettled(body, success)
            return success
          })
        posts.add(pending)
        void pending.then(
          () => posts.delete(pending),
          () => posts.delete(pending),
        )
      })
      // Return an object so the driver does not await the deliberately held POST.
      return { done: pending }
    },
    async respond(index: number, body: unknown, status = 200) {
      await act(() => requests[index].respond(body, status))
    },
    async waitForRequests(count: number) {
      await waitForRealTaskCondition(async () => {
        await act(async () => {})
        return requests.length >= count
      }, `${count} comment requests`)
      expect(requests).toHaveLength(count)
    },
    snapshot() {
      return {
        artifact: display.state.artifactId,
        threads: display.state.threads.map((thread) => ({
          id: thread.id,
          bodies: thread.messages.map((message) => message.body),
        })),
        drafts: { ...reply.drafts },
        pending: writers.map((writer) => [...writer.pendingKeys].sort()),
        failed: display.targetFetchFailed,
      }
    },
    pending(artifact = 'a') {
      return withCommentRuntime(artifact, (lease) => lease.hasPending())
    },
    async dispose() {
      // A zero-epoch leaked lease is otherwise indistinguishable from a fresh
      // record. Mark before unmount, then require a newly acquired clean record.
      for (const artifact of artifacts)
        withCommentRuntime(artifact, (lease) => lease.invalidate('selected'))
      disposing = true
      const countBeforeUnmount = requests.length
      await unmount()
      const unfinished = requests.filter((request) => !request.settled)
      await act(async () => {
        for (const request of unfinished) request.respond({}, 500)
        await Promise.allSettled(posts)
      })
      await act(async () => {})
      expect(unfinished).toEqual([])
      expect(lateRequests).toEqual([])
      expect(requests).toHaveLength(countBeforeUnmount)
      expect(requests.filter((request) => !request.settled)).toEqual([])
      expect(posts.size).toBe(0)
      for (const artifact of artifacts) {
        withCommentRuntime(artifact, (lease) => {
          expect(lease.hasPending()).toBe(false)
          expect(lease.getEpoch('selected')).toBe(0)
        })
      }
    },
  }
}

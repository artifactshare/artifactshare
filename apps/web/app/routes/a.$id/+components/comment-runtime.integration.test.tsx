import { withCommentRuntime } from './comment-runtime-browser'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { useViewerComments } from './viewer-shell'
import { useCommentMutations } from './use-comment-mutations'

vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
const at = '2026-05-01T00:00:00.000Z'
function thread(id: string, body = id): CommentThreadView {
  return {
    id,
    status: 'open',
    subject: { kind: 'artifact' },
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    canResolve: true,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [
      {
        id: `${id}-message`,
        body,
        createdAt: at,
        updatedAt: at,
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
const initial = [thread('selected'), thread('other')]
let comments: ReturnType<typeof useViewerComments>
let mutations: ReturnType<typeof useCommentMutations>
function Harness({
  artifact = 'synthetic-artifact',
  navigationTarget = 'selected',
  liveEnabled = false,
}: {
  artifact?: string
  navigationTarget?: string | null
  liveEnabled?: boolean
}) {
  comments = useViewerComments({
    framePresent: false,
    artifactId: artifact,
    currentUserId: 'reviewer',
    currentVersionId: null,
    initialThreads:
      artifact === 'different-artifact'
        ? [thread('b-only', 'B original')]
        : initial,
    targetCommentId: navigationTarget,
    liveEnabled,
  })
  mutations = useCommentMutations({
    shareableId: artifact,
    isCurrentShareableId: comments.isCurrentArtifactId,
    onThreadsChange: comments.replaceThreads,
  })
  return null
}
let root: Root | undefined
async function render(
  artifact?: string,
  navigationTarget: string | null = 'selected',
) {
  if (!root) root = createRoot(document.createElement('div'))
  await act(async () =>
    root!.render(
      <Harness artifact={artifact} navigationTarget={navigationTarget} />,
    ),
  )
}
async function until(condition: () => boolean) {
  await waitForRealTaskCondition(async () => {
    await act(async () => {})
    return condition()
  }, 'comment reconciliation completed')
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  vi.unstubAllGlobals()
})

test('migration probe: isolated sequential scenarios via public hook operations', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  async function scenario() {
    let answer!: (value: Response) => void
    const reads: string[] = []
    const cancellations: string[] = []
    let answerSummary!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST')
          return new Promise<Response>((resolve) => {
            answer = resolve
          })
        reads.push(url)
        init?.signal?.addEventListener('abort', () => cancellations.push(url), {
          once: true,
        })
        return new Promise<Response>((resolve) => {
          answerSummary = resolve
        })
      }),
    )
    await render('synthetic-artifact', null)
    const pending = mutations.mutate({
      intent: 'reply',
      threadId: 'selected',
      body: 'probe',
    })
    await until(() => typeof answer === 'function')
    await render('different-artifact', null)
    expect(comments.state.threads[0].messages[0].body).toBe('B original')
    await render('synthetic-artifact', null)
    await act(async () => {
      answer(
        Response.json({
          threadId: 'selected',
          threads: [thread('selected', 'settled'), initial[1]],
        }),
      )
      await pending
    })
    const postBodies = comments.state.threads.map((t) => t.messages[0].body)
    expect(postBodies).toEqual(['settled', 'other'])
    await until(() => typeof answerSummary === 'function')
    await act(async () => {
      answerSummary(
        Response.json({
          threads: [thread('selected', 'reconciled'), initial[1]],
        }),
      )
    })
    await until(
      () => comments.state.threads[0].messages[0].body === 'reconciled',
    )
    const result = {
      artifact: comments.state.artifactId,
      postBodies,
      requests: [...reads],
      cancellations: [...cancellations],
      bodies: comments.state.threads.map((t) => t.messages[0].body),
      failed: comments.targetFetchFailed,
    }
    await act(async () => root!.unmount())
    root = undefined
    const count = reads.length
    await act(async () => {})
    expect(reads).toHaveLength(count)
    expect(result).toEqual({
      artifact: 'synthetic-artifact',
      postBodies: ['settled', 'other'],
      requests: ['/api/shareables/synthetic-artifact/comments'],
      cancellations: [],
      bodies: ['reconciled', 'other'],
      failed: false,
    })
    return result
  }
  expect(await scenario()).toEqual(await scenario())
})

test('an A response arriving while B is shown does not replace B data', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let answer!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          answer = resolve
        })
      return Promise.resolve(
        Response.json({ threads: [thread('b-only', 'B original')] }),
      )
    }),
  )
  await render('synthetic-artifact', null)
  let pending!: Promise<boolean>
  await act(async () => {
    pending = mutations.mutate({
      intent: 'reply',
      threadId: 'selected',
      body: 'A draft',
    })
  })
  await until(() => typeof answer === 'function')
  await render('different-artifact', null)
  let posted: boolean | undefined
  await act(async () => {
    answer(
      Response.json({
        threadId: 'selected',
        threads: [thread('selected', 'A committed')],
      }),
    )
    posted = await pending
  })
  expect(posted).toBe(false)
  expect(
    withCommentRuntime('synthetic-artifact', (lease) => lease.hasPending()),
  ).toBe(false)
  expect(
    withCommentRuntime('synthetic-artifact', (lease) =>
      lease.getEpoch('selected'),
    ),
  ).toBe(0)
  expect(comments.state.artifactId).toBe('different-artifact')
  expect(comments.state.threads.map((t) => t.messages[0].body)).toEqual([
    'B original',
  ])
})

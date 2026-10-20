import { messageCursor } from '~/lib/comment-cursor'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { useViewerComments } from './viewer-shell'
import { useCommentPage } from './use-comment-page'
import {
  COMMENT_MUTATION_SETTLED_EVENT,
  useCommentMutations,
} from './use-comment-mutations'

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
let paging: ReturnType<typeof useCommentPage>
let mutations: ReturnType<typeof useCommentMutations>
function Harness({
  target,
  artifact = 'synthetic-artifact',
  navigationTarget = 'selected',
  liveEnabled = false,
}: {
  target?: string
  artifact?: string
  navigationTarget?: string | null
  liveEnabled?: boolean
}) {
  comments = useViewerComments({
    framePresent: false,
    artifactId: artifact,
    currentUserId: 'reviewer',
    currentVersionId: null,
    initialThreads: initial,
    targetCommentId: navigationTarget,
    liveEnabled,
  })
  paging = useCommentPage(artifact, 'selected', comments.replaceThreads, target)
  mutations = useCommentMutations({
    shareableId: artifact,
    isCurrentShareableId: comments.isCurrentArtifactId,
    onThreadsChange: comments.replaceThreads,
  })
  return null
}
let root: Root | undefined
async function render(
  target?: string,
  artifact?: string,
  navigationTarget: string | null = 'selected',
) {
  if (!root) root = createRoot(document.createElement('div'))
  await act(async () =>
    root!.render(
      <Harness
        target={target}
        artifact={artifact}
        navigationTarget={navigationTarget}
      />,
    ),
  )
}
async function until(condition: () => boolean) {
  await waitForRealTaskCondition(async () => {
    await act(async () => {})
    return condition()
  }, 'comment reconciliation completed')
}
function reconcile(threadId = 'other') {
  window.dispatchEvent(
    new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
      detail: {
        shareableId: 'synthetic-artifact',
        clientMutationId: 'synthetic-mutation',
        appliedThreads: true,
        requiresReconcile: true,
        threadId,
      },
    }),
  )
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  vi.unstubAllGlobals()
})

test.each(['network', 408, 429, 500, 503] as const)(
  'selected-thread %s preserves its expanded cache while applying the valid list',
  async (failure) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const expanded = {
      ...initial[0],
      messages: [
        ...initial[0].messages,
        { ...initial[0].messages[0], id: 'reply', body: 'Expanded reply' },
      ],
      messageCount: 2,
      replyCount: 1,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('thread_id=')) {
          if (failure === 'network') throw new TypeError('Synthetic offline')
          return Response.json(
            { error: 'Synthetic retryable failure' },
            { status: failure },
          )
        }
        return Response.json({ threads: [thread('other', 'Remote update')] })
      }),
    )
    await render()
    await act(async () => comments.replaceThreads([expanded, initial[1]]))
    await act(async () => reconcile())
    await until(() =>
      comments.state.threads.some(
        (row) => row.messages[0].body === 'Remote update',
      ),
    )
    expect(comments.state.threads.find((row) => row.id === 'selected')).toEqual(
      expanded,
    )
    expect(comments.state.targetThreadId).toBe('selected')
    expect(comments.targetFetchFailed).toBe(true)
  },
)

test('a page winning the mutation reconciliation race schedules one replacement reconcile', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolveList!: (value: Response) => void
  let listCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('before='))
        return Response.json({
          threads: [
            {
              ...initial[0],
              messageCount: 2,
              replyCount: 1,
              messages: [
                ...initial[0].messages,
                {
                  ...initial[0].messages[0],
                  id: 'selected-z1',
                  body: 'Loaded reply',
                },
              ],
            },
          ],
        })
      listCalls++
      if (listCalls === 1)
        return new Promise<Response>((done) => {
          resolveList = done
        })
      return Response.json({
        threads: [
          thread('other', 'Remote update'),
          {
            ...initial[0],
            messageCount: 5,
            replyCount: 4,
            olderCursor: messageCursor('selected', {
              createdAt: at,
              id: 'selected-z3',
            }),
            messages: [
              ...initial[0].messages,
              ...[3, 4, 5].map((i) => ({
                ...initial[0].messages[0],
                id: `selected-z${i}`,
              })),
            ],
          },
        ],
      })
    }),
  )
  await render()
  await act(async () => reconcile())
  await until(() => listCalls === 1)
  let completed = false
  await act(async () => {
    void paging
      .load({
        before: messageCursor('selected', { createdAt: at, id: 'selected-z3' }),
        limit: 50,
      })
      .then(() => {
        completed = true
      })
  })
  await until(() => completed)
  resolveList(Response.json({ threads: initial }))
  await until(
    () => comments.state.threads[0]?.messages[0].body === 'Remote update',
  )
  expect(listCalls).toBe(2)
  expect(
    comments.state.threads
      .find((row) => row.id === 'selected')
      ?.messages.some((row) => row.body === 'Loaded reply'),
  ).toBe(true)
})

test('target intent resumes after a pending mutation settles without polling', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolvePost!: (value: Response) => void
  const targets: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Promise<Response>((done) => {
          resolvePost = done
        })
      if (url.includes('around_message_id='))
        targets.push(
          new URL(url, 'https://example.com').searchParams.get(
            'around_message_id',
          )!,
        )
      return Response.json({ threads: initial })
    }),
  )
  await render()
  let posted = false
  await act(async () => {
    void mutations
      .mutate({ intent: 'reply', threadId: 'selected', body: 'Draft' })
      .then(() => {
        posted = true
      })
  })
  await render('target-old')
  await render('target-new')
  expect(targets).toEqual([])
  resolvePost(Response.json({ threads: [initial[0]], threadId: 'selected' }))
  await until(() => posted && targets.length === 1 && !paging.pending)
  expect(targets).toEqual(['target-new'])
})

test('target intent resumes after another page and is cancelled on teardown', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolvePage!: (value: Response) => void
  const targets: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('before='))
        return new Promise<Response>((done) => {
          resolvePage = done
        })
      targets.push(
        new URL(url, 'https://example.com').searchParams.get(
          'around_message_id',
        )!,
      )
      return Response.json({ threads: initial })
    }),
  )
  await render()
  await act(async () => {
    void paging.load({ before: 'cursor', limit: 50 })
  })
  await render('target-old')
  await render('target-new')
  expect(targets).toEqual([])
  resolvePage(Response.json({ threads: initial }))
  await until(() => targets.length === 1 && !paging.pending)
  expect(targets).toEqual(['target-new'])
  await act(async () => {
    void paging.load({ before: 'cursor', limit: 50 })
  })
  await render('teardown-target')
  await act(async () => root!.unmount())
  root = undefined
  resolvePage(Response.json({ threads: initial }))
  expect(targets).toEqual(['target-new'])
})

test('accepted outside-window navigation survives URL cleanup and is isolated on artifact changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const pending = new Map<
    string,
    { resolve: (response: Response) => void; signal: AbortSignal }
  >()
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      !url.includes('thread_id=')
        ? Promise.resolve(Response.json({ threads: initial }))
        : new Promise<Response>((resolve) => {
            pending.set(
              new URL(url, 'https://example.com').searchParams.get(
                'thread_id',
              )!,
              { resolve, signal: init!.signal! },
            )
          }),
    ),
  )
  await render(undefined, undefined, 'outside')
  await until(() => pending.has('outside'))
  await render(undefined, undefined, null)
  expect(pending.get('outside')!.signal.aborted).toBe(false)
  pending
    .get('outside')!
    .resolve(Response.json({ threads: [thread('outside')] }))
  await until(() => comments.state.threads.some((row) => row.id === 'outside'))
  expect(comments.state.targetThreadId).toBe('outside')
  await render(undefined, undefined, 'stale')
  await until(() => pending.has('stale'))
  await render(undefined, 'different-artifact', null)
  expect(pending.get('stale')!.signal.aborted).toBe(true)
  await act(async () =>
    pending
      .get('stale')!
      .resolve(Response.json({ threads: [thread('stale')] })),
  )
  expect(comments.state.artifactId).toBe('different-artifact')
  expect(comments.state.threads.map((row) => row.id)).toEqual(
    initial.map((row) => row.id),
  )
  expect(comments.state.targetThreadId).toBe(null)
})

test.each([404, 410])(
  'selected-thread %i removes cached content and selection while applying the valid list',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('thread_id=')
          ? Response.json({ error: 'Comment not found.' }, { status })
          : Response.json({ threads: [thread('other', 'Remote update')] }),
      ),
    )
    await render()
    await act(async () =>
      comments.openInlineThread('selected', {
        top: 0,
        left: 0,
        width: 10,
        height: 10,
      }),
    )
    await act(async () => reconcile())
    await until(() =>
      comments.state.threads.some(
        (row) => row.messages[0].body === 'Remote update',
      ),
    )
    expect(comments.state.threads.map((row) => row.id)).toEqual(['other'])
    expect(comments.state.targetThreadId).toBe(null)
    expect(comments.state.inlineThreadId).toBe(null)
    expect(comments.targetFetchFailed).toBe(false)
  },
)

test.each(['outside', 'selected'])(
  'a definitive 404 on target retry clears %s even when it was never loaded',
  async (target) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('thread_id=')
          ? Response.json({ error: 'Synthetic offline' }, { status: 503 })
          : Response.json({ threads: [thread('other', 'Remote update')] }),
      ),
    )
    await render(undefined, undefined, target)
    if (target === 'selected') await act(async () => reconcile())
    await until(() => comments.targetFetchFailed)
    await render(undefined, undefined, null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('thread_id=')
          ? Response.json({ error: 'Comment not found.' }, { status: 404 })
          : Response.json({ threads: [initial[1]] }),
      ),
    )
    await act(async () => comments.retryTargetFetch())
    await until(() => comments.state.targetThreadId === null)
    expect(comments.state.threads.some((row) => row.id === target)).toBe(false)
    expect(comments.targetFetchFailed).toBe(false)
  },
)

const cursor = (id: string) => messageCursor('selected', { createdAt: at, id })
const reply = (id: string) => ({ ...initial[0].messages[0], id, body: id })
const windowThread: CommentThreadView = {
  ...initial[0],
  messageCount: 8,
  replyCount: 7,
  olderCursor: cursor('z7'),
  messages: [...initial[0].messages, ...['z7', 'z8', 'z9'].map(reply)],
}
const expandedThread: CommentThreadView = {
  ...windowThread,
  messages: [
    ...initial[0].messages,
    ...['z1', 'z2', 'z7', 'z8', 'z9'].map(reply),
  ],
  loadedPages: [
    { before: cursor('z7'), limit: 50, coverageStart: cursor('z1') },
  ],
}

test.each(['selected read', 'loaded range', 'unselected loaded range'])(
  '%s failure keeps independent updates and retry authoritatively removes deleted older replies',
  async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let failing = true
    let ranges = 0
    const fetch = vi.fn(async (url: string) => {
      const params = new URL(url, 'https://example.com').searchParams
      if (params.has('before')) {
        ranges++
        if (failing) return Response.json({}, { status: 503 })
        return Response.json({
          threads: [
            {
              ...windowThread,
              messageCount: 7,
              replyCount: 6,
              olderCursor: null,
              messages: [...initial[0].messages, reply('z2')],
            },
          ],
        })
      }
      if (params.has('thread_id')) {
        if (failing) return Response.json({}, { status: 503 })
        return Response.json({ threads: [windowThread] })
      }
      return Response.json({
        threads: [
          thread('other', 'Independent update'),
          ...(mode !== 'selected read' ? [windowThread] : []),
        ],
      })
    })
    vi.stubGlobal('fetch', fetch)
    await render()
    await act(async () => comments.replaceThreads([expandedThread, initial[1]]))
    if (mode === 'unselected loaded range')
      await act(async () => comments.targetThread('other'))
    await act(async () => reconcile('selected'))
    await until(() => comments.targetFetchFailed)
    expect(
      comments.state.threads.find((row) => row.id === 'other')?.messages[0]
        .body,
    ).toBe('Independent update')
    expect(
      comments.state.threads
        .find((row) => row.id === 'selected')
        ?.messages.some((row) => row.id === 'z1'),
    ).toBe(true)
    failing = false
    const previousRanges = ranges
    await act(async () => comments.retryTargetFetch())
    await until(() => !comments.targetFetchFailed)
    expect(ranges).toBeGreaterThan(previousRanges)
    expect(
      comments.state.threads
        .find((row) => row.id === 'selected')
        ?.messages.map((row) => row.id),
    ).toEqual(['selected-message', 'z2', 'z7', 'z8', 'z9'])
    const calls = fetch.mock.calls.length
    await act(async () => comments.targetThread('other'))
    await act(async () => comments.targetThread('selected'))
    expect(fetch.mock.calls).toHaveLength(calls)
  },
)

test.each(['other', null])(
  'selection changing to %s during a delayed read keeps the valid summary',
  async (next) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let resolveSelected!: (response: Response) => void
    let lists = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('thread_id'))
          return new Promise<Response>((resolve) => {
            resolveSelected = resolve
          })
        lists++
        return Response.json({
          threads: [thread('other', 'Independent update')],
        })
      }),
    )
    await render()
    await act(async () => reconcile())
    await until(() => !!resolveSelected)
    await act(async () =>
      next ? comments.targetThread(next) : comments.changePanelOpen(false),
    )
    resolveSelected(Response.json({}, { status: 503 }))
    await until(() =>
      comments.state.threads.some(
        (row) => row.messages[0].body === 'Independent update',
      ),
    )
    expect(lists).toBe(1)
    expect(comments.state.targetThreadId).toBe(next)
    expect(comments.targetFetchFailed).toBe(false)
  },
)

test('missing target exposes retry when the summary fails before its read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const fetch = vi.fn(async (_url?: string) =>
    Response.json({}, { status: 503 }),
  )
  vi.stubGlobal('fetch', fetch)
  await render(undefined, undefined, 'outside')
  await until(() => comments.targetFetchFailed)
  expect(comments.state.targetThreadId).toBe('outside')
  expect(fetch).toHaveBeenCalledTimes(1)
  fetch.mockImplementation(async (url?: string) =>
    Response.json({
      threads: url?.includes('thread_id') ? [thread('outside')] : initial,
    }),
  )
  await act(async () => comments.retryTargetFetch())
  await until(() => comments.state.threads.some((row) => row.id === 'outside'))
  expect(comments.targetFetchFailed).toBe(false)
})

test.each([404, 410])(
  'a definitive %i while revalidating a range removes the thread without retry fallback',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('before=')
          ? Response.json({}, { status })
          : Response.json({
              threads: [windowThread, thread('other', 'Independent update')],
            }),
      ),
    )
    await render()
    await act(async () => comments.replaceThreads([expandedThread, initial[1]]))
    await act(async () => reconcile('selected'))
    await until(() => comments.state.targetThreadId === null)
    expect(comments.state.threads.map((row) => row.id)).toEqual(['other'])
    expect(comments.state.threads[0].messages[0].body).toBe(
      'Independent update',
    )
    expect(comments.targetFetchFailed).toBe(false)
  },
)

test('selection changing during a delayed range retains the newly selected cache and reconciles it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolveRange!: (response: Response) => void
  let resolveContinuation!: (response: Response) => void
  let listCalls = 0
  let targetReads = 0
  const cached = thread('other', 'Retained target')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const params = new URL(url, 'https://example.com').searchParams
      if (params.has('before'))
        return new Promise<Response>((resolve) => {
          resolveRange = resolve
        })
      if (params.get('thread_id') === 'other') {
        targetReads++
        return Response.json({
          threads: [thread('other', 'Reconciled target')],
        })
      }
      listCalls++
      if (listCalls > 1)
        return new Promise<Response>((resolve) => {
          resolveContinuation = resolve
        })
      return Response.json({
        threads: [windowThread, thread('independent', 'Independent update')],
      })
    }),
  )
  await render()
  await act(async () =>
    comments.replaceThreads([expandedThread, cached, thread('independent')]),
  )
  await act(async () => reconcile('selected'))
  await until(() => !!resolveRange)
  await act(async () => comments.targetThread('other'))
  resolveRange(
    Response.json({
      threads: [
        {
          ...windowThread,
          olderCursor: null,
          messages: [...initial[0].messages, reply('z1'), reply('z2')],
        },
      ],
    }),
  )
  await until(() =>
    comments.state.threads.some(
      (row) => row.messages[0].body === 'Independent update',
    ),
  )
  expect(comments.state.targetThreadId).toBe('other')
  expect(comments.state.threads.find((row) => row.id === 'other')).toEqual(
    cached,
  )
  expect(comments.targetFetchFailed).toBe(false)
  await until(() => !!resolveContinuation)
  expect(listCalls).toBe(2)
  resolveContinuation(
    Response.json({
      threads: [windowThread, thread('independent', 'Independent update')],
    }),
  )
  await until(() =>
    comments.state.threads.some(
      (row) => row.messages[0].body === 'Reconciled target',
    ),
  )
  expect(comments.state.targetThreadId).toBe('other')
  expect(targetReads).toBe(1)
  expect(listCalls).toBe(2)
})

test('an invalid range keeps accessible cached replies and offers an authoritative retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let invalid = true
  let rangeReads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('before=')) {
        rangeReads++
        return invalid
          ? Response.json({ error: 'invalid-page' }, { status: 400 })
          : Response.json({
              threads: [
                {
                  ...windowThread,
                  olderCursor: null,
                  messages: [...initial[0].messages, reply('z2')],
                },
              ],
            })
      }
      return Response.json({
        threads: [windowThread, thread('other', 'Independent update')],
      })
    }),
  )
  await render()
  await act(async () => comments.replaceThreads([expandedThread, initial[1]]))
  await act(async () => reconcile('selected'))
  await until(() =>
    comments.state.threads.some(
      (row) => row.messages[0].body === 'Independent update',
    ),
  )
  expect(comments.state.targetThreadId).toBe('selected')
  expect(
    comments.state.threads
      .find((row) => row.id === 'selected')
      ?.messages.some((row) => row.id === 'z1'),
  ).toBe(true)
  expect(comments.targetFetchFailed).toBe(true)
  invalid = false
  await act(async () => comments.retryTargetFetch())
  await until(() => !comments.targetFetchFailed)
  expect(rangeReads).toBe(2)
  expect(
    comments.state.threads
      .find((row) => row.id === 'selected')
      ?.messages.map((row) => row.id),
  ).toEqual(['selected-message', 'z2', 'z7', 'z8', 'z9'])
})

test.each([401, 403])(
  'range %i retains cached pages and selection through auth recovery',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()
    let ranges = 0
    let lists = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('before=')) {
          ranges++
          return ranges === 1
            ? Response.json({}, { status })
            : Response.json({
                threads: [
                  {
                    ...windowThread,
                    olderCursor: null,
                    messages: [...initial[0].messages, reply('z2')],
                  },
                ],
              })
        }
        lists++
        return Response.json({ threads: [windowThread, initial[1]] })
      }),
    )
    try {
      await render()
      await act(async () =>
        comments.replaceThreads([expandedThread, initial[1]]),
      )
      await act(async () => reconcile('selected'))
      await until(() => ranges === 1)
      expect(comments.state.threads[0]).toEqual(expandedThread)
      expect(comments.state.targetThreadId).toBe('selected')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      await until(
        () =>
          ranges === 2 &&
          !comments.state.threads[0].messages.some((row) => row.id === 'z1'),
      )
      expect(lists).toBe(2)
      expect(comments.state.targetThreadId).toBe('selected')
      expect(comments.state.threads[0].loadedPages).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  },
)

test('authoritative replacement and artifact changes clear the panel retry error', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('thread_id=')
        ? Response.json({}, { status: 503 })
        : Response.json({ threads: [initial[1]] }),
    ),
  )
  await render()
  await act(async () => reconcile())
  await until(() => comments.targetFetchFailed)
  await act(async () => comments.replaceThreads(initial))
  expect(comments.targetFetchFailed).toBe(false)
  await act(async () => reconcile())
  await until(() => comments.targetFetchFailed)
  await render(undefined, 'different-artifact', null)
  expect(comments.targetFetchFailed).toBe(false)
  await render(undefined, 'synthetic-artifact', null)
  expect(comments.targetFetchFailed).toBe(false)
})

class ReconnectSocket extends EventTarget {
  static OPEN = 1
  static CONNECTING = 0
  static instances: ReconnectSocket[] = []
  readyState = 0
  constructor(_url: string) {
    super()
    ReconnectSocket.instances.push(this)
  }
  send() {}
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  close() {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
  }
  change(threadId?: string) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'comments-changed', threadId }),
      }),
    )
  }
}

test.each(['reconnect', 'unidentified change'])(
  '%s refreshes a retained range outside an existing dirty set',
  async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('WebSocket', ReconnectSocket)
    vi.useFakeTimers()
    ReconnectSocket.instances = []
    let failing = false
    let deleted = false
    let lists = 0
    let ranges = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('before=')) {
          ranges++
          return Response.json({
            threads: [
              {
                ...windowThread,
                olderCursor: null,
                messages: [
                  ...initial[0].messages,
                  ...(!deleted ? [reply('z1')] : []),
                  reply('z2'),
                ],
              },
            ],
          })
        }
        lists++
        return failing
          ? new Response(null, { status: 503 })
          : Response.json({ threads: [windowThread, initial[1]] })
      }),
    )
    try {
      root = createRoot(document.createElement('div'))
      await act(async () => root!.render(<Harness liveEnabled />))
      await act(async () =>
        comments.replaceThreads([expandedThread, initial[1]]),
      )
      const socket = ReconnectSocket.instances.at(-1)!
      await act(async () => socket.open())
      await until(
        () =>
          ranges === 1 && comments.state.threads[0].loadedPages?.length === 1,
      )
      // An unsuccessful refresh leaves only the unrelated thread dirty.
      failing = true
      await act(async () => socket.change('other'))
      await until(() => lists === 2)
      failing = false
      deleted = true
      if (mode === 'reconnect') {
        await act(async () => socket.close())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000)
        })
        expect(ReconnectSocket.instances.at(-1)).not.toBe(socket)
        await act(async () => ReconnectSocket.instances.at(-1)!.open())
      } else {
        await act(async () => socket.change())
      }
      await until(
        () =>
          !comments.state.threads[0].messages.some((row) => row.id === 'z1'),
      )
      expect(ranges).toBe(2)
      expect(
        comments.state.threads[0].messages.some((row) => row.id === 'z2'),
      ).toBe(true)
      expect(comments.state.threads.map((row) => row.id)).toEqual([
        'selected',
        'other',
      ])
    } finally {
      vi.useRealTimers()
    }
  },
)

test.each(['lost response', 'invalid JSON'])(
  'an uncertain deletion with %s reconciles retained history without a success thread ID',
  async (failure) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    let committed = false
    let rangeReads = 0
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        // The write commits, but the client cannot determine its outcome.
        committed = true
        if (failure === 'lost response')
          throw new TypeError('Synthetic connection lost')
        return new Response('{', {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('before=')) {
        rangeReads++
        return Response.json({
          threads: [
            {
              ...windowThread,
              olderCursor: null,
              messages: [
                ...initial[0].messages,
                ...(!committed ? [reply('z1')] : []),
                reply('z2'),
              ],
            },
          ],
        })
      }
      return Response.json({ threads: [windowThread, initial[1]] })
    })
    vi.stubGlobal('fetch', fetch)
    await render()
    await act(async () => comments.replaceThreads([expandedThread, initial[1]]))
    // Start from a completed targeted refresh, with no outstanding dirty scope.
    await act(async () => reconcile('other'))
    await until(() => comments.state.threads[0].latestReplyIds?.length === 3)
    expect(rangeReads).toBe(0)
    let result: boolean | undefined
    await act(async () => {
      result = await mutations.mutate({
        intent: 'delete-message',
        messageId: 'z1',
      })
    })
    expect(result).toBe(false)
    await until(
      () => !comments.state.threads[0].messages.some((row) => row.id === 'z1'),
    )
    expect(rangeReads).toBe(1)
    expect(comments.state.threads[0].messages.map((row) => row.id)).toEqual([
      'selected-message',
      'z2',
      'z7',
      'z8',
      'z9',
    ])
    expect(comments.state.threads[0].loadedPages).toHaveLength(1)
    expect(comments.state.threads[1]).toMatchObject(initial[1])
    expect(comments.state.targetThreadId).toBe('selected')
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1)
  },
)

test.each([401, 403])(
  'selected-thread %i preserves cached pages and selection during auth recovery',
  async (status) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()
    let targets = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('thread_id=')) {
          targets++
          return targets === 1
            ? Response.json({}, { status })
            : Response.json({ threads: [expandedThread] })
        }
        return Response.json({ threads: [initial[1]] })
      }),
    )
    try {
      await render()
      await act(async () =>
        comments.replaceThreads([expandedThread, initial[1]]),
      )
      await act(async () => reconcile('selected'))
      await until(() => targets === 1)
      expect(comments.state.threads[0]).toEqual(expandedThread)
      expect(comments.state.targetThreadId).toBe('selected')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000)
      })
      await until(() => targets >= 2)
      expect(comments.state.targetThreadId).toBe('selected')
      expect(
        comments.state.threads.find((row) => row.id === 'selected')
          ?.loadedPages,
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  },
)

test('around page survives anchor resolution, socket open and another thread change', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('WebSocket', ReconnectSocket)
  ReconnectSocket.instances = []
  let resolvePage!: (response: Response) => void
  let lists = 0
  const anchored: CommentThreadView = {
    ...initial[0],
    subject: {
      kind: 'text',
      state: 'attached',
      positionState: 'unchecked',
      quotedText: 'Synthetic quote',
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: null,
      textStart: 0,
      textEnd: 15,
      cssPath: null,
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('around_message_id='))
        return new Promise<Response>((resolve) => {
          resolvePage = resolve
        })
      lists++
      return Response.json({
        threads: [anchored, thread('other', `Update ${lists}`)],
      })
    }),
  )
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(<Harness liveEnabled />))
  await act(async () => comments.replaceThreads([anchored, initial[1]]))
  await act(async () => {
    void paging.load({ aroundMessageId: 'z2', limit: 50 })
  })
  await until(() => !!resolvePage)
  await act(async () =>
    comments.applyAnchorResolutions([
      {
        threadId: 'selected',
        state: 'needs-check',
        textStart: null,
        textEnd: null,
        textHash: null,
      },
    ]),
  )
  expect(comments.state.threads[0].subject).toMatchObject({
    positionState: 'needs-check',
  })
  const socket = ReconnectSocket.instances.at(-1)!
  await act(async () => socket.open())
  await until(() => lists === 1)
  await act(async () => socket.change('other'))
  await until(() => lists === 2)
  resolvePage(
    Response.json({
      threads: [
        {
          ...initial[0],
          messageCount: 2,
          replyCount: 1,
          messages: [...initial[0].messages, reply('z2')],
        },
      ],
      page: { through: cursor('z2') },
    }),
  )
  await until(() => !paging.pending)
  expect(paging.failed).toBe(false)
  expect(
    comments.state.threads
      .find((row) => row.id === 'selected')
      ?.messages.some((row) => row.id === 'z2'),
  ).toBe(true)
})

test('an explicit older-page request waits for a mutation on another thread to settle', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let resolvePost!: (response: Response) => void
  let pages = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          resolvePost = resolve
        })
      if (url.includes('before=')) {
        pages++
        return Response.json({ threads: [expandedThread] })
      }
      return Response.json({ threads: initial })
    }),
  )
  await render()
  await act(async () => {
    void mutations.mutate({ intent: 'reply', threadId: 'other', body: 'Draft' })
  })
  await act(async () => {
    void paging.load({ before: cursor('z7'), limit: 50 })
  })
  expect(paging.pending).toBe(true)
  expect(pages).toBe(0)
  resolvePost(
    Response.json({ error: { code: 'rate-limited' } }, { status: 429 }),
  )
  await until(() => pages === 1 && !paging.pending)
  expect(paging.failed).toBe(false)
  expect(
    comments.state.threads[0].messages.some((row) => row.id === 'z1'),
  ).toBe(true)
})

test.each(
  ['reconnect', 'recovery ranges', 'recovery window'].flatMap((mode) =>
    ['message', 'thread'].map((deletedTarget) => ({ mode, deletedTarget })),
  ),
)(
  '$mode reconciliation prevents a stale page restoring a deleted $deletedTarget',
  async ({ mode, deletedTarget }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('WebSocket', ReconnectSocket)
    vi.useFakeTimers()
    ReconnectSocket.instances = []
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible')
    let deleted = false
    let lists = 0
    let resolvePage!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('around_message_id='))
          return new Promise<Response>((resolve) => {
            resolvePage = resolve
          })
        if (deleted && deletedTarget === 'thread' && url.includes('thread_id='))
          return Response.json({}, { status: 404 })
        if (url.includes('before='))
          return Response.json({
            threads: [
              {
                ...windowThread,
                olderCursor: null,
                messages: [
                  ...initial[0].messages,
                  ...(!deleted ? [reply('z1')] : []),
                  reply('z2'),
                ],
              },
            ],
          })
        lists++
        return Response.json({
          threads:
            deleted && deletedTarget === 'thread'
              ? [initial[1]]
              : [windowThread, initial[1]],
        })
      }),
    )
    try {
      root = createRoot(document.createElement('div'))
      await act(async () => root!.render(<Harness liveEnabled />))
      await act(async () =>
        comments.replaceThreads([
          mode === 'recovery window' ? windowThread : expandedThread,
          initial[1],
        ]),
      )
      const socket = ReconnectSocket.instances.at(-1)!
      await act(async () => socket.open())
      await until(
        () =>
          lists === 1 &&
          comments.state.threads[0].messages.some((row) => row.id === 'z9'),
      )
      const unchangedThread = comments.state.threads.find(
        (row) => row.id === 'other',
      )
      await act(async () => {
        if (mode === 'reconnect') socket.close()
        else {
          visibility.mockReturnValue('hidden')
          document.dispatchEvent(new Event('visibilitychange'))
        }
      })
      // The server answered this request before the offline deletion, but its
      // response remains delayed until the new connection has reconciled.
      await act(async () => {
        void paging.load({ aroundMessageId: 'z1', limit: 50 })
      })
      await until(() => !!resolvePage)
      deleted = true
      await act(async () => {
        if (mode === 'reconnect') await vi.advanceTimersByTimeAsync(2000)
        else {
          visibility.mockReturnValue('visible')
          document.dispatchEvent(new Event('visibilitychange'))
        }
      })
      await until(() => ReconnectSocket.instances.at(-1) !== socket)
      const reconnected = ReconnectSocket.instances.at(-1)!
      expect(reconnected).not.toBe(socket)
      await act(async () => reconnected.open())
      await until(
        () =>
          lists >= 2 &&
          !comments.state.threads.some((row) =>
            row.messages.some((message) => message.id === 'z1'),
          ),
      )
      resolvePage(
        Response.json({
          threads: [expandedThread],
          page: { through: cursor('z2') },
        }),
      )
      await until(() => !paging.pending)
      expect(
        comments.state.threads.some((row) =>
          row.messages.some((message) => message.id === 'z1'),
        ),
      ).toBe(false)
      expect(comments.state.threads.some((row) => row.id === 'selected')).toBe(
        deletedTarget !== 'thread',
      )
      expect(comments.state.threads.find((row) => row.id === 'other')).toEqual(
        unchangedThread,
      )
    } finally {
      visibility.mockRestore()
      vi.useRealTimers()
    }
  },
)

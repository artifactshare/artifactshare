// Browser mode cannot load a test module from the route directory whose name
// contains `$`, so this behavior test lives one level above the component.
import { act, useState } from 'react'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useViewerComments } from './a.$id/+components/viewer-shell'
import type { CommentThreadView } from '~/lib/comments'
import { VIEWER_FETCH_TIMEOUT_MS } from '~/lib/viewer-network'
import {
  COMMENT_MUTATION_SETTLED_EVENT,
  useCommentMutations,
  type CommentMutationPayload,
} from './a.$id/+components/use-comment-mutations'
import type { ChangeCommentThreads } from './a.$id/+components/comment-history'

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

function LocalWriter({
  onThreadsChange,
  payload,
}: {
  onThreadsChange: ChangeCommentThreads
  payload: CommentMutationPayload
}) {
  const { mutate } = useCommentMutations({
    shareableId: 'artifact-1',
    isCurrentShareableId: () => true,
    onThreadsChange,
  })
  return (
    <button onClick={() => void mutate(payload)}>Commit local mutation</button>
  )
}

class ControlledWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: ControlledWebSocket[] = []

  readonly url: string
  readyState = ControlledWebSocket.CONNECTING
  sent: unknown[] = []

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    ControlledWebSocket.instances.push(this)
  }

  send(value: unknown) {
    if (this.readyState !== ControlledWebSocket.OPEN) {
      throw new Error('socket is not open')
    }
    this.sent.push(value)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === ControlledWebSocket.CLOSED) return
    this.readyState = ControlledWebSocket.CLOSED
    this.dispatchEvent(
      new CloseEvent('close', { code, reason, wasClean: true }),
    )
  }

  open() {
    this.readyState = ControlledWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  fail(code = 1006, reason = '') {
    this.readyState = ControlledWebSocket.CLOSED
    this.dispatchEvent(
      new CloseEvent('close', { code, reason, wasClean: false }),
    )
  }

  message(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: typeof value === 'string' ? value : JSON.stringify(value),
      }),
    )
  }
}

const localThread: CommentThreadView = {
  id: 'new-local-thread',
  status: 'open',
  subject: { kind: 'artifact' },
  createdAt: '2026-09-19T00:00:00Z',
  updatedAt: '2026-09-19T00:00:00Z',
  resolvedAt: null,
  canResolve: true,
  messageCount: 0,
  replyCount: 0,
  olderCursor: null,
  messages: [],
}

const oldThread: CommentThreadView = { ...localThread, id: 'old-thread' }

function Harness({
  artifactId = 'artifact-1',
  initialThreads = [],
  mutation,
  liveEnabled = true,
  localMutation,
  showDraft = false,
}: {
  artifactId?: string
  initialThreads?: CommentThreadView[]
  mutation?: { requiresReconcile: boolean }
  liveEnabled?: boolean
  localMutation?: CommentMutationPayload
  showDraft?: boolean
}) {
  const [connected, setConnected] = useState(false)
  const comments = useViewerComments({
    framePresent: false,
    artifactId,
    currentUserId: 'user-1',
    currentVersionId: 'version-1',
    initialThreads,
    targetCommentId: null,
    liveEnabled,
    onLiveConnectionChanged: setConnected,
  })
  return (
    <>
      <output
        data-messages={JSON.stringify(
          comments.state.threads.flatMap((thread) => thread.messages),
        )}
        data-connected={String(connected)}
        data-threads={comments.state.threads
          .map((thread) => thread.id)
          .join(',')}
      >
        {comments.presence.map((presence) => presence.name).join(',')}
      </output>
      {(localMutation || showDraft) && (
        <textarea
          aria-label="Unrelated draft"
          defaultValue="Keep this unsent reply"
        />
      )}
      {localMutation && (
        <LocalWriter
          onThreadsChange={comments.replaceThreads}
          payload={localMutation}
        />
      )}
      {mutation && (
        <button
          onClick={() => {
            comments.replaceThreads([localThread])
            window.dispatchEvent(
              new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
                detail: {
                  shareableId: artifactId,
                  clientMutationId: 'local-mutation',
                  appliedThreads: true,
                  requiresReconcile: mutation.requiresReconcile,
                },
              }),
            )
          }}
        >
          Settle local mutation
        </button>
      )}
    </>
  )
}

function expandedFixture(): CommentThreadView {
  const at = '2026-05-01T00:00:00.000Z'
  const cursor = btoa(
    JSON.stringify([1, localThread.id, at, 'message-4']),
  ).replace(/=+$/, '')
  return {
    ...localThread,
    messageCount: 7,
    replyCount: 6,
    olderCursor: null,
    loadedPages: [{ before: cursor, limit: 50 }],
    messages: Array.from({ length: 7 }, (_, i) => ({
      id: `message-${i}`,
      body: `Reply ${i}`,
      createdAt: at,
      updatedAt: at,
      agent: null,
      author: {
        id: 'user-1',
        name: 'Reviewer',
        email: 'reviewer@example.com',
        image: null,
      },
      canEdit: true,
      canDelete: true,
    })),
  }
}

function initialWindow(thread: CommentThreadView): CommentThreadView {
  return thread.loadedPages?.length
    ? {
        ...thread,
        messages: [thread.messages[0], ...thread.messages.slice(-3)],
        olderCursor: thread.loadedPages[0].before!,
        loadedPages: undefined,
      }
    : thread
}

function authorizedResponseForMutation(body: unknown) {
  return Promise.resolve(observeAuthorizedBody(Response.json(body)))
}

// Retain native JSON reads, including reads from deliberately aborted fetches.
// Empty and stale snapshots need this witness because their DOM may not change.
let authorizedBodies: Array<{ settled: boolean }> = []

function observeAuthorizedBody(response: Response) {
  const completion = { settled: false }
  authorizedBodies.push(completion)
  const readJson = response.json.bind(response)
  response.json = async () => {
    try {
      return await readJson()
    } finally {
      completion.settled = true
    }
  }
  return response
}

function authorizedResponse(threads: unknown[] = []) {
  return Promise.resolve(
    observeAuthorizedBody(
      new Response(JSON.stringify({ threads }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

async function settleAuthorizedResponses(
  condition: () => boolean = () => true,
  description = 'authorized response JSON consumed',
) {
  await waitForRealTaskCondition(async () => {
    await act(async () => {})
    return authorizedBodies.every((body) => body.settled) && condition()
  }, description)
  // Flush the consumers of the native reads, including stale-result suppression.
  await act(async () => {})
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('bounded live authorization browser lifecycle', () => {
  let root: Root
  let host: HTMLDivElement
  let fetchMock: ReturnType<typeof vi.fn>

  async function waitForThreads(ids: string) {
    await settleAuthorizedResponses(
      () => host.querySelector('output')?.dataset.threads === ids,
      `committed thread IDs: ${ids}`,
    )
  }

  beforeEach(async () => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    ControlledWebSocket.instances = []
    authorizedBodies = []
    vi.stubGlobal('WebSocket', ControlledWebSocket)
    fetchMock = vi.fn(() => authorizedResponse())
    vi.stubGlobal('fetch', fetchMock)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<Harness />)
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    host.parentNode?.removeChild(host)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = false
    vi.useRealTimers()
  })

  test.each([
    { intent: 'create-thread', liveEnabled: false, stopped: false },
    { intent: 'delete-thread', liveEnabled: false, stopped: false },
    { intent: 'resolve', liveEnabled: false, stopped: false },
    { intent: 'create-thread', liveEnabled: true, stopped: false },
    { intent: 'delete-thread', liveEnabled: true, stopped: false },
    { intent: 'resolve', liveEnabled: true, stopped: false },
    { intent: 'create-thread', liveEnabled: true, stopped: true },
    { intent: 'delete-thread', liveEnabled: true, stopped: true },
    { intent: 'resolve', liveEnabled: true, stopped: true },
    { intent: 'create-thread', liveEnabled: true, stopped: true, hidden: true },
    { intent: 'delete-thread', liveEnabled: true, stopped: true, hidden: true },
  ] as const)(
    'reconciles local $intent at the 50-thread boundary (live=$liveEnabled, stopped=$stopped, hidden=$hidden)',
    async (scenario) => {
      const { intent, liveEnabled, stopped } = scenario
      const hidden = 'hidden' in scenario && scenario.hidden
      const initial = Array.from({ length: 50 }, (_, i) => ({
        ...localThread,
        id: `selected-${i}`,
      }))
      const retained = expandedFixture()
      initial[1] = retained
      const added = { ...localThread, id: 'newly-selected' }
      const selected = [added, ...initial.slice(1)].map((thread) =>
        thread.id === retained.id ? initialWindow(thread) : thread,
      )
      const changed =
        intent === 'create-thread'
          ? added
          : { ...initial[0], status: 'resolved' as const }
      const payload: CommentMutationPayload =
        intent === 'create-thread'
          ? { intent, body: 'New thread' }
          : { intent, threadId: initial[0].id }
      await act(async () =>
        root.render(
          <Harness
            key="local-boundary"
            initialThreads={initial}
            liveEnabled={liveEnabled}
            localMutation={payload}
          />,
        ),
      )
      fetchMock.mockImplementation(() => authorizedResponse(initial))
      if (liveEnabled) {
        // The initial connection uses bounded windows; retain the existing page.
        fetchMock.mockImplementation((input: string) =>
          authorizedResponse(
            input.includes('?') ? [retained] : initial.map(initialWindow),
          ),
        )
        await act(async () => ControlledWebSocket.instances.at(-1)!.open())
        await waitForThreads(initial.map((thread) => thread.id).join(','))
      }
      if (stopped) {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))
        await act(async () =>
          ControlledWebSocket.instances
            .at(-1)!
            .fail(4401, 'live-authorization-expired'),
        )
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        await flush()
        expect(host.querySelector('output')!.dataset.connected).toBe('false')
      }
      if (hidden) {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        await act(async () =>
          document.dispatchEvent(new Event('visibilitychange')),
        )
      }
      fetchMock.mockClear()
      fetchMock.mockImplementation((input: string, init: RequestInit) =>
        init?.method === 'POST'
          ? authorizedResponseForMutation(
              intent === 'delete-thread'
                ? {
                    threads: [],
                    threadId: initial[0].id,
                    deletedThreadId: initial[0].id,
                  }
                : { threads: [changed], threadId: changed.id },
            )
          : authorizedResponse(input.includes('?') ? [retained] : selected),
      )
      await act(async () =>
        [...host.querySelectorAll('button')]
          .find((button) => button.textContent === 'Commit local mutation')!
          .click(),
      )
      if (hidden) {
        await settleAuthorizedResponses()
        expect(
          fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST'),
        ).toHaveLength(0)
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        await act(async () =>
          document.dispatchEvent(new Event('visibilitychange')),
        )
      }
      await waitForThreads(selected.map((thread) => thread.id).join(','))
      if (stopped) {
        // Never open any replacement socket. HTTP reconciliation must already
        // have restored membership, and survive exhaustion of all retries.
        for (const delay of [2_000, 4_000, 0]) {
          await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
          if (delay) await advance(delay)
        }
        await flush()
        expect(host.querySelector('output')!.dataset.connected).toBe('false')
        expect(host.querySelector('output')!.dataset.threads).toBe(
          selected.map((thread) => thread.id).join(','),
        )
      }
      expect(
        host.querySelector('output')!.dataset.threads!.split(','),
      ).toHaveLength(50)
      expect(host.querySelector('output')!.dataset.messages).toContain(
        'Reply 2',
      )
      expect(host.querySelector('textarea')!.value).toBe(
        'Keep this unsent reply',
      )
      expect(
        fetchMock.mock.calls
          .filter((call) => call[1]?.method !== 'POST')
          .map((call) => String(call[0])),
      ).toEqual(
        stopped
          ? [
              '/api/shareables/artifact-1/comments',
              '/api/shareables/artifact-1/comments',
              `/api/shareables/artifact-1/comments?thread_id=${retained.id}&before=${encodeURIComponent(retained.loadedPages![0].before!)}&limit=50`,
            ]
          : ['/api/shareables/artifact-1/comments'],
      )
      if (!liveEnabled)
        expect(ControlledWebSocket.instances.at(-1)!.readyState).toBe(
          ControlledWebSocket.CLOSED,
        )
    },
  )

  test.each([3, 50])(
    'reconciles displaced rows in a %i-reply page across later and stale refreshes',
    async (size) => {
      const base = expandedFixture()
      const first = size === 3 ? 101 : 51
      const makeMessage = (i: number) => ({
        ...base.messages[0],
        id: `message-${String(i).padStart(3, '0')}`,
        body: `Reply ${i}`,
      })
      const cursor = (id: string) =>
        btoa(
          JSON.stringify([1, base.id, base.messages[0].createdAt, id]),
        ).replace(/=+$/, '')
      const indices = Array.from({ length: size }, (_, i) => first + i)
      const initial: CommentThreadView = {
        ...base,
        messages: [0, ...indices, 201, 202, 203].map(makeMessage),
        latestReplyIds: [201, 202, 203].map((i) => makeMessage(i).id),
        olderCursor: cursor(makeMessage(first).id),
        loadedPages: [
          {
            ...(size === 3
              ? { through: cursor(makeMessage(103).id) }
              : { before: cursor(makeMessage(101).id) }),
            limit: size,
            coverageStart: cursor(makeMessage(first).id),
          },
        ],
      }
      let stored = [makeMessage(first - 1), ...initial.messages.slice(1)]
      let hold = false
      let release: (() => void) | undefined
      const requestedLimits: number[] = []
      fetchMock.mockImplementation((input: string) => {
        const params = new URL(input, 'https://example.com').searchParams
        const edge = params.get('before') ?? params.get('through')
        let rows = stored.slice(-3)
        if (edge) {
          const id = JSON.parse(atob(edge))[3] as string
          const limit = Number(params.get('limit'))
          requestedLimits.push(limit)
          rows = stored
            .filter((m) => (params.has('before') ? m.id < id : m.id <= id))
            .slice(-limit)
        }
        const snapshot = {
          ...base,
          loadedPages: undefined,
          messages: [makeMessage(0), ...rows],
          messageCount: stored.length + 1,
          replyCount: stored.length,
          olderCursor:
            rows[0] && stored.some((m) => m.id < rows[0].id)
              ? cursor(rows[0].id)
              : null,
        }
        if (
          hold &&
          params.get('before') === cursor(`${makeMessage(first).id}a`)
        ) {
          hold = false
          return new Promise<Response>((resolve) => {
            release = () => void authorizedResponse([snapshot]).then(resolve)
          })
        }
        return authorizedResponse(edge ? [snapshot] : [snapshot, oldThread])
      })
      await act(async () =>
        root.render(
          <Harness
            key={`displacement-${size}`}
            initialThreads={[initial, oldThread]}
            showDraft
          />,
        ),
      )
      await act(async () => ControlledWebSocket.instances.at(-1)!.open())
      await settleAuthorizedResponses()
      const notify = async (id: string) => {
        await act(async () =>
          ControlledWebSocket.instances.at(-1)!.message({
            type: 'comments-changed',
            threadId: base.id,
            originUserId: 'other-user',
            originMutationId: id,
          }),
        )
      }
      const displayed = () =>
        JSON.parse(host.querySelector('output')!.dataset.messages!) as Array<{
          id: string
          body: string
        }>
      const inserted = {
        ...makeMessage(first),
        id: `${makeMessage(first).id}a`,
        body: 'Inserted at tied timestamp',
      }
      stored = [...stored, inserted].sort((a, b) => a.id.localeCompare(b.id))
      stored = stored.map((m) =>
        m.id === makeMessage(first).id
          ? { ...m, body: 'Edited displaced row' }
          : m,
      )
      await notify('insert-and-edit')
      await settleAuthorizedResponses(() =>
        displayed().some((m) => m.body === 'Edited displaced row'),
      )
      expect(displayed().some((m) => m.id === inserted.id)).toBe(true)
      // Leave an older continuation in flight, then deliver a deletion notification.
      hold = true
      await notify('older-refresh')
      await settleAuthorizedResponses(() => release !== undefined)
      stored = stored.filter((m) => m.id !== makeMessage(first).id)
      await notify('delete-displaced')
      release!()
      await settleAuthorizedResponses(
        () => !displayed().some((m) => m.id === makeMessage(first).id),
      )
      await notify('later-refresh')
      await settleAuthorizedResponses()
      expect(displayed().some((m) => m.id === makeMessage(first).id)).toBe(
        false,
      )
      expect(
        indices
          .slice(1)
          .every((i) => displayed().some((m) => m.id === makeMessage(i).id)),
      ).toBe(true)
      expect(requestedLimits.every((limit) => limit >= 1 && limit <= 50)).toBe(
        true,
      )
      expect(host.querySelector('textarea')!.value).toBe(
        'Keep this unsent reply',
      )
      expect(host.querySelector('output')!.dataset.threads).toContain(
        oldThread.id,
      )
    },
  )

  test('authorized recovery revalidates expanded history after a remote edit and deletion', async () => {
    const expanded = expandedFixture()
    const latest = initialWindow(expanded)
    await act(async () =>
      root.render(
        <Harness
          key="recovery-history"
          showDraft
          initialThreads={[expanded, oldThread]}
        />,
      ),
    )
    fetchMock.mockImplementation((input: string) =>
      authorizedResponse(
        input.includes('?') ? [expanded] : [latest, oldThread],
      ),
    )
    await act(async () => ControlledWebSocket.instances.at(-1)!.open())
    await settleAuthorizedResponses(() =>
      host.querySelector('output')!.dataset.messages!.includes('Reply 2'),
    )
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    const changedPage = {
      ...expanded,
      messages: expanded.messages
        .slice(0, 4)
        .filter((message) => message.body !== 'Reply 2')
        .map((message) =>
          message.body === 'Reply 1'
            ? { ...message, body: 'Edited during interruption' }
            : message,
        ),
      olderCursor: null,
    }
    fetchMock.mockClear()
    fetchMock.mockImplementation((input: string) =>
      authorizedResponse(
        input.includes('?') ? [changedPage] : [latest, oldThread],
      ),
    )
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settleAuthorizedResponses()
    await act(async () => ControlledWebSocket.instances.at(-1)!.open())
    await settleAuthorizedResponses(() =>
      host
        .querySelector('output')!
        .dataset.messages!.includes('Edited during interruption'),
    )
    const messages = JSON.parse(
      host.querySelector('output')!.dataset.messages!,
    ) as Array<{ body: string }>
    expect(messages.map((message) => message.body)).toEqual([
      'Reply 0',
      'Edited during interruption',
      'Reply 3',
      'Reply 4',
      'Reply 5',
      'Reply 6',
    ])
    expect(host.querySelector('textarea')!.value).toBe('Keep this unsent reply')
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('?')),
    ).toHaveLength(1)
    expect(host.querySelector('output')!.dataset.threads).toBe(
      `${localThread.id},${oldThread.id}`,
    )
  })

  test.each(['reconnect', 'unidentified notification'])(
    '%s refreshes all retained pages even with another dirty thread left over',
    async (mode) => {
      const expanded = expandedFixture()
      const latest = initialWindow(expanded)
      await act(async () =>
        root.render(
          <Harness
            key="dirty-reconnect"
            showDraft
            initialThreads={[expanded, oldThread]}
          />,
        ),
      )
      fetchMock.mockImplementation((input: string) =>
        authorizedResponse(
          input.includes('?') ? [expanded] : [latest, oldThread],
        ),
      )
      const socket = ControlledWebSocket.instances.at(-1)!
      await act(async () => socket.open())
      await settleAuthorizedResponses(() => fetchMock.mock.calls.length === 2)
      fetchMock.mockClear()
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 503 })),
      )
      await act(async () =>
        socket.message({ type: 'comments-changed', threadId: oldThread.id }),
      )
      await settleAuthorizedResponses(() => fetchMock.mock.calls.length === 1)
      const changed = {
        ...expanded,
        messages: expanded.messages
          .slice(0, 4)
          .filter((message) => message.id !== 'message-2'),
      }
      fetchMock.mockClear()
      fetchMock.mockImplementation((input: string) =>
        authorizedResponse(
          input.includes('?') ? [changed] : [latest, oldThread],
        ),
      )
      if (mode === 'reconnect') {
        // Ordinary reconnect does not perform an HTTP recovery-snapshot lookup.
        await act(async () => socket.fail())
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000)
        })
        expect(ControlledWebSocket.instances.at(-1)).not.toBe(socket)
        await act(async () => ControlledWebSocket.instances.at(-1)!.open())
      } else {
        await act(async () => socket.message({ type: 'comments-changed' }))
      }
      await settleAuthorizedResponses(
        () =>
          !host.querySelector('output')!.dataset.messages!.includes('Reply 2'),
      )
      expect(
        fetchMock.mock.calls.filter((call) =>
          String(call[0]).includes('before='),
        ),
      ).toHaveLength(1)
      expect(host.querySelector('output')!.dataset.messages).toContain(
        'Reply 1',
      )
      expect(host.querySelector('output')!.dataset.threads).toContain(
        oldThread.id,
      )
      expect(host.querySelector('textarea')!.value).toBe(
        'Keep this unsent reply',
      )
    },
  )

  test('reconciles selected membership and refreshes only the changed thread history', async () => {
    const expanded = {
      ...localThread,
      loadedPages: [{ before: 'older-boundary', limit: 50 }],
    }
    await act(async () =>
      root.render(
        <Harness key="expanded" initialThreads={[expanded, oldThread]} />,
      ),
    )
    fetchMock.mockImplementationOnce(() =>
      authorizedResponse([localThread, oldThread]),
    )
    fetchMock.mockImplementationOnce(() => authorizedResponse([localThread]))
    await act(async () => ControlledWebSocket.instances.at(-1)!.open())
    await waitForThreads(`${localThread.id},${oldThread.id}`)
    fetchMock.mockClear()
    fetchMock.mockImplementation((input: string) =>
      authorizedResponse(
        input.includes('?') ? [localThread] : [localThread, oldThread],
      ),
    )
    await act(async () =>
      ControlledWebSocket.instances.at(-1)!.message({
        type: 'comments-changed',
        threadId: localThread.id,
        originUserId: 'another-user',
        originMutationId: 'remote-edit',
      }),
    )
    await settleAuthorizedResponses(() => fetchMock.mock.calls.length === 2)
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `/api/shareables/artifact-1/comments`,
      `/api/shareables/artifact-1/comments?thread_id=${localThread.id}&before=older-boundary&limit=50`,
    ])
    expect(host.querySelector('output')?.dataset.threads).toContain(
      oldThread.id,
    )
  })

  test('keeps the server-selected 50 threads across new-thread and status notifications', async () => {
    const initial = Array.from({ length: 50 }, (_, i) => ({
      ...localThread,
      id: `selected-${i}`,
    }))
    await act(async () =>
      root.render(<Harness key="membership" initialThreads={initial} />),
    )
    fetchMock.mockImplementation(() => authorizedResponse(initial))
    await act(async () => ControlledWebSocket.instances.at(-1)!.open())
    await waitForThreads(initial.map((thread) => thread.id).join(','))
    const added = { ...localThread, id: 'added-thread' }
    const next = [added, ...initial.slice(0, 49)]
    for (const selected of [
      next,
      [...initial.slice(1), { ...added, status: 'resolved' }],
    ]) {
      fetchMock.mockClear()
      fetchMock.mockImplementation(() => authorizedResponse(selected))
      await act(async () =>
        ControlledWebSocket.instances.at(-1)!.message({
          type: 'comments-changed',
          threadId: added.id,
          originUserId: 'another-user',
          originMutationId: `change-${selected[0].id}`,
        }),
      )
      await waitForThreads(selected.map((thread) => thread.id).join(','))
      expect(
        host.querySelector('output')!.dataset.threads!.split(','),
      ).toHaveLength(50)
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
        '/api/shareables/artifact-1/comments',
      ])
    }
  })

  test('revalidates replies displaced from the latest window on later remote edits and deletions', async () => {
    const at = '2026-05-01T00:00:00.000Z'
    const message = (i: number) => ({
      id: `message-${i}`,
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
      btoa(JSON.stringify([1, localThread.id, at, message(i).id])).replace(
        /=+$/,
        '',
      )
    const initial = {
      ...localThread,
      messages: [0, 1, 2, 3].map(message),
      messageCount: 4,
      replyCount: 3,
      olderCursor: null,
    }
    await act(async () =>
      root.render(
        <Harness key="displaced" initialThreads={[initial, oldThread]} />,
      ),
    )
    fetchMock.mockImplementation(() => authorizedResponse([initial, oldThread]))
    await act(async () => ControlledWebSocket.instances.at(-1)!.open())
    await waitForThreads(`${localThread.id},${oldThread.id}`)
    const latest = {
      ...initial,
      messages: [0, 4, 5, 6].map(message),
      messageCount: 7,
      replyCount: 6,
      olderCursor: cursor(4),
    }
    let edited = false
    const notify = async (id: string) => {
      await act(async () =>
        ControlledWebSocket.instances.at(-1)!.message({
          type: 'comments-changed',
          threadId: localThread.id,
          originUserId: 'another-user',
          originMutationId: id,
        }),
      )
    }
    fetchMock.mockClear()
    fetchMock.mockImplementation((input: string) => {
      const url = new URL(input, 'https://example.com')
      return authorizedResponse([
        url.searchParams.has('through')
          ? {
              ...latest,
              olderCursor: null,
              messages: edited
                ? [
                    message(0),
                    message(1),
                    { ...message(2), body: 'Edited remotely' },
                  ]
                : initial.messages,
            }
          : latest,
        ...(url.searchParams.has('through') ? [] : [oldThread]),
      ])
    })
    await notify('remote-additions')
    await settleAuthorizedResponses(
      () =>
        JSON.parse(host.querySelector('output')!.dataset.messages!).length ===
        7,
    )
    edited = true
    fetchMock.mockClear()
    await notify('remote-edit-and-delete')
    await settleAuthorizedResponses(() =>
      host
        .querySelector('output')!
        .dataset.messages!.includes('Edited remotely'),
    )
    const messages = JSON.parse(
      host.querySelector('output')!.dataset.messages!,
    ) as Array<{ id: string }>
    expect(messages.map((item) => item.id)).toEqual(
      [0, 1, 2, 4, 5, 6].map((i) => message(i).id),
    )
    expect(
      fetchMock.mock.calls.map((call) =>
        new URL(String(call[0]), 'https://example.com').searchParams.get(
          'through',
        ),
      ),
    ).toEqual([null, cursor(3)])
    expect(host.querySelector('output')!.dataset.threads).toContain(
      oldThread.id,
    )
  })

  test('reconciles a comment with its notification withheld once per direct renewal without a recovery check', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.message({
        type: 'presence',
        users: [{ id: 'user-1', name: 'Viewer', image: null, initial: 'V' }],
      })
    })
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    const renewal = ControlledWebSocket.instances[1]!
    expect(renewal).toBeDefined()
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')

    // Withhold comments-changed in controlled Chromium. Actual server-side
    // notification filtering is covered by separate local workerd evidence.
    fetchMock.mockImplementation(() => authorizedResponse([localThread]))
    expect(host.querySelector('output')?.dataset.threads).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => renewal.open())
    await waitForThreads(localThread.id)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(ControlledWebSocket.instances).toHaveLength(2)
    expect(renewal.readyState).toBe(ControlledWebSocket.OPEN)
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')

    await act(async () => renewal.fail(4401, 'live-authorization-expired'))
    const nextRenewal = ControlledWebSocket.instances[2]!
    expect(nextRenewal).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')

    await act(async () => nextRenewal.open())
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')
    expect(nextRenewal.readyState).toBe(ControlledWebSocket.OPEN)
    expect(ControlledWebSocket.instances).toHaveLength(3)

    // Stay below the heartbeat interval: this socket does not synthesize pongs.
    await advance(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(host.textContent).toBe('Viewer')
    expect(host.querySelector('output')?.dataset.connected).toBe('true')
    expect(nextRenewal.readyState).toBe(ControlledWebSocket.OPEN)
    expect(ControlledWebSocket.instances).toHaveLength(3)
  })

  test.each([false, true])(
    'preserves newer applied threads across a delayed direct-renewal GET (requiresReconcile=%s)',
    async (requiresReconcile) => {
      await act(async () =>
        root.render(<Harness mutation={{ requiresReconcile }} />),
      )
      fetchMock.mockImplementationOnce(() => authorizedResponse([oldThread]))
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await waitForThreads(oldThread.id)
      expect(host.querySelector('output')?.dataset.threads).toBe(oldThread.id)

      let finishOld!: (response: Response) => void
      let finishReplacement!: (response: Response) => void
      fetchMock
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishOld = resolve
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishReplacement = resolve
            }),
        )
      await act(async () => first.fail(4401, 'live-authorization-expired'))
      const renewal = ControlledWebSocket.instances[1]!
      await act(async () => renewal.open())
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const oldSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal

      await act(async () => host.querySelector('button')!.click())
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      // The mock deliberately completes even if aborted, exercising stale data
      // suppression after settlement rather than relying on transport cancellation.
      await act(async () => finishOld(await authorizedResponse([oldThread])))
      await settleAuthorizedResponses()
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(oldSignal.aborted).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(3)

      // Keep any replacement unresolved so it cannot hide a stale intermediate write.
      await advance(2_000)
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      await act(async () =>
        finishReplacement(await authorizedResponse([localThread, oldThread])),
      )
      await waitForThreads(`${localThread.id},${oldThread.id}`)
      expect(host.querySelector('output')?.dataset.threads).toBe(
        `${localThread.id},${oldThread.id}`,
      )
      await act(async () =>
        renewal.message({
          type: 'comments-changed',
          originMutationId: 'local-mutation',
          originUserId: 'user-1',
        }),
      )
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(renewal.readyState).toBe(ControlledWebSocket.OPEN)
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
      expect(ControlledWebSocket.instances).toHaveLength(2)
    },
  )

  test('replaces an aborted renewal GET once to recover a remote comment missing from the mutation snapshot', async () => {
    await act(async () =>
      root.render(<Harness mutation={{ requiresReconcile: false }} />),
    )
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    expect(host.querySelector('output')?.dataset.threads).toBe('')

    const remoteThread = { ...oldThread, id: 'missed-remote-thread' }
    let finishRenewal!: (response: Response) => void
    let finishReplacement!: (response: Response) => void
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishRenewal = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishReplacement = resolve
          }),
      )
    // The POST-like snapshot contains only localThread. The remote comment
    // becomes available afterward, with its expiry notification withheld.
    // This controls client ordering; it does not execute a server POST.
    await act(async () => first.fail(4401, 'live-authorization-expired'))
    const renewal = ControlledWebSocket.instances[1]!
    await act(async () => renewal.open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const renewalSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal

    await act(async () => host.querySelector('button')!.click())
    await flush()
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(renewalSignal.aborted).toBe(true)
    // Even a newer response from the canceled attempt must remain ignored.
    await act(async () =>
      finishRenewal(await authorizedResponse([localThread, remoteThread])),
    )
    await settleAuthorizedResponses()
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    await advance(2_000)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    // Initial open + one aborted renewal attempt + one settlement replacement.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await act(async () =>
      finishReplacement(await authorizedResponse([localThread, remoteThread])),
    )
    await waitForThreads(`${localThread.id},${remoteThread.id}`)
    expect(host.querySelector('output')?.dataset.threads).toBe(
      `${localThread.id},${remoteThread.id}`,
    )
    await advance(2_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(host.querySelector('output')?.dataset.threads).toBe(
      `${localThread.id},${remoteThread.id}`,
    )
    expect(renewal.readyState).toBe(ControlledWebSocket.OPEN)
    expect(ControlledWebSocket.instances).toHaveLength(2)
  })

  test('reconciles membership after an applied mutation without deferred work', async () => {
    await act(async () =>
      root.render(<Harness mutation={{ requiresReconcile: false }} />),
    )
    await act(async () => ControlledWebSocket.instances[0]!.open())
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockImplementation(() => authorizedResponse([localThread]))
    await act(async () => host.querySelector('button')!.click())
    await settleAuthorizedResponses(() => fetchMock.mock.calls.length === 2)
    expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each(['success', 'denied', 'rejected'] as const)(
    'ignores an old ordinary %s completion while direct-renewal reconciliation is pending',
    async (completion) => {
      let finishOld!: (response: Response) => void
      let rejectOld!: (error: Error) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            finishOld = resolve
            rejectOld = reject
          }),
      )
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await flush()
      const oldSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal

      await act(async () => first.fail(4401, 'live-authorization-expired'))
      const renewal = ControlledWebSocket.instances[1]!
      await act(async () => renewal.open())
      await flush()
      expect(oldSignal.aborted).toBe(true)

      let finishRenewal!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishRenewal = resolve
          }),
      )
      await act(async () => {
        if (completion === 'rejected') rejectOld(new TypeError('late failure'))
        else
          finishOld(
            completion === 'denied'
              ? new Response(null, { status: 403 })
              : await authorizedResponse([oldThread]),
          )
      })
      if (completion === 'success') await settleAuthorizedResponses()
      else await flush()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(host.querySelector('output')?.dataset.threads).toBe('')
      await act(async () =>
        finishRenewal(await authorizedResponse([localThread])),
      )
      await settleAuthorizedResponses()
      await advance(2_000)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(renewal.readyState).toBe(ControlledWebSocket.OPEN)
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
    },
  )

  test('closes the renewed socket after its own ordinary reconciliation repeats an auth error', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    fetchMock.mockClear()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    const renewal = ControlledWebSocket.instances[1]!
    await act(async () => renewal.open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await advance(1_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(renewal.readyState).toBe(ControlledWebSocket.CLOSED)
    expect(host.querySelector('output')?.dataset.connected).toBe('false')
    expect(ControlledWebSocket.instances).toHaveLength(2)
  })

  test.each([
    { kind: 'bounded', completion: 'success' },
    { kind: 'bounded', completion: 'denied' },
    { kind: 'bounded', completion: 'rejected' },
    { kind: 'renewal', completion: 'success' },
    { kind: 'renewal', completion: 'denied' },
    { kind: 'renewal', completion: 'rejected' },
  ])(
    'keeps the $kind recovery snapshot after an older ordinary fetch completes ($completion)',
    async ({ kind, completion }) => {
      let finishOld!: (response: Response) => void
      let rejectOld!: (error: Error) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            finishOld = resolve
            rejectOld = reject
          }),
      )
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await flush()
      const oldSignal = fetchMock.mock.calls[0]![1].signal as AbortSignal
      // Queue an ordinary refresh too; applying the snapshot supersedes it.
      await act(async () => first.message({ type: 'comments-changed' }))
      fetchMock.mockImplementationOnce(() => authorizedResponse([localThread]))
      if (kind === 'renewal') {
        await act(async () => first.fail(4401, 'live-authorization-expired'))
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        await settleAuthorizedResponses()
        await advance(2_000)
      } else {
        const visibility = vi.spyOn(document, 'visibilityState', 'get')
        for (const value of ['hidden', 'visible'] as const) {
          visibility.mockReturnValue(value)
          await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
          )
          if (value === 'visible') await settleAuthorizedResponses()
          else await flush()
        }
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const recovered = ControlledWebSocket.instances.at(-1)!
      await act(async () => recovered.open())
      await flush()
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      const log = vi.spyOn(console, 'info')
      await act(async () => {
        if (completion === 'rejected') rejectOld(new TypeError('late failure'))
        else
          finishOld(
            completion === 'denied'
              ? new Response(null, { status: 403 })
              : await authorizedResponse([]),
          )
      })
      if (completion === 'success') await settleAuthorizedResponses()
      else await flush()
      await advance(2_000)
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(oldSignal.aborted).toBe(true)
      expect(log).not.toHaveBeenCalled()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(recovered.readyState).toBe(ControlledWebSocket.OPEN)
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
    },
  )

  test.each(['bounded', 'renewal'] as const)(
    'caps a pending %s episode across repeated hide-while-connecting cycles',
    async (kind) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      const setVisibility = async (value: DocumentVisibilityState) => {
        visibility.mockReturnValue(value)
        await act(async () =>
          document.dispatchEvent(new Event('visibilitychange')),
        )
        await flush()
        if (value === 'visible') await settleAuthorizedResponses()
      }
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await settleAuthorizedResponses()
      fetchMock.mockClear()
      if (kind === 'renewal') {
        await act(async () => first.fail(4401, 'live-authorization-expired'))
      } else {
        await setVisibility('hidden')
        await setVisibility('visible')
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(ControlledWebSocket.instances).toHaveLength(1 + attempt)
        expect(ControlledWebSocket.instances.at(-1)!.readyState).toBe(
          ControlledWebSocket.CONNECTING,
        )
        await setVisibility('hidden')
        await setVisibility('visible')
      }
      // The last Authorized check stops the exhausted episode, not attempt four.
      expect(fetchMock).toHaveBeenCalledTimes(kind === 'renewal' ? 3 : 4)
      expect(ControlledWebSocket.instances).toHaveLength(4)
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(4)
      expect(host.querySelector('output')?.dataset.connected).toBe('false')

      // A later explicit trigger gets a fresh, complete three-attempt budget.
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
            detail: { shareableId: 'artifact-1' },
          }),
        ),
      )
      await settleAuthorizedResponses()
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(ControlledWebSocket.instances).toHaveLength(4 + attempt)
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        if (attempt < 3) await advance(attempt * 2_000)
      }
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(7)
      expect(fetchMock).toHaveBeenCalledTimes(kind === 'renewal' ? 4 : 5)
    },
  )

  test.each([
    { kind: 'renewal', requiresReconcile: false },
    { kind: 'renewal', requiresReconcile: true },
    { kind: 'bounded', requiresReconcile: false },
    { kind: 'bounded', requiresReconcile: true },
  ])(
    'reconciles once on $kind open after a newer applied mutation (requiresReconcile=$requiresReconcile)',
    async ({ kind, requiresReconcile }) => {
      await act(async () =>
        root.render(<Harness mutation={{ requiresReconcile }} />),
      )
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await settleAuthorizedResponses()
      fetchMock.mockClear()
      if (kind === 'renewal') {
        await act(async () => first.fail(4401, 'live-authorization-expired'))
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        await settleAuthorizedResponses()
        await advance(2_000)
      } else {
        const visibility = vi.spyOn(document, 'visibilityState', 'get')
        for (const value of ['hidden', 'visible'] as const) {
          visibility.mockReturnValue(value)
          await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
          )
          if (value === 'visible') await settleAuthorizedResponses()
          else await flush()
        }
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const recovery = ControlledWebSocket.instances.at(-1)!
      expect(recovery.readyState).toBe(ControlledWebSocket.CONNECTING)
      await act(async () => host.querySelector('button')!.click())
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      let finishReconcile!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishReconcile = resolve
          }),
      )
      await act(async () => recovery.open())
      await flush()
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await act(async () =>
        finishReconcile(await authorizedResponse([localThread])),
      )
      await settleAuthorizedResponses()
      await act(async () =>
        recovery.message({
          type: 'comments-changed',
          originUserId: 'user-1',
          originMutationId: 'local-mutation',
        }),
      )
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      await act(async () => recovery.message({ type: 'comments-changed' }))
      await settleAuthorizedResponses()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  test.each([
    { kind: 'renewal', requiresReconcile: false },
    { kind: 'renewal', requiresReconcile: true },
    { kind: 'bounded', requiresReconcile: false },
    { kind: 'bounded', requiresReconcile: true },
  ])(
    'reconciles once on $kind open after a mutation settles during its check (requiresReconcile=$requiresReconcile)',
    async ({ kind, requiresReconcile }) => {
      await act(async () =>
        root.render(<Harness mutation={{ requiresReconcile }} />),
      )
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await settleAuthorizedResponses()
      fetchMock.mockClear()
      let finishCheck!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishCheck = resolve
          }),
      )
      if (kind === 'renewal') {
        await act(async () => first.fail(4401, 'live-authorization-expired'))
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        await flush()
      } else {
        const visibility = vi.spyOn(document, 'visibilityState', 'get')
        for (const value of ['hidden', 'visible'] as const) {
          visibility.mockReturnValue(value)
          await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
          )
          await flush()
        }
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => host.querySelector('button')!.click())
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(async () => finishCheck(await authorizedResponse()))
      await settleAuthorizedResponses()
      if (kind === 'renewal') await advance(2_000)
      const recovery = ControlledWebSocket.instances.at(-1)!
      expect(recovery.readyState).toBe(ControlledWebSocket.CONNECTING)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      let finishReconcile!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishReconcile = resolve
          }),
      )
      await act(async () => recovery.open())
      await flush()
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await act(async () =>
        finishReconcile(await authorizedResponse([localThread])),
      )
      await settleAuthorizedResponses()
      await act(async () =>
        recovery.message({
          type: 'comments-changed',
          originUserId: 'user-1',
          originMutationId: 'local-mutation',
        }),
      )
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(host.querySelector('output')?.dataset.threads).toBe(localThread.id)
      await act(async () => recovery.message({ type: 'comments-changed' }))
      await settleAuthorizedResponses()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  test('preserves consumed attempts when hiding aborts an in-flight explicit check', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const setVisibility = async (value: DocumentVisibilityState) => {
      visibility.mockReturnValue(value)
      await act(async () =>
        document.dispatchEvent(new Event('visibilitychange')),
      )
      await flush()
      if (value === 'visible') await settleAuthorizedResponses()
    }
    await setVisibility('hidden')
    await setVisibility('visible')
    expect(ControlledWebSocket.instances).toHaveLength(2)
    await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
    await advance(2_000)
    expect(ControlledWebSocket.instances).toHaveLength(3)
    await setVisibility('hidden')

    let finishInterrupted!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishInterrupted = resolve
        }),
    )
    await setVisibility('visible')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const interruptedSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal
    await setVisibility('hidden')
    expect(interruptedSignal.aborted).toBe(true)
    await act(async () =>
      finishInterrupted(await authorizedResponse([localThread])),
    )
    await settleAuthorizedResponses()
    expect(ControlledWebSocket.instances).toHaveLength(3)
    expect(host.querySelector('output')?.dataset.threads).toBe('')

    await setVisibility('visible')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(ControlledWebSocket.instances).toHaveLength(4)
    await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
    await advance(60_000)
    expect(ControlledWebSocket.instances).toHaveLength(4)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(host.querySelector('output')?.dataset.connected).toBe('false')
  })

  test.each([
    { oldResult: 'authorized', ending: 'open' },
    { oldResult: 'rejected', ending: 'open' },
    { oldResult: 'authorized', ending: 'exhaust' },
    { oldResult: 'rejected', ending: 'exhaust' },
  ])(
    'ignores a superseded explicit $oldResult completion while its replacement is pending ($ending)',
    async ({ oldResult, ending }) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      const setVisibility = async (value: DocumentVisibilityState) => {
        visibility.mockReturnValue(value)
        await act(async () =>
          document.dispatchEvent(new Event('visibilitychange')),
        )
        await flush()
        if (value === 'visible') await settleAuthorizedResponses()
      }
      await setVisibility('hidden')
      await setVisibility('visible')
      await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      await advance(2_000)
      expect(ControlledWebSocket.instances).toHaveLength(3)
      await setVisibility('hidden')

      let finishOld!: (response: Response) => void
      let rejectOld!: (error: Error) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            finishOld = resolve
            rejectOld = reject
          }),
      )
      await setVisibility('visible')
      const oldSignal = fetchMock.mock.calls[1]![1].signal as AbortSignal
      await setVisibility('hidden')
      expect(oldSignal.aborted).toBe(true)

      let finishReplacement!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishReplacement = resolve
          }),
      )
      await setVisibility('visible')
      const replacementSignal = fetchMock.mock.calls[2]![1]
        .signal as AbortSignal
      // A second trigger must join the replacement rather than create a check.
      await setVisibility('visible')
      expect(fetchMock).toHaveBeenCalledTimes(3)
      await act(async () => {
        if (oldResult === 'authorized')
          finishOld(await authorizedResponse([localThread]))
        else rejectOld(new TypeError('old request aborted'))
      })
      if (oldResult === 'authorized') await settleAuthorizedResponses()
      else await flush()
      expect(replacementSignal.aborted).toBe(false)
      expect(ControlledWebSocket.instances).toHaveLength(3)
      expect(host.querySelector('output')?.dataset.threads).toBe('')
      expect(host.querySelector('output')?.dataset.connected).toBe('false')

      await act(async () =>
        finishReplacement(await authorizedResponse([localThread])),
      )
      await settleAuthorizedResponses()
      expect(ControlledWebSocket.instances).toHaveLength(4)
      const replacement = ControlledWebSocket.instances.at(-1)!
      expect(replacement.readyState).toBe(ControlledWebSocket.CONNECTING)
      if (ending === 'open') {
        await act(async () => replacement.open())
        await flush()
        expect(host.querySelector('output')?.dataset.connected).toBe('true')
        expect(host.querySelector('output')?.dataset.threads).toBe(
          localThread.id,
        )
      } else {
        // Two attempts were already consumed; cancellation cannot replenish them.
        await act(async () => replacement.fail())
        await advance(60_000)
        expect(ControlledWebSocket.instances).toHaveLength(4)
        expect(host.querySelector('output')?.dataset.connected).toBe('false')
      }
      expect(fetchMock).toHaveBeenCalledTimes(3)
    },
  )

  test('uses one dedicated check and caps a denied renewal after its first failed attempt', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    const renewal = ControlledWebSocket.instances[1]!
    await act(async () => renewal.fail())
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ControlledWebSocket.instances).toHaveLength(2)
    expect(host.querySelector('output')?.dataset.connected).toBe('false')
    expect(host.textContent).toBe('')
  })

  test('uses a fresh dedicated check for explicit mutation recovery after a stop', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    await act(async () => ControlledWebSocket.instances[1]!.fail())
    await flush()
    expect(ControlledWebSocket.instances).toHaveLength(2)

    fetchMock.mockImplementationOnce(() => authorizedResponse([]))
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
          detail: { shareableId: 'artifact-1' },
        }),
      )
    })
    await settleAuthorizedResponses()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ControlledWebSocket.instances).toHaveLength(3)
  })

  test('uses exact two and four second delays with a three-attempt authorized renewal cap', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await settleAuthorizedResponses()
    fetchMock.mockClear()
    fetchMock.mockImplementationOnce(() => authorizedResponse([]))

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    await act(async () => ControlledWebSocket.instances[1]!.fail())
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999)
    })
    expect(ControlledWebSocket.instances).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(ControlledWebSocket.instances).toHaveLength(3)

    await act(async () => ControlledWebSocket.instances[2]!.fail())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_999)
    })
    expect(ControlledWebSocket.instances).toHaveLength(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(ControlledWebSocket.instances).toHaveLength(4)

    await act(async () => ControlledWebSocket.instances[3]!.fail())
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(ControlledWebSocket.instances).toHaveLength(4)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host.querySelector('output')?.dataset.connected).toBe('false')
  })

  test.each([
    { state: 'opened', remainingAttempts: 3 },
    { state: 'connecting', remainingAttempts: 1 },
    { state: 'retry scheduled', remainingAttempts: 2 },
  ])(
    'preserves the correct budget after hiding with recovery $state',
    async ({ state, remainingAttempts }) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      const setVisibility = async (value: DocumentVisibilityState) => {
        visibility.mockReturnValue(value)
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'))
        })
        await flush()
        if (value === 'visible') await settleAuthorizedResponses()
      }
      const advance = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      }

      await act(async () => ControlledWebSocket.instances[0]!.open())
      await settleAuthorizedResponses()
      fetchMock.mockClear()
      await setVisibility('hidden')
      await setVisibility('visible')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(ControlledWebSocket.instances).toHaveLength(2)
      await act(async () => ControlledWebSocket.instances[1]!.fail())
      if (state !== 'retry scheduled') {
        await advance(2_000)
        expect(ControlledWebSocket.instances).toHaveLength(3)
        if (state === 'opened') {
          await act(async () => ControlledWebSocket.instances[2]!.open())
          await flush()
          expect(host.querySelector('output')?.dataset.connected).toBe('true')
          expect(fetchMock).toHaveBeenCalledTimes(1)
        }
      }

      await setVisibility('hidden')
      expect(host.querySelector('output')?.dataset.connected).toBe('false')
      expect(
        ControlledWebSocket.instances.every(
          (socket) => socket.readyState === ControlledWebSocket.CLOSED,
        ),
      ).toBe(true)
      const beforeResume = ControlledWebSocket.instances.length
      await setVisibility('visible')
      expect(fetchMock).toHaveBeenCalledTimes(2)

      for (let attempt = 1; attempt <= remainingAttempts; attempt += 1) {
        expect(ControlledWebSocket.instances).toHaveLength(
          beforeResume + attempt,
        )
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        if (attempt < remainingAttempts) {
          const delay = (3 - remainingAttempts + attempt) * 2_000
          await advance(delay - 1)
          expect(ControlledWebSocket.instances).toHaveLength(
            beforeResume + attempt,
          )
          await advance(1)
        }
      }
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(
        beforeResume + remainingAttempts,
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(host.querySelector('output')?.dataset.connected).toBe('false')
    },
  )

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  const staleEvents = async (socket: ControlledWebSocket) => {
    await act(async () => {
      socket.open()
      socket.message({
        type: 'presence',
        users: [{ id: 'stale', name: 'Stale', image: null, initial: 'S' }],
      })
      socket.dispatchEvent(new Event('error'))
      socket.fail(4401, 'live-authorization-expired')
    })
  }

  test.each(['synchronous close', 'silent close', 'throwing close'] as const)(
    'times out stalled renewal attempts once with %s, ignores late events, and permits explicit recovery after exhaustion',
    async (closeBehavior) => {
      const first = ControlledWebSocket.instances[0]!
      await act(async () => first.open())
      await settleAuthorizedResponses()
      await act(async () =>
        first.message({
          type: 'presence',
          users: [{ id: 'user-1', name: 'Viewer', image: null, initial: 'V' }],
        }),
      )
      fetchMock.mockClear()
      await act(async () => first.fail(4401, 'live-authorization-expired'))
      const stalled = ControlledWebSocket.instances[1]!
      const close = vi.spyOn(stalled, 'close')
      if (closeBehavior !== 'synchronous close') {
        close.mockImplementationOnce(() => {
          if (closeBehavior === 'throwing close')
            throw new Error('close failed')
          stalled.readyState = ControlledWebSocket.CLOSING
        })
      }
      await advance(VIEWER_FETCH_TIMEOUT_MS - 1)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(host.textContent).toBe('Viewer')
      await advance(1)
      await settleAuthorizedResponses()
      expect(close).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
      await advance(1_999)
      expect(ControlledWebSocket.instances).toHaveLength(2)
      await advance(1)
      const second = ControlledWebSocket.instances[2]!
      await staleEvents(stalled)
      expect(second.readyState).toBe(ControlledWebSocket.CONNECTING)
      expect(host.textContent).toBe('Viewer')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await advance(VIEWER_FETCH_TIMEOUT_MS)
      await advance(3_999)
      expect(ControlledWebSocket.instances).toHaveLength(3)
      await advance(1)
      await advance(VIEWER_FETCH_TIMEOUT_MS)
      expect(host.textContent).toBe('')
      expect(host.querySelector('output')?.dataset.connected).toBe('false')
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(4)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
            detail: { shareableId: 'artifact-1' },
          }),
        ),
      )
      await settleAuthorizedResponses()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(ControlledWebSocket.instances).toHaveLength(5)
      await act(async () => ControlledWebSocket.instances[4]!.open())
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
    },
  )

  test.each([0, 1])(
    'controlled opaque handshake retries use bounded jitter at random=%i',
    async (random) => {
      vi.mocked(Math.random).mockReturnValue(random)
      await act(async () => {
        ControlledWebSocket.instances[0]!.dispatchEvent(new Event('error'))
        ControlledWebSocket.instances[0]!.fail()
      })
      for (const base of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        const count = ControlledWebSocket.instances.length
        const delay = base + random * 250
        await advance(delay - 1)
        expect(ControlledWebSocket.instances).toHaveLength(count)
        await advance(1)
        expect(ControlledWebSocket.instances).toHaveLength(count + 1)
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      }
      const count = ControlledWebSocket.instances.length
      await advance(29_999)
      expect(ControlledWebSocket.instances).toHaveLength(count)
      await advance(1)
      await settleAuthorizedResponses()
      expect(ControlledWebSocket.instances).toHaveLength(count + 1)
    },
  )

  test.each([0, 1])(
    'controlled renewal retries jitter without adding attempts at random=%i',
    async (random) => {
      vi.mocked(Math.random).mockReturnValue(random)
      await act(async () => ControlledWebSocket.instances[0]!.open())
      await act(async () =>
        ControlledWebSocket.instances[0]!.fail(
          4401,
          'live-authorization-expired',
        ),
      )
      const first = ControlledWebSocket.instances.at(-1)!
      await act(async () => first.fail())
      await settleAuthorizedResponses()
      for (const base of [2_000, 4_000]) {
        const count = ControlledWebSocket.instances.length
        await advance(base + random * 250 - 1)
        expect(ControlledWebSocket.instances).toHaveLength(count)
        await advance(1)
        expect(ControlledWebSocket.instances).toHaveLength(count + 1)
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      }
      const count = ControlledWebSocket.instances.length
      await advance(120_000)
      expect(ControlledWebSocket.instances).toHaveLength(count)
    },
  )

  test('accounts for silent ordinary failures and exhausts three stalled authorized recovery attempts', async () => {
    const first = ControlledWebSocket.instances[0]!
    await advance(VIEWER_FETCH_TIMEOUT_MS - 1)
    expect(first.readyState).toBe(ControlledWebSocket.CONNECTING)
    await advance(1)
    expect(first.readyState).toBe(ControlledWebSocket.CLOSED)
    // The first failure starts the ordinary clock at t=15s. Further stalls
    // plus backoff reach the first qualifying check decision at t=75s.
    for (const delay of [1_000, 2_000, 4_000]) {
      await advance(delay)
      await advance(VIEWER_FETCH_TIMEOUT_MS)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    await advance(8_000)
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const beforeBounded = ControlledWebSocket.instances.length
    const bounded = ControlledWebSocket.instances.at(-1)!
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    await advance(2_000)
    await staleEvents(bounded)
    expect(host.querySelector('output')?.dataset.connected).toBe('false')
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    await advance(4_000)
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    await advance(120_000)
    expect(ControlledWebSocket.instances).toHaveLength(beforeBounded + 2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test.each(['timeout', 'late open'] as const)(
    'enforces the absolute ordinary boundary for a stalled socket via %s',
    async (ending) => {
      // Resolve just before the check timeout so the final socket starts at
      // t=105.999s and has only 14.001s before the absolute boundary.
      let finishCheck!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishCheck = resolve
          }),
      )
      await act(async () => ControlledWebSocket.instances[0]!.fail())
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        await advance(delay)
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      }
      await advance(30_000)
      // Keep the HTTP check within its own 15-second timeout.
      await advance(14_999)
      await act(async () =>
        finishCheck(observeAuthorizedBody(new Response('{}', { status: 200 }))),
      )
      await settleAuthorizedResponses()
      await advance(30_000)
      const stalled = ControlledWebSocket.instances.at(-1)!
      // Delay its timeout callback; a late open must independently enforce t=120s.
      if (ending === 'late open') {
        vi.setSystemTime(Date.now() + 14_001)
        await act(async () => stalled.open())
      } else {
        await advance(14_000)
        expect(stalled.readyState).toBe(ControlledWebSocket.CONNECTING)
        await advance(1)
      }
      expect(stalled.readyState).toBe(ControlledWebSocket.CLOSED)
      const count = ControlledWebSocket.instances.length
      await staleEvents(stalled)
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(count)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(host.querySelector('output')?.dataset.connected).toBe('false')
    },
  )

  test('keeps a same-sequence ordinary boundary abort indeterminate and rejects its late Authorized data', async () => {
    let finishCheck!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishCheck = resolve
        }),
    )
    await act(async () => ControlledWebSocket.instances[0]!.fail())
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await advance(delay)
      await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
    }
    // A delayed reconnect decision leaves only one second for its check.
    vi.setSystemTime(Date.now() + 58_000)
    await advance(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal
    await advance(999)
    expect(signal.aborted).toBe(false)
    await advance(1)
    expect(signal.aborted).toBe(true)
    const socketCount = ControlledWebSocket.instances.length
    await act(async () => finishCheck(await authorizedResponse([localThread])))
    await settleAuthorizedResponses()
    await advance(60_000)
    expect(ControlledWebSocket.instances).toHaveLength(socketCount)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host.querySelector('output')?.dataset.threads).toBe('')
    // Indeterminate at the boundary stops the episode, allowing explicit recovery.
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
          detail: { shareableId: 'artifact-1' },
        }),
      ),
    )
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ControlledWebSocket.instances).toHaveLength(socketCount + 1)
  })

  test('clears a stalled bounded timer on hide while preserving its consumed attempt', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const setVisibility = async (value: DocumentVisibilityState) => {
      visibility.mockReturnValue(value)
      await act(async () =>
        document.dispatchEvent(new Event('visibilitychange')),
      )
      await flush()
      if (value === 'visible') await settleAuthorizedResponses()
    }
    await setVisibility('hidden')
    await setVisibility('visible')
    const interrupted = ControlledWebSocket.instances.at(-1)!
    await advance(5_000)
    await setVisibility('hidden')
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await setVisibility('visible')
    const resumed = ControlledWebSocket.instances.at(-1)!
    await staleEvents(interrupted)
    expect(resumed.readyState).toBe(ControlledWebSocket.CONNECTING)
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    await advance(3_999)
    expect(ControlledWebSocket.instances).toHaveLength(3)
    await advance(1)
    await advance(VIEWER_FETCH_TIMEOUT_MS + 60_000)
    expect(ControlledWebSocket.instances).toHaveLength(4)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test.each(['mutation', 'visibility return'] as const)(
    'grants all three fresh attempts via %s after a hidden bounded episode exhausts',
    async (trigger) => {
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      const setVisibility = async (value: DocumentVisibilityState) => {
        visibility.mockReturnValue(value)
        await act(async () =>
          document.dispatchEvent(new Event('visibilitychange')),
        )
        await flush()
        if (value === 'visible') await settleAuthorizedResponses()
      }
      await setVisibility('hidden')
      await setVisibility('visible')
      await setVisibility('hidden')
      await setVisibility('visible')
      // The interrupted first attempt is consumed, leaving attempts two and three.
      expect(ControlledWebSocket.instances).toHaveLength(3)
      await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      await advance(4_000)
      await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(4)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      if (trigger === 'visibility return') {
        await setVisibility('hidden')
        await advance(60_000)
        expect(ControlledWebSocket.instances).toHaveLength(4)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        await setVisibility('visible')
      } else {
        await act(async () =>
          window.dispatchEvent(
            new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
              detail: { shareableId: 'artifact-1' },
            }),
          ),
        )
        await settleAuthorizedResponses()
      }
      expect(fetchMock).toHaveBeenCalledTimes(3)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(ControlledWebSocket.instances).toHaveLength(4 + attempt)
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        if (attempt < 3) await advance(attempt * 2_000)
      }
      await advance(60_000)
      expect(ControlledWebSocket.instances).toHaveLength(7)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(host.querySelector('output')?.dataset.connected).toBe('false')
    },
  )

  test('clears pre-open timers on open, artifact replacement, and teardown', async () => {
    const old = ControlledWebSocket.instances[0]!
    await advance(5_000)
    await act(async () => root.render(<Harness artifactId="artifact-2" />))
    const current = ControlledWebSocket.instances[1]!
    await staleEvents(old)
    await act(async () => {
      current.open()
      current.message('pong')
    })
    await settleAuthorizedResponses()
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    expect(current.readyState).toBe(ControlledWebSocket.OPEN)
    expect(ControlledWebSocket.instances).toHaveLength(2)
    await act(async () => root.render(<Harness artifactId="artifact-3" />))
    const disposed = ControlledWebSocket.instances[2]!
    await act(async () => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
    await staleEvents(disposed)
    await advance(60_000)
    expect(ControlledWebSocket.instances).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('keeps ordinary backoff for sixty seconds before its sole denial check', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))
    await act(async () => ControlledWebSocket.instances[0]!.fail())

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      ControlledWebSocket.instances.at(-1)!.fail()
    }
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const countAfterDenial = ControlledWebSocket.instances.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(ControlledWebSocket.instances).toHaveLength(countAfterDenial)
  })

  test('stops ordinary indeterminate recovery at 120 seconds and permits fresh authorized recovery', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network failed'))
    await act(async () => ControlledWebSocket.instances[0]!.fail())

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      ControlledWebSocket.instances.at(-1)!.fail()
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    const late = ControlledWebSocket.instances.at(-1)!
    late.fail()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000)
    })
    const countAtBoundary = ControlledWebSocket.instances.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(ControlledWebSocket.instances).toHaveLength(countAtBoundary)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockImplementationOnce(() => authorizedResponse([]))
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
          detail: { shareableId: 'artifact-1' },
        }),
      ),
    )
    await settleAuthorizedResponses()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ControlledWebSocket.instances).toHaveLength(countAtBoundary + 1)
    const recovered = ControlledWebSocket.instances.at(-1)!
    await act(async () => {
      recovered.open()
      recovered.message('pong')
    })
    await advance(VIEWER_FETCH_TIMEOUT_MS)
    expect(recovered.readyState).toBe(ControlledWebSocket.OPEN)
    expect(host.querySelector('output')?.dataset.connected).toBe('true')
    // The authorized mutation check reconciles before open; open then performs
    // its normal bounded refresh for changes since that HTTP response.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

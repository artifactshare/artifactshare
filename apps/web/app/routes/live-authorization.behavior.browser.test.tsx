// Browser mode cannot load a test module from the route directory whose name
// contains `$`, so this behavior test lives one level above the component.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useViewerComments } from './a.$id/+components/viewer-shell'
import type { CommentThreadView } from '~/lib/comments'
import { VIEWER_FETCH_TIMEOUT_MS } from '~/lib/viewer-network'
import { COMMENT_MUTATION_SETTLED_EVENT } from './a.$id/+components/use-comment-mutations'

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
  messages: [],
}

function Harness({
  artifactId = 'artifact-1',
  mutation,
}: {
  artifactId?: string
  mutation?: { requiresReconcile: boolean }
}) {
  const [connected, setConnected] = useState(false)
  const comments = useViewerComments({
    artifactId,
    currentUserId: 'user-1',
    currentVersionId: 'version-1',
    initialThreads: [],
    targetCommentId: null,
    liveEnabled: true,
    onLiveConnectionChanged: setConnected,
  })
  return (
    <>
      <output
        data-connected={String(connected)}
        data-threads={comments.state.threads
          .map((thread) => thread.id)
          .join(',')}
      >
        {comments.presence.map((presence) => presence.name).join(',')}
      </output>
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

function authorizedResponse(threads: unknown[] = []) {
  return Promise.resolve(
    new Response(JSON.stringify({ threads }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
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

  beforeEach(async () => {
    ;(
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean
      }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    ControlledWebSocket.instances = []
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

  test('renews established leases handshake-first while retaining local presence', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await flush()
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

    await act(async () => renewal.open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => renewal.fail(4401, 'live-authorization-expired'))
    const nextRenewal = ControlledWebSocket.instances[2]!
    await act(async () => nextRenewal.open())
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

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
      await flush()
      fetchMock.mockClear()
      if (kind === 'renewal') {
        await act(async () => first.fail(4401, 'live-authorization-expired'))
        await act(async () => ControlledWebSocket.instances.at(-1)!.fail())
        await flush()
        await advance(2_000)
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
      await flush()
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
      await flush()
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
      await flush()
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
      await flush()
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
      await flush()
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
      await flush()
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
    await flush()
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
      await flush()
      expect(replacementSignal.aborted).toBe(false)
      expect(ControlledWebSocket.instances).toHaveLength(3)
      expect(host.querySelector('output')?.dataset.threads).toBe('')
      expect(host.querySelector('output')?.dataset.connected).toBe('false')

      await act(async () =>
        finishReplacement(await authorizedResponse([localThread])),
      )
      await flush()
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
    await flush()
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
    await flush()
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
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ControlledWebSocket.instances).toHaveLength(3)
  })

  test('uses exact two and four second delays with a three-attempt authorized renewal cap', async () => {
    const first = ControlledWebSocket.instances[0]!
    await act(async () => first.open())
    await flush()
    fetchMock.mockClear()
    fetchMock.mockImplementationOnce(() => authorizedResponse([]))

    await act(async () => first.fail(4401, 'live-authorization-expired'))
    await act(async () => ControlledWebSocket.instances[1]!.fail())
    await flush()
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
      }
      const advance = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms)
        })
      }

      await act(async () => ControlledWebSocket.instances[0]!.open())
      await flush()
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
      await flush()
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
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(ControlledWebSocket.instances).toHaveLength(5)
      await act(async () => ControlledWebSocket.instances[4]!.open())
      expect(host.querySelector('output')?.dataset.connected).toBe('true')
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
      await act(async () => finishCheck(new Response('{}', { status: 200 })))
      await flush()
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
    await flush()
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
    await flush()
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
        await flush()
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
    await flush()
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
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

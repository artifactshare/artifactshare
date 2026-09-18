// Browser mode cannot load a test module from the route directory whose name
// contains `$`, so this behavior test lives one level above the component.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useViewerComments } from './a.$id/+components/viewer-shell'
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

function Harness() {
  const [connected, setConnected] = useState(false)
  const comments = useViewerComments({
    artifactId: 'artifact-1',
    currentUserId: 'user-1',
    currentVersionId: 'version-1',
    initialThreads: [],
    targetCommentId: null,
    liveEnabled: true,
    onLiveConnectionChanged: setConnected,
  })
  return (
    <output data-connected={String(connected)}>
      {comments.presence.map((presence) => presence.name).join(',')}
    </output>
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

  test('stops an indeterminate ordinary path at the absolute 120 second boundary', async () => {
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
  })
})

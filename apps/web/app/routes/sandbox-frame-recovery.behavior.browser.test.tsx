import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SandboxFrame } from './a.$id/+components/sandbox-frame'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let root: Root | undefined

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

describe('SandboxFrame recovery', () => {
  test('remounts once, then stops automatic recovery at the manual retry state', async () => {
    vi.useFakeTimers()
    const tokenRequests: Array<Deferred<Response>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/__artifactshare_probe')) {
          return Promise.resolve(
            new Response('artifactshare-sandbox-probe-v1', {
              status: 200,
              headers: {
                'X-ArtifactShare-Sandbox-Probe':
                  'artifactshare-sandbox-probe-v1',
              },
            }),
          )
        }
        expect(init?.cache).toBe('no-store')
        const request = deferred<Response>()
        tokenRequests.push(request)
        return request.promise
      }),
    )

    const host = await renderFrame()
    const initialFrame = host.querySelector('iframe')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })
    expect(tokenRequests).toHaveLength(1)

    await act(async () => {
      tokenRequests[0].resolve(
        Response.json({
          sandboxUrl: `${window.location.origin}/sandbox-frame-test?t=fresh`,
          renderType: 'html',
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stateOf(host)).toBe('loading')
    const recoveredFrame = host.querySelector('iframe')
    expect(recoveredFrame).not.toBe(initialFrame)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(tokenRequests).toHaveLength(1)
    expect(stateOf(host)).toBe('paused')

    const retry = host.querySelector<HTMLButtonElement>('button')
    expect(retry?.textContent).toBe('Continue viewing')
    await act(async () => retry?.click())
    expect(stateOf(host)).toBe('resuming')
    expect(host.querySelector('iframe')).toBe(recoveredFrame)
    expect(tokenRequests).toHaveLength(2)

    await act(async () => {
      tokenRequests[1].resolve(
        Response.json({
          sandboxUrl: `${window.location.origin}/sandbox-frame-test?t=retry`,
          renderType: 'html',
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stateOf(host)).toBe('loading')
    expect(host.querySelector('iframe')).not.toBe(recoveredFrame)
  })

  test('ignores initial pageshow but checks a visible persisted restore', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const host = await renderFrame()
    const frame = host.querySelector('iframe')
    expect(frame?.contentWindow).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame?.contentWindow,
          data: { source: 'artifactshare', kind: 'ready' },
        }),
      )
    })
    expect(stateOf(host)).toBe('ready')

    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: false }),
      )
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(stateOf(host)).toBe('ready')

    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      )
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(stateOf(host)).toBe('loading')
  })

  test('gives a restored navigation its own automatic recovery attempt', async () => {
    vi.useFakeTimers()
    const tokenRequests: Array<Deferred<Response>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('/__artifactshare_probe')) {
          return Promise.resolve(
            new Response('artifactshare-sandbox-probe-v1', {
              status: 200,
              headers: {
                'X-ArtifactShare-Sandbox-Probe':
                  'artifactshare-sandbox-probe-v1',
              },
            }),
          )
        }
        const request = deferred<Response>()
        tokenRequests.push(request)
        return request.promise
      }),
    )

    const host = await renderFrame()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })
    expect(tokenRequests).toHaveLength(1)
    expect(stateOf(host)).toBe('resuming')

    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      )
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(stateOf(host)).toBe('loading')

    await act(async () => {
      tokenRequests[0].resolve(
        Response.json({
          sandboxUrl: `${window.location.origin}/sandbox-frame-test?t=stale`,
          renderType: 'html',
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })

    expect(tokenRequests).toHaveLength(2)
    expect(stateOf(host)).toBe('resuming')
  })

  test('returns to the manual retry state when a refreshed URL is invalid', async () => {
    vi.useFakeTimers()
    const tokenRequests: Array<Deferred<Response>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('/__artifactshare_probe')) {
          return Promise.resolve(new Response('', { status: 403 }))
        }
        const request = deferred<Response>()
        tokenRequests.push(request)
        return request.promise
      }),
    )

    const host = await renderFrame()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })
    expect(stateOf(host)).toBe('blocked')

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button')?.click(),
    )
    expect(stateOf(host)).toBe('resuming')
    expect(tokenRequests).toHaveLength(1)

    await act(async () => {
      tokenRequests[0].resolve(
        Response.json({ sandboxUrl: 'not a URL', renderType: 'html' }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stateOf(host)).toBe('paused')
  })
})

async function renderFrame() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SandboxFrame
        shareableId="abc123def4"
        versionId="v1"
        url={`${window.location.origin}/sandbox-frame-test?t=old`}
        name="Recovery test"
        mermaidEnabled={false}
        textAnchorsEnabled={false}
        linkNavigationMode="document"
        bundlePaths={[]}
        fallbackToIndex={false}
        commentThreads={[]}
        targetThreadId={null}
        highlightThreadId={null}
        followsAppTheme={false}
        onTextSelection={() => {}}
        onTextSelectionClear={() => {}}
        onThreadSelect={() => {}}
        onOutsidePointerDown={() => {}}
        sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />,
    )
  })
  return host
}

function stateOf(host: HTMLElement) {
  return host
    .querySelector('[data-sandbox-state]')
    ?.getAttribute('data-sandbox-state')
}

import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { act, Profiler, type ProfilerOnRenderCallback } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SandboxFrame } from './a.$id/+components/sandbox-frame'

const realNow = performance.now.bind(performance)

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
  test('retries a lost ready-check and stops probing after the frame replies', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const host = await renderFrame()
    const frame = host.querySelector('iframe')!
    // Settle native navigation before counting checks from the explicit load
    // below. Otherwise its late load event legitimately starts another check.
    await act(async () => {
      await new Promise<void>((resolve) => {
        const onLoad = () => {
          if (frame.contentDocument?.title !== 'Readiness fixture') return
          frame.removeEventListener('load', onLoad)
          resolve()
        }
        frame.addEventListener('load', onLoad)
        frame.srcdoc = '<!doctype html><title>Readiness fixture</title>'
      })
    })
    const postMessage = vi
      .spyOn(frame.contentWindow!, 'postMessage')
      .mockImplementation(() => {})
    const readyChecks = () =>
      postMessage.mock.calls.filter(
        ([message]) => message.kind === 'ready-check',
      )

    // Drive the component's load handler; the first check gets no reply.
    await act(async () => frame.dispatchEvent(new Event('load')))
    expect(readyChecks()).toHaveLength(1)
    expect(stateOf(host)).toBe('loading')
    await act(async () => vi.advanceTimersByTimeAsync(249))
    expect(readyChecks()).toHaveLength(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(readyChecks()).toHaveLength(2)
    const challenge = readyChecks()[1][0].challenge
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: 'artifactshare',
            kind: 'ready',
            challenge,
            token: 'a'.repeat(64),
          },
        }),
      )
    })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(stateOf(host)).toBe('ready')
    expect(readyChecks()).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
    postMessage.mockRestore()
  })

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

    const checking = vi.fn()
    const host = await renderFrame(checking)
    const initialFrame = host.querySelector('iframe')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await waitForRealTaskCondition(
      () => tokenRequests.length === 1,
      'first token request',
    )
    await expectFrameState(host, 'resuming')
    expect(tokenRequests).toHaveLength(1)
    expect(stateOf(host)).toBe('resuming')
    expect(checking).toHaveBeenLastCalledWith(false)
    const callsAfterDeadline = checking.mock.calls.length

    await act(async () => {
      tokenRequests[0].resolve(
        Response.json({
          sandboxUrl: `${window.location.origin}/sandbox-frame-test?t=fresh`,
          renderType: 'html',
        }),
      )
    })
    await expectFrameState(host, 'loading')
    expect(checking.mock.calls.slice(callsAfterDeadline)).not.toContainEqual([
      true,
    ])
    expect(checking).toHaveBeenLastCalledWith(false)
    const recoveredFrame = host.querySelector('iframe')
    expect(recoveredFrame).not.toBe(initialFrame)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await expectFrameState(host, 'paused')
    expect(tokenRequests).toHaveLength(1)
    expect(stateOf(host)).toBe('paused')
    expect(checking).toHaveBeenLastCalledWith(false)

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
    })
    await expectFrameState(host, 'loading')
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
    })
    await waitForRealTaskCondition(
      () => tokenRequests.length === 1,
      'first token request',
    )
    await expectFrameState(host, 'resuming')
    expect(tokenRequests).toHaveLength(1)
    expect(stateOf(host)).toBe('resuming')

    await act(async () => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      )
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(stateOf(host)).toBe('loading')

    const staleResponse = Response.json({
      sandboxUrl: `${window.location.origin}/sandbox-frame-test?t=stale`,
      renderType: 'html',
    })
    const readJson = staleResponse.json.bind(staleResponse)
    let staleBodyRead = false
    staleResponse.json = async () => {
      const body = await readJson()
      staleBodyRead = true
      return body
    }
    await act(async () => tokenRequests[0].resolve(staleResponse))
    await waitForRealTaskCondition(async () => {
      await act(async () => {})
      return staleBodyRead
    }, 'stale token body consumed')
    await expectFrameState(host, 'loading')
    expect(host.querySelector('iframe')?.src).not.toContain('t=stale')
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    await waitForRealTaskCondition(
      () => tokenRequests.length === 2,
      'restored token request',
    )
    await expectFrameState(host, 'resuming')

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

    const checking = vi.fn()
    const host = await renderFrame(checking)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })
    expect(stateOf(host)).toBe('blocked')
    expect(checking).toHaveBeenLastCalledWith(false)

    await act(async () =>
      host.querySelector<HTMLButtonElement>('button')?.click(),
    )
    expect(stateOf(host)).toBe('resuming')
    expect(tokenRequests).toHaveLength(1)

    await act(async () => {
      tokenRequests[0].resolve(
        Response.json({ sandboxUrl: 'not a URL', renderType: 'html' }),
      )
    })
    await expectFrameState(host, 'paused')
    expect(host.textContent).toContain(
      'The last attempt did not finish. Try again or reload the page.',
    )
    const retryButton = host.querySelector<HTMLButtonElement>('button')
    expect(retryButton?.getAttribute('aria-describedby')).toBe(
      'sandbox-paused-guidance',
    )
    expect(host.querySelector('#sandbox-paused-guidance')?.textContent).toBe(
      'The last attempt did not finish. Try again or reload the page.',
    )
  })
})

// Native Response body reads can finish after the microtask queue drains.
// Poll without advancing the fake recovery deadlines, flushing React each time.
async function expectFrameState(host: HTMLElement, expected: string) {
  await waitForRealTaskCondition(async () => {
    await act(async () => {})
    return stateOf(host) === expected
  }, `frame state ${expected}`)
  expect(stateOf(host)).toBe(expected)
}

async function renderFrame(
  onAnchorCheckingChange?: (available: boolean) => void,
  canViewEnvironmentDiagnostics = false,
  siteNavigation = false,
  onRender: ProfilerOnRenderCallback = () => {},
  options: {
    host?: HTMLElement
    renderType?: string | null
    beforeHydrate?: (host: HTMLElement) => void
  } = {},
) {
  const host = options.host ?? document.createElement('div')
  if (!options.host) {
    document.body.appendChild(host)
    if (!options.beforeHydrate) root = createRoot(host)
  }
  await act(async () => {
    const view = (
      <Profiler id="sandbox-frame" onRender={onRender}>
        <SandboxFrame
          renderType={
            options.renderType === undefined
              ? siteNavigation
                ? 'static_site'
                : 'html'
              : options.renderType
          }
          canViewEnvironmentDiagnostics={canViewEnvironmentDiagnostics}
          onAnchorCheckingChange={onAnchorCheckingChange}
          shareableId="abc123def4"
          versionId="v1"
          url={`${window.location.origin}/sandbox-frame-test?t=old`}
          name="Recovery test"
          mermaidEnabled={false}
          textAnchorsEnabled={false}
          linkNavigationMode={siteNavigation ? 'site' : 'document'}
          bundlePaths={siteNavigation ? ['/next.html'] : []}
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
        />
      </Profiler>
    )
    if (options.beforeHydrate) {
      host.replaceChildren(
        document.createRange().createContextualFragment(renderToString(view)),
      )
      options.beforeHydrate(host)
      root = hydrateRoot(host, view)
    } else {
      root?.render(view)
    }
  })
  return host
}

function stateOf(host: HTMLElement) {
  return host
    .querySelector('[data-sandbox-state]')
    ?.getAttribute('data-sandbox-state')
}

test('a frame that never becomes ready expires checking without inventing a resolution', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  const checking = vi.fn()
  const host = await renderFrame(checking)
  expect(checking).toHaveBeenLastCalledWith(true)
  await act(async () => vi.advanceTimersByTimeAsync(3001))
  expect(stateOf(host)).toBe('loading')
  expect(checking).toHaveBeenLastCalledWith(false)
})

describe('waitForRealTaskCondition', () => {
  test.each(['native', 'streamed'] as const)(
    'consumes a %s Response body without advancing fake time',
    async (kind) => {
      vi.useFakeTimers()
      const now = Date.now()
      const timer = vi.fn()
      setTimeout(timer, 1)
      const delivery = new MessageChannel()
      let turns = 0
      const startedAt = realNow()
      try {
        const response =
          kind === 'native'
            ? new Response('body ready')
            : new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    delivery.port1.onmessage = () => {
                      turns += 1
                      if (turns < 60 || realNow() - startedAt < 100) {
                        delivery.port2.postMessage(null)
                      } else {
                        controller.enqueue(
                          new TextEncoder().encode('body ready'),
                        )
                        controller.close()
                      }
                    }
                    delivery.port2.postMessage(null)
                  },
                }),
              )
        let text: string | undefined
        const consumed = response.text().then((value) => {
          text = value
        })
        // This control fails if the stream fixture stops requiring real tasks.
        await Promise.resolve()
        await Promise.resolve()
        if (kind === 'streamed') expect(text).toBeUndefined()
        await waitForRealTaskCondition(
          () => text === 'body ready',
          `${kind} body read`,
        )
        await consumed
        expect(text).toBe('body ready')
        if (kind === 'streamed') {
          expect(turns).toBeGreaterThanOrEqual(60)
          expect(realNow() - startedAt).toBeGreaterThanOrEqual(100)
        }
        expect(Date.now()).toBe(now)
        expect(timer).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)
      } finally {
        delivery.port1.onmessage = null
        delivery.port1.close()
        delivery.port2.close()
      }
    },
  )

  test.each([undefined, 30])(
    'waits for the real-time budget (%s) without advancing fake time',
    async (budgetMs) => {
      vi.useFakeTimers()
      const now = Date.now()
      const timer = vi.fn()
      setTimeout(timer, 1)
      const condition = vi.fn(() => false)
      const startedAt = realNow()
      await expect(
        waitForRealTaskCondition(condition, 'missing response', budgetMs),
      ).rejects.toThrow(
        `Condition "missing response" did not hold after ${budgetMs ?? 1000} ms of real time`,
      )
      expect(realNow() - startedAt).toBeGreaterThanOrEqual(budgetMs ?? 1000)
      expect(condition).toHaveBeenCalled()
      expect(Date.now()).toBe(now)
      expect(timer).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(1)
    },
  )

  test('checks initially, closes ports on settlement, and propagates predicate errors', async () => {
    vi.useFakeTimers()
    const postMessage = vi.spyOn(MessagePort.prototype, 'postMessage')
    const close = vi.spyOn(MessagePort.prototype, 'close')
    try {
      await waitForRealTaskCondition(() => true, 'already ready', 0)
      expect(postMessage).not.toHaveBeenCalled()
      let checks = 0
      await waitForRealTaskCondition(() => ++checks === 3, 'eventually ready')
      expect(checks).toBe(3)
      expect(close).toHaveBeenCalledTimes(2)
      close.mockClear()
      await expect(
        waitForRealTaskCondition(() => false, 'never ready', 30),
      ).rejects.toThrow('never ready')
      expect(close).toHaveBeenCalledTimes(2)
      close.mockClear()
      const failure = new Error('predicate failed')
      await expect(
        waitForRealTaskCondition(() => {
          if (++checks === 5) throw failure
          return false
        }, 'broken predicate'),
      ).rejects.toBe(failure)
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      close.mockRestore()
      postMessage.mockRestore()
    }
  })
})

test.each([false, true])(
  'CSP diagnostics visibility with editor permission %s',
  async (privileged) => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const onRender = vi.fn()
    const host = await renderFrame(undefined, privileged, true, onRender)
    const frame = host.querySelector('iframe')!
    const report = (
      sourceFile: string | null,
      sample: string,
      blockedURI = 'eval',
      directive = 'script-src',
    ) => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: frame.contentWindow,
            data: {
              source: 'artifactshare',
              kind: 'csp-violation',
              directive,
              blockedURI,
              sourceFile,
              lineNumber: 1,
              sample,
              disposition: 'enforce',
            },
          }),
        )
      })
    }
    onRender.mockClear()
    for (let index = 0; index < 100; index++) {
      report(null, '<img src=x onerror=alert(1)>')
    }
    // Retain hidden reports for later permission changes, without rendering them.
    expect(onRender.mock.calls.length).toBeGreaterThan(0)
    expect(host.querySelector('aside') !== null).toBe(privileged)
    expect(host.textContent?.includes('browser environment')).toBe(privileged)
    expect(host.textContent?.includes('<img src=x onerror=alert(1)>')).toBe(
      privileged,
    )
    if (privileged) expect(host.textContent).not.toContain('Security blocked')
    for (const blockedURI of [
      'eval',
      'wasm-eval',
      'inline',
      '',
      'chrome-extension://abc/app.js',
      'moz-extension://abc/app.js',
      'safari-web-extension://abc/app.js',
      'webkit-masked-url://hidden/',
      'custom:script',
    ]) {
      report(null, 'unattributed-resource', blockedURI)
      expect(host.querySelector('aside') !== null).toBe(privileged)
      expect(host.textContent?.includes('unattributed-resource')).toBe(
        privileged,
      )
      expect(host.textContent).not.toContain('Security blocked')
    }
    report(`${window.location.origin}/index.html`, 'inline-positive-control')
    expect(host.textContent).toContain('Security blocked 1 resource')
    report('https://cdn.jsdelivr.net/app.js', 'cdn-positive-control')
    expect(host.textContent).toContain('Security blocked 2 resources')
    expect(host.textContent?.includes('<img src=x onerror=alert(1)>')).toBe(
      privileged,
    )
    report(null, 'parser-image', 'https://example.com/a.png', 'img-src')
    report('', 'parser-frame', 'http://example.com/frame.html', 'frame-src')
    expect(host.textContent).toContain('parser-image')
    expect(host.textContent).toContain('parser-frame')
    expect(host.textContent).toContain('Security blocked 4 resources')
    report(null, 'parser-data', 'data', 'img-src')
    report('', 'parser-blob', 'blob', 'frame-src')
    expect(host.textContent).toContain('parser-data')
    expect(host.textContent).toContain('parser-blob')
    expect(host.textContent).toContain('Security blocked 6 resources')
    report(
      null,
      'extension-resource',
      'chrome-extension://abc/a.png',
      'img-src',
    )
    expect(host.textContent).toContain('Security blocked 6 resources')
    expect(host.textContent?.includes('extension-resource')).toBe(privileged)
    expect(host.querySelector('aside img')).toBeNull()
    for (const summary of host.querySelectorAll('aside summary'))
      await act(async () => (summary as HTMLElement).click())
    expect(host.textContent).toContain('Sample: inline-positive-control')
    const nextUrl = `${window.location.origin}/next.html`
    expect(frame.src).not.toBe(nextUrl)
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: 'artifactshare',
            kind: 'link-clicked',
            href: nextUrl,
          },
        }),
      )
    })
    expect(frame.src).toBe(nextUrl)
    expect(host.querySelector('aside')).toBeNull()
  },
)

test('retains early CSP reports across load and settled diagnostics props with a bounded history', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  const host = await renderFrame(undefined, false, false, undefined, {
    renderType: null,
  })
  const frame = host.querySelector('iframe')!
  const report = (sourceFile: string | null, sample: string) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          source: 'artifactshare',
          kind: 'csp-violation',
          directive: 'script-src',
          blockedURI: 'eval',
          sourceFile,
          lineNumber: 1,
          sample,
        },
      }),
    )
  }
  await act(async () => {
    report('https://cdn.jsdelivr.net/app.js', 'early-cdn')
    for (let index = 0; index < 110; index++)
      report(null, `environment-${index}`)
  })
  expect(host.querySelector('aside')).toBeNull()
  await act(async () => {
    report(window.location.origin, 'early-inline')
    for (let index = 110; index < 220; index++)
      report(null, `environment-${index}`)
  })
  expect(host.textContent).toContain('Security blocked 1 resource')
  // Loading the document must not clear diagnostics emitted during parsing.
  await act(async () => frame.dispatchEvent(new Event('load')))
  const removed = vi.spyOn(window as Window, 'removeEventListener')
  try {
    await renderFrame(undefined, false, false, undefined, {
      host,
      renderType: 'html',
    })
    expect(host.querySelector('iframe')).toBe(frame)
    expect(host.textContent).toContain('Security blocked 2 resources')
    expect(host.textContent).toContain('early-cdn')
    expect(host.textContent).not.toContain('environment-')
    await renderFrame(undefined, true, false, undefined, {
      host,
      renderType: 'html',
    })
    expect(host.textContent).toContain('browser environment')
    expect(host.textContent).toContain('environment-219')
    expect(host.textContent).not.toContain('environment-0')
    expect(host.querySelectorAll('aside li')).toHaveLength(102)
    expect(
      removed.mock.calls.filter(([type]) => type === 'message'),
    ).toHaveLength(0)
    await renderFrame(undefined, false, false, undefined, {
      host,
      renderType: 'markdown',
    })
    expect(host.textContent).toContain('Security blocked 1 resource')
    expect(host.textContent).toContain('early-inline')
    expect(host.textContent).not.toContain('early-cdn')
    expect(host.textContent).not.toContain('browser environment')
  } finally {
    removed.mockRestore()
  }
})

test('accepts a parse-time report before passive effects run', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  const host = await renderFrame(undefined, false, false, (_id, phase) => {
    if (phase !== 'mount') return
    const frame = document.querySelector('iframe')!
    // Profiler runs during commit, before the passive message subscription.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          source: 'artifactshare',
          kind: 'csp-violation',
          directive: 'connect-src',
          blockedURI: 'https://example.com/blocked',
          sourceFile: window.location.origin,
          lineNumber: 1,
          sample: 'during-parse',
        },
      }),
    )
  })
  expect(host.textContent).toContain('Security blocked 1 resource')
  expect(host.textContent).toContain('during-parse')
})

test.each([false, true])(
  'SSR starts the document immediately and accepts diagnostics after hydration (owner %s)',
  async (privileged) => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    let serverFrame: HTMLIFrameElement | null = null
    let delivered = false
    const host = await renderFrame(
      undefined,
      privileged,
      false,
      () => {
        const frame = document.querySelector('iframe')!
        if (!frame.hasAttribute('src') || delivered) return
        delivered = true
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: frame.contentWindow,
            data: {
              source: 'artifactshare',
              kind: 'csp-violation',
              directive: 'script-src',
              blockedURI: 'eval',
              sourceFile: privileged ? null : window.location.origin,
              lineNumber: 1,
              sample: 'first-document-report',
            },
          }),
        )
      },
      {
        beforeHydrate: (serverHost) => {
          serverFrame = serverHost.querySelector('iframe')
          expect(serverFrame).not.toBeNull()
          expect(serverFrame!.getAttribute('src')).toBe(
            `${window.location.origin}/sandbox-frame-test?t=old`,
          )
          expect(serverHost.querySelector('aside')).toBeNull()
        },
      },
    )
    expect(host.querySelector('iframe')).toBe(serverFrame)
    expect(delivered).toBe(true)
    expect(host.textContent).toContain('first-document-report')
    expect(host.textContent?.includes('browser environment')).toBe(privileged)
    expect(host.textContent?.includes('Security blocked 1 resource')).toBe(
      !privileged,
    )
  },
)

test.each([false, true])(
  'Markdown retains artifact diagnostics through CDN environment noise (owner %s)',
  async (privileged) => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const host = await renderFrame(undefined, privileged, false, undefined, {
      renderType: 'markdown',
    })
    const frame = host.querySelector('iframe')!
    await act(async () => {
      for (let index = 0; index <= 200; index++) {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: frame.contentWindow,
            data: {
              source: 'artifactshare',
              kind: 'csp-violation',
              directive: 'script-src',
              blockedURI: 'eval',
              lineNumber: 1,
              sourceFile:
                index === 0
                  ? window.location.origin
                  : 'https://cdn.jsdelivr.net/app.js',
              sample: index === 0 ? 'inline-survives' : `cdn-noise-${index}`,
            },
          }),
        )
      }
    })
    expect(host.textContent).toContain('Security blocked 1 resource')
    expect(host.textContent).toContain('inline-survives')
    expect(host.textContent?.includes('cdn-noise-200')).toBe(privileged)
    expect(host.querySelectorAll('aside li')).toHaveLength(privileged ? 101 : 1)
  },
)

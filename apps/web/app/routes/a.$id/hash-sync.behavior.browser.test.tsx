import { act, type ComponentProps } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { server } from 'vitest/browser'
import { toast } from 'sonner'
import { VIOLATION_REPORTER_SCRIPT_BODY } from '~/lib/csp-reporter'
import {
  SandboxFrame,
  refreshSandboxFrameUrl,
} from './+components/sandbox-frame'
import { AnonymousViewerSignInControl } from './+components/anonymous-viewer-sign-in'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))
const originalUrl = window.location.href
const originalState = window.history.state
let root: Root | undefined
let blob: string | undefined
let messages: MessageEvent[] = []
const receive = (event: MessageEvent) => messages.push(event)
window.addEventListener('message', receive)

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  if (blob) URL.revokeObjectURL(blob)
  blob = undefined
  messages = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.history.replaceState(originalState, '', originalUrl)
})

function props(
  patch: Partial<ComponentProps<typeof SandboxFrame>> = {},
): ComponentProps<typeof SandboxFrame> {
  return {
    renderType: 'html',
    canViewEnvironmentDiagnostics: false,
    shareableId: 'abc123def4',
    versionId: 'v1',
    url: blob!,
    name: 'Hash fixture',
    mermaidEnabled: false,
    textAnchorsEnabled: false,
    linkNavigationMode: 'document',
    bundlePaths: [],
    fallbackToIndex: false,
    commentThreads: [],
    targetThreadId: null,
    highlightThreadId: null,
    followsAppTheme: false,
    onTextSelection: () => {},
    onTextSelectionClear: () => {},
    onThreadSelect: () => {},
    onOutsidePointerDown: () => {},
    sandboxPermissions:
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads',
    ...patch,
  }
}
function documentUrl() {
  blob = URL.createObjectURL(
    new Blob(
      [
        `<!doctype html><script>window.setInterval = () => 0</script><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script><script>parent.postMessage({kind:'first-script',hash:location.hash},'*')</script><h1>Fixture</h1>`,
      ],
      { type: 'text/html' },
    ),
  )
}
async function ready(host: HTMLElement) {
  await vi.waitFor(() =>
    expect(
      host
        .querySelector('[data-sandbox-state]')
        ?.getAttribute('data-sandbox-state'),
    ).toBe('ready'),
  )
  const frame = host.querySelector('iframe')!
  const token = messages.find(
    (event) =>
      event.source === frame.contentWindow && event.data?.kind === 'ready',
  )!.data.token as string
  await vi.waitFor(() =>
    expect(
      messages.some(
        (event) =>
          event.source === frame.contentWindow &&
          event.data?.kind === 'hash-changed' &&
          event.data.token === token,
      ),
    ).toBe(true),
  )
  return { frame, token }
}
async function report(
  frame: HTMLIFrameElement,
  token: string,
  patch: Record<string, unknown> = {},
  origin = window.location.origin,
  source: Window | null = frame.contentWindow,
) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source,
        data: {
          source: 'artifactshare',
          kind: 'hash-changed',
          token,
          hash: '#changed',
          path: '/index.html',
          ...patch,
        },
      }),
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)))
}

test.each(
  ['html', 'md', 'static_site'].flatMap((renderType) =>
    [false, true].flatMap((signedIn) =>
      ['', '#q=abc'].map((hash) => ({ renderType, signedIn, hash })),
    ),
  ),
)(
  'SSR $renderType (signed-in $signedIn, hash $hash) loads once before hydration',
  async ({ renderType, signedIn, hash }) => {
    window.history.replaceState(
      { preserved: true },
      '',
      window.location.pathname + window.location.search + hash,
    )
    const url = await server.commands.sandboxHashDocument(
      `<!doctype html><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script><script>parent.postMessage({kind:'first-script',hash:location.hash},'*')</script><h1>Fixture</h1>`,
      signedIn,
    )
    const frameProps = props({ renderType, url })
    const view = <SandboxFrame {...frameProps} />
    const markup = renderToString(view)
    expect(markup.match(/<iframe[^>]+>/)?.[0]).toContain('data-src=')
    expect(markup.match(/<iframe[^>]+>/)?.[0]).not.toMatch(/\ssrc=/)
    expect(markup).toContain('</iframe><script>')
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Contextual fragments execute their parser-created script on insertion.
    host.appendChild(document.createRange().createContextualFragment(markup))
    await vi.waitFor(() =>
      expect(
        messages.filter((e) => e.data?.kind === 'first-script'),
      ).toHaveLength(1),
    )
    expect(
      messages.find((e) => e.data?.kind === 'first-script')!.data.hash,
    ).toBe(hash)
    const frame = host.querySelector('iframe')!
    const src = frame.src
    await act(async () => {
      root = hydrateRoot(host, view)
    })
    await ready(host)
    await act(async () =>
      root!.render(<SandboxFrame {...frameProps} name="Renamed" />),
    )
    expect(host.querySelector('iframe')).toBe(frame)
    expect(frame.src).toBe(src)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      messages.filter((e) => e.data?.kind === 'first-script'),
    ).toHaveLength(1)
    expect(await server.commands.sandboxHashDocumentLoads()).toBe(1)
  },
)

test.each(['/a/abc123def4?comment=s1', '/?access-request=s1'])(
  'replaces the live URL and preserves history at %s',
  async (path) => {
    window.history.replaceState({ key: 'retained' }, '', path + '#initial')
    documentUrl()
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <>
          <SandboxFrame {...props()} />
          <AnonymousViewerSignInControl
            href="https://example.test/sign-in?next=%2Fa%2Fabc123def4"
            label="Sign in"
            shouldLoadAnalytics
          />
        </>,
      )
    })
    const { frame, token } = await ready(host)
    expect(frame.src.endsWith('#initial')).toBe(true)
    const length = window.history.length
    const replace = vi.spyOn(window.history, 'replaceState')
    await report(frame, token)
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(path + '#changed')
    expect(window.history.state).toEqual({ key: 'retained' })
    expect(window.history.length).toBe(length)
    expect(
      new URL(host.querySelector('a')!.href).searchParams.get('next'),
    ).toBe('/a/abc123def4?as_hash=%23changed')
    await report(frame, token)
    expect(replace).toHaveBeenCalledTimes(1)
    for (const patch of [
      { token: undefined },
      { token: 'b'.repeat(64) },
      { hash: 'invalid' },
      { hash: 42 },
      { hash: '#' + 'x'.repeat(2048) },
    ])
      await report(frame, token, patch)
    await report(frame, token, {}, 'https://example.com')
    await report(frame, token, {}, window.location.origin, window)
    expect(replace).toHaveBeenCalledTimes(1)
    await report(frame, token, { hash: '#' + 'x'.repeat(2047) })
    expect(window.location.hash.length).toBe(2048)
    await report(frame, token, { hash: '' })
    expect(window.location.hash).toBe('')
    expect(window.location.pathname + window.location.search).toBe(path)
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    await act(async () => frame.dispatchEvent(new Event('load')))
    await report(frame, token, { hash: '#stale' })
    expect(window.location.hash).toBe('')
  },
)

test.each(['/index.html', '/start.html'])(
  'static-site reports use the reported entrypoint, %s',
  async (entrypointPath) => {
    window.history.replaceState(null, '', '#entry')
    documentUrl()
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <SandboxFrame
          {...props({ renderType: 'static_site', entrypointPath })}
        />,
      )
    })
    const { frame, token } = await ready(host)
    await report(frame, token, { path: '/other.html' })
    expect(window.location.hash).toBe('#entry')
    await report(frame, token, { path: '/' })
    expect(window.location.hash).toBe(
      entrypointPath === '/index.html' ? '#changed' : '#entry',
    )
    await report(frame, token, { path: entrypointPath, hash: '#returned' })
    expect(window.location.hash).toBe('#returned')
  },
)

test.each(['network error', 'non-success response'])(
  'failed link refresh preserves the current document hash sync: %s',
  async (failure) => {
    window.history.replaceState(null, '', '#entry')
    documentUrl()
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <SandboxFrame
          {...props({
            renderType: 'static_site',
            linkNavigationMode: 'site',
            bundlePaths: ['/index.html', '/other.html'],
          })}
        />,
      )
    })
    const { frame, token } = await ready(host)
    const src = frame.src
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000)
    const fetch = vi.fn(async () => {
      if (failure === 'network error') throw new TypeError('Failed to fetch')
      return new Response('', { status: 503 })
    })
    vi.stubGlobal('fetch', fetch)
    vi.mocked(toast).mockClear()
    await report(frame, token, {
      kind: 'link-clicked',
      href: new URL('/other.html', window.location.origin).href,
    })
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(host.querySelector('iframe')).toBe(frame)
    expect(frame.src).toBe(src)
    expect(
      host
        .querySelector('[data-sandbox-state]')
        ?.getAttribute('data-sandbox-state'),
    ).toBe('ready')
    await report(frame, token, { hash: '#after-failed-refresh' })
    expect(window.location.hash).toBe('#after-failed-refresh')
  },
)

test.each(['html', 'md', 'static_site'])(
  'refresh reads the latest hash after awaiting the %s token',
  async (renderType) => {
    let resolve!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done
          }),
      ),
    )
    window.history.replaceState(null, '', '#old')
    const pending = refreshSandboxFrameUrl(
      'abc123def4',
      'v1',
      'https://example.test/index.html#old',
    )
    window.history.replaceState(null, '', '#latest')
    resolve(
      Response.json({
        sandboxUrl: 'https://example.test/index.html?t=new',
        renderType,
      }),
    )
    const url = new URL((await pending)!)
    expect(url.hash).toBe('#latest')
    expect(url.searchParams.get('t')).toBe('new')
    if (renderType === 'static_site')
      expect(url.searchParams.get('as_next')).toBe('/index.html#latest')
  },
)

test.each(['', '#subpage'])(
  'static-site refresh preserves a subpage destination fragment %s',
  async (hash) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          sandboxUrl: 'https://example.test/index.html?t=new',
          renderType: 'static_site',
        }),
      ),
    )
    window.history.replaceState(null, '', '#entry')
    const url = new URL(
      (await refreshSandboxFrameUrl(
        'abc123def4',
        'v1',
        'https://example.test/other.html?q=1' + hash,
      ))!,
    )
    expect(url.searchParams.get('as_next')).toBe('/other.html?q=1' + hash)
    expect(url.hash).toBe(hash)
  },
)

test.each(['html', 'md', 'static_site'])(
  'client mount, version switch, and retry each load %s once with the live hash',
  async (renderType) => {
    const url = await server.commands.sandboxHashDocument(
      `<!doctype html><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script><script>
        addEventListener('message', ({ data }) => {
          if (data?.kind === 'test-set-hash') {
            history.replaceState(null, '', data.hash)
            return
          }
          if (data?.kind !== 'test-hash-report') return
          parent.postMessage({
            source: 'artifactshare', kind: 'hash-changed',
            token: data.token, hash: data.hash, path: location.pathname,
          }, '*')
        })
      </script><h1>Fixture</h1>`,
      true,
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const frameProps = props({ renderType, url })
    window.history.replaceState(null, '', '#soft')
    await act(async () => {
      root = createRoot(host)
      root.render(<SandboxFrame key="v1" {...frameProps} />)
    })
    await ready(host)
    expect(host.querySelector('iframe')!.src).toBe(url + '#soft')
    const secondUrl = url.replace('synthetic-token', 'synthetic-next')
    window.history.replaceState(null, '', '#version')
    await act(async () =>
      root!.render(
        <SandboxFrame
          key="v2"
          {...frameProps}
          versionId="v2"
          url={secondUrl}
        />,
      ),
    )
    const { frame, token } = await ready(host)
    expect(frame.src).toBe(secondUrl + '#version')
    expect(await server.commands.sandboxHashDocumentLoads()).toBe(2)
    // Drive a failed liveness check into the manual retry state.
    await act(async () => {
      const loaded = new Promise<void>((resolve) =>
        frame.addEventListener('load', () => resolve(), { once: true }),
      )
      frame.srcdoc = '<!doctype html><title>Interrupted document</title>'
      await loaded
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/sandbox-token')
          ? Response.json({
              sandboxUrl: url.replace('synthetic-token', 'synthetic-retry'),
              renderType,
            })
          : new Response('', { status: 403 }),
      ),
    )
    await act(async () =>
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      ),
    )
    await vi.waitFor(
      () =>
        expect(
          host
            .querySelector('[data-sandbox-state]')
            ?.getAttribute('data-sandbox-state'),
        ).toBe('blocked'),
      { timeout: 6000 },
    )
    window.history.replaceState(null, '', '#retry')
    const button = host.querySelector('button')!
    await act(async () => button.click())
    const { frame: retryFrame, token: retryToken } = await ready(host)
    expect(retryFrame).not.toBe(frame)
    expect(retryFrame.src.endsWith('#retry')).toBe(true)
    expect(await server.commands.sandboxHashDocumentLoads()).toBe(3)
    expect(retryToken).not.toBe(token)
    // Let the browser supply the cross-origin WindowProxy: Firefox rejects it
    // as the source of a constructed MessageEvent.
    async function reportFromRetry(
      kind: 'test-hash-report' | 'test-set-hash',
      documentToken: string,
      hash: string,
    ) {
      await act(async () => {
        retryFrame.contentWindow!.postMessage(
          { kind, token: documentToken, hash },
          new URL(url).origin,
        )
        await vi.waitFor(() =>
          expect(
            messages.some(
              (event) =>
                event.source === retryFrame.contentWindow &&
                event.origin === new URL(url).origin &&
                event.data?.kind === 'hash-changed' &&
                event.data.token === documentToken &&
                event.data.hash === hash,
            ),
          ).toBe(true),
        )
      })
    }
    await reportFromRetry('test-hash-report', token, '#stale')
    expect(window.location.hash).toBe('#retry')
    // Change the actual document hash so repeated ready snapshots agree with
    // the positive control. Let the real reporter attach its current token.
    await reportFromRetry('test-set-hash', retryToken, '#accepted')
    await vi.waitFor(() => expect(window.location.hash).toBe('#accepted'))
  },
  15000,
)

test.each(['', '#new'])(
  'explicit entrypoint navigation preserves its destination fragment %s on refresh',
  async (hash) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          sandboxUrl: 'https://example.test/index.html?t=new',
          renderType: 'static_site',
        }),
      ),
    )
    window.history.replaceState(null, '', '#old')
    const url = new URL(
      (await refreshSandboxFrameUrl(
        'abc123def4',
        'v1',
        'https://example.test/index.html?q=1' + hash,
        { navigation: true },
      ))!,
    )
    expect(url.hash).toBe(hash)
    expect(url.searchParams.get('as_next')).toBe('/index.html?q=1' + hash)
  },
)

test('SSR sign-in return restores the fragment before the first document script', async () => {
  const url = await server.commands.sandboxHashDocument(
    `<!doctype html><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script><script>parent.postMessage({kind:'first-script',hash:location.hash},'*')</script>`,
    true,
  )
  const view = <SandboxFrame {...props({ url })} />
  const markup = renderToString(view)
  // Set the callback URL after serialization: only the parser bootstrap can restore it.
  window.history.replaceState(
    { retained: true },
    '',
    '/?version=v1&as_hash=%23q%3Dabc',
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.appendChild(document.createRange().createContextualFragment(markup))
  await vi.waitFor(() =>
    expect(
      messages.find((e) => e.data?.kind === 'first-script')?.data.hash,
    ).toBe('#q=abc'),
  )
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe('/?version=v1#q=abc')
  expect(window.history.state).toEqual({ retained: true })
  await act(async () => {
    root = hydrateRoot(host, view)
  })
  await ready(host)
  expect(await server.commands.sandboxHashDocumentLoads()).toBe(1)
})

test.each(['load', 'link'])(
  'accepted frame bursts flush on %s and later stale reports are rejected',
  async (transition) => {
    window.history.replaceState({ retained: true }, '', '#initial')
    documentUrl()
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(
        <SandboxFrame
          {...props({
            renderType: 'static_site',
            linkNavigationMode: 'site',
            bundlePaths: ['/next.html'],
          })}
        />,
      )
    })
    const { frame, token } = await ready(host)
    const replace = vi.spyOn(window.history, 'replaceState')
    const dispatch = (hash: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: 'artifactshare',
            kind: 'hash-changed',
            path: '/index.html',
            token,
            hash,
          },
        }),
      )
    await act(async () => {
      for (let i = 0; i < 250; i++) dispatch('#step=' + i)
    })
    expect(replace).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(window.location.hash).toBe('#step=249'))
    expect(replace).toHaveBeenCalledTimes(1)
    // Keep the old document from accepting another ready challenge. A listener
    // dies with that document; restoring a WindowProxy spy after navigation can
    // fail Firefox's cross-origin property checks.
    frame.contentWindow!.addEventListener(
      'message',
      (event) => event.stopImmediatePropagation(),
      { capture: true },
    )
    await act(async () => {
      dispatch('#accepted')
      if (transition === 'load') frame.dispatchEvent(new Event('load'))
      else
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: frame.contentWindow,
            data: {
              source: 'artifactshare',
              kind: 'link-clicked',
              href: window.location.origin + '/next.html',
            },
          }),
        )
      expect(window.location.hash).toBe('#accepted')
      dispatch('#stale')
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(window.location.hash).toBe('#accepted')
    expect(replace).toHaveBeenCalledTimes(2)
  },
)

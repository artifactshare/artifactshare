import { createElement } from 'react'
import { reloadViewerPage } from './reload-viewer-page'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  SANDBOX_FRAME_ALLOW,
  SandboxFrame,
  refreshSandboxFrameUrl,
  sandboxFrameSurfaceClassName,
} from './sandbox-frame'

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))

vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => false }))

describe('sandbox frame permissions', () => {
  const expectedAllow =
    'fullscreen; clipboard-write; language-model; summarizer; translator; language-detector'
  const expectedSandbox =
    'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'

  test('delegates exactly the supported permissions', () => {
    expect(SANDBOX_FRAME_ALLOW).toBe(expectedAllow)
  })

  test.each(['html', 'md', 'static_site'])(
    'keeps permissions identical in both %s frame branches',
    (renderType) => {
      const markup = renderToStaticMarkup(
        createElement(SandboxFrame, {
          renderType,
          canViewEnvironmentDiagnostics: false,
          shareableId: 'abc123def4',
          versionId: 'v1',
          url: 'https://example.test/index.html',
          name: 'Example artifact',
          mermaidEnabled: false,
          textAnchorsEnabled: false,
          linkNavigationMode: 'document',
          bundlePaths: [],
          fallbackToIndex: false,
          commentThreads: [],
          targetThreadId: null,
          highlightThreadId: null,
          followsAppTheme: renderType === 'md',
          sandboxPermissions: expectedSandbox,
          onTextSelection: vi.fn(),
          onTextSelectionClear: vi.fn(),
          onThreadSelect: vi.fn(),
          onOutsidePointerDown: vi.fn(),
        }),
      )
      const frames = markup.match(/<iframe\b[^>]*>/g) ?? []
      expect(frames).toHaveLength(2)
      expect(markup).toContain(`<noscript>${frames[1]}</iframe></noscript>`)
      for (const frame of frames) {
        expect(frame).toContain(`allow="${expectedAllow}"`)
        expect(frame).toContain(`sandbox="${expectedSandbox}"`)
        expect(frame).toContain('referrerPolicy="no-referrer"')
      }
    },
  )
  test.each(['html', 'md', 'static_site'])(
    'renders cutover unavailability without any %s execution frame',
    (renderType) => {
      const markup = renderToStaticMarkup(
        createElement(SandboxFrame, {
          renderType,
          canViewEnvironmentDiagnostics: false,
          shareableId: 'abc123def4',
          versionId: 'v1',
          url: 'https://a-abc123def4--v-7631.artifactshareusercontent.com/.well-known/artifactshare-delivery-unavailable',
          name: 'Example artifact',
          mermaidEnabled: false,
          textAnchorsEnabled: false,
          linkNavigationMode: 'document',
          bundlePaths: [],
          fallbackToIndex: false,
          commentThreads: [],
          targetThreadId: null,
          highlightThreadId: null,
          followsAppTheme: renderType === 'md',
          sandboxPermissions: expectedSandbox,
          onTextSelection: vi.fn(),
          onTextSelectionClear: vi.fn(),
          onThreadSelect: vi.fn(),
          onOutsidePointerDown: vi.fn(),
        }),
      )
      expect(markup).toContain('data-sandbox-state="delivery-unavailable"')
      expect(markup).toContain('role="heading"')
      expect(markup).toContain(
        'role="status" aria-live="polite">vw.deliveryUnavailable.title</span>',
      )
      expect(markup).toContain('vw.deliveryUnavailable.title')
      expect(markup).toContain('vw.deliveryUnavailable.body')
      expect(markup).toMatch(
        /<button[^>]*>vw\.deliveryUnavailable\.reload<\/button>/,
      )
      expect(markup).not.toContain('<iframe')
      expect(markup).not.toContain('<script')
    },
  )
})

describe('sandboxFrameSurfaceClassName', () => {
  test('keeps unstyled HTML on a readable light default', () => {
    const className = sandboxFrameSurfaceClassName(false)

    expect(className).toContain('bg-white')
    expect(className).toContain('[color-scheme:light]')
    expect(className).not.toContain('dark:[color-scheme:dark]')
  })

  test('lets rendered Markdown follow the app theme', () => {
    const className = sandboxFrameSurfaceClassName(true)

    expect(className).toContain('bg-background')
    expect(className).toContain('dark:[color-scheme:dark]')
    expect(className).toContain('[[data-theme=light]_&]:[color-scheme:light]')
  })
})

afterEach(() => vi.unstubAllGlobals())

test.each(['html', 'md', 'static_site'])(
  'refresh carries the live fragment after the %s token response',
  async (renderType) => {
    const location = { hash: '#old' }
    vi.stubGlobal('window', { location })
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
    const request = refreshSandboxFrameUrl(
      'abc123def4',
      'v1',
      'https://a-abc123def4--v-7631.artifactshareusercontent.com/index.html?q=1#old',
    )
    location.hash = '#current'
    resolve(
      Response.json({
        renderType,
        sandboxUrl:
          'https://a-abc123def4--v-7631.artifactshareusercontent.com/index.html?__as_token=new',
      }),
    )
    const url = new URL((await request)!)
    expect(url.hash).toBe('#current')
    expect(url.searchParams.get('__as_token')).toBe('new')
    if (renderType === 'static_site')
      expect(url.searchParams.get('as_next')).toBe('/index.html?q=1#current')
  },
)

test.each(['', '#subpage'])(
  'refresh leaves the static subpage destination fragment intact: %s',
  async (hash) => {
    vi.stubGlobal('window', { location: { hash: '#entrypoint' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          renderType: 'static_site',
          sandboxUrl:
            'https://a-abc123def4--v-7631.artifactshareusercontent.com/index.html?__as_token=new',
        }),
      ),
    )
    const url = new URL(
      (await refreshSandboxFrameUrl(
        'abc123def4',
        'v1',
        'https://a-abc123def4--v-7631.artifactshareusercontent.com/other.html?q=1' +
          hash,
      ))!,
    )
    expect(url.searchParams.get('as_next')).toBe('/other.html?q=1' + hash)
    expect(url.hash).toBe(hash)
  },
)

test.each(['a', 'l'])(
  'refresh accepts a new version for the same %s authority and removes consumed tokens',
  async (kind) => {
    vi.stubGlobal('window', {
      location: { hostname: 'artifactshare.com', hash: '#current' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          renderType: 'static_site',
          sandboxUrl: `https://${kind}-abc123def4--v-7632.artifactshareusercontent.com/?__as_token=fresh`,
        }),
      ),
    )
    const result = await refreshSandboxFrameUrl(
      'abc123def4',
      'v1',
      `https://${kind}-abc123def4--v-7631.artifactshareusercontent.com/index.html?q=a%20b&flag&__as_token=consumed&__as_cookie_check=1#old`,
    )
    const url = new URL(result!)
    expect(url.hostname).toBe(
      `${kind}-abc123def4--v-7632.artifactshareusercontent.com`,
    )
    expect(url.searchParams.get('__as_token')).toBe('fresh')
    expect(url.searchParams.get('as_next')).toBe(
      '/index.html?q=a%20b&flag#current',
    )
  },
)

test.each([
  'https://a-abc123def4--v-7632.artifactshareusercontent.com/',
  'https://l-abc123def5--v-7632.artifactshareusercontent.com/',
  'https://l-abc123def4--v-7.artifactshareusercontent.com/',
  'https://abc123def4--v-7632.artifactshare.link/',
  'https://abc123def4--v-7632.sandbox.artifactshare.com/',
  'https://l-abc123def4--v-7632.usercontent.localhost:5174/',
  'http://l-abc123def4--v-7632.artifactshareusercontent.com/',
  'https://l-abc123def4--v-7632.artifactshareusercontent.com:444/',
])(
  'refresh rejects an unrelated or invalid renewal: %s',
  async (sandboxUrl) => {
    vi.stubGlobal('window', {
      location: { hostname: 'artifactshare.com', hash: '' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ renderType: 'static_site', sandboxUrl }),
      ),
    )
    expect(
      await refreshSandboxFrameUrl(
        'abc123def4',
        'v1',
        'https://l-abc123def4--v-7631.artifactshareusercontent.com/',
      ),
    ).toBeNull()
  },
)

test.each(['a', 'l'])(
  'two consecutive %s static-site renewals retain the in-artifact location',
  async (kind) => {
    vi.stubGlobal('window', { location: { hash: '#viewer' } })
    const origin = `https://${kind}-abc123def4--v-7631.artifactshareusercontent.com`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          renderType: 'static_site',
          sandboxUrl: `${origin}/index.html?__as_token=fresh`,
        }),
      ),
    )
    const first = await refreshSandboxFrameUrl(
      'abc123def4',
      'v1',
      `${origin}/sub?q=a%20b&flag&__as_token=old&__as_cookie_check=1#section`,
    )
    const second = await refreshSandboxFrameUrl('abc123def4', 'v1', first!)
    for (const renewed of [first, second]) {
      const url = new URL(renewed!)
      expect(url.searchParams.get('as_next')).toBe('/sub?q=a%20b&flag#section')
      expect(url.hash).toBe('#section')
    }
  },
)

test('reloads the public viewer page without navigating the execution frame', () => {
  const reload = vi.fn()
  vi.stubGlobal('window', { location: { reload } })
  reloadViewerPage()
  expect(reload).toHaveBeenCalledOnce()
  expect(reload).toHaveBeenCalledWith()
})

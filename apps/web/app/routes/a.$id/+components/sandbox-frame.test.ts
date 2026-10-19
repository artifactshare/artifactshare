import { createElement } from 'react'
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
      'https://example.test/index.html?q=1#old',
    )
    location.hash = '#current'
    resolve(
      Response.json({
        renderType,
        sandboxUrl: 'https://example.test/index.html?t=new',
      }),
    )
    const url = new URL((await request)!)
    expect(url.hash).toBe('#current')
    expect(url.searchParams.get('t')).toBe('new')
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
          sandboxUrl: 'https://example.test/index.html?t=new',
        }),
      ),
    )
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

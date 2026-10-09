import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  refreshSandboxFrameUrl,
  sandboxFrameSurfaceClassName,
} from './sandbox-frame'

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

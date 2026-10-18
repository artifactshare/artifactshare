// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true}}
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as mermaidExport from '~/lib/mermaid-export.client'
import { isolatedPrintHtml } from './export-print-frame'
import { inertExportDocument, sanitizeExportDocument } from './export-resources'
import { canonicalExportPath, exportAssetHref } from '~/lib/export-path'
import {
  prepareExportDocument,
  parseExportSrcset,
  rewriteExportCss,
  printMediaQuery,
} from './export-resources'
import { resolveExportHtml, type ExportSourceData } from './export-actions'

const data = (source: string): ExportSourceData => ({
  kind: 'html',
  artifactKind: 'static_site',
  source,
  path: '/guide/report.html',
  versionId: 'version-1',
  fileName: 'report.html',
})
const cssText = (uri: string) => atob(uri.slice(uri.indexOf(',') + 1))
// These tests exercise acquisition and rewriting. Image/font decoding and the
// network/DOM boundary are exercised with real bytes in all browser projects.
beforeEach(() => {
  vi.stubEnv('SSR', false)
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(
    80,
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

test.each(['', '   ', '#', ' #placeholder '])(
  'normalizes inert HTML image placeholder %j without changing selected resources',
  (source) => {
    const doc = inertExportDocument(
      `<picture><source srcset="selected.png 2x"><img src="${source}" alt="Placeholder" width="80" srcset="fallback.png 1x"></picture><img src="real.png#fragment">`,
    )
    sanitizeExportDocument(doc)
    const placeholder = doc.querySelector('img')!
    expect(placeholder.hasAttribute('src')).toBe(false)
    expect(placeholder.getAttribute('alt')).toBe('Placeholder')
    expect(placeholder.getAttribute('width')).toBe('80')
    expect(placeholder.getAttribute('srcset')).toBe('fallback.png 1x')
    expect(doc.querySelector('source')!.getAttribute('srcset')).toBe(
      'selected.png 2x',
    )
    expect(doc.querySelectorAll('img')[1]!.getAttribute('src')).toBe(
      'real.png#fragment',
    )
  },
)

test.each(['img', 'picture'])(
  'normalizes %s srcset without changing real candidates',
  (kind) => {
    const candidates = '# 1x, data:image/png;base64,YQ== 2x, photo.png#crop 3x'
    const doc = inertExportDocument(
      kind === 'img'
        ? `<img srcset="${candidates}">`
        : `<picture><source srcset="${candidates}"><img src="fallback.png"></picture>`,
    )
    sanitizeExportDocument(doc)
    expect(doc.querySelector('[srcset]')!.getAttribute('srcset')).toBe(
      'data:image/png;base64,YQ== 2x, photo.png#crop 3x',
    )
  },
)

test('image placeholder policy leaves non-image source elements alone', () => {
  const doc = inertExportDocument('<video><source srcset="# 1x"></video>')
  sanitizeExportDocument(doc)
  expect(doc.querySelector('source')!.getAttribute('srcset')).toBe('# 1x')
})

test.each(
  ['1q', '0w', '00w', '0.5w', '1.5w', '1.0w'].flatMap((descriptor) => [
    `<img srcset="# ${descriptor}">`,
    `<picture><source srcset="# ${descriptor}"></picture>`,
  ]),
)('rejects malformed placeholder descriptors: %s', (html) => {
  expect(() => sanitizeExportDocument(inertExportDocument(html))).toThrow(
    'Invalid srcset',
  )
})

test.each([
  '1w',
  '900w',
  '01w',
  '0x',
  '1.5x',
  '.5x',
  '1e0x',
  '1E+0x',
  '1e-1x',
  '-0x',
])('preserves valid srcset descriptor %s', (descriptor) => {
  expect(parseExportSrcset(`photo.png ${descriptor}`)).toEqual([
    { url: 'photo.png', descriptor },
  ])
})

test.each([
  '+1x',
  '1.x',
  '-1x',
  'NaNx',
  'Infinityx',
  '1e309x',
  '1e+x',
  '1xjunk',
])('rejects invalid density descriptor %s', (descriptor) => {
  expect(() => parseExportSrcset(`photo.png ${descriptor}`)).toThrow(
    'Invalid srcset',
  )
})

test.each(['.5x', '1e0x', '1E+0x', '1e-1x', '-0x'])(
  'HTML download acquires and preserves valid density %s',
  async (descriptor) => {
    const input = data(
      `<picture><source srcset="../image.png#crop ${descriptor}"><img srcset="../image.png ${descriptor}"></picture>`,
    )
    const fetch = vi.fn(async (url: string) =>
      String(url).includes('export-source')
        ? Response.json(input)
        : new Response('image', { headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetch)
    const html = await resolveExportHtml('artifact-1', input)
    expect(html).toContain(`data:image/png;base64,aW1hZ2U=#crop ${descriptor}`)
    expect(html).toContain(`data:image/png;base64,aW1hZ2U= ${descriptor}`)
    expect(
      fetch.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes('export-asset')),
    ).toEqual([
      `${window.location.origin}/api/shareables/artifact-1/export-asset/image.png?versionId=version-1`,
    ])
  },
)

test.each(['0w', '1.5w', '1.0w', '+1x', '1.x', '-1x', 'NaNx', '1e309x'])(
  'HTML download rejects malformed descriptor %s',
  async (descriptor) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      resolveExportHtml(
        'artifact-1',
        data(`<img srcset="image.png ${descriptor}">`),
      ),
    ).rejects.toThrow('Invalid srcset')
    expect(fetch).not.toHaveBeenCalled()
  },
)

test.each([
  '/../escape',
  '/%2e%2e/escape',
  '/safe/%2fescape',
  '/safe/%5cescape',
  '/safe/%252e%252e/escape',
  '//example.com/path',
  '/bad%ZZ',
])('rejects ambiguous or escaping path %s', (path) => {
  expect(() => canonicalExportPath(path)).toThrow()
})

test('normalizes relative dot segments and keeps source suffixes outside endpoint construction', () => {
  expect(
    canonicalExportPath('../images/a%20b.png?v=1#mark', '/guide/report.html'),
  ).toBe('/images/a b.png')
  const url = new URL(
    exportAssetHref(
      'artifact-1',
      'version-1',
      '/images/a.png?versionId=other#mark',
      'https://artifactshare.test',
    ),
  )
  expect(url.pathname).toBe(
    '/api/shareables/artifact-1/export-asset/images/a.png',
  )
  expect(url.search).toBe('?versionId=version-1')
})

test('recursively embeds linked CSS, imports, relative font and root image using the exact snapshot', async () => {
  const calls: string[] = []
  const files: Record<string, [string, string]> = {
    '/styles/main.css': [
      'text/css',
      '@import "nested/theme.css" layer(theme) screen;',
    ],
    '/styles/nested/theme.css': [
      'text/css',
      '@font-face{src:url("../../fonts/font.woff2?v=1")} h1{background:url("/images/mark.png#mark")} @page { size:A0 }',
    ],
    '/fonts/font.woff2': ['font/woff2', 'font-bytes'],
    '/images/mark.png': ['image/png', 'image-bytes'],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input)
      calls.push(url.href)
      expect(url.searchParams.get('versionId')).toBe('version-1')
      expect(init.cache).toBe('no-store')
      expect(init.redirect).toBe('error')
      const file = files[url.pathname.split('/export-asset')[1]]
      return new Response(file?.[1] ?? '', {
        status: file ? 200 : 404,
        headers: { 'content-type': file?.[0] ?? 'text/plain' },
      })
    }),
  )
  const prepared = await prepareExportDocument(
    'artifact-1',
    data('<link rel="stylesheet" href="../styles/main.css"><h1>Page</h1>'),
    AbortSignal.timeout(1000),
  )
  const main = cssText(prepared.querySelector('link')!.getAttribute('href')!)
  expect(main).toContain('layer(theme) screen')
  const nested = cssText(/"(data:[^"]+)"/.exec(main)![1])
  expect(nested).toContain('data:font/woff2;base64,')
  expect(nested).toContain('data:image/png;base64,')
  expect(nested).toContain('#mark')
  expect(nested).toContain('@page') // Download HTML retains source paper rules.
  expect(calls).toHaveLength(4)
})

test('HTML download shares snapshot-bound embedding rather than leaving credentialed URLs', async () => {
  const fetch = vi.fn(async (input: string, _init?: RequestInit) =>
    String(input).includes('export-source')
      ? Response.json(data('<img src="../image.png">'))
      : new Response('image', { headers: { 'content-type': 'image/png' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const html = await resolveExportHtml(
    'artifact-1',
    data('<img src="../image.png">'),
  )
  expect(html).toContain('data:image/png;base64,')
  expect(fetch.mock.calls[0][0]).toContain('versionId=version-1')
})

test('asset failure and aborted preparation reject rather than returning incomplete HTML', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  )
  await expect(
    prepareExportDocument(
      'artifact-1',
      data('<img src="missing.png">'),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('unavailable')
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  const pending = prepareExportDocument(
    'artifact-1',
    data('<img src="stalled.png">'),
    controller.signal,
  )
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
})

test('simultaneously referenced cyclic stylesheets fail without a promise deadlock', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (input: string) =>
        new Response(
          input.includes('/a.css') ? '@import "b.css";' : '@import "a.css";',
          { headers: { 'content-type': 'text/css' } },
        ),
    ),
  )
  await expect(
    prepareExportDocument(
      'artifact-1',
      data(
        '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">',
      ),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow(/Cyclic/)
})

test('external embedding uses anonymous CORS with no redirects and rejects app-origin URLs', async () => {
  const fetch = vi.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response('image', { headers: { 'content-type': 'image/png' } }),
  )
  vi.stubGlobal('fetch', fetch)
  await prepareExportDocument(
    'artifact-1',
    data('<img src="https://example.com/image.png">'),
    AbortSignal.timeout(1000),
  )
  expect(fetch).toHaveBeenCalledWith(
    'https://example.com/image.png',
    expect.objectContaining({
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    }),
  )
  fetch.mockClear()
  await expect(
    prepareExportDocument(
      'artifact-1',
      data(`<img src="${window.location.origin}/api/mutation">`),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Unsafe')
  expect(fetch).not.toHaveBeenCalled()
})

test('srcset preserves data URI commas and CSS rewrites escaped URLs, imports and image-set strings', async () => {
  expect(
    parseExportSrcset('data:image/png;base64,abc 1x, image.png 2x'),
  ).toEqual([
    { url: 'data:image/png;base64,abc', descriptor: '1x' },
    { url: 'image.png', descriptor: '2x' },
  ])
  const resolve = vi.fn(async (ref: string) => `data:image/png,${ref}`)
  const css = await rewriteExportCss(
    '@import url("theme.css") supports(display:grid);a{background:u\\72l("a.png");background-image:image-set("b.png" 2x)}',
    resolve,
  )
  expect(resolve).toHaveBeenCalledWith('theme.css', true)
  expect(resolve).toHaveBeenCalledWith('a.png', false)
  expect(resolve).toHaveBeenCalledWith('b.png', false)
  expect(css).toContain('supports(display:grid)')
})

test('HTML root and body attributes survive inert parsing without connecting source nodes', async () => {
  const prepared = await prepareExportDocument(
    'artifact-1',
    data(
      '<!doctype html><html lang="ja" class="report"><head></head><body data-artifact-markdown><h1>Report</h1></body></html>',
    ),
    AbortSignal.timeout(1000),
  )
  expect(prepared.documentElement.lang).toBe('ja')
  expect(prepared.documentElement.className).toBe('report')
  expect(prepared.body.hasAttribute('data-artifact-markdown')).toBe(true)
  expect(prepared.documentElement.isConnected).toBe(false)
})

test('duplicate acquisitions are shared, while the resource count and deadline remain bounded', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('image', { headers: { 'content-type': 'image/png' } }),
  )
  vi.stubGlobal('fetch', fetch)
  await prepareExportDocument(
    'artifact-1',
    data('<img src="a.png"><img src="a.png">'),
    AbortSignal.timeout(1000),
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(
    prepareExportDocument(
      'artifact-1',
      data(
        Array.from(
          { length: 129 },
          (_, index) => `<img src="${index}.png">`,
        ).join(''),
      ),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Too many')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  await expect(
    prepareExportDocument(
      'artifact-1',
      data('<img src="stalled.png">'),
      AbortSignal.timeout(20),
    ),
  ).rejects.toThrow('timed out')
})

test('dot artifact identifiers cannot normalize out of the fixed export endpoint', () => {
  expect(() =>
    exportAssetHref(
      '..',
      'version-1',
      '/image.png',
      'https://artifactshare.test',
    ),
  ).toThrow()
})

test('PDF embeds bundled Japanese fonts without runtime acquisition', async () => {
  const fetcher = vi.fn(() => Promise.reject(new Error('Unexpected request')))
  vi.stubGlobal('fetch', fetcher)
  const doc = await prepareExportDocument(
    'artifact-1',
    data('<h1>日本語の印刷</h1>'),
    new AbortController().signal,
    true,
  )
  const style = doc.head.querySelector('style')!.textContent!
  expect(style).toContain('ArtifactSharePrintJP')
  expect(style).toContain('SIL OPEN FONT LICENSE')
  expect(style.match(/data:font\/woff2;base64,/g)).toHaveLength(4)
  expect(style).not.toContain('fonts.gstatic.com')
  expect(fetcher).not.toHaveBeenCalled()
})

test('print preview evaluates media types before measuring without changing feature queries, import paths or download CSS', async () => {
  const css =
    '@import url("print.css") layer(screen) supports(display:grid) print; @media screen, print and (min-width:800px) { .print { color:red } } @media not print {p{display:none}} @media not screen {p{display:block}}'
  const resolve = vi.fn(async (ref: string) => ref)
  const rewritten = await rewriteExportCss(css, resolve)
  expect(rewritten).toContain('layer(screen) supports(display:grid) all;')
  expect(rewritten).toContain(
    '@media artifactshare-screen, all and (min-width:800px)',
  )
  expect(rewritten).toContain('@media not all')
  expect(rewritten).toContain('@media not artifactshare-screen')
  expect(resolve).toHaveBeenCalledWith('print.css', true)
  expect(await rewriteExportCss(css, resolve, false)).toBe(css)
  expect(
    printMediaQuery('only print and (orientation:portrait), not screen'),
  ).toBe('only all and (orientation:portrait), not artifactshare-screen')
  const doc = await prepareExportDocument(
    'artifact-1',
    data('<style media="print">p{color:red}</style><p>Print</p>'),
    new AbortController().signal,
    true,
  )
  expect(doc.querySelector('style[media]')!.getAttribute('media')).toBe('all')
})

test('ordinary Viewer imports and HTML downloads do not load PDF fonts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data('<p>HTML download</p>'))),
  )
  const load = vi.fn(() => ({
    PRINT_FONT_STYLE: 'font fixture',
    PRINT_FONT_FAMILY: 'ArtifactSharePrintJP',
  }))
  vi.resetModules()
  vi.doMock('~/lib/export-print-font', load)
  try {
    const actions = await import('./export-actions')
    expect(load).not.toHaveBeenCalled()
    await actions.resolveExportHtml('artifact-1', data('<p>HTML download</p>'))
    expect(load).not.toHaveBeenCalled()
    const resources = await import('./export-resources')
    await expect(resources.loadPrintFont()).resolves.toMatchObject({
      PRINT_FONT_STYLE: 'font fixture',
    })
    expect(load).toHaveBeenCalledOnce()
    vi.stubEnv('SSR', true)
    await expect(resources.loadPrintFont()).rejects.toThrow(
      'PDF fonts require a browser',
    )
  } finally {
    vi.doUnmock('~/lib/export-print-font')
    vi.resetModules()
  }
})

test('print viewport lengths use a fixed basis without changing strings, URLs, queries or HTML downloads', async () => {
  const css =
    '@media (min-height:100vh) {.hero:hover{height:100vh;min-height:calc(100dvh + 20px);padding:1.5svh;gap:.5lvh;max-width:50vmax;width:50vmin;--spacing:1e1vh;content:"100vh";background:url(100vh)}}'
  const resolve = vi.fn(async (ref: string) => ref)
  const printCss = await rewriteExportCss(css, resolve)
  expect(printCss).toContain('@media (min-height:100vh)')
  expect(printCss).toContain(
    '.hero:hover{height:760px;min-height:calc(760px + 20px);padding:11.4px;gap:3.8px;max-width:450px;width:380px;--spacing:76px;content:"100vh";background:url("100vh")}',
  )
  expect(resolve).toHaveBeenCalledWith('100vh', false)
  expect(await rewriteExportCss('height:100v\\68', resolve)).toBe(
    'height:760px',
  )
  expect(await rewriteExportCss('height:100vh;gap:.5dvh', resolve, false)).toBe(
    'height:100vh;gap:.5dvh',
  )
})

test('picture source media is adapted for print while ordinary HTML preserves media selection', async () => {
  const html =
    '<picture><source media="screen"><source media="print and (min-width:800px)"><img></picture>'
  const printed = await prepareExportDocument(
    'artifact-1',
    data(html),
    new AbortController().signal,
    true,
  )
  expect(
    Array.from(printed.querySelectorAll('source'), (source) =>
      source.getAttribute('media'),
    ),
  ).toEqual(['artifactshare-screen', 'all and (min-width:800px)'])
  const downloaded = await prepareExportDocument(
    'artifact-1',
    data(html),
    new AbortController().signal,
  )
  expect(
    Array.from(downloaded.querySelectorAll('source'), (source) =>
      source.getAttribute('media'),
    ),
  ).toEqual(['screen', 'print and (min-width:800px)'])
})

test('serializes the helper nonce matching the frame policy', () => {
  const html = isolatedPrintHtml(
    inertExportDocument('<p>Report</p>'),
    'channel',
  )
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)![1]
  expect(html).toContain(`<script nonce="${nonce}">`)
  expect(html).toMatch(/kind:\s*['"]ready['"]/)
})

test('freezes logical viewport lengths without assuming horizontal writing', async () => {
  const css = await rewriteExportCss(
    '.hero{height:100vb;width:50dvi;padding:2svb;gap:1lvi}',
    async (url) => url,
  )
  expect(css).toContain('height:calc(100 * var(--artifactshare-print-vb))')
  expect(css).toContain('width:calc(50 * var(--artifactshare-print-vi))')
  expect(css).toContain('padding:calc(2 * var(--artifactshare-print-vb))')
  expect(css).toContain('gap:calc(1 * var(--artifactshare-print-vi))')
})

test('embeds logical viewport defaults in print content only', async () => {
  const snapshot = data('<div style="height:100vb;width:50vi">Report</div>')
  const printed = await prepareExportDocument(
    'artifact-1',
    snapshot,
    new AbortController().signal,
    true,
  )
  expect(
    printed.head.textContent?.includes('--artifactshare-print-vb: 7.6px'),
  ).toBe(true)
  expect(
    printed.head.textContent?.includes('--artifactshare-print-vi: 9px'),
  ).toBe(true)
  const downloaded = await prepareExportDocument(
    'artifact-1',
    snapshot,
    new AbortController().signal,
  )
  expect(downloaded.head.textContent).not.toContain('--artifactshare-print-vb:')
  expect(downloaded.head.textContent).not.toContain('--artifactshare-print-vi:')
})

test.each([128, 129])(
  'Mermaid prepared images use the original %i resource count',
  async (size) => {
    vi.spyOn(mermaidExport, 'renderExportMermaidSvg').mockImplementation(
      async (_source, _signal, acquire) => {
        const images = await Promise.all(
          Array.from(
            { length: size },
            async (_, index) =>
              `<image href="${await acquire!(`${index}.png`).catch(
                (error: Error) => {
                  error.name = 'MermaidResourceError'
                  throw error
                },
              )}"/>`,
          ),
        )
        return `<svg xmlns="http://www.w3.org/2000/svg">${images.join('')}</svg>`
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(url, { headers: { 'content-type': 'image/png' } }),
      ),
    )
    const result = prepareExportDocument(
      'artifact-1',
      {
        ...data(''),
        kind: 'markdown',
        renderedHtml:
          '<body data-artifact-markdown><pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      },
      AbortSignal.timeout(5000),
    )
    if (size === 128)
      expect((await result).querySelectorAll('image')).toHaveLength(size)
    else await expect(result).rejects.toThrow('Too many')
  },
)

test.each([2, 3])(
  'prepared image bytes are charged once and still bounded (%i images)',
  async (size) => {
    // Model large encoded images at the accounting boundary without allocating
    // tens of megabytes or making DOM parsing the subject of this regression.
    const encode = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(
      function (this: TextEncoder, input) {
        const bytes = encode.call(this, input)
        if (input?.startsWith('data:image/png;'))
          Object.defineProperty(bytes, 'byteLength', {
            value: 24 * 1024 * 1024,
          })
        return bytes
      },
    )
    vi.spyOn(mermaidExport, 'renderExportMermaidSvg').mockImplementation(
      async (_source, _signal, acquire) => {
        const images = await Promise.all(
          Array.from(
            { length: size },
            async (_, index) =>
              `<image href="${await acquire!(`${index}.png`).catch(
                (error: Error) => {
                  error.name = 'MermaidResourceError'
                  throw error
                },
              )}"/>`,
          ),
        )
        return `<svg xmlns="http://www.w3.org/2000/svg">${images.join('')}</svg>`
      },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(url, { headers: { 'content-type': 'image/png' } }),
      ),
    )
    const result = prepareExportDocument(
      'artifact-1',
      {
        ...data(''),
        kind: 'markdown',
        renderedHtml:
          '<body data-artifact-markdown><pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      },
      AbortSignal.timeout(5000),
    )
    if (size === 2)
      expect((await result).querySelectorAll('image')).toHaveLength(2)
    else await expect(result).rejects.toThrow('embedded resource budget')
  },
)

test.each([127, 128])(
  'counts %i literal images matching renderer output',
  async (copies) => {
    const uri = 'data:image/png;base64,cG5n'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('png', { headers: { 'content-type': 'image/png' } }),
      ),
    )
    vi.spyOn(mermaidExport, 'renderExportMermaidSvg').mockImplementation(
      async (_source, _signal, acquire) =>
        `<svg xmlns="http://www.w3.org/2000/svg"><image href="${await acquire!('image.png')}"/></svg>`,
    )
    const result = prepareExportDocument(
      'artifact-1',
      {
        ...data(''),
        kind: 'markdown',
        renderedHtml:
          '<body data-artifact-markdown>' +
          `<img src="${uri}">`.repeat(copies) +
          '<pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      },
      AbortSignal.timeout(5000),
    )
    if (copies === 127)
      expect((await result).querySelectorAll('img, image')).toHaveLength(128)
    else await expect(result).rejects.toThrow('Too many export assets')
  },
)

test.each(['dropped', 'invalid-svg', 'render-failure', 'extra-reference'])(
  'unused credits cannot subsidize literal images after %s',
  async (outcome) => {
    const uri = 'data:image/png;base64,cG5n'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('png', { headers: { 'content-type': 'image/png' } }),
      ),
    )
    vi.spyOn(mermaidExport, 'renderExportMermaidSvg').mockImplementation(
      async (_source, _signal, acquire) => {
        await acquire!('image.png')
        if (outcome === 'render-failure') throw new Error('Invalid diagram')
        if (outcome === 'invalid-svg') return '<not-svg/>'
        return `<svg xmlns="http://www.w3.org/2000/svg">${
          outcome === 'extra-reference'
            ? `<image href="${uri}"/><image href="${uri}"/>`
            : ''
        }</svg>`
      },
    )
    const prepare = (copies: number) =>
      prepareExportDocument(
        'artifact-1',
        {
          ...data(''),
          kind: 'markdown',
          renderedHtml:
            '<body data-artifact-markdown>' +
            `<img class="mermaid-diagram" src="${uri}">`.repeat(copies) +
            '<pre><code class="language-mermaid">flowchart LR</code></pre></body>',
        },
        AbortSignal.timeout(5000),
      )
    const valid = await prepare(outcome === 'extra-reference' ? 126 : 127)
    expect(valid.querySelectorAll('img')).toHaveLength(
      outcome === 'extra-reference' ? 126 : 127,
    )
    if (outcome === 'render-failure' || outcome === 'invalid-svg')
      expect(
        valid.querySelector('pre')?.classList.contains('mermaid-error'),
      ).toBe(true)
    await expect(
      prepare(outcome === 'extra-reference' ? 127 : 128),
    ).rejects.toThrow('Too many export assets')
  },
)

test.each([
  'https://user@example.com/image.png',
  'https://:pass@example.com/image.png',
])(
  'rejects credential URL before invoking even a permissive fetch: %s',
  async (url) => {
    const fetch = vi.fn(
      async () =>
        new Response('png', { headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(
      prepareExportDocument(
        'artifact-1',
        data(`<img src="${url}">`),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow('Unsafe external asset')
    expect(fetch).not.toHaveBeenCalled()
    await prepareExportDocument(
      'artifact-1',
      data('<img src="https://example.com/image.png">'),
      AbortSignal.timeout(1000),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  },
)

test.each([6, 10])(
  'counts literal copies alongside %i prepared Mermaid image references',
  async (diagrams) => {
    const uri = 'data:image/png;base64,cG5n'
    const html =
      '<body data-artifact-markdown>' +
      `<img src="${uri}">`.repeat(4) +
      '<pre><code class="language-mermaid">flowchart LR</code></pre>'.repeat(
        diagrams,
      ) +
      '</body>'
    const mib = 1024 * 1024
    const encode = TextEncoder.prototype.encode
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(
      function (this: TextEncoder, input) {
        const bytes = encode.call(this, input)
        // Four literal 6 MiB URIs plus markup fit below 25 MiB. Each renderer
        // returns one 6 MiB URI, below its independent 8 MiB SVG limit.
        if (input === html)
          Object.defineProperty(bytes, 'length', { value: 25 * mib })
        if (input === uri)
          Object.defineProperty(bytes, 'byteLength', { value: 6 * mib })
        return bytes
      },
    )
    const fetchMock = vi.fn(async () => {
      const chunk = new TextEncoder().encode('png')
      // The cached base64 image models 4.5 MiB of acquired bytes; source plus
      // acquisition is 29.5 MiB, independently below the 32 MiB limit.
      Object.defineProperty(chunk, 'byteLength', { value: 4.5 * mib })
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk)
            controller.close()
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(mermaidExport, 'renderExportMermaidSvg').mockImplementation(
      async (_source, _signal, acquire) =>
        `<svg xmlns="http://www.w3.org/2000/svg"><image href="${await acquire!('image.png')}"/></svg>`,
    )
    const result = prepareExportDocument(
      'artifact-1',
      {
        ...data(''),
        kind: 'markdown',
        renderedHtml: html,
      },
      AbortSignal.timeout(5000),
    )
    if (diagrams === 6) {
      const doc = await result
      expect(doc.querySelectorAll('img, image')).toHaveLength(10)
      expect(
        Array.from(doc.querySelectorAll('image'), (el) =>
          el.getAttribute('href'),
        ),
      ).toEqual(Array(6).fill(uri))
    } else await expect(result).rejects.toThrow('embedded resource budget')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

test('new nested data images retain sanitization and resource budgets', async () => {
  const nested =
    'data:text/css,' +
    encodeURIComponent('body { background: url("data:text/html,unsafe") }')
  await expect(
    prepareExportDocument(
      'artifact-1',
      data(`<link rel="stylesheet" href="${nested}">`),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Unsafe inline asset')
  await expect(
    prepareExportDocument(
      'artifact-1',
      data(
        Array.from(
          { length: 129 },
          (_, i) => `<img src="data:image/png;base64,${btoa(String(i))}">`,
        ).join(''),
      ),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Too many')
})

test.each([false, true])(
  'stylesheet rel tokens preserve stylesheets without acquiring non-stylesheet links (print=%s)',
  async (forPrint) => {
    const fetcher = vi.fn(
      async (_url: string) =>
        new Response('h1{color:red}', {
          headers: { 'content-type': 'text/css' },
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const doc = await prepareExportDocument(
      'artifact-1',
      data(
        '<link rel=" stylesheet \t" href="/main.css"><link rel="preload" href="/ignored.css">',
      ),
      AbortSignal.timeout(5000),
      forPrint,
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      '/export-asset/main.css?versionId=version-1',
    )
    expect(
      cssText(
        doc.querySelector('link[rel*="stylesheet"]')!.getAttribute('href')!,
      ),
    ).toBe('h1{color:red}')
  },
)

test('CSS namespace identifiers are retained without acquisition, including escapes and comments', async () => {
  const resolve = vi.fn(async () => 'data:image/png;base64,cG5n')
  const namespace =
    '@n\\61mespace /* space */ svg u\\72l( http://www.w3.org/2000/svg ); @namespace "http://www.w3.org/1999/xhtml";'
  const output = await rewriteExportCss(
    namespace + 'svg|image{background:url(/image.png)}',
    resolve,
  )
  expect(output).toContain(namespace)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('/image.png', false)
})

test.each([
  '<img src="/a.png"><img srcset="/b.png 1q">',
  '<style>a{background:url(/x.png)}b{background:url(</style>',
  '<img src="/a.png"><style>b{background:url(</style>',
])('malformed scans own all asynchronous work: %s', async (html) => {
  const unhandled: unknown[] = []
  const receive = (error: unknown) => unhandled.push(error)
  process.on('unhandledRejection', receive)
  const fetcher = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      }),
  )
  vi.stubGlobal('fetch', fetcher)
  try {
    await expect(
      prepareExportDocument(
        'artifact-1',
        data(html),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow(/Invalid srcset|Malformed CSS/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (html.includes('<img src="/a.png"><style>')) {
      expect(fetcher).toHaveBeenCalledOnce()
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    } else expect(fetcher).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  } finally {
    process.removeListener('unhandledRejection', receive)
  }
})

test.each([20, 40])(
  'charges transformed inline CSS output with %i cached imports',
  async (imports) => {
    const fetcher = vi.fn(
      async () =>
        new Response(`/*${'x'.repeat(1024 * 1024)}*/`, {
          headers: { 'content-type': 'text/css' },
        }),
    )
    vi.stubGlobal('fetch', fetcher)
    const inline =
      'data:text/css,' +
      encodeURIComponent('@import "/large.css";'.repeat(imports))
    const result = prepareExportDocument(
      'artifact-1',
      data(`<link rel="stylesheet" href="${inline}">`),
      AbortSignal.timeout(10000),
    )
    if (imports === 20) {
      const doc = await result
      expect(
        doc.querySelector('link')!.getAttribute('href')!.length,
      ).toBeGreaterThan(37_000_000)
    } else await expect(result).rejects.toThrow('embedded resource budget')
    expect(fetcher).toHaveBeenCalledOnce()
  },
  15000,
)

test.each([
  ['direct', 13],
  ['cached', 8],
  ['cached', 4],
  ['inline', 8],
] as const)(
  'composed depth: %s subtree with %i parents',
  async (mode, parents) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const name = new URL(input).pathname.split('/').at(-1)!
        const index = Number(name.slice(1, -4))
        const isB = name.startsWith('b')
        const next = isB
          ? index < 7
            ? `b${index + 1}.css`
            : null
          : index < parents - 1
            ? `a${index + 1}.css`
            : mode === 'direct'
              ? null
              : 'b0.css'
        let content = next ? `@import "${next}";` : 'p{color:red}'
        if (mode === 'inline' && !isB && index === parents - 1)
          content = `@import "data:text/css,${encodeURIComponent(content)}";`
        return new Response(content, {
          headers: { 'content-type': 'text/css' },
        })
      }),
    )
    const html =
      (mode === 'direct' ? '' : '<link rel="stylesheet" href="b0.css">') +
      '<link rel="stylesheet" href="a0.css">'
    const result = prepareExportDocument(
      'artifact-1',
      data(html),
      AbortSignal.timeout(5000),
    )
    if (parents === 4)
      expect((await result).querySelectorAll('link')).toHaveLength(2)
    else await expect(result).rejects.toThrow(/nested/)
  },
)

test('HTML download preserves SVG navigation without fetching its destination', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const doc = await prepareExportDocument(
    'artifact-1',
    data('<svg><a href="https://example.com/page"><text>link</text></a></svg>'),
    AbortSignal.timeout(1000),
  )
  expect(doc.querySelector('svg a')!.getAttribute('href')).toBe(
    'https://example.com/page',
  )
  expect(fetcher).not.toHaveBeenCalled()
})

test('loading Viewer export actions does not initialize the Markdown renderer', async () => {
  vi.resetModules()
  const renderer = vi.fn(() => {
    throw new Error('Renderer must remain outside the Viewer import graph')
  })
  vi.doMock('~/lib/markdown-render', renderer)
  try {
    const actions = await import('./export-actions')
    expect(actions.openPrintWindow).toBeTypeOf('function')
    expect(renderer).not.toHaveBeenCalled()
  } finally {
    vi.doUnmock('~/lib/markdown-render')
    vi.resetModules()
  }
})

test('malformed namespace blocks do not hide subsequent required CSS resources', async () => {
  const resolve = vi.fn(async () => 'data:image/png;base64,cG5n')
  const css = '@namespace x url(y) p{ nested{} } q{background:url(/hero.png)}'
  const rewritten = await rewriteExportCss(css, resolve)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('/hero.png', false)
  expect(rewritten).toContain('q{background:url("data:image/png;base64,cG5n")}')
})

test.each([false, true])(
  'alternate stylesheets embed nested resources from the exact snapshot (print=%s)',
  async (forPrint) => {
    const files: Record<string, [string, string]> = {
      '/styles/alternate.css': ['text/css', '@import "nested/theme.css";'],
      '/styles/nested/theme.css': [
        'text/css',
        '@font-face{font-family:Other;src:url("../../font.woff2")}p{background:url("/image.png")}',
      ],
      '/font.woff2': ['font/woff2', 'font-bytes'],
      '/image.png': ['image/png', 'image-bytes'],
    }
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input)
      expect(url.pathname).toMatch(
        /^\/api\/shareables\/artifact-1\/export-asset\//,
      )
      expect(url.search).toBe('?versionId=version-1')
      expect(init.cache).toBe('no-store')
      expect(init.redirect).toBe('error')
      const file = files[url.pathname.split('/export-asset')[1]]
      return new Response(file?.[1] ?? '', {
        status: file ? 200 : 404,
        headers: { 'content-type': file?.[0] ?? 'text/plain' },
      })
    })
    vi.stubGlobal('fetch', fetcher)
    const doc = await prepareExportDocument(
      'artifact-1',
      data(
        '<link rel="alternate stylesheet" title="Other" href="/styles/alternate.css"><p>Report</p>',
      ),
      AbortSignal.timeout(5000),
      forPrint,
    )
    const link = doc.querySelector('link')!
    expect(link.getAttribute('rel')).toBe('alternate stylesheet')
    expect(link.getAttribute('title')).toBe('Other')
    const main = cssText(link.getAttribute('href')!)
    const nested = cssText(/"(data:[^"]+)"/.exec(main)![1])
    expect(nested).toContain('data:font/woff2;base64,')
    expect(nested).toContain('data:image/png;base64,')
    expect(fetcher).toHaveBeenCalledTimes(4)
  },
)

test.each([false, true])(
  'missing alternate stylesheet resources fail preparation (print=%s)',
  async (forPrint) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    await expect(
      prepareExportDocument(
        'artifact-1',
        data(
          '<link rel="alternate stylesheet" title="Other" href="/missing.css">',
        ),
        AbortSignal.timeout(5000),
        forPrint,
      ),
    ).rejects.toThrow()
  },
)

test('namespace URL punctuation is not an at-rule terminator', async () => {
  const resolve = vi.fn(async () => 'data:image/png;base64,cG5n')
  const namespace = '@namespace svg url(https://example.com/a{b;c);'
  const css = await rewriteExportCss(
    namespace + 'q{background:url(/hero.png)}',
    resolve,
  )
  expect(css).toContain(namespace)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('/hero.png', false)
})

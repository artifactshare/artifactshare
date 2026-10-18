// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true}}
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as mermaidExport from '~/lib/mermaid-export.client'
import { isolatedPrintHtml } from './export-print-frame'
import { inertExportDocument } from './export-resources'
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

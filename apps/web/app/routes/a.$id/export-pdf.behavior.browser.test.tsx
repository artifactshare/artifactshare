import { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { server, userEvent, page } from 'vitest/browser'
import {
  openPrintWindow,
  writePrintPdf,
  type ExportSourceData,
} from './+components/export-actions'
import {
  inertExportDocument,
  rewriteExportCss,
} from './+components/export-resources'

const labels = {
  savePdf: 'Save PDF',
  backgroundHint: 'Background graphics',
  preparing: 'Preparing',
  heightLimited: 'Long document',
  failed: 'Export failed',
}
let popup: Window | null = null
let toolbarBefore: { top: number; left: number; width: number } | undefined
afterEach(async () => {
  popup?.close()
  popup = null
  await server.commands.exportPdfObservation('stop')
  vi.restoreAllMocks()
})
const source = (html: string): ExportSourceData => ({
  kind: 'html',
  artifactKind: 'html_page',
  versionId: 'version-1',
  path: '/index.html',
  source: html,
  fileName: 'index.html',
})

// Keep the captured WindowProxy identity without cross-realm WebIDL conversion
// (Firefox rejects opaque-frame sources passed to another realm's constructor).
function replayMessage(init: MessageEventInit) {
  const event = new MessageEvent('message', {
    origin: init.origin,
    data: init.data,
  })
  Object.defineProperty(event, 'source', { value: init.source })
  popup!.dispatchEvent(event)
}

async function openPopup() {
  const button = document.createElement('button')
  button.textContent = 'Open test print popup'
  let opened: Window | null = null
  button.onclick = () => {
    opened = openPrintWindow(labels)
  }
  document.body.appendChild(button)
  try {
    await userEvent.click(button)
    return opened
  } finally {
    button.remove()
  }
}

async function print(data: ExportSourceData) {
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  expect(popup).not.toBeNull()
  const toolbar = popup!.document
    .querySelector('.asx-print-toolbar')!
    .getBoundingClientRect()
  toolbarBefore = { top: toolbar.top, left: toolbar.left, width: toolbar.width }
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  try {
    await writePrintPdf(popup!, 'artifact-1', data, labels)
  } catch (error) {
    const diagnostics = await server.commands.exportPdfDiagnostics()
    throw new Error(
      `${String(error)}\nPopup diagnostics: ${diagnostics.join('\n')}`,
      { cause: error },
    )
  }
  return spy
}

describe('opaque PDF product export', () => {
  test('isolates hostile DOM/CSS and keeps trusted controls operational; observation has an authenticated negative control', async () => {
    const spy = await print(
      source(`<style>body{height:1750px} .asx-print-toolbar{display:none!important} input{position:fixed;inset:0;z-index:999999}</style>
      <meta http-equiv="refresh" content="0;url=/__pdf_probe_refresh"><base href="/__pdf_probe_base">
      <script>fetch('/__pdf_probe_script',{method:'POST'})</script>
      <form action="/__pdf_probe_form" method="post"><input autofocus accesskey="s"><button formaction="/__pdf_probe_button">Submit</button></form>
      <a href="/__pdf_probe_link">Link</a><a href="javascript:fetch('/__pdf_probe_unsafe')">Unsafe link</a><svg><a href="/__pdf_probe_svg"><text>SVG link</text></a><foreignObject><iframe src="/__pdf_probe_frame"></iframe></foreignObject></svg>
      <div onclick="fetch('/__pdf_probe_event')">Final marker</div>`),
    )
    expect(spy).toHaveBeenCalledTimes(1)
    const doc = popup!.document
    expect(doc.querySelector('form')).toBeNull()
    const frame = doc.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.contentDocument).toBeNull()
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(1750)
    const button = doc.querySelector<HTMLInputElement>(
      '#artifactshare-print-button',
    )!
    expect(button.disabled).toBe(false)
    expect(button.getBoundingClientRect().width).toBeGreaterThan(30)
    expect(popup!.getComputedStyle(button).visibility).toBe('visible')
    const toolbar = doc
      .querySelector('.asx-print-toolbar')!
      .getBoundingClientRect()
    expect({
      top: toolbar.top,
      left: toolbar.left,
      width: toolbar.width,
    }).toEqual(toolbarBefore)
    const hit = button.getBoundingClientRect()
    expect(
      doc.elementFromPoint(hit.left + hit.width / 2, hit.top + hit.height / 2),
    ).toBe(button)
    expect(frame.srcdoc).not.toContain('javascript:')
    button.focus()
    expect(doc.activeElement).toBe(button)
    button.click()
    button.click()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    })
    await server.commands.printExportPdfWithKeyboard()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3), {
      timeout: 5000,
    })
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
    const negative = await server.commands.exportPdfObservation('negative')
    expect(
      negative.some(
        (request) =>
          request.method === 'POST' &&
          request.wire === true &&
          request.cookie.includes('pdf_test_session=synthetic'),
      ),
    ).toBe(true)
  }, 20_000)

  test('keeps the complete frame beyond the custom paper limit', async () => {
    await print(
      source('<div style="height:41000px">Start</div><p>FINAL-PDF-MARKER</p>'),
    )
    expect(
      parseFloat(popup!.document.querySelector('iframe')!.style.height),
    ).toBeGreaterThan(41000)
    expect(
      popup!.document.getElementById(
        'artifactshare-client-print-dynamic-style',
      )!.textContent,
    ).toContain('size:auto')
    expect(
      popup!.document.getElementById('artifactshare-print-status')!.textContent,
    ).toBe(labels.heightLimited)
  }, 20_000)

  test('inert parsing starts no image or nested document requests', async () => {
    await server.commands.exportPdfObservation('start', source('test'))
    const doc = inertExportDocument(
      '<img src="/__pdf_probe_image"><iframe src="/__pdf_probe_frame"></iframe>',
    )
    expect(doc.querySelector('img')).not.toBeNull()
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  })

  test('resolves escaped CSS imports and URLs while adapting screen conditions for print', async () => {
    const resolve = vi.fn(
      async (ref: string) => `data:text/css,${encodeURIComponent(ref)}`,
    )
    const result = await rewriteExportCss(
      '@import "nested.css" layer(theme) screen; a {background:u\\72l("../image.png")} @page {size: A0}',
      resolve,
    )
    expect(resolve).toHaveBeenCalledWith('nested.css', true)
    expect(resolve).toHaveBeenCalledWith('../image.png', false)
    expect(result).toContain('layer(theme) artifactshare-screen')
    expect(result).not.toContain('@page')
  })
})

test('Markdown renders bounded Mermaid inside the opaque frame', async () => {
  const { renderMarkdownDocument } = await import('~/lib/markdown-render')
  const markdown =
    '# Diagram\n\n```mermaid\nflowchart LR\nA --> B\n```\n\nFINAL-PDF-MARKER'
  await print({
    ...source(markdown),
    kind: 'markdown',
    artifactKind: 'markdown_page',
    path: '/index.md',
    renderedHtml: renderMarkdownDocument(markdown),
  })
  const frame = await server.commands.inspectExportPdf()
  expect(frame.origin).toBe('null')
  expect(frame.parentDenied).toBe(true)
  expect(frame.svgCount).toBeGreaterThan(0)
  expect(frame.text).toContain('FINAL-PDF-MARKER')
}, 25_000)

test('Mermaid embedded image nodes remain printable without network authority', async () => {
  const { PDF_FIXTURE_IMAGE } =
    await import('~/services/dev-pdf-export-fixtures')
  const { renderMarkdownDocument } = await import('~/lib/markdown-render')
  const markdown =
    '```mermaid\nflowchart LR\nA@{ img: "' +
    PDF_FIXTURE_IMAGE +
    '", label: "Image", h: 40 }\n```'
  await print({
    ...source(markdown),
    kind: 'markdown',
    artifactKind: 'markdown_page',
    path: '/index.md',
    renderedHtml: renderMarkdownDocument(markdown),
  })
  expect((await server.commands.inspectExportPdf()).svgCount).toBeGreaterThan(0)
  expect(popup!.document.querySelector('iframe')!.srcdoc).toContain('<image')
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
}, 25_000)

test('Mermaid HTTPS image nodes acquire actual bytes anonymously before isolated rendering', async () => {
  const { PDF_FIXTURE_IMAGE } =
    await import('~/services/dev-pdf-export-fixtures')
  const { renderMarkdownDocument } = await import('~/lib/markdown-render')
  const image = 'https://example.com/pdf-fixture/mermaid.png'
  const markdown =
    '```mermaid\nflowchart LR\nA@{ img: "' +
    image +
    '", label: "Image", h: 40 }\n```'
  const data = {
    ...source(markdown),
    kind: 'markdown' as const,
    artifactKind: 'markdown_page' as const,
    path: '/index.md',
    renderedHtml: renderMarkdownDocument(markdown),
  }
  await server.commands.exportPdfObservation('start', data, [
    {
      path: '/pdf-fixture/mermaid.png',
      mime: 'image/png',
      body: PDF_FIXTURE_IMAGE.split(',')[1],
      base64: true,
    },
  ])
  const fetchSpy = vi.spyOn(window, 'fetch')
  popup = await openPopup()
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  await writePrintPdf(popup!, 'artifact-1', data, labels)
  expect(spy).toHaveBeenCalledTimes(1)
  const html = popup!.document.querySelector('iframe')!.srcdoc
  expect(html).toContain('<image')
  expect(html).toContain('data:image/png;base64,')
  const frame = await server.commands.inspectExportPdf()
  // The hidden Mermaid code block deliberately retains the original source.
  // Check live SVG resource attributes, not URLs appearing in inert text.
  expect(frame.text).toContain(image)
  expect(frame.svgImages).toEqual([
    { href: PDF_FIXTURE_IMAGE, xlinkHref: null },
  ])
  expect(frame.svgCount).toBeGreaterThan(0)
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
  const external = await server.commands.exportPdfObservation('external')
  expect(external).toHaveLength(1)
  // Cookie metadata is diagnostic in WebKit; the real acquisition call also
  // proves policy in every engine, alongside successfully decoded image bytes.
  expect(external[0].cookie).toBe('')
  expect(fetchSpy).toHaveBeenCalledWith(
    image,
    expect.objectContaining({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      mode: 'cors',
    }),
  )
}, 25_000)

test('Mermaid image-node preparation cannot use application authentication', async () => {
  const { renderMarkdownDocument } = await import('~/lib/markdown-render')
  const image = window.location.origin + '/__pdf_probe_mermaid_image'
  const diagram = `flowchart LR\nA@{ img: "${image}", label: "Image", h: 40 }`
  const markdown = '```mermaid\n' + diagram + '\n```'
  const data = {
    ...source(markdown),
    kind: 'markdown' as const,
    artifactKind: 'markdown_page' as const,
    path: '/index.md',
    renderedHtml: renderMarkdownDocument(markdown),
  }
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  await expect(
    writePrintPdf(popup!, 'artifact-1', data, labels),
  ).rejects.toThrow('forbidden resource')
  expect(spy).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
  // Same Mermaid syntax in the former app-realm renderer is an unsafe control.
  // It must reach the server with the synthetic cookie, even if image decoding
  // subsequently fails on the fixture's text response.
  const { renderMermaidSvg } = await import('~/lib/mermaid-render.client')
  await renderMermaidSvg(diagram).catch(() => {})
  const requests = await server.commands.exportPdfObservation('read')
  expect(
    requests.some(
      (request) =>
        request.url === image &&
        request.wire === true &&
        request.cookie.includes('pdf_test_session=synthetic'),
    ),
  ).toBe(true)
}, 25_000)

test('selected static-site page retains nested imported CSS, real font and image bytes', async () => {
  const { PDF_EXPORT_FIXTURES, pdfFixtureFiles } =
    await import('~/services/dev-pdf-export-fixtures')
  const fixture = PDF_EXPORT_FIXTURES[4]
  const data = {
    ...source(fixture.source),
    artifactKind: fixture.kind,
    path: fixture.path,
  }
  const assets = pdfFixtureFiles(4).map((file) => ({
    path: file.path,
    mime: file.mime,
    body:
      typeof file.body === 'string'
        ? file.body
        : btoa(String.fromCharCode(...file.body)),
    base64: typeof file.body !== 'string',
  }))
  await server.commands.exportPdfObservation('start', data, assets)
  popup = await openPopup()
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  await writePrintPdf(popup!, 'artifact-1', data, labels)
  expect(spy).toHaveBeenCalledOnce()
  const frame = await server.commands.inspectExportPdf()
  expect(frame.text).toContain('Selected guide page')
  expect(frame.fontLoaded).toBe(true)
  expect(frame.imageLoaded).toBe(true)
  expect(frame.color).toBe('rgb(23, 102, 173)')
  expect(frame.parentDenied).toBe(true)
}, 20_000)

test('revoked access prevents repeat printing even when every resource is embedded', async () => {
  const spy = await print(source('<h1>Snapshot</h1>'))
  await server.commands.exportPdfObservation('revoke')
  const button = popup!.document.querySelector<HTMLInputElement>(
    '#artifactshare-print-button',
  )!
  button.click()
  await vi.waitFor(
    () => expect(popup!.document.body.dataset.exportState).toBe('failed'),
    { timeout: 5000 },
  )
  expect(spy).toHaveBeenCalledOnce()
  expect(button.disabled).toBe(true)
  expect(
    popup!.document.getElementById('artifactshare-print-status')!.textContent,
  ).toBe(labels.failed)
  expect(popup!.document.querySelector('iframe')).toBeNull()
}, 15_000)

test.each([
  '<img src="redirect.png">',
  '<img src="https://example.com/pdf-fixture/redirect">',
  '<img src="https://example.com/pdf-fixture/unavailable.png">',
  '<img src="missing.png">',
  '<style>@import "/__pdf_probe_css";</style>',
  '<img srcset="/__pdf_probe_srcset 1x, /__pdf_probe_srcset2 2x">',
  '<video poster="/__pdf_probe_poster"><source src="/__pdf_probe_media"></video>',
  '<svg><image href="/__pdf_probe_svg_image"/></svg>',
  '<div style="background:u\\72l(/__pdf_probe_escaped_css)">Image</div>',
])(
  'resource failure cannot become a successful print or authenticated resource escape: %s',
  async (html) => {
    const data = source(html)
    await server.commands.exportPdfObservation('start', data)
    popup = await openPopup()
    const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
    await expect(
      writePrintPdf(popup!, 'artifact-1', data, labels),
    ).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
  15_000,
)

test('rejects forged origin/window/channel/sequence and invalid dimensions while measuring a repeat print', async () => {
  const spy = await print(source('<h1>Measured page</h1>'))
  let measured: MessageEvent | undefined
  const hold = (event: MessageEvent) => {
    if (event.data?.kind === 'measured') {
      event.stopImmediatePropagation()
      measured = event
    }
  }
  popup!.addEventListener('message', hold, true)
  popup!.document
    .querySelector<HTMLInputElement>('#artifactshare-print-button')!
    .click()
  await vi.waitFor(() => expect(measured).toBeDefined(), { timeout: 5000 })
  popup!.removeEventListener('message', hold, true)
  const event = measured!
  const valid = { origin: event.origin, source: event.source, data: event.data }
  const removed = vi.spyOn(popup!, 'removeEventListener')
  for (const init of [
    { ...valid, origin: window.location.origin },
    { ...valid, source: window },
    { ...valid, data: { ...event.data, channel: 'wrong' } },
    { ...valid, data: { ...event.data, sequence: event.data.sequence - 1 } },
    ...[0, -1, Infinity, NaN, 2_000_001, '900'].map((height) => ({
      ...valid,
      data: { ...event.data, height },
    })),
  ]) {
    removed.mockClear()
    replayMessage(init)
    // Accepting a packet synchronously finishes this measurement and removes
    // its listener, well before layout/revalidation can lead to another print.
    expect(removed.mock.calls.filter(([type]) => type === 'message')).toEqual(
      [],
    )
    expect(spy).toHaveBeenCalledTimes(1)
  }
  replayMessage(valid)
  expect(removed.mock.calls.some(([type]) => type === 'message')).toBe(true)
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
    timeout: 5000,
  })
  replayMessage(valid)
  expect(spy).toHaveBeenCalledTimes(2)
}, 15_000)

test('closing the popup during preparation settles without printing', async () => {
  const data = source('<h1>Close while preparing</h1>')
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  const pending = writePrintPdf(popup!, 'artifact-1', data, labels)
  popup!.close()
  await expect(pending).rejects.toThrow()
  expect(spy).not.toHaveBeenCalled()
}, 15_000)

test('popup blocking retains the null result used by localized Viewer feedback', () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  expect(openPrintWindow(labels)).toBeNull()
})

test('missing readiness fails within its deadline and late messages cannot print', async () => {
  const spy = await print(source('<h1>Readiness deadline</h1>'))
  let held: MessageEvent | undefined
  const block = (event: MessageEvent) => {
    if (event.data?.kind === 'measured') {
      held = event
      event.stopImmediatePropagation()
    }
  }
  popup!.addEventListener('message', block, true)
  const schedule = window.setTimeout.bind(window)
  let expire: (() => void) | undefined
  vi.spyOn(window, 'setTimeout').mockImplementation(
    (handler, timeout, ...args) => {
      if (timeout === 10_000 && typeof handler === 'function')
        expire = () => handler(...args)
      return schedule(handler, timeout, ...args) as unknown as ReturnType<
        typeof window.setTimeout
      >
    },
  )
  popup!.document
    .querySelector<HTMLInputElement>('#artifactshare-print-button')!
    .click()
  await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 5000 })
  expect(held!.source).toBe(
    popup!.document.querySelector('iframe')!.contentWindow,
  )
  expect(held!.origin).toBe('null')
  expect(expire).toBeDefined()
  expire!()
  await vi.waitFor(
    () => expect(popup!.document.body.dataset.exportState).toBe('failed'),
    { timeout: 3000 },
  )
  popup!.removeEventListener('message', block, true)
  replayMessage({
    origin: held!.origin,
    source: held!.source,
    data: held!.data,
  })
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  )
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(spy).toHaveBeenCalledTimes(1)
  expect(popup!.document.querySelector('iframe')).toBeNull()
}, 15_000)

test('real Viewer export menu opens the isolated print shell', async () => {
  const { createRoot } = await import('react-dom/client')
  const { createMemoryRouter, RouterProvider } = await import('react-router')
  const { TooltipProvider } = await import('~/components/ui/tooltip')
  const { ViewerChrome } = await import('./+components/viewer-chrome')
  const data = source('<h1>Menu export</h1>')
  await server.commands.exportPdfObservation('start', data)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let completion: Promise<void> | undefined
  const router = createMemoryRouter([
    {
      id: 'root',
      path: '/',
      loader: () => ({ locale: 'en' }),
      element: (
        <TooltipProvider>
          <ViewerChrome
            artifact={{
              id: 'artifact-1',
              storageKey: 'artifact-1',
              name: 'Menu export',
              derivedTitle: null,
              titleOverride: null,
              ownerId: 'viewer',
              ownerName: 'Viewer',
              ownerEmail: 'viewer@example.com',
              ownerImage: null,
              ownerInitial: 'V',
              modifiedTime: null,
              viewCount: 1,
            }}
            user={{
              id: 'viewer',
              name: 'Viewer',
              email: 'viewer@example.com',
              image: null,
              initial: 'V',
            }}
            renderType="html"
            onDownloadPdf={() => {
              popup = openPrintWindow(labels)
              if (!popup) throw new Error('Popup unexpectedly blocked')
              vi.spyOn(popup, 'print').mockImplementation(() => {})
              completion = writePrintPdf(popup, 'artifact-1', data, labels)
            }}
          />
        </TooltipProvider>
      ),
    },
  ])
  try {
    await act(async () => {
      root.render(<RouterProvider router={router} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: 'More', exact: true }).click()
    })
    await act(async () => {
      await page
        .getByRole('menuitem', { name: 'Download PDF', exact: true })
        .click()
    })
    await vi.waitFor(() => expect(completion).toBeDefined())
    await completion
    expect(
      popup!.document.querySelector('iframe')!.getAttribute('sandbox'),
    ).toBe('allow-scripts')
    expect(popup!.document.body.dataset.exportState).toBe('ready')
  } finally {
    await act(async () => {
      root.unmount()
    })
    router.dispose()
    host.remove()
  }
}, 20_000)

test('sandbox and CSP deny active content independently of the sanitizer', async () => {
  await print(source('<h1>Independent boundary</h1>'))
  await server.commands.probeExportPdfBoundary()
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
  // A browser may announce an image attempt before enforcing CSP. The probe
  // requires the actual img-src violation; no attempt may reach interception.
  const attempts = await server.commands.exportPdfObservation('attempts')
  expect(
    attempts.every(
      (request) =>
        new URL(request.url).pathname === '/__pdf_probe_csp_image' &&
        request.method === 'GET' &&
        request.cookie === '',
    ),
  ).toBe(true)

  expect((await server.commands.inspectExportPdf()).parentDenied).toBe(true)
  const negative = await server.commands.exportPdfObservation('negative')
  expect(
    negative.some(
      (request) =>
        new URL(request.url).pathname === '/__pdf_probe_csp_image' &&
        request.wire === true &&
        request.cookie.includes('pdf_test_session=synthetic'),
    ),
  ).toBe(true)
  expect(
    negative.some(
      (request) =>
        request.method === 'POST' &&
        request.wire === true &&
        request.cookie.includes('pdf_test_session=synthetic'),
    ),
  ).toBe(true)
}, 15_000)

test('a stalled frame font cannot be treated as ready', async () => {
  const spy = await print(source('<h1>Font readiness</h1>'))
  await server.commands.stallExportPdfFonts()
  const schedule = window.setTimeout.bind(window)
  vi.spyOn(window, 'setTimeout').mockImplementation(
    (handler, timeout, ...args) =>
      schedule(
        handler,
        timeout === 10_000 ? 150 : timeout,
        ...args,
      ) as unknown as ReturnType<typeof window.setTimeout>,
  )
  popup!.document
    .querySelector<HTMLInputElement>('#artifactshare-print-button')!
    .click()
  await vi.waitFor(
    () => expect(popup!.document.body.dataset.exportState).toBe('failed'),
    { timeout: 3000 },
  )
  expect(spy).toHaveBeenCalledTimes(1)
}, 15_000)

test('navigation during acquisition leaves the replacement document alone', async () => {
  const data = source('<img src="stalled.png">')
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const initial = popup!.document
  const fetch = window.fetch.bind(window)
  vi.spyOn(window, 'fetch').mockImplementation((input, init) =>
    String(input).includes('/export-asset/')
      ? new Promise(() => {})
      : fetch(input, init),
  )
  const pending = writePrintPdf(popup!, 'artifact-1', data, labels)
  // Attach the rejection handler before the watchdog can reject the operation.
  const rejected = expect(pending).rejects.toThrow()
  popup!.location.href = window.location.origin + '/__pdf_probe_navigation'
  await vi.waitFor(() => expect(popup!.document).not.toBe(initial), {
    timeout: 5000,
  })
  popup!.document.body.textContent = 'Replacement document'
  await rejected
  expect(popup!.closed).toBe(false)
  expect(popup!.document.body.textContent).toBe('Replacement document')
}, 15_000)

test('bundled Japanese regular and bold fonts decode in chrome and opaque content without a font host', async () => {
  const spy = await print(source('<h1>日本語の印刷</h1><p>日本語の本文</p>'))
  expect(spy).toHaveBeenCalledTimes(1)
  for (const weight of [400, 700]) {
    const faces = await popup!.document.fonts.load(
      `${weight} 16px ArtifactSharePrintJP`,
      '日本語',
    )
    expect(faces.length).toBeGreaterThan(0)
    expect(faces.every((face) => face.status === 'loaded')).toBe(true)
  }
  const frame = await server.commands.inspectExportPdf()
  expect(frame.printFontsLoaded).toBe(true)
  expect(
    popup!.document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute('content'),
  ).toContain('font-src data:;')
  const requests = await server.commands.exportPdfObservation('read')
  expect(
    requests.filter((request) => request.url.includes('fonts.gstatic.com')),
  ).toEqual([])
})

test('real redirect negative control reaches the observed destination with synthetic authentication', async () => {
  await server.commands.exportPdfObservation(
    'start',
    source('<p>Redirect control</p>'),
  )
  const response = await fetch(
    '/api/shareables/artifact-1/export-asset/redirect.png?versionId=version-1',
    { redirect: 'follow' },
  )
  expect(response.redirected).toBe(true)
  const requests = await server.commands.exportPdfObservation('read')
  expect(
    requests.some(
      (request) =>
        new URL(request.url).pathname === '/__pdf_probe_redirect' &&
        request.wire === true &&
        request.cookie.includes('pdf_test_session=synthetic'),
    ),
  ).toBe(true)
})

test('anonymous redirect receipts retain multiplicity across repeated reads', async () => {
  await server.commands.exportPdfObservation(
    'start',
    source('<p>Anonymous control</p>'),
  )
  const url =
    '/api/shareables/artifact-1/export-asset/redirect.png?versionId=version-1'
  const firstResponse = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
  })
  expect(firstResponse.redirected).toBe(true)
  const initial = await server.commands.exportPdfObservation('read')
  expect(initial.filter((request) => request.wire)).toHaveLength(1)
  const secondResponse = await fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
  })
  expect(secondResponse.redirected).toBe(true)
  const first = await server.commands.exportPdfObservation('read')
  const receipts = first.filter(
    (request) =>
      new URL(request.url).pathname === '/__pdf_probe_redirect' && request.wire,
  )
  expect(receipts).toHaveLength(2)
  expect(new Set(receipts.map((request) => request.receipt)).size).toBe(2)
  expect(receipts.every((request) => request.cookie === '')).toBe(true)
  expect(await server.commands.exportPdfObservation('read')).toEqual(first)
})

test('print-only expansion is measured before first and repeated print, including the final long-page marker', async () => {
  const spy = await print(
    source(`<style>
    .print-content { display:none }
    @media screen { .print-content { height:1px } }
    @media print { .print-content { display:block; height:41000px } }
    @media not print { .print-content { display:none } }
  </style><div class="print-content">Print content</div><p>Final print marker</p>`),
  )
  const frame = popup!.document.querySelector('iframe')!
  expect(parseFloat(frame.style.height)).toBeGreaterThan(41000)
  expect(popup!.document.body.dataset.exportState).toBe('height-limited')
  expect((await server.commands.inspectExportPdf()).text).toContain(
    'Final print marker',
  )
  const printed = await server.commands.inspectExportPdf(true)
  expect(printed.layoutHeight).toBeGreaterThan(41000)
  expect(printed.layoutHeight).toBeLessThanOrEqual(
    parseFloat(frame.style.height),
  )
  popup!.document
    .querySelector<HTMLInputElement>('#artifactshare-print-button')!
    .click()
  await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
    timeout: 5000,
  })
  expect(parseFloat(frame.style.height)).toBeGreaterThan(41000)
}, 15000)

test('first print includes content expanded by the resized frame viewport', async () => {
  const spy = await print(
    source(`<style>
    .content {height:600px}
    @media (min-height:500px) {.content {height:2400px}}
  </style><div class="content">Viewport-dependent content</div><p>Final viewport marker</p>`),
  )
  expect(spy).toHaveBeenCalledOnce()
  const frame = popup!.document.querySelector('iframe')!
  const layout = await server.commands.inspectExportPdf(true)
  expect(layout.layoutHeight).toBeGreaterThan(2400)
  expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(
    layout.layoutHeight,
  )
  expect(layout.text).toContain('Final viewport marker')
}, 15000)

test.each([
  ['height:100vh', 760],
  ['height:100vb', 760],
  ['height:100dvi', 900],
  ['height:100dvh', 760],
  ['height:100svh', 760],
  ['height:100lvh', 760],
  ['height:100vmax', 900],
  ['height:calc(100vh + 100px)', 860],
  ['min-height:100vh;padding:24px;box-sizing:content-box', 808],
])(
  'viewport hero plus following content prints completely: %s',
  async (style, minimum) => {
    const spy = await print(
      source(`<div style="${style}">Hero</div><p>FINAL-VIEWPORT-MARKER</p>`),
    )
    expect(spy).toHaveBeenCalledOnce()
    const frame = popup!.document.querySelector('iframe')!
    const layout = await server.commands.inspectExportPdf(true)
    expect(layout.layoutHeight).toBeGreaterThan(minimum)
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(
      layout.layoutHeight,
    )
    expect(layout.text).toContain('FINAL-VIEWPORT-MARKER')
  },
  15000,
)

test('an early empty-document load cannot start measurement before the frame helper is ready', async () => {
  const data = source('<div style="height:80px">Short intrinsic content</div>')
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  const bodyPrototype = Object.getPrototypeOf(popup!.document.body) as Node
  const appendChild = bodyPrototype.appendChild
  let earlyLoad = false
  vi.spyOn(bodyPrototype, 'appendChild').mockImplementation(function (
    this: HTMLElement,
    node: Node,
  ) {
    if (node.nodeName === 'IFRAME') {
      earlyLoad = true
      const html = (node as HTMLIFrameElement).srcdoc
      const nonce = /script-src 'nonce-([^']+)'/.exec(html)![1]
      expect(html).toContain(`<script nonce="${nonce}">`)
      node.dispatchEvent(new Event('load'))
    }
    return appendChild.call(this, node)
  })
  await writePrintPdf(popup!, 'artifact-1', data, labels)
  expect(earlyLoad).toBe(true)
  expect(spy).toHaveBeenCalledOnce()
  const height = parseFloat(
    popup!.document.querySelector('iframe')!.style.height,
  )
  expect(height).toBeGreaterThanOrEqual(80)
  expect(height).toBeLessThan(200)
}, 15000)

test('print picture selection is decoded and included in the complete layout before printing', async () => {
  const svg = (height: number) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="${height}"><rect width="60" height="${height}" fill="red"/></svg>`,
    )
  const small = svg(20)
  const tall = svg(1800)
  const spy = await print(
    source(`<picture>
    <source media="screen" srcset="${small}">
    <source media="print" srcset="${tall}">
    <img src="${small}" style="display:block">
  </picture><p>FINAL-PICTURE-MARKER</p>`),
  )
  expect(spy).toHaveBeenCalledOnce()
  const frame = popup!.document.querySelector('iframe')!
  for (const printMedia of [false, true]) {
    const layout = await server.commands.inspectExportPdf(printMedia)
    expect(layout.imageHeights).toEqual([1800])
    expect(layout.layoutHeight).toBeGreaterThan(1800)
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(
      layout.layoutHeight,
    )
    expect(layout.text).toContain('FINAL-PICTURE-MARKER')
  }
}, 15000)

test('percentage-height body with padding prints its final overflow', async () => {
  await print(
    source(`<style>html,body{height:100%}body{padding:24px}
    .wrap{min-height:100%}</style><div class="wrap">Report</div>
    <footer>Final percentage marker</footer>`),
  )
  const frame = popup!.document.querySelector('iframe')!
  const layout = await server.commands.inspectExportPdf(true)
  expect(layout.text).toContain('Final percentage marker')
  expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(
    layout.layoutHeight,
  )
})

test('logical viewport lengths follow the root vertical writing mode', async () => {
  await print(
    source(`<html style="writing-mode:vertical-rl"><body>
    <div style="height:100vb;width:50dvi">Vertical report</div>
    </body></html>`),
  )
  const layout = await server.commands.inspectExportPdf(true)
  expect(layout.layoutHeight).toBeGreaterThanOrEqual(900)
  expect(
    parseFloat(popup!.document.querySelector('iframe')!.style.height),
  ).toBeGreaterThanOrEqual(layout.layoutHeight)
})

test('application controller relays first and repeat measurements through the popup realm', async () => {
  const data = source('<div style="height:1750px">Relay layout</div>')
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const messages: MessageEvent[] = []
  const observe = (event: MessageEvent) => messages.push(event)
  popup!.addEventListener('message', observe)
  const spy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  try {
    await writePrintPdf(popup!, 'artifact-1', data, labels)
    expect(spy).toHaveBeenCalledOnce()
    const commands = () =>
      messages.filter((event) => event.data?.kind === 'measure')
    const replies = () =>
      messages.filter((event) => event.data?.kind === 'measured')
    expect(commands().length).toBeGreaterThanOrEqual(2)
    expect(replies().length).toBe(commands().length)
    for (const event of commands()) {
      expect(event.source).toBe(window)
      expect(event.source).not.toBe(popup)
      expect(event.origin).toBe(window.location.origin)
    }
    for (const event of replies()) {
      expect(event.source).toBe(
        popup!.document.querySelector('iframe')!.contentWindow,
      )
      expect(event.origin).toBe('null')
      expect(event.data.height).toBeGreaterThanOrEqual(1750)
    }
    const last = commands().at(-1)!
    const next = { ...last.data, sequence: last.data.sequence + 1 }
    const before = replies().length
    for (const init of [
      { source: popup, origin: window.location.origin, data: next },
      { source: window, origin: 'null', data: next },
      {
        source: window,
        origin: window.location.origin,
        data: { ...next, channel: 'wrong' },
      },
      { source: window, origin: window.location.origin, data: last.data },
      {
        source: window,
        origin: window.location.origin,
        data: { ...next, sequence: Infinity },
      },
    ])
      replayMessage(init)
    popup!.document
      .querySelector<HTMLInputElement>('#artifactshare-print-button')!
      .click()
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    })
    expect(replies().length).toBe(before + 2)
    expect(
      replies()
        .slice(before)
        .map((event) => event.data.sequence),
    ).toEqual([next.sequence, next.sequence + 1])
  } finally {
    popup!.removeEventListener('message', observe)
  }
}, 15000)

test('external images and fonts are acquired anonymously and decoded before first and repeat print', async () => {
  const { PDF_FIXTURE_IMAGE, PDF_FIXTURE_FONT } =
    await import('~/services/dev-pdf-export-fixtures')
  const imageUrl = 'https://example.com/pdf-fixture/image.png'
  const fontUrl = 'https://example.com/pdf-fixture/font.woff2'
  const data = source(`<style>
    @font-face{font-family:ExportFixture;src:url("${fontUrl}") format("woff2")}
    h1{font-family:ExportFixture}
  </style><h1>External resource report</h1><img src="${imageUrl}" alt="External fixture">`)
  await server.commands.exportPdfObservation('start', data, [
    {
      path: '/pdf-fixture/image.png',
      mime: 'image/png',
      body: PDF_FIXTURE_IMAGE.split(',')[1],
      base64: true,
    },
    {
      path: '/pdf-fixture/font.woff2',
      mime: 'font/woff2',
      body: PDF_FIXTURE_FONT.split(',')[1],
      base64: true,
    },
  ])
  const fetchSpy = vi.spyOn(window, 'fetch')
  popup = await openPopup()
  const printSpy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  await writePrintPdf(popup!, 'artifact-1', data, labels)
  expect(printSpy).toHaveBeenCalledOnce()
  const frame = await server.commands.inspectExportPdf()
  expect(frame.imageHeights).toEqual([40])
  expect(frame.imageLoaded).toBe(true)
  expect(frame.fontLoaded).toBe(true)
  expect(frame.parentDenied).toBe(true)
  for (const url of [imageUrl, fontUrl]) {
    expect(fetchSpy).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        redirect: 'error',
        cache: 'no-store',
      }),
    )
  }
  // Intercepted headers are supplementary evidence: WebKit omits Cookie even
  // for credentialed interception. The fetch assertions above establish the
  // product's credentials-omit policy; these headers alone cannot prove it.
  const acquired = await server.commands.exportPdfObservation('external')
  expect(acquired.map((request) => request.url).sort()).toEqual(
    [fontUrl, imageUrl].sort(),
  )
  expect(
    acquired.every(
      (request) =>
        request.cookie === '' &&
        request.referrer === '' &&
        request.method === 'GET',
    ),
  ).toBe(true)
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
  popup!.document
    .querySelector<HTMLInputElement>('#artifactshare-print-button')!
    .click()
  await vi.waitFor(() => expect(printSpy).toHaveBeenCalledTimes(2), {
    timeout: 5000,
  })
  expect(await server.commands.exportPdfObservation('external')).toEqual(
    acquired,
  )
  const repeated = await server.commands.inspectExportPdf()
  expect(repeated.fontLoaded).toBe(true)
  expect(repeated.imageHeights).toEqual([40])
}, 20000)

test('empty receipt query falls back to the dispatched session header', async () => {
  await server.commands.exportPdfObservation(
    'start',
    source('<p>Receipt control</p>'),
  )
  const url = new URL('/__pdf_probe_empty?pdf_probe_id=', location.origin).href
  await fetch(url, { credentials: 'omit' })
  const records = await server.commands.exportPdfObservation('read')
  expect(
    records.filter((record) => record.url === url && record.wire),
  ).toHaveLength(1)
  expect(await server.commands.exportPdfObservation('read')).toEqual(records)
})

test.each(['application', 'credentials', 'redirect', 'allowed'])(
  'Mermaid image message resource policy: %s',
  async (kind) => {
    const { PDF_FIXTURE_IMAGE } =
      await import('~/services/dev-pdf-export-fixtures')
    const { renderMarkdownDocument } = await import('~/lib/markdown-render')
    const original = 'https://example.com/pdf-fixture/original.png'
    const ref =
      kind === 'application'
        ? location.origin + '/__pdf_probe_message'
        : kind === 'credentials'
          ? 'https://user:pass@example.com/pdf-fixture/image.png'
          : kind === 'redirect'
            ? 'redirect.png'
            : original
    const markdown =
      '```mermaid\nflowchart LR\nA@{ img: "' +
      original +
      '", label: "Image", h: 40 }\n```'
    const data = {
      ...source(markdown),
      kind: 'markdown' as const,
      artifactKind: 'markdown_page' as const,
      renderedHtml: renderMarkdownDocument(markdown),
    }
    await server.commands.exportPdfObservation('start', data, [
      {
        path: '/pdf-fixture/original.png',
        mime: 'image/png',
        body: PDF_FIXTURE_IMAGE.split(',')[1],
        base64: true,
      },
    ])
    const fetchSpy = vi.spyOn(window, 'fetch')
    let intercepted = 0
    // Mutate only the payload of the actual realm's event before the product
    // listener: WindowProxy, opaque origin, channel and sequence stay intact.
    const substitute = (event: MessageEvent) => {
      if (event.data?.kind === 'image' && event.data.ref === original) {
        expect(event.origin).toBe('null')
        event.data.ref = ref
        intercepted++
      }
    }
    window.addEventListener('message', substitute, true)
    popup = await openPopup()
    const printSpy = vi.spyOn(popup!, 'print').mockImplementation(() => {})
    try {
      const result = writePrintPdf(popup!, 'artifact-1', data, labels)
      if (kind === 'allowed') {
        await result
        expect(printSpy).toHaveBeenCalledTimes(1)
        expect((await server.commands.inspectExportPdf()).svgImages).toEqual([
          { href: PDF_FIXTURE_IMAGE, xlinkHref: null },
        ])
      } else {
        await expect(result).rejects.toThrow('forbidden resource')
        expect(printSpy).not.toHaveBeenCalled()
      }
      if (kind === 'application' || kind === 'credentials') {
        // Observe invocation before native fetch can reject credentialed URLs.
        expect(fetchSpy.mock.calls.some(([url]) => String(url) === ref)).toBe(
          false,
        )
      } else if (kind === 'allowed') {
        expect(fetchSpy).toHaveBeenCalledWith(
          original,
          expect.objectContaining({
            credentials: 'omit',
            redirect: 'error',
            mode: 'cors',
          }),
        )
      }
      expect(intercepted).toBe(1)
      expect(await server.commands.exportPdfObservation('read')).toEqual([])
      // Live unsafe control proves the same receipt observer sees dispatch.
      await fetch('/__pdf_probe_message', { credentials: 'include' })
      const records = await server.commands.exportPdfObservation('read')
      expect(
        records.some(
          (record) =>
            record.wire && record.cookie.includes('pdf_test_session=synthetic'),
        ),
      ).toBe(true)
    } finally {
      window.removeEventListener('message', substitute, true)
    }
  },
  25_000,
)

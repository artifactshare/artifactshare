import { act } from 'react'
import DOMPurify from 'dompurify'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { server, userEvent, page } from 'vitest/browser'
import {
  openPrintWindow,
  writePrintPdf,
  type ExportSourceData,
} from './+components/export-actions'
import {
  inertExportDocument,
  sanitizeExportDocument,
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
  expect(popup!.getComputedStyle(button).cursor).toBe('default')
  expect(popup!.document.querySelector('.asx-print-hint')!.textContent).toBe('')
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

test('real Viewer export menu opens the isolated print shell without unwrapped React updates', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const consoleError = vi.spyOn(console, 'error')
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
              // Observe failure immediately while the browser click completes;
              // awaiting completion below still propagates the same rejection.
              void completion.catch(() => {})
            }}
          />
        </TooltipProvider>
      ),
    },
  ])
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    const more = page.getByRole('button', { name: 'More', exact: true })
    await expect.element(more).toBeVisible()
    await act(async () => more.click({ timeout: 5000 }))
    const download = page.getByRole('menuitem', {
      name: 'Download PDF',
      exact: true,
    })
    await expect.element(download).toBeVisible()
    await act(async () => download.click({ timeout: 5000 }))
    await vi.waitFor(() => expect(completion).toBeDefined())
    await act(async () => {
      await completion
    })
    expect(
      popup!.document.querySelector('iframe')!.getAttribute('sandbox'),
    ).toBe('allow-scripts')
    expect(popup!.document.body.dataset.exportState).toBe('ready')
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    host.remove()
    vi.unstubAllGlobals()
  }
  expect(
    consoleError.mock.calls.filter((args) =>
      args.some(
        (value) =>
          typeof value === 'string' && value.includes('not wrapped in act'),
      ),
    ),
  ).toEqual([])
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

test('HTML image placeholder normalization retains the existing SVG boundary', () => {
  const doc = inertExportDocument(
    '<img src="#" alt="Placeholder"><svg><image href="#image"/><use href="#shape"/></svg>',
  )
  sanitizeExportDocument(doc)
  expect(doc.querySelector('img')!.hasAttribute('src')).toBe(false)
  expect(doc.querySelector('image')!.getAttribute('href')).toBe('#image')
  expect(doc.querySelector('use')).toBeNull()
})

test.each([
  '<img data-src="photo.jpg" alt="Placeholder">',
  '<img src="" alt="Placeholder">',
  '<img src="#" alt="Placeholder">',
  '<img src=" #placeholder " alt="Placeholder">',
  '<img src="   " alt="Placeholder">',
  '<img src="#" srcset="# 1x" alt="Placeholder">',
  '<img srcset="  #placeholder 1x, #other 2x  " alt="Placeholder">',
  '<img srcset="   " alt="Placeholder">',
  '<picture><source srcset="# 1x"><img src="#" alt="Placeholder"></picture>',
  '<picture><source srcset="  #placeholder 1x, #other 2x  "><img alt="Placeholder"></picture>',
  '<picture><source srcset=""><img alt="Placeholder"></picture>',
  '<picture><source srcset="   "><img alt="Placeholder"></picture>',
])(
  'harmless image placeholders retain visible content and reach print: %s',
  async (html) => {
    const printed = await print(source(`<h1>Placeholder report</h1>${html}`))
    expect(printed).toHaveBeenCalledOnce()
    expect(popup!.document.body.dataset.exportState).toBe('ready')
    expect(popup!.document.querySelector('iframe')!.srcdoc).toContain(
      'alt="Placeholder"',
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
  15000,
)

test('generated Markdown PDF is legible in light/dark print media with readable TOC and no copy controls', async () => {
  const { renderMarkdownDocument } = await import('~/lib/markdown-render')
  const { resolveExportHtml } = await import('./+components/export-actions')
  const markdown =
    '# Report\nBody text\n## Source\n```js\nconst answer = 42\n```\n## PDF\n```mermaid\nflowchart LR\nSource --> PDF\n```'
  const data = {
    ...source(markdown),
    kind: 'markdown' as const,
    artifactKind: 'markdown_page',
    path: '/index.md',
    renderedHtml: renderMarkdownDocument(markdown),
  }
  const printed = await print(data)
  expect(printed).toHaveBeenCalledOnce()
  for (const scheme of ['light', 'dark'] as const) {
    const inspected = await server.commands.inspectExportPdf(true, scheme)
    expect(inspected.markdownPresentation).toMatchObject({
      bodyColor: 'rgb(55, 53, 47)',
      codeColor: 'rgb(55, 53, 47)',
      keywordColor: 'rgb(207, 34, 46)',
      copyControls: 0,
      tocOpen: true,
    })
    expect(inspected.markdownPresentation.tocHeight).toBeGreaterThan(40)
    expect(inspected.svgCount).toBeGreaterThan(0)
    expect(inspected.text).toContain('Source')
    expect(inspected.text).toContain('PDF')
    for (const name of ['Source', 'PDF']) {
      const label = inspected.markdownPresentation.svgLabels.find(
        (candidate) => candidate.text === name,
      )
      expect(label).toBeDefined()
      expect(label!.height).toBeGreaterThan(0)
      expect(label!.fill).not.toBe('rgb(255, 255, 255)')
    }
  }
  const downloaded = await resolveExportHtml('artifact-1', data)
  expect(downloaded).toContain('data-code-copy')
  expect(downloaded).toContain('<details class="md-toc-mobile">')
  expect(downloaded).toContain('prefers-color-scheme: dark')
}, 30000)

test.each([32, 65])(
  'transformed inline SVG charges its final embedded output (%i MiB)',
  async (size) => {
    const { prepareExportDocument } =
      await import('./+components/export-resources')
    const { PDF_FIXTURE_IMAGE } =
      await import('~/services/dev-pdf-export-fixtures')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><image href="${PDF_FIXTURE_IMAGE}" width="80" height="40"/></svg>`
    const uri = 'data:image/svg+xml,' + encodeURIComponent(svg)
    const encode = TextEncoder.prototype.encode
    // Scale only the final transformed URI's byte cost. Real SVG sanitation,
    // nested raster decoding and serialized output still run in each engine.
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(
      function (this: TextEncoder, input) {
        const bytes = encode.call(this, input)
        if (input?.startsWith('data:image/svg+xml;base64,'))
          Object.defineProperty(bytes, 'byteLength', {
            value: size * 1024 * 1024,
          })
        return bytes
      },
    )
    const result = prepareExportDocument(
      'artifact-1',
      source(`<img src="${uri}">`),
      AbortSignal.timeout(10000),
    )
    if (size === 32)
      expect((await result).querySelector('img')!.getAttribute('src')).toMatch(
        /^data:image\/svg\+xml;base64,/,
      )
    else await expect(result).rejects.toThrow('embedded resource budget')
  },
  15000,
)

test('picture-selected images decode even when the fallback src is a placeholder', async () => {
  const { PDF_FIXTURE_IMAGE } =
    await import('~/services/dev-pdf-export-fixtures')
  const printed = await print(
    source(
      `<picture><source srcset="${PDF_FIXTURE_IMAGE}"><img src="#" alt="Selected image"></picture>`,
    ),
  )
  expect(printed).toHaveBeenCalledOnce()
  expect((await server.commands.inspectExportPdf()).imageLoaded).toBe(true)
}, 15000)

test.each(['img', 'picture', 'fallback'])(
  'real image candidates survive placeholder normalization: %s',
  async (kind) => {
    const { PDF_FIXTURE_IMAGE } =
      await import('~/services/dev-pdf-export-fixtures')
    const html =
      kind === 'img'
        ? `<img src="#" srcset="# 2x, ${PDF_FIXTURE_IMAGE} 1x">`
        : kind === 'picture'
          ? `<picture><source srcset="# 2x, ${PDF_FIXTURE_IMAGE} 1x"><img src="#"></picture>`
          : `<picture><source srcset="# 1x, #other 2x"><img src="${PDF_FIXTURE_IMAGE}"></picture>`
    const printed = await print(source(html))
    expect(printed).toHaveBeenCalledOnce()
    expect((await server.commands.inspectExportPdf()).imageLoaded).toBe(true)
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
  15000,
)

test.each(
  ['.5x', '1e0x', '1E+0x', '1e-1x', '-0x'].flatMap((descriptor) =>
    ['img', 'picture'].flatMap((kind) =>
      [false, true].map((mixed) => ({ descriptor, kind, mixed })),
    ),
  ),
)(
  'prints valid density $descriptor in $kind with fragment placeholders: $mixed',
  async ({ descriptor, kind, mixed }) => {
    const { PDF_FIXTURE_IMAGE } =
      await import('~/services/dev-pdf-export-fixtures')
    const candidates = `${mixed ? '#placeholder 2x, ' : ''}${PDF_FIXTURE_IMAGE} ${descriptor}`
    const html =
      kind === 'img'
        ? `<img srcset="${candidates}">`
        : `<picture><source srcset="${candidates}"><img src="#"></picture>`
    const printed = await print(source(html))
    expect(printed).toHaveBeenCalledOnce()
    expect(popup!.document.body.dataset.exportState).toBe('ready')
    // Real helper readiness awaits image.decode(); density-corrected intrinsic
    // dimensions are not a decode oracle for a valid zero-density candidate.
    expect(popup!.document.querySelector('iframe')!.srcdoc).toContain(
      `${PDF_FIXTURE_IMAGE} ${descriptor}`,
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
  15000,
)

test.each([
  '<img srcset="# 2x, data:image/png;base64,Y29ycnVwdA== 1x">',
  '<picture><source srcset="# 2x, data:image/png;base64,Y29ycnVwdA== 1x"><img src="#"></picture>',
  '<img srcset="# 2x, /missing.png 1x">',
  '<picture><source srcset="# 2x, /missing.png 1x"><img src="#"></picture>',
  '<img srcset="# 2x, /api/private 1x">',
  ...[
    '1q',
    '0w',
    '00w',
    '0.5w',
    '1.5w',
    '1.0w',
    '+1x',
    '1.x',
    '-1x',
    'NaNx',
    '1e309x',
  ].flatMap((descriptor) => [
    `<img srcset="# ${descriptor}">`,
    `<picture><source srcset="# ${descriptor}"><img src="#"></picture>`,
  ]),
])(
  'invalid or required real candidates still fail: %s',
  async (html) => {
    const data = source(html)
    await server.commands.exportPdfObservation('start', data)
    popup = await openPopup()
    const printed = vi.spyOn(popup!, 'print').mockImplementation(() => {})
    await expect(
      writePrintPdf(popup!, 'artifact-1', data, labels),
    ).rejects.toThrow()
    expect(printed).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
  },
  15000,
)

test('corrupt required picture candidates still fail preparation', async () => {
  const data = source(
    '<picture><source srcset="data:image/png;base64,Y29ycnVwdA=="><img alt="Required image"></picture>',
  )
  await server.commands.exportPdfObservation('start', data)
  popup = await openPopup()
  const printed = vi.spyOn(popup!, 'print').mockImplementation(() => {})
  await expect(
    writePrintPdf(popup!, 'artifact-1', data, labels),
  ).rejects.toThrow()
  expect(printed).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
}, 15000)

test('an unmatched picture source leaves a harmless placeholder', async () => {
  const { PDF_FIXTURE_IMAGE } =
    await import('~/services/dev-pdf-export-fixtures')
  const printed = await print(
    source(
      `<picture><source media="(min-width:99999px)" srcset="${PDF_FIXTURE_IMAGE}"><img alt="Placeholder"></picture>`,
    ),
  )
  expect(printed).toHaveBeenCalledOnce()
  expect((await server.commands.inspectExportPdf()).imageHeights).toEqual([0])
}, 15000)

test.each([
  'base64-fragment',
  'percent-fragment',
  'base64',
  'raw-percent',
  'escaped-percent',
])(
  'inline SVG data URL round trips through actual print preparation: %s',
  async (encoding) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><style>text{font-family:"A&amp;B"}</style><rect width="100%" height="100%" fill="red"/><text y="90">Safe\u00a0text</text></svg>`
    const fragment = encoding.endsWith('-fragment')
      ? '#svgView(viewBox(0,0,50,50))'
      : ''
    const base64 = encoding.startsWith('base64')
    const payload = base64
      ? btoa(unescape(encodeURIComponent(svg)))
      : encoding === 'raw-percent'
        ? svg.replaceAll('"', "'")
        : encodeURIComponent(svg)
    const uri = `data:image/svg+xml${base64 ? ';base64' : ''},${payload}${fragment}`
    // A real browser decode is the positive control for each source encoding.
    const original = new Image()
    original.src = uri
    await original.decode()
    const printed = await print(
      source(`<img src="${uri}"><p>Safe SVG report</p>`),
    )
    expect(printed).toHaveBeenCalledOnce()
    const inspected = await server.commands.inspectExportPdf(
      false,
      'light',
      true,
    )
    expect(inspected.imageLoaded).toBe(true)
    const prepared = inspected.imageSources[0]
    expect(new URL(prepared).hash).toBe(fragment)
    const xml = new TextDecoder().decode(
      Uint8Array.from(atob(prepared.split(',')[1].split('#')[0]), (c) =>
        c.charCodeAt(0),
      ),
    )
    expect(xml).not.toContain('&nbsp;')
    expect(xml).toContain('\u00a0')
    expect(
      new DOMParser()
        .parseFromString(xml, 'image/svg+xml')
        .querySelector('parsererror'),
    ).toBeNull()
    const screenshot = new Image()
    screenshot.src = `data:image/png;base64,${inspected.imageScreenshots[0]}`
    await screenshot.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.drawImage(screenshot, 0, 0)
    expect(Array.from(context.getImageData(0, 0, 1, 1).data)).toEqual([
      255, 0, 0, 255,
    ])
  },
  15000,
)

test.each(['100%', '100%25'])(
  'print embeds CSS data URLs with %s lengths',
  async (width) => {
    await print(
      source(
        `<link rel="stylesheet" href="data:text/css,h1{width:${width};color:rgb(255,0,0)}"><h1>Percent CSS</h1>`,
      ),
    )
    expect((await server.commands.inspectExportPdf()).color).toBe(
      'rgb(255, 0, 0)',
    )
  },
)

test.each([1800, 41000])(
  'root generated final content fits the printed frame (%i pixels)',
  async (height) => {
    await print(
      source(
        `<style>html::after{display:block;padding-top:${height}px;content:'FINAL-PDF-MARKER'}</style><p>Short body</p>`,
      ),
    )
    const frame = popup!.document.querySelector('iframe')!
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.rootAfterContent).toContain('FINAL-PDF-MARKER')
    expect(parseFloat(frame.style.height)).toBeGreaterThan(height)
    expect(parseFloat(frame.style.height)).toBeGreaterThanOrEqual(
      inspected.rootScrollHeight,
    )
    if (height > 32000)
      expect(
        popup!.document.getElementById('artifactshare-print-status')!
          .textContent,
      ).toBe(labels.heightLimited)
  },
)

test.each(['absolute', 'fixed-descendant', 'fixed-flow-offset'])(
  'viewport anchored %s stabilizes without hiding ordinary content',
  async (kind) => {
    const anchored =
      '<div style="position:absolute;bottom:-80px">Anchored marker</div>'
    await print(
      source(
        `<p>Ordinary marker</p>${kind === 'absolute' ? anchored : kind === 'fixed-descendant' ? `<div style="position:fixed;bottom:0">${anchored}</div>` : '<div style="position:fixed;bottom:-80px"><div>Anchored marker</div></div>'}`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    // Resolved CSS offsets can round a fraction of a pixel before the helper
    // rounds the final paper extent up to an integer. Never clip that fraction.
    expect(height).toBeGreaterThanOrEqual(840)
    expect(height).toBeLessThanOrEqual(841)
    expect(
      (await server.commands.inspectExportPdf(true)).layoutHeight,
    ).toBeLessThanOrEqual(height)
    expect((await server.commands.inspectExportPdf()).text).toContain(
      'Ordinary marker',
    )
  },
)

test.each([
  '<div style="position:relative;height:100%">CONTENT</div>',
  '<div style="position:absolute;inset:0"><div style="position:relative;height:100%">CONTENT</div></div>',
])(
  'fixed shell with intermediate containing blocks prints completely: %s',
  async (wrapper) => {
    const anchored =
      '<div style="position:absolute;bottom:-80px">Anchored marker</div>'
    const printed = await print(
      source(
        `<p>Ordinary marker</p><div style="position:fixed;inset:0">${wrapper.replace('CONTENT', anchored)}</div>`,
      ),
    )
    expect(printed).toHaveBeenCalledOnce()
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(height).toBeGreaterThanOrEqual(840)
    expect(height).toBeLessThanOrEqual(841)
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.layoutHeight).toBeLessThanOrEqual(height)
    expect(inspected.text).toContain('Ordinary marker')
    expect(inspected.text).toContain('Anchored marker')
  },
)

test('whitespace Mermaid preserves visible source in PDF and HTML alongside a valid diagram', async () => {
  const { resolveExportHtml } = await import('./+components/export-actions')
  const data: ExportSourceData = {
    ...source(''),
    kind: 'markdown',
    artifactKind: 'markdown_page',
    source: '```mermaid\n   \n```',
    renderedHtml:
      '<body data-artifact-markdown><pre><code class="language-mermaid">   \n\t</code></pre><pre><code class="language-mermaid">flowchart LR\nA --> B</code></pre><p>Report marker</p></body>',
  }
  await print(data)
  const inspected = await server.commands.inspectExportPdf()
  expect(inspected.svgCount).toBe(1)
  expect(inspected.text).toContain('Report marker')
  const downloaded = await resolveExportHtml('artifact-1', data)
  expect(downloaded).toContain('language-mermaid')
  expect(downloaded).toContain('<svg')
  expect(downloaded).toContain('Report marker')
}, 30000)

test('foreign namespace serialization cannot recreate refresh navigation', async () => {
  await print(
    source(
      `<p>Safe report marker</p><form><math><mtext></form><form><mglyph><style></math><meta http-equiv="refresh" content="0;url=https://example.com/pdf-fixture/refresh">`,
    ),
  )
  const inspected = await server.commands.inspectExportPdf()
  expect(inspected.activeNavigationCount).toBe(0)
  expect(inspected.text).toContain('Safe report marker')
  expect(await server.commands.exportPdfObservation('external')).toEqual([])
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test('same-session eager and below-fold lazy images both decode completely', async () => {
  const { PDF_FIXTURE_IMAGE } =
    await import('~/services/dev-pdf-export-fixtures')
  for (const loading of ['eager', 'lazy']) {
    await print(
      source(
        `<div style="height:2000px">Image report</div><img loading="${loading}" src="${PDF_FIXTURE_IMAGE}"><p>Final image marker</p>`,
      ),
    )
    expect((await server.commands.inspectExportPdf()).imageLoaded).toBe(true)
    expect(
      parseFloat(popup!.document.querySelector('iframe')!.style.height),
    ).toBeGreaterThan(2000)
    popup!.close()
    await server.commands.exportPdfObservation('stop')
  }
}, 30000)

test.each(['-->', '--!>'])(
  'noscript comment serialization cannot introduce unsanitized navigation: %s',
  async (commentEnd) => {
    await print(
      source(
        `<p>Safe noscript report</p><noscript><!--<meta http-equiv="refresh" content="0;url=https://example.com/pdf-fixture/refresh"><img src="/__pdf_probe_noscript">${commentEnd}</noscript>`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf()
    expect(inspected.activeNavigationCount).toBe(0)
    expect(inspected.text).toContain('Safe noscript report')
    expect(inspected.imageSources).toEqual([])
    expect(await server.commands.exportPdfObservation('external')).toEqual([])
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test('native MathML retains fraction layout without exposing hidden annotation text', async () => {
  await print(
    source(
      `<p>Mathematical report</p><math display="block"><semantics><mfrac><mi id="numerator">x</mi><mn id="denominator">2</mn></mfrac><annotation encoding="application/x-tex">HIDDEN-TEX-ANNOTATION</annotation></semantics></math>`,
    ),
  )
  const inspected = await server.commands.inspectExportPdf()
  expect(inspected.mathLayout).toMatchObject({
    fractions: 1,
    namespace: 'http://www.w3.org/1998/Math/MathML',
  })
  expect(inspected.mathLayout.numeratorBottom).toBeLessThan(
    inspected.mathLayout.denominatorTop,
  )
  expect(inspected.text).not.toContain('HIDDEN-TEX-ANNOTATION')
  expect(inspected.text).toContain('Mathematical report')
})

test.each(
  ['div', 'body'].flatMap((tag) => [
    { tag, height: 1800, bottom: 0 },
    { tag, height: 41000, bottom: 0 },
    { tag, height: 1800, bottom: -80 },
    { tag, height: 41000, bottom: -80 },
  ]),
)(
  'fixed scrolling $tag shells retain their entire normal-flow content ($height px, bottom $bottom)',
  async ({ tag, height, bottom }) => {
    await print(
      source(
        `<${tag} style="position:fixed;inset:0;bottom:${bottom}px;overflow:auto"><main><div style="height:${height}px">Long report</div><p>FINAL-FIXED-MARKER</p></main></${tag}>`,
      ),
    )
    const frame = popup!.document.querySelector('iframe')!
    const inspected = await server.commands.inspectExportPdf(true)
    expect(parseFloat(frame.style.height)).toBeGreaterThan(height)
    expect(inspected.fixedShell).not.toBeNull()
    expect(inspected.fixedShell!.markerBottom).toBeLessThanOrEqual(
      inspected.fixedShell!.bottom,
    )
    expect(inspected.fixedShell!.markerBottom).toBeLessThanOrEqual(
      parseFloat(frame.style.height),
    )
    expect(inspected.text).toContain('FINAL-FIXED-MARKER')
    if (height > 32000)
      expect(
        popup!.document.getElementById('artifactshare-print-status')!
          .textContent,
      ).toBe(labels.heightLimited)
  },
)

test.each(['Anchored body text', '<span>Anchored body text</span>'])(
  'fixed negative-bottom body stabilizes with content: %s',
  async (content) => {
    const printed = await print(
      source(
        `<body style="position:fixed;bottom:-80px;margin:0">${content}</body>`,
      ),
    )
    expect(printed).toHaveBeenCalledOnce()
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(height).toBeGreaterThanOrEqual(840)
    expect(height).toBeLessThanOrEqual(841)
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.text).toContain('Anchored body text')
    expect(inspected.fixedElements).toHaveLength(1)
    expect(inspected.fixedElements[0].contentTop).toBeGreaterThan(760)
    expect(inspected.fixedElements[0].contentBottom).toBeLessThanOrEqual(height)
    expect(inspected.fixedElements[0].contentBottom).toBeGreaterThan(
      inspected.fixedElements[0].contentTop,
    )
    expect(inspected.layoutHeight).toBeLessThanOrEqual(height)
  },
)

test.each([40, 1800])(
  'intrinsic fixed footer stays visible and bottom-anchored with a %s px report and repeat print',
  async (reportHeight) => {
    const printed = await print(
      source(
        `<div style="height:${reportHeight}px">Report</div><p>FINAL-REPORT-MARKER</p><footer style="position:fixed;bottom:0;background:red">One-line footer</footer>`,
      ),
    )
    for (const count of [1, 2]) {
      const inspected = await server.commands.inspectExportPdf(true)
      const height = parseFloat(
        popup!.document.querySelector('iframe')!.style.height,
      )
      expect(height).toBeGreaterThan(reportHeight)
      expect(inspected.text).toContain('FINAL-REPORT-MARKER')
      expect(inspected.layoutHeight).toBeLessThanOrEqual(height)
      expect(inspected.fixedElements).toHaveLength(1)
      const footer = inspected.fixedElements[0]
      expect(footer.height).toBeGreaterThan(0)
      expect(footer.height).toBeLessThan(40)
      expect(footer.top).toBeGreaterThan(700)
      expect(footer.bottom).toBeCloseTo(760, 0)
      expect(footer.bottom).toBeLessThanOrEqual(height)
      expect(footer.contentTop).toBeGreaterThanOrEqual(footer.top)
      expect(footer.contentBottom).toBeLessThanOrEqual(footer.bottom)
      expect(printed).toHaveBeenCalledTimes(count)
      if (count === 1) {
        await server.commands.printExportPdfWithKeyboard()
        await vi.waitFor(() => expect(printed).toHaveBeenCalledTimes(2))
      }
    }
  },
)

test.each(
  ['flex', 'grid'].flatMap((layout) =>
    ['visible', 'hidden'].flatMap((overflow) =>
      [1800, 41000].map((height) => ({ layout, overflow, height })),
    ),
  ),
)(
  'fixed $layout shell with $overflow overflow expands its descendant scroller for $height px',
  async ({ layout, overflow, height }) => {
    const printed = await print(
      source(
        `<div style="position:fixed;inset:0;display:${layout};flex-direction:column;grid-template-rows:auto minmax(0,1fr);overflow:${overflow}"><header>Report header</header><main style="flex:1;min-height:0;overflow:auto"><div style="height:${height}px">Report</div><p>FINAL-NESTED-SCROLL-MARKER</p></main></div>`,
      ),
    )
    expect(printed).toHaveBeenCalledOnce()
    const inspected = await server.commands.inspectExportPdf(true)
    const frameHeight = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(inspected.text).toContain('FINAL-NESTED-SCROLL-MARKER')
    expect(frameHeight).toBeGreaterThan(height)
    expect(inspected.fixedShell).not.toBeNull()
    const shell = inspected.fixedShell!
    expect(shell.scrollHeight).toBeLessThanOrEqual(shell.clientHeight + 1)
    expect(shell.markerBottom).toBeLessThanOrEqual(shell.scrollBottom)
    expect(shell.markerBottom).toBeLessThanOrEqual(shell.bottom)
    expect(shell.markerBottom).toBeLessThanOrEqual(frameHeight)
  },
)

test.each([
  'height:100vh',
  'height:100vh;max-height:100vh',
  'height:760px;max-height:760px',
])(
  'fixed scrolling shell expands explicit viewport constraints: %s',
  async (constraint) => {
    await print(
      source(
        `<div style="position:fixed;inset:0;overflow:auto;${constraint}"><main><div style="height:41000px">Long report</div><p>FINAL-EXPLICIT-SHELL-MARKER</p></main></div>`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(inspected.text).toContain('FINAL-EXPLICIT-SHELL-MARKER')
    expect(height).toBeGreaterThan(41000)
    expect(inspected.fixedShell).not.toBeNull()
    expect(inspected.fixedShell!.markerBottom).toBeLessThanOrEqual(
      inspected.fixedShell!.bottom,
    )
    expect(inspected.fixedShell!.markerBottom).toBeLessThanOrEqual(height)
  },
)

test.each([
  'inset:0;background:#111',
  'top:0;bottom:0;left:0;width:80px;background:#111',
])(
  'fixed full-height layer keeps covering the complete report: %s',
  async (position) => {
    await print(
      source(
        `<div style="position:fixed;${position}"></div><main style="position:relative;margin-left:90px"><div style="height:41000px">Long report</div><p>FINAL-LAYER-MARKER</p></main>`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(height).toBeGreaterThan(41000)
    expect(inspected.text).toContain('FINAL-LAYER-MARKER')
    expect(inspected.fixedElements).toHaveLength(1)
    expect(inspected.fixedElements[0].top).toBeCloseTo(0, 0)
    expect(inspected.fixedElements[0].bottom).toBeCloseTo(height, 0)
  },
)

test.each(['visible', 'hidden'])(
  'intrinsic footer does not stretch for an independent %s scrolling box',
  async (visibility) => {
    await print(
      source(
        `<div style="height:1800px">Report</div><p>FINAL-FOOTER-SCROLLER-MARKER</p><footer style="position:fixed;bottom:0"><div style="height:40px;max-height:40px;overflow:auto;visibility:${visibility}"><div style="height:120px">Independent scrolling box</div></div></footer>`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.text).toContain('FINAL-FOOTER-SCROLLER-MARKER')
    expect(inspected.fixedElements).toHaveLength(1)
    expect(inspected.fixedElements[0].height).toBeCloseTo(40, 0)
    expect(inspected.fixedElements[0].bottom).toBeCloseTo(760, 0)
  },
)

test.each([
  '<p>Start</p><noscript><noscript></noscript><p id="pdf-final-marker">FINAL-PARSING-MARKER</p>',
  '<p>A</ <noscript>B</p><p id="pdf-final-marker">FINAL-PARSING-MARKER</p>',
  '<p title=<noscript>Text</p><p id="pdf-final-marker">FINAL-PARSING-MARKER</p>',
  '<noscript><!--</noscript><p id="pdf-final-marker">FINAL-PARSING-MARKER</p>',
])(
  'preserves visible trailing content across noscript token boundaries: %s',
  async (html) => {
    await print(
      source(`${html}<noscript><img src="/__pdf_probe_noscript"></noscript>`),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.text).toContain('FINAL-PARSING-MARKER')
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
      parseFloat(popup!.document.querySelector('iframe')!.style.height),
    )
    expect(inspected.imageSources).toEqual([])
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each(
  ['flow', 'footer'].flatMap((kind) =>
    [180, 3000].map((lines) => ({ kind, lines })),
  ),
)(
  'independent clipped $kind scroll box with $lines lines preserves short-page print height',
  async ({ kind, lines }) => {
    const box = `<pre style="margin:0;max-height:200px;overflow:auto"><span>${'Log line\n'.repeat(lines)}</span></pre>`
    await print(
      source(
        `<body style="margin:0">${kind === 'flow' ? box : `<footer style="position:fixed;bottom:0">${box}</footer>`}<p id="pdf-final-marker">FINAL-CLIPPED-MARKER</p></body>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    expect(height).toBeLessThanOrEqual(760)
    const inspected = await server.commands.inspectExportPdf(true)
    expect(inspected.text).toContain('FINAL-CLIPPED-MARKER')
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.top).toBeGreaterThanOrEqual(0)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
    if (kind === 'footer') {
      expect(height).toBe(760)
      expect(inspected.fixedElements[0].bottom).toBeLessThanOrEqual(height)
    }
  },
)

test.each([
  "<noscript>x</noscript ='><p id='pdf-final-marker'>FINAL-EQUALS-MARKER</p>",
  "<noscript ='><img src='/__pdf_probe_noscript'></noscript><p id='pdf-final-marker'>FINAL-EQUALS-MARKER</p>",
  "<noscript a='x'='><img src='/__pdf_probe_noscript'></noscript><p id='pdf-final-marker'>FINAL-EQUALS-MARKER</p>",
  "<noscript /='><img src='/__pdf_probe_noscript'></noscript><p id='pdf-final-marker'>FINAL-EQUALS-MARKER</p>",
])(
  'unexpected equals signs do not swallow trailing content: %s',
  async (html) => {
    const printed = await print(source(html))
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(inspected.text).toContain('FINAL-EQUALS-MARKER')
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.imageSources).toEqual([])
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each([
  '<svg><noscript></svg><p>FINAL</p>',
  '<math><noscript></math><p>FINAL</p>',
  '<svg><noscript></svg><p>FINAL</p><noscript>Fallback</noscript>',
  '<svg data=x/><noscript></svg><p>FINAL</p><noscript>Fallback</noscript>',
  '<math><noscript></math><p>FINAL</p><noscript>Fallback</noscript>',
])('foreign noscript fails preparation explicitly: %s', async (html) => {
  await expect(print(source(html))).rejects.toThrow('Foreign export noscript')
  expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
    labels.failed,
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each([
  {
    name: 'root vertical scroll',
    css: 'html{overflow-y:scroll}',
    container: '',
    position: 'absolute',
  },
  {
    name: 'root implicit vertical auto',
    css: 'html{overflow-x:hidden}',
    container: '',
    position: 'absolute',
  },
  {
    name: 'body viewport overflow',
    css: 'body{overflow-y:scroll}',
    container: '',
    position: 'absolute',
  },
  {
    name: 'absolute escaping static scroller',
    css: '',
    container: 'height:100px;overflow:auto',
    position: 'absolute',
  },
  {
    name: 'fixed escaping positioned scroller',
    css: '',
    container: 'position:relative;height:100px;overflow:auto',
    position: 'fixed',
  },
])(
  'preserves out-of-flow final content with $name',
  async ({ css, container, position }) => {
    await print(
      source(
        `<style>body{margin:0;height:100px}${css}</style><div style="${container}"><div style="position:${position};top:1800px"><p id="pdf-final-marker">FINAL-ESCAPED-MARKER</p></div></div>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(height).toBeGreaterThan(1800)
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
  },
)

test.each([
  { container: 'position:relative', position: 'absolute' },
  { container: 'transform:translateX(0)', position: 'fixed' },
])(
  'containing-block scroller still clips $position descendants',
  async ({ container, position }) => {
    await print(
      source(
        `<body style="margin:0"><div style="${container};height:200px;overflow:auto"><div style="position:${position};top:1800px"><p>Clipped scroll content</p></div></div><p id="pdf-final-marker">FINAL-VISIBLE-MARKER</p></body>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(height).toBeLessThan(760)
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
  },
)

test('foreign CDATA keeps visible text and the final HTML marker', async () => {
  await print(
    source(
      '<svg width="300" height="60"><text y="30"><![CDATA[a>b<noscript>c]]></text></svg><p id="pdf-final-marker">FINAL-CDATA-MARKER</p>',
    ),
  )
  const inspected = await server.commands.inspectExportPdf(true)
  expect(inspected.text).toContain('a>b<noscript>c')
  expect(inspected.text).toContain('FINAL-CDATA-MARKER')
  expect(inspected.finalMarker!.visible).toBe(true)
  expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
    parseFloat(popup!.document.querySelector('iframe')!.style.height),
  )
})

test.each(['auto', 'scroll', 'hidden', 'clip'])(
  'display:contents does not clip a fixed descendant marker with overflow:%s',
  async (overflow) => {
    await print(
      source(
        `<body style="margin:0;height:100px"><div style="position:fixed;top:1800px"><div style="display:contents;overflow:${overflow}"><p id="pdf-final-marker">FINAL-BOXLESS-MARKER</p></div></div></body>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(height).toBeGreaterThan(1800)
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
  },
)

test.each(
  ['hidden', 'clip'].flatMap((overflow) =>
    [0, 200].flatMap((maxHeight) =>
      [3000, 41000].map((contentHeight) => ({
        overflow,
        maxHeight,
        contentHeight,
      })),
    ),
  ),
)(
  'overflow:$overflow preview capped at $maxHeight does not print $contentHeight px of hidden content',
  async ({ overflow, maxHeight, contentHeight }) => {
    const printed = await print(
      source(
        `<body style="margin:0"><div style="max-height:${maxHeight}px;overflow:${overflow}"><div style="height:${contentHeight}px">Clipped preview</div></div><p id="pdf-final-marker">FINAL-CLIPPED-PREVIEW</p></body>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(height).toBeLessThan(760)
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
  },
)

test.each([
  '<script><!--<script></script><noscript></script><p>FINAL</p><noscript>x</noscript>',
  '<script><!--<ScRiPt type="text/plain"></script><noscript></script><p>FINAL</p><noscript>x</noscript>',
])(
  'double-escaped scripts fail explicitly before preparing incomplete content: %s',
  async (html) => {
    await expect(print(source(html))).rejects.toThrow(
      'Double-escaped export script',
    )
    expect(popup!.print).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(
      popup!.document.getElementById('artifactshare-print-status')!.textContent,
    ).toBe(labels.failed)
    expect(popup!.document.querySelector('iframe')).toBeNull()
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each([
  '<script><!-- legacy comment --></script>',
  '<script><!--><script></script>',
  '<script><!---><script></script>',
  '<script><!-- comment --><script></script>',
  '<script><!--<scripture></script>',
])('ordinary script comments preserve the final marker: %s', async (script) => {
  const printed = await print(
    source(
      `${script}<p id="pdf-final-marker">FINAL-SCRIPT-MARKER</p><noscript><img src="/__pdf_probe_noscript"></noscript>`,
    ),
  )
  const inspected = await server.commands.inspectExportPdf(true)
  expect(printed).toHaveBeenCalledOnce()
  expect(inspected.text).toContain('FINAL-SCRIPT-MARKER')
  expect(inspected.finalMarker!.visible).toBe(true)
  expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
    parseFloat(popup!.document.querySelector('iframe')!.style.height),
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each(['overflow-x:hidden', 'overflow:hidden'])(
  'root-positioned content escapes static body clipping with %s on both roots',
  async (overflow) => {
    const printed = await print(
      source(
        `<style>html,body{${overflow}}body{margin:0}</style><p>Intro</p><div style="position:absolute;top:1800px"><p id="pdf-final-marker">FINAL-ROOT-POSITIONED-MARKER</p></div>`,
      ),
    )
    const height = parseFloat(
      popup!.document.querySelector('iframe')!.style.height,
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(height).toBeGreaterThan(1800)
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.top).toBeGreaterThanOrEqual(1800)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(height)
  },
)

test.each([
  '<!DOCTYPE html PUBLIC "identifier > <noscript>" "about:legacy-compat">',
  "<!DOCTYPE html SYSTEM 'identifier > <noscript>'>",
])('quoted DOCTYPE preserves the final PDF marker: %s', async (declaration) => {
  const printed = await print(
    source(
      `${declaration}<html lang="en"><body><p id="pdf-final-marker">FINAL-DOCTYPE-MARKER</p><noscript><img src="/__pdf_probe_noscript"></noscript></body></html>`,
    ),
  )
  const inspected = await server.commands.inspectExportPdf(true)
  expect(printed).toHaveBeenCalledOnce()
  expect(inspected.text).toContain('FINAL-DOCTYPE-MARKER')
  expect(inspected.finalMarker!.visible).toBe(true)
  expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
    parseFloat(popup!.document.querySelector('iframe')!.style.height),
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each([
  'style',
  'script',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
])('foreign %s cannot prepare silently truncated content', async (tag) => {
  await expect(
    print(
      source(`<svg><${tag}></svg><noscript><style></noscript><p>FINAL</p>`),
    ),
  ).rejects.toThrow('Ambiguous foreign export text')
  expect(popup!.print).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(
    popup!.document.getElementById('artifactshare-print-status')!.textContent,
  ).toBe(labels.failed)
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each([
  '<svg><foreignObject><div><![CDATA[></div></foreignObject></svg>',
  '<svg><desc><span><![CDATA[></span></desc></svg>',
  '<math><mtext><span><![CDATA[></span></mtext></math>',
  '<math><annotation-xml encoding="text/html"><div><![CDATA[></div></annotation-xml></math>',
])(
  'integration-point CDATA cannot hide a later HTML noscript: %s',
  async (prefix) => {
    await expect(
      print(source(`${prefix}<noscript><style></noscript><p>FINAL</p>`)),
    ).rejects.toThrow('Ambiguous export CDATA')
    expect(popup!.print).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test('simple SVG styles and titles preserve sibling CDATA and the final marker', async () => {
  const printed = await print(
    source(
      '<svg width="300" height="60"><title>Report</title><style>text{fill:red}</style><text y="30"><![CDATA[<noscript>literal]]></text></svg><p id="pdf-final-marker">FINAL-FOREIGN-TEXT-MARKER</p>',
    ),
  )
  const inspected = await server.commands.inspectExportPdf(true)
  expect(printed).toHaveBeenCalledOnce()
  expect(inspected.text).toContain('<noscript>literal')
  expect(inspected.finalMarker!.visible).toBe(true)
  expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
    parseFloat(popup!.document.querySelector('iframe')!.style.height),
  )
})

test('foreign HTML error recovery fails explicitly before misreading CDATA', async () => {
  await expect(
    print(
      source(
        '<svg><p><![CDATA[></p></svg><noscript><style></noscript><p>FINAL</p>',
      ),
    ),
  ).rejects.toThrow('Ambiguous foreign export markup')
  expect(popup!.print).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each([
  '<svg><foreignObject><p>x</svg></p></foreignObject><noscript></svg>',
  '<math><mtext><p>x</math></p></mtext><noscript></math>',
])('stray ancestor close fails instead of losing FINAL: %s', async (prefix) => {
  await expect(
    print(
      source(
        `${prefix}<p>FINAL</p><noscript><img src="/__pdf_probe_noscript"></noscript>`,
      ),
    ),
  ).rejects.toThrow('Ambiguous foreign export closing tag')
  expect(popup!.print).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
    labels.failed,
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test('deep foreign input settles with localized failure and no hidden requests', async () => {
  const html = `${'<svg>'.repeat(120_000)}<!--<noscript>--><noscript><img src="/__pdf_probe_noscript"></noscript>${'</svg>'.repeat(120_000)}`
  await expect(print(source(html))).rejects.toThrow(
    'Export foreign nesting limit exceeded',
  )
  expect(popup!.print).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
    labels.failed,
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each([
  '<svg><foreignObject><div>x</foreignObject></svg></div></foreignObject>',
  '<svg><desc><div>x</desc></svg></div></desc>',
  '<math><mtext><div>x</mtext></math></div></mtext>',
  '<math><annotation-xml encoding="text/html"><div>x</annotation-xml></math></div></annotation-xml>',
  '<math><annotation-xml><div>x</div></annotation-xml><![CDATA[><svg>]]></math>',
  '<math><annotation-xml encoding="text/plain"><div>x</div></annotation-xml><![CDATA[><svg>]]></math>',
  '<math><desc><div>x</div></desc><![CDATA[><svg>]]></math>',
  '<math><title><div>x</div></title><![CDATA[><svg>]]></math>',
  ...['mi', 'mo', 'mn', 'ms', 'mtext'].map(
    (tag) => `<svg><${tag}><div>x</div></${tag}><![CDATA[><svg>]]></svg>`,
  ),
])('ambiguous integration boundaries fail explicitly: %s', async (prefix) => {
  await expect(
    print(
      source(
        `${prefix}<noscript></svg><p>FINAL</p><noscript><img src="/__pdf_probe_noscript"></noscript>`,
      ),
    ),
  ).rejects.toThrow(/Ambiguous foreign export (closing tag|markup|text)/)
  expect(popup!.print).not.toHaveBeenCalled()
  expect(popup!.document.body.dataset.exportState).toBe('failed')
  expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
    labels.failed,
  )
  expect(await server.commands.exportPdfObservation('read')).toEqual([])
})

test.each(['<?', '<!x', '</1'])(
  'unterminated bogus comment %s finishes preparation without hidden requests',
  async (opener) => {
    const printed = await print(
      source(
        `<p id="pdf-final-marker">FINAL-BOGUS-MARKER</p><noscript><img src="/__pdf_probe_noscript"></noscript>${opener.repeat(500_000)}`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test('nested SVG in MathML retains the stricter SVG sanitization pass', () => {
  const doc = inertExportDocument(
    '<math><mtext><svg><svg><text>Visible</text><a href="javascript:alert(1)">Unsafe</a></svg></svg></mtext><annotation>Hidden</annotation></math><svg><text>Sibling</text></svg>',
    true,
  )
  const sanitizer = vi.spyOn(DOMPurify, 'sanitize')
  sanitizeExportDocument(doc)
  expect(
    sanitizer.mock.calls.map(([root]) => (root as Element).localName),
  ).toEqual(['math', 'svg', 'svg'])
  expect(doc.querySelector('annotation')).toBeNull()
  expect(doc.documentElement.outerHTML).not.toContain('javascript:')
  expect(doc.body.textContent).toContain('Visible')
  expect(doc.body.textContent).toContain('Sibling')
})

test.each(['svg', 'math'])(
  'nested %s without noscript prints with bounded sanitizer work',
  async (kind) => {
    const child =
      kind === 'svg'
        ? '<g><text y="30">Visible</text></g>'
        : '<mrow><mspace width="1px" height="1px"/></mrow>'
    const html = `${`<${kind}>`.repeat(100)}${child.repeat(200)}${`</${kind}>`.repeat(100)}<p id="pdf-final-marker">FINAL-NESTED-MARKER</p>`
    const sanitizer = vi.spyOn(DOMPurify, 'sanitize')
    const printed = await print(source(html))
    const visited = sanitizer.mock.calls.reduce(
      (total, [root]) =>
        total + (root as Element).querySelectorAll('*').length + 1,
      0,
    )
    // At most two profiles over 100 roots + 400 child elements, independent
    // of nesting. The old loop submits tens of thousands of node visits.
    expect(visited).toBeGreaterThan(200)
    expect(visited).toBeLessThanOrEqual(1_000)
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each([
  ['svg', 'foreignObject', 'svg'],
  ['svg', 'desc', 'math'],
  ['math', 'mtext', 'svg'],
  ['math', 'mi', 'math'],
])(
  'rejects HTML ancestor closes across %s/%s/%s before losing FINAL',
  async (root, integration, nested) => {
    const html = `<${root}><${integration}><div><${nested}></div><section></${nested}></div></${integration}></${root}></section><![CDATA[><noscript>]]></${root}><p id="pdf-final-marker">FINAL</p><noscript><img src="/__pdf_probe_noscript"></noscript>`
    await expect(print(source(html))).rejects.toThrow(
      'Ambiguous foreign export closing tag',
    )
    expect(popup!.print).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
      labels.failed,
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each([
  ['div', 'svg'],
  ['span', 'math'],
  ['section', 'svg'],
  ['b', 'math'],
  ['custom-report', 'svg'],
])(
  'rejects closing outer HTML %s across %s before misreading CDATA',
  async (ancestor, root) => {
    const html = `<${ancestor}><${root}></${ancestor}><![CDATA[><noscript>]]></${root}><p id="pdf-final-marker">FINAL</p><noscript><img src="/__pdf_probe_noscript"></noscript>`
    await expect(print(source(html))).rejects.toThrow(
      'Ambiguous foreign export closing tag',
    )
    expect(popup!.print).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(popup!.document.querySelector('[role="status"]')!.textContent).toBe(
      labels.failed,
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each(['p', 'li'])(
  'prints long ordinary HTML with omitted %s end tags',
  async (tag) => {
    const printed = await print(
      source(
        `${`<${tag}>Report item`.repeat(300)}<svg width="300" height="60"><a><text y="30">Visible link</text></a></svg><p id="pdf-final-marker">FINAL-OPTIONAL-TAGS</p><noscript><img src="/__pdf_probe_noscript"></noscript>`,
      ),
    )
    const inspected = await server.commands.inspectExportPdf(true)
    expect(printed).toHaveBeenCalledOnce()
    expect(inspected.text).toContain('Visible link')
    expect(inspected.text).toContain('FINAL-OPTIONAL-TAGS')
    expect(inspected.finalMarker!.visible).toBe(true)
    expect(inspected.finalMarker!.bottom).toBeLessThanOrEqual(
      parseFloat(popup!.document.querySelector('iframe')!.style.height),
    )
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

test.each([
  ['<h2><svg>', 'h3'],
  ['<table><td><svg>', 'tr'],
  ['<table><td><svg>', 'tbody'],
  ['<table><svg>', 'td'],
])(
  'uncertain foreign closing tags show localized failure: %s / %s',
  async (prefix, end) => {
    await expect(
      print(
        source(
          `${prefix}</${end}></svg><p>FINAL</p><noscript>Fallback</noscript>`,
        ),
      ),
    ).rejects.toThrow('Ambiguous foreign export closing tag')
    expect(popup!.print).not.toHaveBeenCalled()
    expect(popup!.document.body.dataset.exportState).toBe('failed')
    expect(
      popup!.document.getElementById('artifactshare-print-status')!.textContent,
    ).toBe(labels.failed)
    expect(popup!.document.querySelector('iframe')).toBeNull()
    expect(await server.commands.exportPdfObservation('read')).toEqual([])
  },
)

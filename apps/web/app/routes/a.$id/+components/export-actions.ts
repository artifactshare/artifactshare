import type { ArtifactType } from '~/lib/artifact-type'
import {
  prepareExportDocument,
  loadPrintFont,
  EXPORT_TIMEOUT,
  PRINT_VIEWPORT_WIDTH,
  PRINT_VIEWPORT_HEIGHT,
  withExportDeadline,
} from './export-resources'
import { isolatedPrintHtml, installPrintRelay } from './export-print-frame'
import { exportAssetHref, exportEndpointRoot } from '~/lib/export-path'

export type ExportSourceData = {
  kind: 'markdown' | 'html'
  artifactKind: string
  path: string
  versionId: string
  source: string
  fileName: string
  renderedHtml?: string
}

export type ExportPrintLabels = {
  savePdf: string
  backgroundHint: string
  preparing: string
  failed?: string
  heightLimited: string
}

const READABILITY_BASE_ORIGIN = 'https://artifactshare.local'
const PRINT_PAGE_WIDTH = PRINT_VIEWPORT_WIDTH
const PRINT_HEIGHT_EXTRA = 760
const PRINT_HEIGHT_LIMIT = 32_000

export function artifactSupportsExport(
  renderType: ArtifactType | null,
): boolean {
  return (
    renderType === 'html' || renderType === 'md' || renderType === 'static_site'
  )
}

export function defaultExportPath(
  entrypointPath: string | null | undefined,
  renderType: ArtifactType | null,
): string {
  const fallback = renderType === 'md' ? '/index.md' : '/index.html'
  return normalizeExportPath(entrypointPath, fallback)
}

export function normalizeExportPath(
  path: string | null | undefined,
  defaultPath = '/index.html',
): string {
  const stripped = stripQueryAndHash(String(path ?? '').trim())
  if (!stripped || stripped === '/') return defaultPath
  return stripped.startsWith('/') ? stripped : `/${stripped}`
}

export function normalizeStaticSiteFramePath(pathname: string): string {
  const decoded = decodePath(pathname)
  if (!decoded || decoded === '/') return '/index.html'
  return decoded.startsWith('/') ? decoded : `/${decoded}`
}

export function markdownDownloadFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '') || 'export'
  return `${stem}.md`
}

export function htmlDownloadFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '') || 'export'
  return `${stem}.html`
}

export function resolveExportHtml(
  shareableId: string,
  data: ExportSourceData,
): Promise<string | null> {
  const source = data.kind === 'markdown' ? data.renderedHtml : data.source
  if (!source?.trim()) return Promise.resolve(null)
  return withExportDeadline(async (signal) => {
    const doc = await prepareExportDocument(shareableId, data, signal)
    // This access check must happen after the last acquisition/rendering await.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const current = await fetchExportSource(
      shareableId,
      data.path,
      data.versionId,
      signal,
    )
    if (!current.ok) throw new Error('Export snapshot unavailable')
    return `<!doctype html>\n${doc.documentElement.outerHTML}`
  })
}

async function fetchSource(
  shareableId: string,
  path: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; data: ExportSourceData }
  | { ok: false; reason: 'unsupported' | 'failed' }
> {
  const url = new URL(
    `${exportEndpointRoot(shareableId)}/export-source`,
    window.location.origin,
  )
  url.searchParams.set('path', path)
  if (versionId) url.searchParams.set('versionId', versionId)

  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal,
    })
  } catch {
    return { ok: false, reason: 'failed' }
  }

  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      error?: string | { code?: string }
    } | null
    const code =
      typeof body?.error === 'string' ? body.error : body?.error?.code
    if (code === 'unsupported-kind') {
      return { ok: false, reason: 'unsupported' }
    }
  }

  if (!response.ok || response.redirected)
    return { ok: false, reason: 'failed' }

  const data = (await response
    .json()
    .catch(() => null)) as ExportSourceData | null
  if (
    !data?.versionId ||
    (versionId && data.versionId !== versionId) ||
    !data?.source ||
    (data.kind !== 'markdown' && data.kind !== 'html')
  ) {
    return { ok: false, reason: 'failed' }
  }

  return { ok: true, data }
}

export function fetchExportSource(
  shareableId: string,
  path: string,
  versionId?: string,
  signal?: AbortSignal,
) {
  return signal
    ? fetchSource(shareableId, path, versionId, signal)
    : withExportDeadline((active) =>
        fetchSource(shareableId, path, versionId, active),
      )
}

export function resolveExportMarkdown(
  data: ExportSourceData,
): Promise<string | null> {
  if (data.kind === 'markdown') {
    const markdown = data.source.trim()
    return Promise.resolve(markdown.length > 0 ? markdown : null)
  }
  return extractMarkdownInBrowser(data.source, data.path)
}

export async function extractMarkdownInBrowser(
  sourceHtml: string,
  path: string,
): Promise<string | null> {
  const [{ Readability }, { default: TurndownService }] = await Promise.all([
    import('@mozilla/readability'),
    import('turndown'),
  ])
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html')
  setReadabilityBase(doc, path)
  const article = new Readability(doc.cloneNode(true) as Document, {
    charThreshold: 100,
  }).parse()
  if (!article?.content?.trim()) return null
  const markdown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
  })
    .turndown(article.content)
    .trim()
  if (!markdown) return null
  return normalizeReadabilityUrls(markdown, path)
}

export function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const printDocuments = new WeakMap<Window, Document>()

export function openPrintWindow(labels?: ExportPrintLabels): Window | null {
  const popup = window.open('', '_blank')
  if (popup) {
    popup.opener = null
    printDocuments.set(popup, popup.document)
    if (labels) installPrintChrome(popup.document, labels)
  }
  return popup
}

export async function writePrintPdf(
  printWindow: Window,
  shareableId: string,
  data: ExportSourceData,
  labels: ExportPrintLabels,
) {
  const target = printDocuments.get(printWindow) ?? printWindow.document
  if (printWindow.closed || printWindow.document !== target)
    throw new Error('Print window navigated')
  printWindow.opener = null
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), EXPORT_TIMEOUT)
  const alive = () => {
    try {
      return !printWindow.closed && printWindow.document === target
    } catch {
      return false
    }
  }
  const shell = document.implementation.createHTMLDocument('')
  installPrintChrome(shell, labels)
  target.replaceChild(
    target.importNode(shell.documentElement, true),
    target.documentElement,
  )
  const button = target.getElementById(
    'artifactshare-print-button',
  ) as HTMLInputElement
  button.disabled = true
  target.body.dataset.exportState = 'preparing'
  const status = target.getElementById('artifactshare-print-status')!
  const frame = createPrintFrame(target, data.fileName)
  const channel = crypto.randomUUID()
  const removeRelay = installPrintRelay(target, frame, channel)
  let sequence = 0
  let busy = false
  let disposed = false
  let rejectMeasurement: ((error: Error) => void) | undefined
  let receive: ((event: MessageEvent) => void) | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    removeRelay()
    controller.abort()
    window.clearTimeout(timer)
    window.clearInterval(watch)
    if (receive) printWindow.removeEventListener('message', receive)
    rejectMeasurement?.(new Error('Print window disposed'))
    button.removeEventListener('click', repeat)
    printWindow.removeEventListener('pagehide', dispose)
  }
  controller.signal.addEventListener(
    'abort',
    () => rejectMeasurement?.(new Error('Print preparation cancelled')),
    { once: true },
  )
  const watch = window.setInterval(() => {
    if (!alive()) dispose()
  }, 200)
  printWindow.addEventListener('pagehide', dispose, { once: true })
  const measure = (signal: AbortSignal) =>
    new Promise<number>((resolve, reject) => {
      const current = ++sequence
      const timeout = window.setTimeout(
        () => finish(new Error('Print layout timeout')),
        10_000,
      )
      const finish = (result: number | Error) => {
        window.clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        if (receive) printWindow.removeEventListener('message', receive)
        receive = undefined
        rejectMeasurement = undefined
        if (typeof result === 'number') resolve(result)
        else reject(result)
      }
      const abort = () => finish(new Error('Print measurement cancelled'))
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      rejectMeasurement = (error) => finish(error)
      receive = (event) => {
        if (
          event.source !== frame.contentWindow ||
          event.origin !== 'null' ||
          event.data?.channel !== channel ||
          event.data?.sequence !== current
        )
          return
        if (event.data.kind === 'failed')
          return finish(new Error('Print resources failed'))
        if (
          event.data.kind !== 'measured' ||
          !Number.isFinite(event.data.height) ||
          event.data.height <= 0 ||
          event.data.height > 2_000_000
        )
          return
        finish(event.data.height)
      }
      printWindow.addEventListener('message', receive)
      printWindow.postMessage(
        { kind: 'measure', channel, sequence: current },
        window.location.origin,
      )
    })
  const waitForLayout = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      let first = 0
      let second = 0
      const abort = () => {
        printWindow.cancelAnimationFrame(first)
        printWindow.cancelAnimationFrame(second)
        reject(new Error('Print layout cancelled'))
      }
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      first = printWindow.requestAnimationFrame(() => {
        second = printWindow.requestAnimationFrame(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
    })
  const print = async () => {
    if (busy || disposed) return
    busy = true
    button.disabled = true
    const operation = new AbortController()
    const deadline = window.setTimeout(() => operation.abort(), 40_000)
    const signal = AbortSignal.any([controller.signal, operation.signal])
    try {
      if (!alive()) throw new Error('Print window closed')
      let height = 0
      let stable = false
      // Resizing changes viewport units and height/orientation media queries.
      // Only print a layout measured again at its final iframe dimensions.
      for (let pass = 0; pass < 8; pass++) {
        signal.throwIfAborted()
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const measured = await measure(signal)
        if (measured === height) {
          stable = true
          break
        }
        height = measured
        frame.style.height = `${height}px`
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await waitForLayout(signal)
      }
      if (!stable) throw new Error('Print layout did not stabilize')
      const check = await fetchExportSource(
        shareableId,
        data.path,
        data.versionId,
        signal,
      )
      if (!check.ok || !alive() || disposed)
        throw new Error('Export snapshot unavailable')
      frame.style.height = `${height}px`
      const paperHeight = height + PRINT_HEIGHT_EXTRA
      target.getElementById(
        'artifactshare-client-print-dynamic-style',
      )!.textContent =
        `@media print { @page { margin:0; size:${paperHeight > PRINT_HEIGHT_LIMIT ? 'auto' : `${PRINT_PAGE_WIDTH}px ${paperHeight}px`}; } }`
      target.body.dataset.exportState =
        paperHeight > PRINT_HEIGHT_LIMIT ? 'height-limited' : 'ready'
      status.textContent =
        paperHeight > PRINT_HEIGHT_LIMIT ? labels.heightLimited : ''
      printWindow.print()
    } finally {
      window.clearTimeout(deadline)
      operation.abort()
      busy = false
      if (!disposed) button.disabled = false
    }
  }
  const failure = () => {
    if (alive()) {
      target.body.dataset.exportState = 'failed'
      status.textContent = labels.failed ?? labels.preparing
      button.disabled = true
      frame.remove()
    }
    dispose()
  }
  function repeat() {
    void print().catch(failure)
  }
  try {
    const doc = await prepareExportDocument(
      shareableId,
      data,
      controller.signal,
      true,
    )
    const { PRINT_FONT_STYLE } = await loadPrintFont()
    if (!alive() || disposed || controller.signal.aborted)
      throw new Error('Print window closed')
    const fonts = target.createElement('style')
    fonts.textContent = PRINT_FONT_STYLE
    target.head.appendChild(fonts)
    await new Promise<void>((resolve, reject) => {
      // about:blank can fire load before the srcdoc helper is listening. Only
      // the nonce helper in the expected opaque frame can acknowledge startup.
      const timeout = window.setTimeout(
        () => finish(new Error('Print frame startup timeout')),
        10_000,
      )
      const finish = (error?: Error) => {
        window.clearTimeout(timeout)
        controller.signal.removeEventListener('abort', abort)
        printWindow.removeEventListener('message', ready)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(new Error('Print preparation timeout'))
      const ready = (event: MessageEvent) => {
        if (
          event.source === frame.contentWindow &&
          event.origin === 'null' &&
          event.data?.channel === channel &&
          event.data?.sequence === 0 &&
          event.data?.kind === 'ready'
        )
          finish()
      }
      controller.signal.addEventListener('abort', abort, { once: true })
      printWindow.addEventListener('message', ready)
      frame.srcdoc = isolatedPrintHtml(doc, channel)
      target.body.appendChild(frame)
    })
    button.addEventListener('click', repeat)
    await print()
    window.clearTimeout(timer)
  } catch (error) {
    failure()
    throw error
  }
}

export async function buildPrintDocument(
  shareableId: string,
  data: ExportSourceData,
  labels: ExportPrintLabels,
): Promise<Document> {
  const doc = document.implementation.createHTMLDocument('')
  installPrintChrome(doc, labels)
  const frame = createPrintFrame(doc, data.fileName)
  frame.srcdoc = isolatedPrintHtml(
    await withExportDeadline((signal) =>
      prepareExportDocument(shareableId, data, signal, true),
    ),
    crypto.randomUUID(),
  )
  const { PRINT_FONT_STYLE } = await loadPrintFont()
  const fonts = doc.createElement('style')
  fonts.textContent = PRINT_FONT_STYLE
  doc.head.appendChild(fonts)
  doc.body.appendChild(frame)
  return doc
}

function createPrintFrame(doc: Document, title: string): HTMLIFrameElement {
  // Unlike JSX, the DOM API cannot take a sandbox prop at construction. Set
  // the sandbox before assigning content or attaching this node to any tree.
  // react-doctor-disable-next-line react-doctor/iframe-missing-sandbox
  const frame = doc.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = title
  frame.setAttribute('tabindex', '-1')
  frame.setAttribute('inert', '')
  frame.style.cssText = `display:block;border:0;width:${PRINT_VIEWPORT_WIDTH}px;height:${PRINT_VIEWPORT_HEIGHT}px;margin:8px auto 0;pointer-events:none;`
  return frame
}

function installPrintChrome(doc: Document, labels: ExportPrintLabels) {
  const csp = doc.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  doc.head.appendChild(csp)
  const brandMarkUri =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='357.22 354.97 539.12 539.12'%3E%3Cpath fill='%23F76B58' d='M473.7 355.404C492.329 354.467 518.221 355.342 537.528 355.346L664.857 355.342 744.53 355.322C758.365 355.32 781.891 354.646 794.68 356.84 814.258 360.247 832.577 368.799 847.761 381.618 870.909 400.841 886.232 428.791 889.234 458.874 889.99 466.447 889.721 476.442 889.723 484.264L889.707 523.333 889.694 646.17 889.696 743.131C889.698 756.565 890.454 784.421 888.465 796.608 885.102 817.301 876.173 836.689 862.635 852.696 841.224 878.324 814.191 890.952 781.434 893.88L565.737 893.959 503.207 893.994C488.842 893.998 472.593 894.674 458.537 892.317 438.796 889.007 418.763 878.481 403.763 865.457 382.223 846.94 365.658 816.682 364.362 787.897 363.289 764.083 363.872 738.745 363.893 714.722L363.901 584.398 363.884 503.047C363.882 489.206 363.172 464.523 365.493 451.533 369.257 430.264 378.813 410.445 393.111 394.255 414.518 370.051 441.638 357.245 473.7 355.404Z'/%3E%3Cpath fill='%23F9F6F2' d='M541.413 517.037C551.831 516.276 562.305 516.897 572.56 518.885 588.67 522.044 604.109 528.889 615.98 540.414 657.87 581.083 624.348 639.167 646.741 671.649 656.823 686.274 676.078 691.85 692.692 694.699 708.04 697.331 736.423 699.548 749.683 689.685 754.033 686.449 756.98 681.684 757.607 676.246 759.781 657.407 727.749 651.942 714.462 648.22 706.498 645.988 698.589 643.595 690.922 640.468 679.054 635.628 668.153 628.987 659.921 619.001 650.03 607.001 646.123 591.049 647.686 575.699 649.433 559.59 657.556 544.852 670.242 534.773 706.622 505.357 773.816 512.758 802.603 549.634 805.783 553.708 811.591 559.82 810.994 565.023 809.231 568.312 780.652 588.946 775.987 591.585 768.63 584.162 766.236 578.474 756.905 570.771 744.155 560.246 711.674 555.844 702.176 571.679 686.313 598.126 743.074 604.594 758.24 610.618 769.805 615.211 776.876 617.391 787.856 625.078 804.114 637.719 812.899 654.617 811.928 675.459 809.264 732.69 750.809 745.568 703.518 742.414 664.873 739.836 629.023 734.456 601.355 704.205 588.631 721.307 573.424 732.782 552.777 738.684 515.018 749.478 462.653 740.219 450.647 697.088 446.328 681.573 447.558 663.093 455.81 649.078 481.51 605.431 539.111 607.646 582.205 596.011 582.084 592.818 582.01 588.707 581.305 585.773 573.376 552.76 522.899 558.305 510.313 584.868 508.736 588.196 506.33 592.305 504.4 595.282L504.025 595.852C503.551 595.746 503.078 595.633 502.607 595.512 496.392 593.865 457.668 581.89 455.629 578.416 455.444 571.268 465.999 555.263 470.892 549.698 489.759 528.24 513.675 519.243 541.413 517.037Z'/%3E%3Cpath fill='%23F76B58' d='M579.612 638.78C581.407 638.551 580.622 638.317 582.081 639.158 584.565 648.251 581.017 664.406 576.409 672.672 565.116 692.926 535.557 703.893 514.612 692.012 505.116 685.676 502.56 672.802 509.072 664.223 521.965 647.235 560.399 642.884 579.612 638.78Z'/%3E%3C/svg%3E"

  const baseStyle = `
:root {
  color-scheme: light;
  background: #fff;
}
html,
body {
  background: #fff !important;
  color: #37352f;
  font-family: ArtifactSharePrintJP, sans-serif !important;
  margin: 0 !important;
  min-height: 0 !important;
}
img,
svg,
canvas,
video {
  max-width: 100%;
}
.asx-print-toolbar {
  align-items: center;
  background: #fff;
  border-bottom: 1px solid rgba(55, 53, 47, 0.1);
  box-shadow: rgba(15, 15, 15, 0.04) 0px 1px 2px;
  color: #37352f;
  display: flex;
  flex-wrap: wrap;
  font: 13px/1.35 system-ui, sans-serif;
  gap: 12px;
  left: 0;
  padding: 8px 12px;
  position: sticky;
  right: 0;
  top: 0;
  z-index: 1;
  box-sizing: border-box;
  width: 100%;
}
.asx-print-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  white-space: nowrap;
}
.asx-print-mark {
  width: 16px;
  height: 16px;
  background-image: url("${brandMarkUri}");
  background-size: contain;
  background-repeat: no-repeat;
  border-radius: 4px;
  flex-shrink: 0;
}
.asx-print-spacer {
  flex: 1;
}
.asx-print-action {
  background: #1766ad;
  border: 0;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font: 600 12px/1 system-ui, sans-serif;
  padding: 8px 12px;
  white-space: nowrap;
}
.asx-print-action:focus-visible { outline: 2px solid #1766ad; outline-offset: 3px; }
.asx-print-action:disabled { opacity: 0.6; cursor: wait; }
.asx-print-action:hover {
  background: #125892;
}
#artifactshare-print-status {
  color: rgba(55, 53, 47, 0.65);
  font-size: 12px;
}
#artifactshare-print-status:empty {
  display: none;
}
.asx-print-hint {
  color: rgba(55, 53, 47, 0.65);
  font-size: 12px;
}
@media screen {
  body {
    margin: 0 auto 24px !important;
  }
}
@media print {
  @page {
    margin: 0;
    size: ${PRINT_PAGE_WIDTH}px 4000px;
  }
  .asx-print-toolbar {
    display: none !important;
  }
  iframe { margin: 0 !important; }
  html,
  body {
    height: auto !important;
    overflow: visible !important;
    width: ${PRINT_PAGE_WIDTH}px !important;
  }
}
`

  const baseStyleElement = doc.createElement('style')
  baseStyleElement.id = 'artifactshare-client-print-base-style'
  baseStyleElement.textContent = baseStyle
  const dynamicStyle = doc.createElement('style')
  dynamicStyle.id = 'artifactshare-client-print-dynamic-style'
  doc.head.insertBefore(dynamicStyle, doc.head.firstChild)
  doc.head.insertBefore(baseStyleElement, doc.head.firstChild)
  doc.head.insertBefore(csp, doc.head.firstChild)

  const toolbar = doc.createElement('div')
  toolbar.className = 'asx-print-toolbar'

  const brand = doc.createElement('div')
  brand.className = 'asx-print-brand'
  const mark = doc.createElement('span')
  mark.className = 'asx-print-mark'
  const brandName = doc.createElement('span')
  brandName.textContent = 'Artifact Share'
  brand.appendChild(mark)
  brand.appendChild(brandName)

  const status = doc.createElement('span')
  status.id = 'artifactshare-print-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = labels.preparing

  const spacer = doc.createElement('span')
  spacer.className = 'asx-print-spacer'

  const hint = doc.createElement('span')
  hint.className = 'asx-print-hint'
  hint.textContent = labels.backgroundHint

  const button = doc.createElement('input')
  button.type = 'button'
  button.id = 'artifactshare-print-button'
  button.className = 'asx-print-action'
  button.value = labels.savePdf
  button.disabled = true
  doc.body.dataset.exportState = 'preparing'

  toolbar.appendChild(brand)
  toolbar.appendChild(status)
  toolbar.appendChild(spacer)
  toolbar.appendChild(hint)
  toolbar.appendChild(button)
  doc.body.insertBefore(toolbar, doc.body.firstChild)
}

function setReadabilityBase(doc: Document, path: string) {
  doc.querySelectorAll('base').forEach((node) => {
    node.remove()
  })
  const head = doc.querySelector('head') ?? doc.documentElement
  const base = doc.createElement('base')
  base.href = `${READABILITY_BASE_ORIGIN}${sourceDirectory(path)}`
  head.insertBefore(base, head.firstChild)
}

export function normalizeReadabilityUrls(
  markdown: string,
  path: string,
): string {
  const base = `${READABILITY_BASE_ORIGIN}${sourceDirectory(path)}`
  return markdown
    .replaceAll(base, '')
    .replaceAll(`${READABILITY_BASE_ORIGIN}/`, '/')
}

export function sourceDirectory(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const slashIndex = normalized.lastIndexOf('/')
  return normalized.slice(0, slashIndex + 1)
}

export function assetRouteHref(
  shareableId: string,
  path: string,
  versionId: string,
  origin = window.location.origin,
): string {
  return exportAssetHref(shareableId, versionId, path, origin)
}

export { splitAssetRef } from '~/lib/asset-ref'

export function isRootRelativeAssetRef(
  value: string | null | undefined,
): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'))
}

export function sanitizePrintSrcset(value: string): string {
  return value
    .split(',')
    .flatMap((candidate) => {
      const trimmed = candidate.trim()
      const [url, ...descriptors] = trimmed.split(/\s+/)
      if (!url || !isSafePrintUrl(url)) return []
      return [[url, ...descriptors].join(' ')]
    })
    .join(', ')
}

export function containsUnsafeCssUrl(value: string): boolean {
  return /url\(\s*["']?\s*(?:javascript|vbscript):/i.test(value)
}

export function containsAppOriginCssUrl(
  value: string,
  appOrigin: string,
): boolean {
  return new RegExp(
    String.raw`url\(\s*["']?\s*${escapeRegExp(appOrigin)}(?:[/#?)]|$)`,
    'i',
  ).test(value)
}

export function stripAppOriginSrcset(value: string, appOrigin: string): string {
  return value
    .split(',')
    .flatMap((candidate) => {
      const trimmed = candidate.trim()
      const [url, ...descriptors] = trimmed.split(/\s+/)
      if (!url || isAppOriginPrintUrl(url, appOrigin)) return []
      return [[url, ...descriptors].join(' ')]
    })
    .join(', ')
}

export function isAppOriginPrintUrl(value: string, appOrigin: string): boolean {
  const compact = compactPrintUrl(value)
  if (!compact || compact.startsWith('#')) return false
  const lower = compact.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    if (!compact.startsWith('//')) return false
  }
  try {
    return new URL(compact, appOrigin).origin === appOrigin
  } catch {
    return false
  }
}

export function isSafePrintUrl(value: string): boolean {
  const compact = compactPrintUrl(value)
  if (!compact || compact.startsWith('#')) return true
  if (
    compact.startsWith('/') ||
    compact.startsWith('./') ||
    compact.startsWith('../')
  ) {
    return true
  }
  if (compact.startsWith('//')) return true

  const scheme = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(compact)?.[1]?.toLowerCase()
  if (!scheme) return true
  return (
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'mailto' ||
    scheme === 'tel' ||
    (scheme === 'data' && compact.toLowerCase().startsWith('data:image/'))
  )
}

function compactPrintUrl(value: string): string {
  return Array.from(value.trim())
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && code !== 0x7f
    })
    .join('')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripQueryAndHash(path: string): string {
  const hashIndex = path.indexOf('#')
  const withoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

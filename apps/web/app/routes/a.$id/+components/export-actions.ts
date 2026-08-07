import { renderMarkdownDocument } from '~/lib/markdown-render'
import { splitAssetRef } from '~/lib/asset-ref'
import type { ArtifactType } from '~/lib/artifact-type'

export type ExportSourceData = {
  kind: 'markdown' | 'html'
  artifactKind: string
  path: string
  versionId: string
  source: string
  fileName: string
}

export type ExportPrintLabels = {
  savePdf: string
  backgroundHint: string
  preparing: string
  heightLimited: string
}

const READABILITY_BASE_ORIGIN = 'https://artifactshare.local'
const PRINT_PAGE_WIDTH = 900
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

export async function resolveExportHtml(
  shareableId: string,
  data: ExportSourceData,
): Promise<string | null> {
  const sourceHtml =
    data.kind === 'markdown' ? renderMarkdownDocument(data.source) : data.source
  if (!sourceHtml.trim()) return null
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html')
  await inlineDocumentAssets(doc, shareableId, data.path)
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

async function inlineDocumentAssets(
  doc: Document,
  shareableId: string,
  pagePath: string,
): Promise<void> {
  const pending = new Map<string, Promise<string | null>>()

  function enqueue(rawUrl: string): void {
    const path = resolveRelativeAssetPath(rawUrl, pagePath)
    if (!path || pending.has(path)) return
    pending.set(path, fetchAssetDataUri(shareableId, path))
  }

  doc.querySelectorAll('[src], [poster]').forEach((el) => {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr)
      if (v) enqueue(v)
    }
  })
  doc.querySelectorAll('link[href]').forEach((el) => {
    if (isStylesheetLink(el)) enqueue(el.getAttribute('href') ?? '')
  })
  doc.querySelectorAll('[srcset]').forEach((el) => {
    for (const c of (el.getAttribute('srcset') ?? '').split(',')) {
      const url = c.trim().split(/\s+/)[0]
      if (url) enqueue(url)
    }
  })
  const cssUrlRe = /url\(["']?((?!data:)[^"')]+)["']?\)/gi
  doc.querySelectorAll('style').forEach((el) => {
    for (const m of (el.textContent ?? '').matchAll(cssUrlRe)) enqueue(m[1])
  })
  doc.querySelectorAll('[style]').forEach((el) => {
    for (const m of (el.getAttribute('style') ?? '').matchAll(cssUrlRe))
      enqueue(m[1])
  })

  if (pending.size === 0) return

  const resolved = new Map<string, string>()
  await Promise.all(
    Array.from(pending).map(async ([path, p]) => {
      const uri = await p
      if (uri) resolved.set(path, uri)
    }),
  )

  function lookup(rawUrl: string): string | null {
    const path = resolveRelativeAssetPath(rawUrl, pagePath)
    return path ? (resolved.get(path) ?? null) : null
  }

  doc.querySelectorAll('[src], [poster]').forEach((el) => {
    for (const attr of ['src', 'poster']) {
      const v = el.getAttribute(attr)
      if (!v) continue
      const uri = lookup(v)
      if (uri) el.setAttribute(attr, uri)
    }
  })
  doc.querySelectorAll('link[href]').forEach((el) => {
    if (!isStylesheetLink(el)) return
    const uri = lookup(el.getAttribute('href') ?? '')
    if (uri) el.setAttribute('href', uri)
  })
  doc.querySelectorAll('[srcset]').forEach((el) => {
    const raw = el.getAttribute('srcset') ?? ''
    el.setAttribute(
      'srcset',
      raw
        .split(',')
        .map((c) => {
          const [url, ...desc] = c.trim().split(/\s+/)
          if (!url) return c
          const uri = lookup(url)
          return uri ? [uri, ...desc].join(' ') : c
        })
        .join(', '),
    )
  })
  function replaceCssUrls(css: string): string {
    return css.replace(
      /url\(["']?((?!data:)[^"')]+)["']?\)/gi,
      (match, url) => {
        const uri = lookup(url)
        return uri ? `url("${uri}")` : match
      },
    )
  }
  doc.querySelectorAll('style').forEach((el) => {
    el.textContent = replaceCssUrls(el.textContent ?? '')
  })
  doc.querySelectorAll('[style]').forEach((el) => {
    el.setAttribute('style', replaceCssUrls(el.getAttribute('style') ?? ''))
  })
}

function resolveRelativeAssetPath(
  rawUrl: string,
  pagePath: string,
): string | null {
  const url = stripQueryAndHash(rawUrl.trim())
  if (
    !url ||
    url.startsWith('data:') ||
    url.startsWith('http:') ||
    url.startsWith('https:') ||
    url.startsWith('//')
  ) {
    return null
  }
  if (url.startsWith('/')) return normalizePath(url)
  const dir = sourceDirectory(pagePath)
  return normalizePath(dir + url)
}

function normalizePath(path: string): string {
  const segments = path.split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') {
      resolved.pop()
    } else {
      resolved.push(segment)
    }
  }
  return `/${resolved.join('/')}`
}

async function fetchAssetDataUri(
  shareableId: string,
  assetPath: string,
): Promise<string | null> {
  const normalized = assetPath.startsWith('/') ? assetPath : `/${assetPath}`
  const encoded = normalized
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  const url = `/api/shareables/${encodeURIComponent(shareableId)}/export-asset${encoded}`
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export async function fetchExportSource(
  shareableId: string,
  path: string,
): Promise<
  | { ok: true; data: ExportSourceData }
  | { ok: false; reason: 'unsupported' | 'failed' }
> {
  const url = new URL(
    `/api/shareables/${encodeURIComponent(shareableId)}/export-source`,
    window.location.origin,
  )
  url.searchParams.set('path', path)

  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } })
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

  if (!response.ok) return { ok: false, reason: 'failed' }

  const data = (await response
    .json()
    .catch(() => null)) as ExportSourceData | null
  if (!data?.source || (data.kind !== 'markdown' && data.kind !== 'html')) {
    return { ok: false, reason: 'failed' }
  }

  return { ok: true, data }
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

export function openPrintWindow(): Window | null {
  return window.open('', '_blank')
}

export function writePrintPdf(
  printWindow: Window,
  shareableId: string,
  data: ExportSourceData,
  labels: ExportPrintLabels,
) {
  const printDoc = buildPrintDocument(shareableId, data, labels)
  const targetDoc = printWindow.document
  printWindow.opener = null
  targetDoc.open()
  targetDoc.close()
  replaceDocumentContents(targetDoc, printDoc)
  setupPrintSizing(printWindow, labels)
}

function replaceDocumentContents(targetDoc: Document, sourceDoc: Document) {
  for (const child of Array.from(targetDoc.childNodes)) {
    child.remove()
  }
  const sourceDoctype = sourceDoc.doctype
  const doctype = targetDoc.implementation.createDocumentType(
    sourceDoctype?.name ?? 'html',
    sourceDoctype?.publicId ?? '',
    sourceDoctype?.systemId ?? '',
  )
  targetDoc.append(
    doctype,
    targetDoc.importNode(sourceDoc.documentElement, true),
  )
}

export function buildPrintDocument(
  shareableId: string,
  data: ExportSourceData,
  labels: ExportPrintLabels,
): Document {
  const sourceHtml =
    data.kind === 'markdown' ? renderMarkdownDocument(data.source) : data.source
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html')
  doc.querySelectorAll('base').forEach((node) => {
    node.remove()
  })
  doc.querySelectorAll('script, iframe, object, embed').forEach((node) => {
    node.remove()
  })
  doc.querySelectorAll('meta[http-equiv]').forEach((node) => {
    const equiv = (node.getAttribute('http-equiv') ?? '').toLowerCase()
    if (
      equiv === 'refresh' ||
      equiv === 'set-cookie' ||
      equiv === 'content-security-policy' ||
      equiv === 'content-security-policy-report-only'
    ) {
      node.remove()
    }
  })
  doc.querySelectorAll('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      if (/^on/i.test(attr.name)) element.removeAttribute(attr.name)
    }
  })
  sanitizePrintUrlAttributes(doc)
  stripSourcePageRules(doc)
  if (data.artifactKind === 'static_site') {
    rewriteRootRelativePrintAssets(doc, shareableId)
  } else {
    stripAppOriginPrintUrls(doc, window.location.origin)
  }
  doc.documentElement.lang = doc.documentElement.lang || 'ja'
  installPrintChrome(doc, shareableId, data, labels)
  return doc
}

function installPrintChrome(
  doc: Document,
  shareableId: string,
  data: ExportSourceData,
  labels: ExportPrintLabels,
) {
  const brandMarkUri =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='357.22 354.97 539.12 539.12'%3E%3Cpath fill='%23F76B58' d='M473.7 355.404C492.329 354.467 518.221 355.342 537.528 355.346L664.857 355.342 744.53 355.322C758.365 355.32 781.891 354.646 794.68 356.84 814.258 360.247 832.577 368.799 847.761 381.618 870.909 400.841 886.232 428.791 889.234 458.874 889.99 466.447 889.721 476.442 889.723 484.264L889.707 523.333 889.694 646.17 889.696 743.131C889.698 756.565 890.454 784.421 888.465 796.608 885.102 817.301 876.173 836.689 862.635 852.696 841.224 878.324 814.191 890.952 781.434 893.88L565.737 893.959 503.207 893.994C488.842 893.998 472.593 894.674 458.537 892.317 438.796 889.007 418.763 878.481 403.763 865.457 382.223 846.94 365.658 816.682 364.362 787.897 363.289 764.083 363.872 738.745 363.893 714.722L363.901 584.398 363.884 503.047C363.882 489.206 363.172 464.523 365.493 451.533 369.257 430.264 378.813 410.445 393.111 394.255 414.518 370.051 441.638 357.245 473.7 355.404Z'/%3E%3Cpath fill='%23F9F6F2' d='M541.413 517.037C551.831 516.276 562.305 516.897 572.56 518.885 588.67 522.044 604.109 528.889 615.98 540.414 657.87 581.083 624.348 639.167 646.741 671.649 656.823 686.274 676.078 691.85 692.692 694.699 708.04 697.331 736.423 699.548 749.683 689.685 754.033 686.449 756.98 681.684 757.607 676.246 759.781 657.407 727.749 651.942 714.462 648.22 706.498 645.988 698.589 643.595 690.922 640.468 679.054 635.628 668.153 628.987 659.921 619.001 650.03 607.001 646.123 591.049 647.686 575.699 649.433 559.59 657.556 544.852 670.242 534.773 706.622 505.357 773.816 512.758 802.603 549.634 805.783 553.708 811.591 559.82 810.994 565.023 809.231 568.312 780.652 588.946 775.987 591.585 768.63 584.162 766.236 578.474 756.905 570.771 744.155 560.246 711.674 555.844 702.176 571.679 686.313 598.126 743.074 604.594 758.24 610.618 769.805 615.211 776.876 617.391 787.856 625.078 804.114 637.719 812.899 654.617 811.928 675.459 809.264 732.69 750.809 745.568 703.518 742.414 664.873 739.836 629.023 734.456 601.355 704.205 588.631 721.307 573.424 732.782 552.777 738.684 515.018 749.478 462.653 740.219 450.647 697.088 446.328 681.573 447.558 663.093 455.81 649.078 481.51 605.431 539.111 607.646 582.205 596.011 582.084 592.818 582.01 588.707 581.305 585.773 573.376 552.76 522.899 558.305 510.313 584.868 508.736 588.196 506.33 592.305 504.4 595.282L504.025 595.852C503.551 595.746 503.078 595.633 502.607 595.512 496.392 593.865 457.668 581.89 455.629 578.416 455.444 571.268 465.999 555.263 470.892 549.698 489.759 528.24 513.675 519.243 541.413 517.037Z'/%3E%3Cpath fill='%23F76B58' d='M579.612 638.78C581.407 638.551 580.622 638.317 582.081 639.158 584.565 648.251 581.017 664.406 576.409 672.672 565.116 692.926 535.557 703.893 514.612 692.012 505.116 685.676 502.56 672.802 509.072 664.223 521.965 647.235 560.399 642.884 579.612 638.78Z'/%3E%3C/svg%3E"

  const baseStyle = `
@font-face {
  font-family: "ArtifactShareNotoSansJP";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("https://fonts.gstatic.com/s/notosansjp/v55/-F6jfjtqLzI2JPCgQBnw7HFQoggM-FNthvIU4Zu1ky4vNQ.woff2") format("woff2");
}
:root {
  color-scheme: light;
  background: #fff;
}
html,
body {
  background: #fff !important;
  color: #37352f;
  font-family: "ArtifactShareNotoSansJP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif !important;
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
  position: fixed;
  right: 0;
  top: 0;
  z-index: 2147483647;
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
    margin: 56px auto 24px !important;
    width: ${PRINT_PAGE_WIDTH}px;
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
  html,
  body {
    height: auto !important;
    overflow: visible !important;
    width: ${PRINT_PAGE_WIDTH}px !important;
  }
}
`

  const baseHref =
    data.artifactKind === 'static_site'
      ? assetBaseHref(shareableId, data.path)
      : `${READABILITY_BASE_ORIGIN}/`

  const base = doc.createElement('base')
  base.href = baseHref
  const baseStyleElement = doc.createElement('style')
  baseStyleElement.id = 'artifactshare-client-print-base-style'
  baseStyleElement.textContent = baseStyle
  const dynamicStyle = doc.createElement('style')
  dynamicStyle.id = 'artifactshare-client-print-dynamic-style'
  doc.head.insertBefore(dynamicStyle, doc.head.firstChild)
  doc.head.insertBefore(baseStyleElement, doc.head.firstChild)
  doc.head.insertBefore(base, doc.head.firstChild)

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

  toolbar.appendChild(brand)
  toolbar.appendChild(status)
  toolbar.appendChild(spacer)
  toolbar.appendChild(hint)
  toolbar.appendChild(button)
  doc.body.insertBefore(toolbar, doc.body.firstChild)
}

function setupPrintSizing(printWindow: Window, labels: ExportPrintLabels) {
  const printDocument = printWindow.document
  let printInProgress = false

  function waitForEventOrTimeout(
    target: EventTarget,
    events: ReadonlyArray<string>,
    timeoutMs: number,
  ) {
    return new Promise<void>((resolve) => {
      const timeout = printWindow.setTimeout(done, timeoutMs)
      function done() {
        printWindow.clearTimeout(timeout)
        events.forEach((event) => {
          target.removeEventListener(event, done)
        })
        resolve()
      }
      events.forEach((event) => {
        target.addEventListener(event, done, { once: true })
      })
    })
  }

  function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number) {
    return Promise.race([
      promise,
      new Promise<void>((resolve) => {
        printWindow.setTimeout(resolve, timeoutMs)
      }),
    ])
  }

  async function waitForStylesheets() {
    const links = Array.from(
      printDocument.querySelectorAll('link[rel~="stylesheet"]'),
    )
    await Promise.all(
      links.map((link) => {
        const stylesheetLink = link as HTMLLinkElement
        if (stylesheetLink.sheet) {
          return Promise.resolve()
        }
        return waitForEventOrTimeout(link, ['load', 'error'], 5000)
      }),
    )
    await waitUntilStylesheetImportsSettle()
  }

  function waitUntilStylesheetImportsSettle() {
    const startedAt = Date.now()
    return new Promise<void>((resolve) => {
      function check() {
        if (areStylesheetImportsSettled() || Date.now() - startedAt > 5000) {
          resolve()
          return
        }
        printWindow.setTimeout(check, 50)
      }
      check()
    })
  }

  function areStylesheetImportsSettled() {
    return Array.from(printDocument.styleSheets).every((sheet) => {
      return canReadNestedStylesheets(sheet)
    })
  }

  function canReadNestedStylesheets(sheet: CSSStyleSheet): boolean {
    try {
      return Array.from(sheet.cssRules).every((rule) => {
        if (rule.type !== CSSRule.IMPORT_RULE) return true
        const importRule = rule as CSSImportRule
        return importRule.styleSheet
          ? canReadNestedStylesheets(importRule.styleSheet)
          : false
      })
    } catch (err) {
      return typeof err === 'object' && err !== null && 'name' in err
        ? err.name === 'SecurityError'
        : false
    }
  }

  async function waitForImages() {
    const images = Array.from(printDocument.images ?? [])
    await Promise.all(
      images.map((image) => {
        if (image.complete && image.naturalWidth > 0) return Promise.resolve()
        if (typeof image.decode === 'function') {
          return waitWithTimeout(image.decode(), 5000).catch(() => {})
        }
        return waitForEventOrTimeout(image, ['load', 'error'], 5000)
      }),
    )
  }

  function maxDocumentHeight() {
    const { body, documentElement } = printDocument
    const elements = Array.from(body.querySelectorAll('*')).filter((node) => {
      return !node.classList?.contains('asx-print-toolbar')
    })
    let maxBottom = 0
    elements.forEach((node) => {
      const rect = node.getBoundingClientRect()
      const style = printWindow.getComputedStyle(node)
      if (style.position === 'fixed') return
      maxBottom = Math.max(maxBottom, rect.bottom + printWindow.scrollY)
    })
    return Math.max(
      maxBottom,
      body.scrollHeight,
      body.offsetHeight,
      documentElement.scrollHeight,
      documentElement.offsetHeight,
    )
  }

  function setStatus(text: string) {
    const status = printDocument.getElementById('artifactshare-print-status')
    if (status) status.textContent = text
  }

  async function waitForLayout() {
    await new Promise<void>((resolve) => {
      printWindow.requestAnimationFrame(() => {
        printWindow.requestAnimationFrame(() => resolve())
      })
    })
  }

  async function applyPageSize() {
    await waitForStylesheets()
    if (printDocument.fonts?.ready) await printDocument.fonts.ready
    await waitForImages()
    await waitForLayout()
    const contentHeight = Math.ceil(maxDocumentHeight())
    const height = contentHeight + PRINT_HEIGHT_EXTRA
    const style = printDocument.getElementById(
      'artifactshare-client-print-dynamic-style',
    )
    if (!style) return
    if (height > PRINT_HEIGHT_LIMIT) {
      style.textContent = '@media print { @page { margin: 0; size: auto; } }'
      setStatus(labels.heightLimited)
      return
    }
    style.textContent = `@media print { @page { margin: 0; size: ${PRINT_PAGE_WIDTH}px ${height}px; } * { page-break-before: auto !important; page-break-after: auto !important; break-before: auto !important; break-after: auto !important; } }`
    setStatus('')
  }

  async function printAfterPageSize() {
    if (printInProgress) return
    printInProgress = true
    try {
      await applyPageSize()
      await waitForLayout()
      printWindow.print()
    } finally {
      printInProgress = false
    }
  }

  printDocument
    .getElementById('artifactshare-print-button')
    ?.addEventListener('click', () => {
      void printAfterPageSize()
    })
  void printAfterPageSize()
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

function assetBaseHref(shareableId: string, path: string): string {
  return assetRouteHref(shareableId, sourceDirectory(path))
}

export function assetRouteHref(
  shareableId: string,
  path: string,
  origin = window.location.origin,
): string {
  const { pathname, suffix } = splitAssetRef(path)
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  const encodedPath = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${origin}/api/shareables/${encodeURIComponent(shareableId)}/export-asset${encodedPath}${suffix}`
}

export { splitAssetRef } from '~/lib/asset-ref'

export function isRootRelativeAssetRef(
  value: string | null | undefined,
): value is string {
  return Boolean(value && value.startsWith('/') && !value.startsWith('//'))
}

function rewriteRootRelativePrintAssets(doc: Document, shareableId: string) {
  doc.querySelectorAll('[src], [poster]').forEach((element) => {
    for (const attrName of ['src', 'poster']) {
      const value = element.getAttribute(attrName)
      if (isRootRelativeAssetRef(value)) {
        element.setAttribute(attrName, assetRouteHref(shareableId, value))
      }
    }
  })

  doc.querySelectorAll('link[href]').forEach((element) => {
    if (!isStylesheetLink(element)) return
    const value = element.getAttribute('href')
    if (isRootRelativeAssetRef(value)) {
      element.setAttribute('href', assetRouteHref(shareableId, value))
    }
  })

  doc.querySelectorAll('[srcset]').forEach((element) => {
    const value = element.getAttribute('srcset')
    if (value) element.setAttribute('srcset', rewriteSrcset(value, shareableId))
  })

  doc.querySelectorAll('[style]').forEach((element) => {
    const value = element.getAttribute('style')
    if (value) {
      element.setAttribute('style', rewriteCssAssetUrls(value, shareableId))
    }
  })

  doc.querySelectorAll('style').forEach((element) => {
    element.textContent = rewriteCssAssetUrls(
      element.textContent ?? '',
      shareableId,
    )
  })
}

function isStylesheetLink(element: Element): boolean {
  return (element.getAttribute('rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet')
}

function stripSourcePageRules(doc: Document) {
  doc.querySelectorAll('style').forEach((element) => {
    const text = element.textContent ?? ''
    if (!/@page/i.test(text)) return
    element.textContent = stripPageAtRules(text)
  })
}

function stripPageAtRules(css: string): string {
  const pattern = /@page[^{]*\{/gi
  let result = ''
  let lastEnd = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    result += css.slice(lastEnd, match.index)
    let depth = 1
    let i = match.index + match[0].length
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    lastEnd = i
  }
  return result + css.slice(lastEnd)
}

const URL_ATTR_NAMES = new Set([
  'href',
  'xlink:href',
  'src',
  'poster',
  'action',
  'formaction',
])

function sanitizePrintUrlAttributes(doc: Document) {
  doc.querySelectorAll('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (URL_ATTR_NAMES.has(name) && !isSafePrintUrl(attr.value)) {
        element.removeAttribute(attr.name)
      }
      if (name === 'srcset') {
        const sanitized = sanitizePrintSrcset(attr.value)
        if (sanitized) {
          element.setAttribute(attr.name, sanitized)
        } else {
          element.removeAttribute(attr.name)
        }
      }
      if (name === 'style' && containsUnsafeCssUrl(attr.value)) {
        element.removeAttribute(attr.name)
      }
    }
  })
  doc.querySelectorAll('style').forEach((element) => {
    if (containsUnsafeCssUrl(element.textContent ?? '')) {
      element.textContent = ''
    }
  })
}

function stripAppOriginPrintUrls(doc: Document, appOrigin: string) {
  doc.querySelectorAll('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (
        URL_ATTR_NAMES.has(name) &&
        isAppOriginPrintUrl(attr.value, appOrigin)
      ) {
        element.removeAttribute(attr.name)
      }
      if (name === 'srcset') {
        const sanitized = stripAppOriginSrcset(attr.value, appOrigin)
        if (sanitized) {
          element.setAttribute(attr.name, sanitized)
        } else {
          element.removeAttribute(attr.name)
        }
      }
      if (name === 'style' && containsAppOriginCssUrl(attr.value, appOrigin)) {
        element.removeAttribute(attr.name)
      }
    }
  })
  doc.querySelectorAll('style').forEach((element) => {
    if (containsAppOriginCssUrl(element.textContent ?? '', appOrigin)) {
      element.textContent = ''
    }
  })
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

function rewriteSrcset(value: string, shareableId: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim()
      const [url, ...descriptors] = trimmed.split(/\s+/)
      if (!isRootRelativeAssetRef(url)) return candidate
      return [assetRouteHref(shareableId, url), ...descriptors].join(' ')
    })
    .join(', ')
}

function rewriteCssAssetUrls(value: string, shareableId: string): string {
  return value.replace(
    /url\((["']?)(\/(?!\/)[^"')]+)\1\)/g,
    (_match, _quote, ref) => {
      return `url("${assetRouteHref(shareableId, ref)}")`
    },
  )
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

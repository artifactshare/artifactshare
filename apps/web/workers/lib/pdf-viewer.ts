// The sandbox serves a PDF artifact as a virtual bundle on its own sandbox
// origin: a generated viewer page at the entrypoint path, the shared viewer
// script and style, the pdf.js library files, and the original file. Only the
// original carries artifact bytes; everything else is the same on every origin
// and is never stored or charged per artifact.

export const PDF_ORIGINAL_PATH = '/__as_pdf/original.pdf'
export const PDF_VIEWER_SCRIPT_PATH = '/__as_pdf/viewer.js'
export const PDF_VIEWER_STYLE_PATH = '/__as_pdf/viewer.css'
export const PDFJS_ASSET_PREFIX = '/__as_pdf/pdfjs/'
export const PDF_MIME_TYPE = 'application/pdf'

export interface PdfViewerAsset {
  body: string
  contentType: string
}

// The viewer's own script and style. pdf.js files under PDFJS_ASSET_PREFIX come
// from the pinned pdfjs-dist package through pdfjsAsset().
export function pdfViewerAsset(path: string): PdfViewerAsset | null {
  if (path === PDF_VIEWER_SCRIPT_PATH)
    return {
      body: PDF_VIEWER_SCRIPT,
      contentType: 'text/javascript; charset=utf-8',
    }
  if (path === PDF_VIEWER_STYLE_PATH)
    return { body: PDF_VIEWER_STYLE, contentType: 'text/css; charset=utf-8' }
  return null
}

// The pinned pdfjs-dist package is the sandbox Worker's static-asset directory
// (binding PDFJS_ASSETS, never served directly). Only these files are reachable
// under PDFJS_ASSET_PREFIX: the library, its worker, the viewer component and
// its stylesheet images, and the CMap, standard-font, WASM and ICC data.
const PDFJS_FILES: Record<string, string> = {
  'pdf.min.mjs': '/build/pdf.min.mjs',
  'pdf.worker.min.mjs': '/build/pdf.worker.min.mjs',
  'pdf_viewer.mjs': '/web/pdf_viewer.mjs',
  'pdf_viewer.css': '/web/pdf_viewer.css',
}
const PDFJS_DIRECTORIES: Record<string, string> = {
  'images/': '/web/images/',
  'cmaps/': '/cmaps/',
  'standard_fonts/': '/standard_fonts/',
  'wasm/': '/wasm/',
  'iccs/': '/iccs/',
}
const PDFJS_CONTENT_TYPES: Record<string, string> = {
  mjs: 'text/javascript; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  gif: 'image/gif',
  ttf: 'font/ttf',
}

export interface PdfjsAssetSource {
  path: string
  contentType: string
}

export function pdfjsAssetSource(path: string): PdfjsAssetSource | null {
  if (!path.startsWith(PDFJS_ASSET_PREFIX)) return null
  const name = path.slice(PDFJS_ASSET_PREFIX.length)
  let source: string | undefined = PDFJS_FILES[name]
  if (!source) {
    const slash = name.indexOf('/') + 1
    const directory = PDFJS_DIRECTORIES[name.slice(0, slash)]
    const file = name.slice(slash)
    if (!directory || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file)) return null
    source = directory + file
  }
  const extension = source.split('.').at(-1)?.toLowerCase() ?? ''
  return {
    path: source,
    contentType: PDFJS_CONTENT_TYPES[extension] ?? 'application/octet-stream',
  }
}

// A safe download name: the entrypoint's last segment, reduced to characters
// that need no quoting, always ending in .pdf.
export function pdfDownloadFileName(entrypointPath: string | null): string {
  const base = (entrypointPath ?? '').split('/').at(-1) ?? ''
  const stem = base
    .replace(/\.pdf$/i, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')
    .slice(0, 120)
  return `${stem || 'document'}.pdf`
}

export function pdfContentDisposition(
  entrypointPath: string | null,
  attachment: boolean,
): string {
  const name = pdfDownloadFileName(entrypointPath)
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_')
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const ICONS = {
  prev: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
} as const

function icon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

// The generated page. Labels start in English and the viewer script localizes
// them; the document never contains artifact content. The page content has no
// language unless the PDF declares one (pdf.js then sets it on #viewer, and
// clears it there for each document, hence the container): pdf.js measures
// selectable text in that language, and Firefox picks fallback fonts by
// language, so inheriting the UI language would misalign the text layer.
export function pdfViewerDocument(entrypointPath: string | null): string {
  const fileName = escapeHtml(pdfDownloadFileName(entrypointPath))
  const download = `${PDF_ORIGINAL_PATH}?download=1`
  return `<!doctype html>
<html lang="en" data-pdf-state="loading">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileName}</title>
<link rel="stylesheet" href="${PDFJS_ASSET_PREFIX}pdf_viewer.css">
<link rel="stylesheet" href="${PDF_VIEWER_STYLE_PATH}">
</head>
<body data-mode="page">
<header class="pdf-toolbar" data-label="toolbar" aria-label="PDF controls">
<div class="toolbar-start"></div>
<div class="page-navigation">
<button id="previous" type="button" data-label="previous" aria-label="Previous page" disabled>${icon('prev')}</button>
<label class="page-label"><input id="page-number" type="text" inputmode="numeric" autocomplete="off" value="1" data-label="pageNumber" aria-label="Page number" disabled><span aria-hidden="true">/</span><output id="page-count">–</output></label>
<button id="next" type="button" data-label="next" aria-label="Next page" disabled>${icon('next')}</button>
</div>
<div class="toolbar-end">
<a id="download" class="download" href="${download}" download="${fileName}" data-label="download" aria-label="Download PDF">${icon('download')}<span class="desktop-label" data-text="downloadShort">Download</span></a>
</div>
</header>
<div id="viewer-container" lang="" tabindex="0" data-label="content" aria-label="PDF content"><div id="viewer" class="pdfViewer"></div></div>
<div id="status" role="status" aria-live="polite"><p id="status-message" data-text="loading">Loading PDF…</p><a id="status-download" class="download-link" href="${download}" download="${fileName}" data-text="downloadOriginal" hidden>Download the original PDF</a></div>
<script type="module" src="${PDF_VIEWER_SCRIPT_PATH}"></script>
</body>
</html>`
}

// Values mirror apps/web/app/app.css (--background, --foreground, --muted,
// --divider, --border, --link and their dark-mode values) and tokens.css
// (--r-md, --duration-base). The iframe cannot load the app stylesheet, so the
// viewer repeats the few tokens it uses.
const PDF_VIEWER_STYLE = `:root {
  color-scheme: light;
  --paper: #ffffff;
  --surface: #f7f6f3;
  --text: #37352f;
  --muted-text: rgba(55, 53, 47, 0.86);
  --line: rgba(55, 53, 47, 0.1);
  --link: #116bb1;
  --hover: rgba(55, 53, 47, 0.04);
  --radius: 6px;
  --toolbar-height: 52px;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans',
    'Hiragino Kaku Gothic ProN', 'Noto Sans JP', Meiryo, sans-serif;
  font-synthesis: none;
  color: var(--text);
  background: var(--surface);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --paper: #111315;
    --surface: #181b1e;
    --text: #e7e2d8;
    --muted-text: rgba(231, 226, 216, 0.77);
    --line: rgba(231, 226, 216, 0.13);
    --link: #7db7ff;
    --hover: rgba(231, 226, 216, 0.07);
  }
}
* { box-sizing: border-box; }
body { margin: 0; overflow: hidden; }
button, input, a { font: inherit; }
button, a { touch-action: manipulation; }
button { cursor: pointer; }
button:disabled { opacity: 0.35; cursor: default; }
button, .download {
  border: 0;
  background: transparent;
  color: inherit;
  min-width: 36px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--radius);
  text-decoration: none;
  font-size: 13px;
  padding: 0 10px;
}
button:not(:disabled):hover, .download:hover { background: var(--hover); }
button:focus-visible, input:focus-visible, a:focus-visible, #viewer-container:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
svg { flex-shrink: 0; }
.pdf-toolbar {
  height: var(--toolbar-height);
  /* The app header's collapse handle overlaps the frame's top-right corner
     (44x18px, 12px from the edge), so the controls stay clear of it with
     room for subpixel layout. */
  padding: 6px 64px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
  position: relative;
  z-index: 3;
}
.toolbar-start, .toolbar-end, .page-navigation {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.toolbar-end { justify-content: flex-end; }
.page-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--muted-text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.page-label input {
  width: 40px;
  height: 36px;
  border: 0;
  border-radius: 4px;
  padding: 6px 2px;
  text-align: center;
  background: transparent;
  color: var(--text);
}
.page-label input:hover { background: var(--hover); }
#viewer-container {
  position: absolute;
  inset: var(--toolbar-height) 0 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.pdfViewer { padding: 20px 16px; }
.pdfViewer .page {
  box-sizing: content-box;
  border: 0;
  margin: 0 auto 20px;
  box-shadow: 0 1px 5px rgb(0 0 0 / 0.1);
}
.pdfViewer .page:last-child { margin-bottom: 0; }
.pdfViewer .page.loading::after { display: none; }
body[data-mode='page'] .pdfViewer {
  min-height: 100%;
  min-width: 100%;
  width: max-content;
  display: flex;
  align-items: center;
  justify-content: center;
}
body[data-mode='page'] .pdfViewer .page { flex-shrink: 0; margin: 0 auto; }
#status {
  position: fixed;
  left: 50%;
  top: 48%;
  transform: translate(-50%, -50%);
  max-width: min(80%, 420px);
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted-text);
  text-align: center;
}
#status p { margin: 0 0 8px; }
.download-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--link);
  font-size: 13px;
}
[hidden] { display: none !important; }
@media (max-width: 700px) {
  :root { --toolbar-height: 52px; }
  .pdf-toolbar {
    padding: 4px 64px;
    gap: 0;
    grid-template-columns: minmax(44px, 1fr) auto minmax(44px, 1fr);
  }
  button, .download { height: 44px; min-width: 44px; padding: 0 8px; }
  .desktop-label { display: none; }
  .page-navigation { gap: 0; }
  .page-navigation button { width: 44px; padding: 0; }
  .page-label { gap: 3px; }
  .page-label input { width: 44px; height: 44px; }
  .pdfViewer { padding: 12px 4px; }
  .pdfViewer .page { margin-bottom: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; transition: none !important; }
}
`

// Plain browser JavaScript (no build step). It loads pdf.js from this origin,
// opens the original with evaluation disabled, and picks the initial layout
// from page 1: landscape pages one at a time fitted to the visible area,
// portrait pages as a vertical scroll fitted to width and capped at 100%.
const PDF_VIEWER_SCRIPT = `const PDFJS = '${PDFJS_ASSET_PREFIX}'
const ORIGINAL = '${PDF_ORIGINAL_PATH}'
const ja = /^ja\\b/i.test(navigator.language || '')
const text = ja
  ? {
      toolbar: 'PDFの操作',
      previous: '前のページ',
      next: '次のページ',
      pageNumber: 'ページ番号',
      download: 'PDFをダウンロード',
      downloadShort: 'ダウンロード',
      content: 'PDFの内容',
      loading: 'PDFを読み込んでいます…',
      downloadOriginal: '元のPDFをダウンロード',
      password: 'このPDFはパスワードで保護されているため、ここでは開けません。ダウンロードして、お使いのPDFアプリで開いてください。',
      corrupt: 'このPDFは壊れているか、PDFとして読み込めませんでした。',
      transport: 'PDFを取得できませんでした。ページを再読み込みしてもう一度お試しください。',
      unsupported: 'このPDFはこのブラウザーでは表示できません。元のPDFをダウンロードして確認してください。',
      pageFailed: 'このページを表示できませんでした。元のPDFをダウンロードして確認してください。',
    }
  : {
      toolbar: 'PDF controls',
      previous: 'Previous page',
      next: 'Next page',
      pageNumber: 'Page number',
      download: 'Download PDF',
      downloadShort: 'Download',
      content: 'PDF content',
      loading: 'Loading PDF…',
      downloadOriginal: 'Download the original PDF',
      password: 'This PDF is password-protected and can’t be opened here. Download it and open it in your PDF app.',
      corrupt: 'This PDF is damaged or could not be read as a PDF.',
      transport: 'The PDF could not be loaded. Reload the page to try again.',
      unsupported: 'This PDF can’t be displayed in this browser. Download the original PDF to view it.',
      pageFailed: 'This page could not be displayed. Download the original PDF to view it.',
    }
document.documentElement.lang = ja ? 'ja' : 'en'
for (const element of document.querySelectorAll('[data-label]'))
  element.setAttribute('aria-label', text[element.dataset.label])
for (const element of document.querySelectorAll('[data-text]'))
  element.textContent = text[element.dataset.text]

const byId = (id) => document.getElementById(id)
const container = byId('viewer-container')
const pageInput = byId('page-number')
const previous = byId('previous')
const next = byId('next')
const status = byId('status')
const statusMessage = byId('status-message')
const statusDownload = byId('status-download')

function showState(state, message, offerDownload) {
  document.documentElement.dataset.pdfState = state
  status.hidden = false
  statusMessage.textContent = message
  statusDownload.hidden = !offerDownload
}

function failureState(error) {
  const name = error && typeof error === 'object' ? error.name : ''
  if (name === 'PasswordException') return ['password', text.password]
  if (name === 'InvalidPDFException') return ['corrupt', text.corrupt]
  if (
    name === 'ResponseException' ||
    name === 'MissingPDFException' ||
    name === 'UnexpectedResponseException' ||
    (error instanceof TypeError && /fetch|network/i.test(String(error.message)))
  )
    return ['transport', text.transport]
  return ['unsupported', text.unsupported]
}

let pdfjs
let viewerModule
try {
  pdfjs = await import(PDFJS + 'pdf.min.mjs')
  globalThis.pdfjsLib = pdfjs
  viewerModule = await import(PDFJS + 'pdf_viewer.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'
} catch (error) {
  console.error(error)
  showState('unsupported', text.unsupported, true)
}

if (viewerModule) {
  const { EventBus, PDFLinkService, PDFViewer, ScrollMode } = viewerModule
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer',
    ignoreDestinationZoom: true,
  })
  const viewer = new PDFViewer({
    container,
    viewer: byId('viewer'),
    eventBus,
    linkService,
    maxCanvasPixels: 16000000,
  })
  linkService.setViewer(viewer)
  let ready = false
  let slides = true

  function sync() {
    const current = viewer.currentPageNumber
    pageInput.value = String(current)
    previous.disabled = current <= 1
    next.disabled = current >= viewer.pagesCount
  }
  // Slides fit the page being shown, so each page change refits it. pdf.js
  // 'page-fit' ignores the viewer padding, so the slide is fitted to the
  // container minus that padding and never makes the area scroll. A report
  // scrolls all pages at one scale, chosen so the widest page fits the width.
  function fit() {
    if (!ready) return
    if (slides) {
      const view = viewer.getPageView(viewer.currentPageNumber - 1)
      if (!view) return
      const padding = getComputedStyle(byId('viewer'))
      const availableWidth =
        container.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) - 1
      const availableHeight =
        container.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - 1
      const scale = Math.min(
        (availableWidth * view.scale) / view.width,
        (availableHeight * view.scale) / view.height,
      )
      if (scale > 0 && Math.abs(scale - viewer.currentScale) > 0.0001) viewer.currentScale = scale
      return
    }
    viewer.currentScaleValue = 'page-width'
    const unscaledWidth = (view) => view.width / view.scale
    let widest = 0
    for (let index = 0; index < viewer.pagesCount; index++)
      widest = Math.max(widest, unscaledWidth(viewer.getPageView(index)))
    const current = unscaledWidth(viewer.getPageView(viewer.currentPageNumber - 1))
    const scale = Math.min((viewer.currentScale * current) / widest, 1)
    if (scale !== viewer.currentScale) viewer.currentScale = scale
  }
  function goTo(page) {
    if (ready && Number.isInteger(page) && page >= 1 && page <= viewer.pagesCount)
      viewer.currentPageNumber = page
    sync()
  }

  // Setting the scale can scroll the report away from its top padding;
  // until the reader moves, the first page keeps its designed top gap.
  const keepTopAtLoad = () => {
    if (!slides && viewer.currentPageNumber === 1) container.scrollTop = 0
  }
  eventBus.on('pagesinit', () => {
    ready = true
    fit()
    keepTopAtLoad()
    pageInput.disabled = false
    byId('page-count').textContent = String(viewer.pagesCount)
    sync()
  })
  eventBus.on('pagechanging', () => {
    sync()
    if (slides) queueMicrotask(fit)
  })
  // Every page's own size is known only once all pages have loaded.
  eventBus.on('pagesloaded', () => {
    fit()
    keepTopAtLoad()
  })
  eventBus.on('pagerendered', ({ error }) => {
    if (error) {
      showState('page-error', text.pageFailed, true)
      return
    }
    if (document.documentElement.dataset.pdfState !== 'page-error') {
      status.hidden = true
      document.documentElement.dataset.pdfState = 'ready'
    }
  })
  previous.addEventListener('click', () => viewer.previousPage())
  next.addEventListener('click', () => viewer.nextPage())
  pageInput.addEventListener('change', () => goTo(Number(pageInput.value)))
  pageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    goTo(Number(pageInput.value))
    pageInput.blur()
  })
  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (
      !ready ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)))
    )
      return
    if (event.key === 'ArrowRight' || event.key === 'PageDown') viewer.nextPage()
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') viewer.previousPage()
    else if (event.key === 'Home') goTo(1)
    else if (event.key === 'End') goTo(viewer.pagesCount)
    else return
    event.preventDefault()
  })
  let touchStart = null
  container.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0]
      touchStart = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null
    },
    { passive: true },
  )
  container.addEventListener(
    'touchend',
    (event) => {
      const touch = event.changedTouches[0]
      if (touchStart && touch && slides && container.scrollWidth <= container.clientWidth + 2) {
        const dx = touch.clientX - touchStart.x
        const dy = touch.clientY - touchStart.y
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) viewer.nextPage()
          else viewer.previousPage()
        }
      }
      touchStart = null
    },
    { passive: true },
  )
  new ResizeObserver(fit).observe(container)

  try {
    const pdf = await pdfjs.getDocument({
      url: ORIGINAL,
      isEvalSupported: false,
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      wasmUrl: PDFJS + 'wasm/',
      iccUrl: PDFJS + 'iccs/',
    }).promise
    const first = await pdf.getPage(1)
    const viewport = first.getViewport({ scale: 1 })
    slides = viewport.width > viewport.height
    viewer.scrollMode = slides ? ScrollMode.PAGE : ScrollMode.VERTICAL
    document.body.dataset.mode = slides ? 'page' : 'scroll'
    viewer.setDocument(pdf)
    linkService.setDocument(pdf)
    addEventListener('pagehide', () => {
      viewer.setDocument(null)
      void pdf.destroy()
    })
  } catch (error) {
    console.error(error)
    const [state, message] = failureState(error)
    showState(state, message, state !== 'transport')
  }
}
`

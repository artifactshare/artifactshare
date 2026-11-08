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
  // Cut by code point so a character outside the BMP is never split into a
  // lone surrogate, which encodeURIComponent rejects.
  const short = Array.from(stem).slice(0, 120).join('')
  return `${short || 'document'}.pdf`
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
  pages:
    '<rect x="4" y="3" width="6" height="7" rx="1"/><rect x="14" y="3" width="6" height="7" rx="1"/><rect x="4" y="14" width="6" height="7" rx="1"/><rect x="14" y="14" width="6" height="7" rx="1"/>',
  prev: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  fit: '<path d="M4 6h8m4 0h4M4 12h3m4 0h9M4 18h10m4 0h2"/><circle cx="14" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
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
<div class="toolbar-start">
<button id="pages" type="button" data-label="openPages" aria-label="Open the page list" aria-haspopup="dialog" disabled>${icon('pages')}<span class="desktop-label" data-text="pages">Pages</span></button>
</div>
<div class="page-navigation">
<button id="previous" type="button" data-label="previous" aria-label="Previous page" disabled>${icon('prev')}</button>
<label class="page-label"><input id="page-number" type="text" inputmode="numeric" autocomplete="off" value="1" data-label="pageNumber" aria-label="Page number" disabled><span aria-hidden="true">/</span><output id="page-count">–</output></label>
<button id="next" type="button" data-label="next" aria-label="Next page" disabled>${icon('next')}</button>
</div>
<div class="toolbar-end">
<button id="fit" type="button" data-label="openSettings" aria-label="Open display settings" aria-expanded="false" aria-controls="display-options" disabled>${icon('fit')}<span class="desktop-label" data-text="settings">Display settings</span><svg class="settings-chevron desktop-label" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
<button id="search-toggle" type="button" data-label="search" aria-label="Search the document" aria-expanded="false" aria-controls="search-bar" disabled>${icon('search')}</button>
<a id="download" class="download" href="${download}" download="${fileName}" data-label="download" aria-label="Download PDF">${icon('download')}<span class="desktop-label" data-text="downloadShort">Download</span></a>
</div>
</header>
<div id="display-options" class="display-options" role="region" data-label="settings" aria-label="Display settings" hidden>
<fieldset><legend data-text="layout">Page layout</legend>
<label><input type="radio" name="layout" value="page"><span data-text="layoutPage">One page at a time</span></label>
<label><input type="radio" name="layout" value="scroll"><span data-text="layoutScroll">Continuous scroll</span></label>
</fieldset>
<fieldset class="size-options"><legend data-text="size">Size</legend>
<select id="zoom" data-label="size" aria-label="Size">
<option value="auto" data-text="sizeAuto">Automatic (up to 100%)</option>
<option value="page-fit" data-text="sizePage">Fit page</option>
<option value="page-width" data-text="sizeWidth">Fit width</option>
<option value="1">100%</option>
<option value="1.5">150%</option>
<option value="2">200%</option>
</select>
</fieldset>
</div>
<div id="search-bar" class="search-bar" role="search" hidden><input id="search-query" type="search" autocomplete="off" data-label="searchQuery" aria-label="Text to find"><output id="search-results" aria-live="polite"></output><button id="search-next" type="button" data-label="searchNext" aria-label="Next result">${icon('next')}</button><button id="search-close" type="button" data-label="searchClose" aria-label="Close search">${icon('close')}</button></div>
<div id="viewer-container" lang="" tabindex="0" data-label="content" aria-label="PDF content"><div id="viewer" class="pdfViewer"></div></div>
<div id="status" role="status" aria-live="polite"><p id="status-message" data-text="loading">Loading PDF…</p><a id="status-download" class="download-link" href="${download}" download="${fileName}" data-text="downloadOriginal" hidden>Download the original PDF</a></div>
<dialog id="pages-dialog" aria-labelledby="pages-heading"><header class="pages-header"><h2 id="pages-heading" data-text="pages">Pages</h2><button id="pages-close" type="button" data-label="closePages" aria-label="Close the page list">${icon('close')}</button></header><nav id="page-list" class="page-list" data-label="choosePage" aria-label="Choose a page"></nav><footer><a id="pages-download" class="download-link" href="${download}" download="${fileName}">${icon('download')}<span data-text="download">Download PDF</span></a></footer></dialog>
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
  --search-height: 52px;
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
button, input, select, a { font: inherit; }
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
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, #viewer-container:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
svg { flex-shrink: 0; }
button[aria-expanded='true'] {
  background: color-mix(in srgb, var(--link) 7%, transparent);
  color: var(--link);
}
.settings-chevron { color: var(--muted-text); }
.pdf-toolbar {
  height: var(--toolbar-height);
  /* The app header's collapse handle overlaps the frame's top-right corner
     (44x18px, 12px from the edge), so the controls stay clear of it with
     room for subpixel layout. */
  padding: 6px 64px;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr);
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
/* The search bar sits below the control row and the document area shrinks. */
body:has(#search-bar:not([hidden])) #viewer-container {
  top: calc(var(--toolbar-height) + var(--search-height));
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
.display-options {
  /* Placed under the settings button by the script. */
  position: absolute;
  z-index: 5;
  right: 8px;
  top: calc(var(--toolbar-height) - 4px);
  width: 244px;
  padding: 16px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.08);
  font-size: 13px;
}
.display-options fieldset {
  padding: 0 0 12px;
  margin: 0 0 12px;
  border: 0;
  border-bottom: 1px solid var(--line);
}
.display-options legend {
  font-size: 12px;
  color: var(--muted-text);
  margin-bottom: 8px;
  padding: 0;
}
.display-options fieldset label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
}
.display-options input { accent-color: var(--link); }
.display-options .size-options { border: 0; margin: 0; padding: 0; }
.size-options select { width: 100%; }
select {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--paper);
  color: var(--text);
  padding: 6px;
  font-size: 13px;
}
.search-bar {
  position: relative;
  z-index: 3;
  height: var(--search-height);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 64px;
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.search-bar input {
  width: 260px;
  min-width: 0;
  flex: 0 1 260px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 8px 10px;
  height: 36px;
  color: var(--text);
  font-size: 14px;
}
.search-bar output {
  font-size: 12px;
  color: var(--muted-text);
  white-space: nowrap;
}
#pages-dialog {
  position: fixed;
  inset: 0 0 0 auto;
  margin: 0;
  width: 320px;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--line);
  background: var(--paper);
  color: var(--text);
  overflow: hidden;
}
#pages-dialog[open] { display: flex; flex-direction: column; }
#pages-dialog::backdrop { background: rgb(23 24 21 / 0.19); }
.pages-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  /* Clear of the app header's collapse handle over the top-right corner. */
  padding: 20px 16px 8px;
  flex-shrink: 0;
}
.pages-header h2 { font-size: 15px; margin: 0; }
.page-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 12px 16px 20px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: 12px;
}
.page-list button {
  height: auto;
  min-height: 72px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 7px;
  gap: 6px;
  justify-content: flex-start;
  border: 1px solid transparent;
  transition: background 160ms ease-out, border-color 160ms ease-out;
}
.page-list button[aria-current] {
  background: color-mix(in srgb, var(--link) 5%, transparent);
  border-color: var(--link);
  color: var(--link);
}
.thumbnail {
  display: block;
  min-height: 64px;
  background: var(--surface);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
}
.thumbnail canvas { display: block; width: 100%; height: 100%; }
.thumbnail-number {
  font-size: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
#pages-dialog footer {
  border-top: 1px solid var(--line);
  padding: 8px 16px;
  flex-shrink: 0;
}
#pages-dialog .download-link {
  display: flex;
  gap: 8px;
  color: var(--muted-text);
  text-decoration: none;
}
[hidden] { display: none !important; }
/* Below this width the labelled end controls would reach the pager. */
@media (max-width: 960px) {
  .desktop-label { display: none; }
}
/* At the narrowest phones the row cannot hold every 44px control; the
   download stays one tap away in the page list. */
@media (max-width: 360px) {
  .pdf-toolbar .download { display: none; }
}
@media (max-width: 700px) {
  /* The app header's collapse handle covers the frame's top 18px on the
     right, so the one row of controls starts below it. */
  :root { --toolbar-height: 72px; }
  .pdf-toolbar {
    padding: 24px 8px 4px;
    gap: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .page-navigation { justify-content: center; }
  button, .download { height: 44px; min-width: 44px; padding: 0 8px; }
  .desktop-label { display: none; }
  .toolbar-end, .page-navigation { gap: 0; }
  .pdf-toolbar button, .pdf-toolbar .download { width: 44px; padding: 0; }
  .page-label { gap: 3px; }
  .page-label input { width: 44px; height: 44px; }
  .display-options fieldset label { min-height: 44px; }
  .pdfViewer { padding: 12px 4px; }
  .pdfViewer .page { margin-bottom: 12px; }
  .search-bar { padding: 4px 8px; gap: 0; }
  .search-bar input { flex: 1; width: 0; }
  .search-bar output { padding: 0 4px; font-size: 11px; }
  #pages-dialog { width: 100%; border-left: 0; }
  .pages-header { padding-top: 20px; }
  .page-list { gap: 16px; }
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
      pages: 'ページ一覧',
      openPages: 'ページ一覧を開く',
      closePages: 'ページ一覧を閉じる',
      choosePage: 'ページを選ぶ',
      goToPage: (n) => n + 'ページへ移動',
      settings: '表示設定',
      openSettings: '表示設定を開く',
      layout: 'ページの並べ方',
      layoutPage: '1ページずつ',
      layoutScroll: '縦にスクロール',
      size: '表示サイズ',
      sizeAuto: '自動（100%まで）',
      sizePage: 'ページ全体',
      sizeWidth: '幅に合わせる',
      search: '文書内を検索',
      searchQuery: '検索する文字',
      searchNext: '次の検索結果',
      searchClose: '検索を閉じる',
      matches: (current, total) => current + ' / ' + total + '件',
      noResults: '見つかりません',
      noText: 'このPDFには検索できる文字がありません',
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
      pages: 'Pages',
      openPages: 'Open the page list',
      closePages: 'Close the page list',
      choosePage: 'Choose a page',
      goToPage: (n) => 'Go to page ' + n,
      settings: 'Display settings',
      openSettings: 'Open display settings',
      layout: 'Page layout',
      layoutPage: 'One page at a time',
      layoutScroll: 'Continuous scroll',
      size: 'Size',
      sizeAuto: 'Automatic (up to 100%)',
      sizePage: 'Fit page',
      sizeWidth: 'Fit width',
      search: 'Search the document',
      searchQuery: 'Text to find',
      searchNext: 'Next result',
      searchClose: 'Close search',
      matches: (current, total) => current + ' of ' + total,
      noResults: 'No results',
      noText: 'This PDF has no searchable text',
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
let downloadable = null
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
  const { EventBus, FindState, PDFLinkService, PDFViewer, PDFFindController, ScrollMode } = viewerModule
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer',
    ignoreDestinationZoom: true,
  })
  const findController = new PDFFindController({ eventBus, linkService })
  const viewer = new PDFViewer({
    container,
    viewer: byId('viewer'),
    eventBus,
    linkService,
    findController,
    maxCanvasPixels: 16000000,
  })
  linkService.setViewer(viewer)
  const toolbar = document.querySelector('.pdf-toolbar')
  const pagesButton = byId('pages')
  const fitButton = byId('fit')
  const displayOptions = byId('display-options')
  const zoom = byId('zoom')
  const layoutInputs = document.querySelectorAll('input[name="layout"]')
  const searchToggle = byId('search-toggle')
  const searchBar = byId('search-bar')
  const searchQuery = byId('search-query')
  const searchResults = byId('search-results')
  const dialog = byId('pages-dialog')
  const list = byId('page-list')
  searchQuery.placeholder = text.search
  let ready = false
  let pdfDocument = null
  // Display settings live only in memory: page layout ('page' or 'scroll')
  // and size ('auto', 'page-fit', 'page-width' or a scale), set from page 1.
  let layoutMode = 'page'
  let size = 'page-fit'

  function sync() {
    const current = viewer.currentPageNumber
    pageInput.value = String(current)
    previous.disabled = current <= 1
    next.disabled = current >= viewer.pagesCount
    for (const item of list.children) {
      if (Number(item.dataset.page) === current) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    }
  }
  // 'page-fit' fits the page being shown in one-page layout, so each page
  // change refits it; in continuous layout one scale fits every page, so
  // scrolling across pages of different sizes never changes the scale. pdf.js 'page-fit' ignores the viewer padding, so the page
  // is fitted to the container minus that padding and never makes the area
  // scroll. Width fits use one scale for all pages, chosen so the widest page
  // fits the width; automatic caps it at 100%. Fixed sizes are kept as set.
  function fit() {
    if (!ready) return
    if (size === 'page-fit') {
      const padding = getComputedStyle(byId('viewer'))
      const availableWidth =
        container.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight) - 1
      const availableHeight =
        container.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom) - 1
      const pageFit = (view) =>
        Math.min((availableWidth * view.scale) / view.width, (availableHeight * view.scale) / view.height)
      let scale = Infinity
      if (layoutMode === 'page') {
        const view = viewer.getPageView(viewer.currentPageNumber - 1)
        if (!view) return
        scale = pageFit(view)
      } else {
        for (let index = 0; index < viewer.pagesCount; index++) {
          const view = viewer.getPageView(index)
          if (view) scale = Math.min(scale, pageFit(view))
        }
      }
      if (scale > 0 && scale !== Infinity && Math.abs(scale - viewer.currentScale) > 0.0001)
        viewer.currentScale = scale
      return
    }
    if (size !== 'auto' && size !== 'page-width') {
      const scale = Number(size)
      if (Math.abs(scale - viewer.currentScale) > 0.0001) viewer.currentScale = scale
      return
    }
    viewer.currentScaleValue = 'page-width'
    const unscaledWidth = (view) => view.width / view.scale
    let widest = 0
    for (let index = 0; index < viewer.pagesCount; index++)
      widest = Math.max(widest, unscaledWidth(viewer.getPageView(index)))
    const current = unscaledWidth(viewer.getPageView(viewer.currentPageNumber - 1))
    let scale = (viewer.currentScale * current) / widest
    if (size === 'auto') scale = Math.min(scale, 1)
    if (scale !== viewer.currentScale) viewer.currentScale = scale
  }
  function goTo(page) {
    if (ready && Number.isInteger(page) && page >= 1 && page <= viewer.pagesCount)
      viewer.currentPageNumber = page
    sync()
  }
  function showSettings() {
    for (const input of layoutInputs) input.checked = input.value === layoutMode
    zoom.value = size
  }
  // A change of layout or size keeps the page being read.
  function applySettings() {
    const page = viewer.currentPageNumber
    viewer.scrollMode = layoutMode === 'page' ? ScrollMode.PAGE : ScrollMode.VERTICAL
    document.body.dataset.mode = layoutMode
    fit()
    viewer.currentPageNumber = page
    sync()
  }

  // Setting the scale can scroll the report away from its top padding;
  // until the reader moves, the first page keeps its designed top gap.
  const keepTopAtLoad = () => {
    if (layoutMode === 'scroll' && viewer.currentPageNumber === 1) container.scrollTop = 0
  }
  eventBus.on('pagesinit', () => {
    ready = true
    fit()
    keepTopAtLoad()
    pageInput.disabled = false
    pagesButton.disabled = false
    fitButton.disabled = false
    searchToggle.disabled = false
    byId('page-count').textContent = String(viewer.pagesCount)
    sync()
  })
  eventBus.on('pagechanging', () => {
    sync()
    showPageState()
    if (size === 'page-fit' && layoutMode === 'page') queueMicrotask(fit)
  })
  // Every page's own size is known only once all pages have loaded.
  eventBus.on('pagesloaded', () => {
    fit()
    keepTopAtLoad()
  })
  // A page that failed to render shows its message only while it is the
  // current page; rendering it, or moving to a page that rendered, clears it.
  const failedPages = new Set()
  const showPageState = () => {
    if (failedPages.has(viewer.currentPageNumber)) {
      showState('page-error', text.pageFailed, true)
      return
    }
    if (document.documentElement.dataset.pdfState === 'page-error') {
      status.hidden = true
      document.documentElement.dataset.pdfState = 'ready'
    }
  }
  eventBus.on('pagerendered', ({ pageNumber, error }) => {
    if (error) failedPages.add(pageNumber)
    else failedPages.delete(pageNumber)
    // The loading message stays until a page has actually rendered.
    if (!error && document.documentElement.dataset.pdfState === 'loading') {
      status.hidden = true
      document.documentElement.dataset.pdfState = 'ready'
    }
    showPageState()
  })
  previous.addEventListener('click', () => viewer.previousPage())
  next.addEventListener('click', () => viewer.nextPage())
  pageInput.addEventListener('change', () => goTo(Number(pageInput.value)))
  pageInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    goTo(Number(pageInput.value))
    pageInput.blur()
  })

  // Display settings popover, placed under its button, again whenever the
  // frame is resized while it is open.
  function placeSettings() {
    const button = fitButton.getBoundingClientRect()
    const right = Math.max(8, Math.min(innerWidth - button.right, innerWidth - displayOptions.offsetWidth - 8))
    displayOptions.style.right = right + 'px'
    displayOptions.style.top = toolbar.getBoundingClientRect().bottom - 4 + 'px'
  }
  function toggleSettings(open, returnFocus) {
    if (open) {
      toggleSearch(false, false)
      showSettings()
    }
    displayOptions.hidden = !open
    fitButton.setAttribute('aria-expanded', String(open))
    if (open) {
      placeSettings()
      displayOptions.querySelector('input:checked')?.focus()
    } else if (returnFocus) fitButton.focus()
  }
  addEventListener('resize', () => {
    if (!displayOptions.hidden) placeSettings()
  })
  fitButton.addEventListener('click', () => toggleSettings(displayOptions.hidden, false))
  document.addEventListener('click', (event) => {
    if (
      !displayOptions.hidden &&
      !displayOptions.contains(event.target) &&
      !fitButton.contains(event.target)
    )
      toggleSettings(false, false)
  })
  for (const input of layoutInputs)
    input.addEventListener('change', () => {
      if (!input.checked) return
      layoutMode = input.value
      applySettings()
    })
  zoom.addEventListener('change', () => {
    size = zoom.value
    applySettings()
  })

  // Search with pdf.js's find controller. Whether the PDF has any text at all
  // is checked once, page by page until the first text, so that a scanned
  // PDF says so instead of reporting no results.
  let searchableText = null
  function hasSearchableText() {
    searchableText ??= (async () => {
      for (let n = 1; n <= pdfDocument.numPages; n++) {
        const content = await (await pdfDocument.getPage(n)).getTextContent()
        if (content.items.some((item) => typeof item.str === 'string' && item.str.trim())) return true
      }
      return false
    })().catch(() => true)
    return searchableText
  }
  function find(type, findPrevious) {
    // An emptied query replaces the old one in the controller, so late
    // counts for the old query are recognised as stale below.
    const query = searchQuery.value.trim() ? searchQuery.value : ''
    if (!query) searchResults.textContent = ''
    else void hasSearchableText()
    eventBus.dispatch('find', {
      source: searchBar,
      type: query ? type : '',
      query,
      highlightAll: true,
      caseSensitive: false,
      entireWord: false,
      findPrevious,
      matchDiacritics: false,
    })
  }
  function toggleSearch(open, returnFocus) {
    if (open === !searchBar.hidden) {
      if (open) searchQuery.focus()
      return
    }
    if (open) toggleSettings(false, false)
    searchBar.hidden = !open
    searchToggle.setAttribute('aria-expanded', String(open))
    if (open) {
      searchResults.textContent = ''
      searchQuery.focus()
      searchQuery.select()
      return
    }
    // Closing ends the search, so reopening starts from an empty field.
    searchQuery.value = ''
    searchResults.textContent = ''
    eventBus.dispatch('findbarclose', { source: searchBar })
    if (returnFocus) searchToggle.focus()
  }
  searchToggle.addEventListener('click', () => toggleSearch(searchBar.hidden, true))
  byId('search-close').addEventListener('click', () => toggleSearch(false, true))
  byId('search-next').addEventListener('click', () => find('again', false))
  // Text being composed (Japanese input) is searched once it is confirmed.
  searchQuery.addEventListener('input', (event) => {
    if (!event.isComposing) find('', false)
  })
  searchQuery.addEventListener('compositionend', () => find('', false))
  searchQuery.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    find('again', event.shiftKey)
  })
  const showMatches = ({ current, total }) => {
    if (
      !searchBar.hidden &&
      searchQuery.value.trim() &&
      findController.state?.query === searchQuery.value &&
      total > 0 &&
      current > 0
    )
      searchResults.textContent = text.matches(current, total)
  }
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => showMatches(matchesCount))
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount, rawQuery }) => {
    if (searchBar.hidden || rawQuery !== searchQuery.value) return
    if (state === FindState.NOT_FOUND) {
      void hasSearchableText().then((found) => {
        if (!searchBar.hidden && rawQuery === searchQuery.value)
          searchResults.textContent = found ? text.noResults : text.noText
      })
    } else if (state !== FindState.PENDING) showMatches(matchesCount)
  })

  // Page list. Thumbnails are drawn only while the list is open and the
  // viewer page is visible, one at a time, for the items near the visible
  // part of the list, closest to the current page first.
  const THUMBNAIL_WIDTH = 240
  const thumbnailsVisible = new Set()
  const thumbnailsDone = new Set()
  let thumbnailObserver = null
  let thumbnailTask = null
  let thumbnailsRunning = false
  let pageShown = true
  const thumbnailsActive = () =>
    dialog.open && pageShown && document.visibilityState === 'visible' && pdfDocument !== null
  function nextThumbnail() {
    const current = viewer.currentPageNumber
    let best = 0
    for (const page of thumbnailsVisible)
      if (!thumbnailsDone.has(page) && (!best || Math.abs(page - current) < Math.abs(best - current)))
        best = page
    return best
  }
  async function drawThumbnails() {
    if (thumbnailsRunning) return
    thumbnailsRunning = true
    try {
      while (thumbnailsActive()) {
        const n = nextThumbnail()
        if (!n) break
        const item = list.children[n - 1]
        try {
          const page = await pdfDocument.getPage(n)
          if (!thumbnailsActive()) break
          const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / page.getViewport({ scale: 1 }).width })
          const canvas = item.querySelector('canvas')
          canvas.width = Math.round(viewport.width)
          canvas.height = Math.round(viewport.height)
          item.firstElementChild.style.aspectRatio = canvas.width + ' / ' + canvas.height
          thumbnailTask = page.render({ canvas, viewport })
          await thumbnailTask.promise
          thumbnailsDone.add(n)
          item.dataset.rendered = 'true'
          // Releases what the thumbnail needed; pdf.js keeps a page the
          // viewer is still drawing.
          page.cleanup()
        } catch (error) {
          // A cancelled thumbnail is drawn again later; one that failed, in
          // loading its page or in drawing it, stays blank and is not retried.
          if (!error || error.name !== 'RenderingCancelledException') {
            if (error) console.error(error)
            thumbnailsDone.add(n)
          }
        } finally {
          thumbnailTask = null
        }
      }
    } finally {
      thumbnailsRunning = false
    }
    if (thumbnailsActive() && nextThumbnail()) void drawThumbnails()
  }
  function pauseThumbnails() {
    thumbnailTask?.cancel()
  }
  function buildPageList() {
    if (thumbnailObserver) return
    thumbnailObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number(entry.target.dataset.page)
          if (entry.isIntersecting) thumbnailsVisible.add(page)
          else thumbnailsVisible.delete(page)
        }
        void drawThumbnails()
      },
      { root: list, rootMargin: '400px 0px' },
    )
    for (let n = 1; n <= viewer.pagesCount; n++) {
      const item = document.createElement('button')
      item.type = 'button'
      item.dataset.page = String(n)
      item.setAttribute('aria-label', text.goToPage(n))
      item.innerHTML = '<span class="thumbnail"><canvas></canvas></span><span class="thumbnail-number"></span>'
      item.lastElementChild.textContent = String(n)
      const view = viewer.getPageView(n - 1)
      if (view) item.firstElementChild.style.aspectRatio = view.width + ' / ' + view.height
      item.addEventListener('click', () => {
        goTo(n)
        dialog.close()
      })
      list.append(item)
      thumbnailObserver.observe(item)
    }
    sync()
  }
  pagesButton.addEventListener('click', () => {
    if (!ready || !pdfDocument) return
    toggleSettings(false, false)
    toggleSearch(false, false)
    buildPageList()
    dialog.showModal()
    const current = list.querySelector('[aria-current]')
    current?.focus()
    current?.scrollIntoView({ block: 'center' })
    void drawThumbnails()
  })
  byId('pages-close').addEventListener('click', () => dialog.close())
  // A click on the backdrop reaches the dialog itself outside its box.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    const box = dialog.getBoundingClientRect()
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      dialog.close()
  })
  dialog.addEventListener('close', () => {
    pauseThumbnails()
    pagesButton.focus()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void drawThumbnails()
    else pauseThumbnails()
  })
  addEventListener('pageshow', () => {
    pageShown = true
    void drawThumbnails()
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target
    // Keys that confirm or cancel text being composed (Japanese input)
    // belong to the input method.
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && !displayOptions.hidden) {
      event.preventDefault()
      toggleSettings(false, true)
      return
    }
    if (event.key === 'Escape' && target instanceof Element && target.closest('#search-bar')) {
      event.preventDefault()
      toggleSearch(false, true)
      return
    }
    // Ctrl/Cmd+F inside the viewer opens its own search.
    if (
      ready &&
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (/^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'f' : event.code === 'KeyF') &&
      !dialog.open
    ) {
      event.preventDefault()
      toggleSearch(true, false)
      return
    }
    if (
      !ready ||
      dialog.open ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (target instanceof Element && target.closest('#display-options, #search-bar')) ||
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
  // Swiping turns pages only one page at a time and while the page fits the
  // width; zoomed wider, a swipe pans the page instead.
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
      if (
        touchStart &&
        touch &&
        layoutMode === 'page' &&
        container.scrollWidth <= container.clientWidth + 2
      ) {
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
  container.addEventListener(
    'touchcancel',
    () => {
      touchStart = null
    },
    { passive: true },
  )
  new ResizeObserver(fit).observe(container)

  try {
    // Download serves the bytes pdf.js already holds, so it keeps working
    // after the sandbox's short-lived cookie expires during long reading.
    // Only once the whole file is in memory: until then the link itself
    // still works, and waiting for the rest could expire the click.
    const saveFromMemory = async (event) => {
      if (!downloadable) return
      event.preventDefault()
      const download = event.currentTarget
      const name = download.getAttribute('download') || 'document.pdf'
      const save = (href) => {
        const link = document.createElement('a')
        link.href = href
        link.download = name
        document.body.append(link)
        link.click()
        link.remove()
      }
      let bytes
      try {
        bytes = await downloadable.getData()
      } catch {
        // Like the link itself: a download, never a navigation of the viewer.
        save(download.href)
        return
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      save(url)
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    }
    byId('download').addEventListener('click', saveFromMemory)
    byId('pages-download').addEventListener('click', saveFromMemory)
    const pdf = await pdfjs.getDocument({
      url: ORIGINAL,
      isEvalSupported: false,
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      wasmUrl: PDFJS + 'wasm/',
      iccUrl: PDFJS + 'iccs/',
    }).promise
    // Saved from memory only once pdf.js holds the whole file.
    pdf.getDownloadInfo().then(() => {
      downloadable = pdf
    }, () => {})
    const first = await pdf.getPage(1)
    const viewport = first.getViewport({ scale: 1 })
    const slides = viewport.width > viewport.height
    layoutMode = slides ? 'page' : 'scroll'
    size = slides ? 'page-fit' : 'auto'
    showSettings()
    viewer.scrollMode = slides ? ScrollMode.PAGE : ScrollMode.VERTICAL
    document.body.dataset.mode = layoutMode
    pdfDocument = pdf
    viewer.setDocument(pdf)
    linkService.setDocument(pdf)
    // A page kept for back/forward navigation keeps its document, so it
    // shows the PDF again when restored; only a real unload releases it.
    addEventListener('pagehide', (event) => {
      pageShown = false
      pauseThumbnails()
      if (event.persisted) return
      thumbnailObserver?.disconnect()
      downloadable = null
      pdfDocument = null
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

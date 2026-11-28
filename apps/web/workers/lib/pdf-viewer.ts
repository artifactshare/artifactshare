import {
  PDF_ORIGINAL_PATH,
  PDF_VIEWER_SCRIPT_PATH,
  PDF_VIEWER_STYLE_PATH,
  PDFJS_ASSET_PREFIX,
} from '../../app/viewers/pdf/paths'
import { PDF_VIEWER_SCRIPT } from './pdf-viewer-script.generated'
import { PDF_VIEWER_STYLE } from './pdf-viewer-style.generated'

export { PDF_ORIGINAL_PATH }
export const PDF_MIME_TYPE = 'application/pdf'

export interface PdfViewerAsset {
  body: string
  contentType: string
}

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

export function pdfViewerDocument(entrypointPath: string | null): string {
  const fileName = escapeHtml(pdfDownloadFileName(entrypointPath))
  const download = `${PDF_ORIGINAL_PATH}?download=1`
  return `<!doctype html>
<html lang="en" data-theme="system" data-pdf-state="loading">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileName}</title>
<link rel="stylesheet" href="${PDFJS_ASSET_PREFIX}pdf_viewer.css">
<link rel="stylesheet" href="${PDF_VIEWER_STYLE_PATH}">
</head>
<body data-mode="page">
<div id="pdf-viewer-root" data-file-name="${fileName}" data-download-href="${download}"></div>
<script type="module" src="${PDF_VIEWER_SCRIPT_PATH}"></script>
</body>
</html>`
}

import type { ArtifactType } from '~/lib/artifact-type'
import { renderMermaidInDocument } from '~/lib/mermaid-render.client'

export type ExportSourceData = {
  kind: 'markdown' | 'html'
  artifactKind: string
  path: string
  versionId: string
  source: string
  fileName: string
  renderedHtml?: string
}

const READABILITY_BASE_ORIGIN = 'https://artifactshare.local'

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
  const sourceHtml = data.kind === 'markdown' ? data.renderedHtml : data.source
  if (!sourceHtml) return null
  if (!sourceHtml.trim()) return null
  const doc = new DOMParser().parseFromString(sourceHtml, 'text/html')
  await renderMermaidInDocument(doc, data.kind === 'markdown')
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

function isStylesheetLink(element: Element): boolean {
  return (element.getAttribute('rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet')
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

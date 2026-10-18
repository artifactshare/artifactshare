import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import { canonicalExportPath, storedExportPath } from '~/lib/export-path'
import { errorResponse } from '~/lib/api-errors'
import { renderMarkdownDocument } from '~/lib/markdown-render'
import type { SessionUser } from '~/lib/user'
import { loadCommentAccess } from '~/services/comments.server'
import { getArtifact, type StoredArtifact } from '~/services/storage.server'
import type { DB } from '~/types/db'

const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml'])
const PASSIVE_EXPORT_ASSET_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.png',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
])

export type ExportSourceResult =
  | { kind: 'ok'; data: ExportSourceData }
  | ExportSourceFailure

export type ExportAssetResult =
  | {
      kind: 'ok'
      object: StoredArtifact
      path: string
      contentType: string
    }
  | ExportSourceFailure

export type ExportSourceFailure =
  | { kind: 'not-found' }
  | { kind: 'unsupported-kind'; artifactKind: string }
  | { kind: 'source-unavailable' }
  | { kind: 'non-html-source'; path: string; contentType: string }

export interface ExportSourceData {
  kind: 'markdown' | 'html'
  artifactKind: string
  path: string
  versionId: string
  source: string
  fileName: string
  renderedHtml?: string
}

export async function getExportSource(
  db: Kysely<DB>,
  user: SessionUser,
  args: { id: string; path?: string | null; versionId?: string | null },
): Promise<ExportSourceResult> {
  const access = await loadCommentAccess(db, user, args.id)
  if (!access?.currentVersionId) return { kind: 'not-found' }

  if (args.versionId != null && args.versionId !== access.currentVersionId)
    return { kind: 'not-found' }
  if (!(await ownsExportVersion(db, args.id, access.currentVersionId)))
    return { kind: 'not-found' }
  try {
    if (args.path) canonicalExportPath(args.path)
  } catch {
    return { kind: 'not-found' }
  }

  const result = await (():
    | Promise<ExportSourceResult>
    | ExportSourceResult => {
    switch (access.artifactKind) {
      case 'markdown_page':
        return loadMarkdownExportSource(access)
      case 'html_page':
        return loadHtmlPageExportSource(access, args.path)
      case 'static_site':
        return loadStaticSiteExportSource(db, access, args.path)
      default:
        return { kind: 'unsupported-kind', artifactKind: access.artifactKind }
    }
  })()
  if (result.kind === 'ok') {
    const current = await loadCommentAccess(db, user, args.id)
    if (current?.currentVersionId !== result.data.versionId)
      return { kind: 'not-found' }
  }
  return result
}

export async function getExportAsset(
  db: Kysely<DB>,
  user: SessionUser,
  args: { id: string; path: string; versionId: string | null },
): Promise<ExportAssetResult> {
  const access = await loadCommentAccess(db, user, args.id)
  if (
    !args.versionId ||
    !access?.currentVersionId ||
    args.versionId !== access.currentVersionId
  )
    return { kind: 'not-found' }
  if (access.artifactKind !== 'static_site') {
    return { kind: 'unsupported-kind', artifactKind: access.artifactKind }
  }

  let path: string
  try {
    path = storedExportPath(args.path)
  } catch {
    return { kind: 'not-found' }
  }
  const file = await db
    .selectFrom('version_files')
    .innerJoin('versions', 'versions.id', 'version_files.version_id')
    .select([
      'version_files.path',
      'version_files.r2_key',
      'version_files.mime_type',
    ])
    .where('version_files.version_id', '=', args.versionId)
    .where('versions.shareable_id', '=', args.id)
    .where('version_files.path', '=', path)
    .executeTakeFirst()
  if (!file) return { kind: 'not-found' }

  const object = await getArtifact(env.BUCKET, file.r2_key)
  if (!object) return { kind: 'source-unavailable' }
  const current = await loadCommentAccess(db, user, args.id)
  if (current?.currentVersionId !== args.versionId) return { kind: 'not-found' }

  return {
    kind: 'ok',
    object,
    path: file.path,
    contentType: !isPassiveExportAssetContent(file.path, file.mime_type)
      ? file.mime_type
      : object.httpMetadata?.contentType ||
        file.mime_type ||
        'application/octet-stream',
  }
}

async function ownsExportVersion(
  db: Kysely<DB>,
  id: string,
  versionId: string,
): Promise<boolean> {
  return Boolean(
    await db
      .selectFrom('versions')
      .select('id')
      .where('id', '=', versionId)
      .where('shareable_id', '=', id)
      .executeTakeFirst(),
  )
}

export function normalizeExportPath(
  path: string | null | undefined,
  defaultPath = '/index.html',
): string {
  const canonical = canonicalExportPath(String(path ?? '').trim())
  return canonical === '/' ? defaultPath : canonical
}

export function isHtmlContent(path: string, contentType: string): boolean {
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (mimeType && HTML_CONTENT_TYPES.has(mimeType)) return true
  const lowerPath = path.toLowerCase()
  return lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')
}

export function isPassiveExportAssetContent(
  path: string,
  contentType: string,
): boolean {
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (mimeType === 'text/css') return true
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') return true
  if (mimeType.startsWith('font/')) return true
  if (mimeType.startsWith('audio/')) return true
  if (mimeType.startsWith('video/')) return true
  if (
    mimeType === 'application/font-woff' ||
    mimeType === 'application/font-woff2' ||
    mimeType === 'application/octet-stream' ||
    mimeType === 'application/vnd.ms-fontobject' ||
    mimeType === 'application/woff' ||
    mimeType === 'application/woff2'
  ) {
    if (mimeType !== 'application/octet-stream') return true
  } else if (mimeType) {
    return false
  }

  const lowerPath = path.toLowerCase()
  const dotIndex = lowerPath.lastIndexOf('.')
  if (dotIndex === -1) return false
  return PASSIVE_EXPORT_ASSET_EXTENSIONS.has(lowerPath.slice(dotIndex))
}

export function exportSourceErrorResponse(
  result: ExportSourceFailure,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'unsupported-kind':
      return errorResponse(
        'unsupported-kind',
        'This artifact kind does not support export.',
        400,
      )
    case 'non-html-source':
      return errorResponse(
        'non-html-source',
        'The requested path is not an HTML source.',
        400,
      )
    case 'source-unavailable':
      return errorResponse(
        'source-unavailable',
        'Export source is unavailable.',
        409,
      )
  }
}

type Access = NonNullable<Awaited<ReturnType<typeof loadCommentAccess>>>

async function loadMarkdownExportSource(
  access: Access,
): Promise<ExportSourceResult> {
  if (!access.r2Key) return { kind: 'source-unavailable' }

  const path = access.entrypointPath
    ? storedExportPath(access.entrypointPath)
    : '/index.md'
  const object = await getArtifact(env.BUCKET, access.r2Key)
  if (!object) return { kind: 'source-unavailable' }
  const source = await object.text()

  return {
    kind: 'ok',
    data: {
      kind: 'markdown',
      artifactKind: access.artifactKind,
      path,
      versionId: access.currentVersionId!,
      source,
      fileName: exportFileName(path, 'index.md'),
      renderedHtml: renderMarkdownDocument(source),
    },
  }
}

async function loadHtmlPageExportSource(
  access: Access,
  queryPath?: string | null,
): Promise<ExportSourceResult> {
  if (!access.r2Key) return { kind: 'source-unavailable' }

  const path = access.entrypointPath
    ? storedExportPath(access.entrypointPath)
    : normalizeExportPath(queryPath)
  const object = await getArtifact(env.BUCKET, access.r2Key)
  if (!object) return { kind: 'source-unavailable' }

  const contentType =
    object.httpMetadata?.contentType ?? 'text/html; charset=utf-8'
  if (!isHtmlContent(path, contentType)) {
    return {
      kind: 'non-html-source',
      path,
      contentType: contentType || 'unknown',
    }
  }

  return {
    kind: 'ok',
    data: {
      kind: 'html',
      artifactKind: access.artifactKind,
      path,
      versionId: access.currentVersionId!,
      source: await object.text(),
      fileName: exportFileName(path, 'index.html'),
    },
  }
}

async function loadStaticSiteExportSource(
  db: Kysely<DB>,
  access: Access,
  queryPath?: string | null,
): Promise<ExportSourceResult> {
  const path =
    queryPath != null
      ? normalizeExportPath(queryPath)
      : access.entrypointPath
        ? storedExportPath(access.entrypointPath)
        : '/index.html'
  const candidatePaths = staticSiteExportCandidatePaths(path)
  const files = await db
    .selectFrom('versions')
    .innerJoin('version_files', 'version_files.version_id', 'versions.id')
    .select([
      'versions.fallback_to_index',
      'version_files.path',
      'version_files.r2_key',
      'version_files.mime_type',
    ])
    .where('versions.id', '=', access.currentVersionId!)
    .where('version_files.path', 'in', candidatePaths)
    .execute()
  const requestedCandidatePaths =
    path === '/index.html'
      ? ['/index.html']
      : candidatePaths.filter(
          (candidatePath) => candidatePath !== '/index.html',
        )
  const htmlCandidate = requestedCandidatePaths
    .map((candidatePath) => files.find((file) => file.path === candidatePath))
    .find(
      (file) =>
        file !== undefined && isHtmlContent(file.path, file.mime_type || ''),
    )
  const nonHtmlCandidate = htmlCandidate
    ? undefined
    : requestedCandidatePaths
        .map((candidatePath) =>
          files.find((file) => file.path === candidatePath),
        )
        .find((file) => file !== undefined)
  const fallback = files.find(
    (file) =>
      file.path === '/index.html' && Number(file.fallback_to_index) === 1,
  )
  const file = htmlCandidate ?? (nonHtmlCandidate ? undefined : fallback)
  if (!file) {
    if (nonHtmlCandidate) {
      return {
        kind: 'non-html-source',
        path: nonHtmlCandidate.path,
        contentType: nonHtmlCandidate.mime_type || 'unknown',
      }
    }
    return { kind: 'not-found' }
  }

  const declaredContentType = file.mime_type || ''
  if (!isHtmlContent(file.path, declaredContentType)) {
    return {
      kind: 'non-html-source',
      path: file.path,
      contentType: declaredContentType || 'unknown',
    }
  }

  const object = await getArtifact(env.BUCKET, file.r2_key)
  if (!object) return { kind: 'source-unavailable' }

  const contentType = object.httpMetadata?.contentType ?? declaredContentType
  if (!isHtmlContent(file.path, contentType)) {
    return {
      kind: 'non-html-source',
      path: file.path,
      contentType: contentType || 'unknown',
    }
  }

  return {
    kind: 'ok',
    data: {
      kind: 'html',
      artifactKind: access.artifactKind,
      path: file.path,
      versionId: access.currentVersionId!,
      source: await object.text(),
      fileName: exportFileName(file.path, 'index.html'),
    },
  }
}

function exportFileName(path: string, fallback: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.at(-1) ?? fallback
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').at(-1) ?? ''
  return /\.[^./]+$/.test(lastSegment)
}

function staticSiteExportCandidatePaths(path: string): string[] {
  if (hasFileExtension(path)) return [path]
  const directoryIndexPath = path.endsWith('/')
    ? `${path}index.html`
    : `${path}/index.html`
  return Array.from(new Set([path, directoryIndexPath, '/index.html']))
}

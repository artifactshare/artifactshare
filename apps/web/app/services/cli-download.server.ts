import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import type { ArtifactKind } from '~/lib/shareable-types'
import type { SessionUser } from '~/lib/user'
import { singleFileFormat } from '~/services/artifact-readback.server'
import { loadCommentAccess } from '~/services/comments.server'
import { getArtifact, type StoredArtifact } from '~/services/storage.server'
import type { DB } from '~/types/db'

export type CliDownloadManifestResult =
  | { kind: 'ok'; data: CliDownloadManifest }
  | { kind: 'not-found' }
  | { kind: 'unsupported-kind'; artifactKind: string }
  | { kind: 'source-unavailable' }

export type CliDownloadFileResult =
  | { kind: 'ok'; file: CliDownloadFile; object: StoredArtifact }
  | { kind: 'not-found' }
  | { kind: 'unsupported-kind'; artifactKind: string }
  | { kind: 'source-unavailable' }

export type CliDownloadFile = {
  path: string
  size_bytes: number
  content_type: string
  sha256: string
}

export type CliDownloadManifest = {
  id: string
  share_url: string
  version_id: string
  artifact_kind: string
  files: CliDownloadFile[]
  total_size_bytes: number
  project_id: string | null
}

export async function getCliDownloadManifest(
  db: Kysely<DB>,
  user: SessionUser,
  args: { id: string; baseUrl: string },
): Promise<CliDownloadManifestResult> {
  const access = await loadCommentAccess(db, user, args.id)
  if (!access?.currentVersionId) return { kind: 'not-found' }
  const projectId = access.projectId ?? null

  if (singleFileFormat(access.artifactKind as ArtifactKind)) {
    if (!access.r2Key) return { kind: 'source-unavailable' }
    const metadata = await loadSingleFileVersionMetadata(
      db,
      access.currentVersionId,
    )
    if (!metadata) return { kind: 'source-unavailable' }
    const file = {
      path: singleFileDownloadPath(access.artifactKind, access.entrypointPath),
      size_bytes: metadata.sizeBytes,
      content_type: singleFileContentType(access.artifactKind),
      sha256: metadata.sha256,
    }
    return {
      kind: 'ok',
      data: {
        id: args.id,
        share_url: shareUrl(args.baseUrl, args.id),
        version_id: access.currentVersionId,
        artifact_kind: access.artifactKind,
        files: [file],
        total_size_bytes: metadata.sizeBytes,
        project_id: projectId,
      },
    }
  }

  if (access.artifactKind !== 'static_site') {
    return { kind: 'unsupported-kind', artifactKind: access.artifactKind }
  }

  const files = await db
    .selectFrom('version_files')
    .select(['path', 'size_bytes', 'mime_type', 'sha256'])
    .where('version_id', '=', access.currentVersionId)
    .orderBy('path')
    .execute()
  if (files.length === 0) return { kind: 'source-unavailable' }

  return {
    kind: 'ok',
    data: {
      id: args.id,
      share_url: shareUrl(args.baseUrl, args.id),
      version_id: access.currentVersionId,
      artifact_kind: access.artifactKind,
      files: files.map((file) => ({
        path: file.path,
        size_bytes: file.size_bytes,
        content_type: file.mime_type,
        sha256: file.sha256,
      })),
      total_size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
      project_id: projectId,
    },
  }
}

export async function getCliDownloadFile(
  db: Kysely<DB>,
  user: SessionUser,
  args: { id: string; path: string },
): Promise<CliDownloadFileResult> {
  const access = await loadCommentAccess(db, user, args.id)
  if (!access?.currentVersionId) return { kind: 'not-found' }

  if (singleFileFormat(access.artifactKind as ArtifactKind)) {
    const filePath = singleFileDownloadPath(
      access.artifactKind,
      access.entrypointPath,
    )
    if (args.path !== filePath || !access.r2Key) return { kind: 'not-found' }
    const object = await getArtifact(env.BUCKET, access.r2Key)
    if (!object) return { kind: 'source-unavailable' }
    const metadata = await loadSingleFileVersionMetadata(
      db,
      access.currentVersionId,
    )
    if (!metadata) return { kind: 'source-unavailable' }
    return {
      kind: 'ok',
      file: {
        path: filePath,
        size_bytes: metadata.sizeBytes,
        content_type: singleFileContentType(access.artifactKind),
        sha256: metadata.sha256,
      },
      object,
    }
  }

  if (access.artifactKind !== 'static_site') {
    return { kind: 'unsupported-kind', artifactKind: access.artifactKind }
  }

  const file = await db
    .selectFrom('version_files')
    .select(['path', 'r2_key', 'size_bytes', 'mime_type', 'sha256'])
    .where('version_id', '=', access.currentVersionId)
    .where('path', '=', args.path)
    .executeTakeFirst()
  if (!file) return { kind: 'not-found' }

  const object = await getArtifact(env.BUCKET, file.r2_key)
  if (!object) return { kind: 'source-unavailable' }
  return {
    kind: 'ok',
    file: {
      path: file.path,
      size_bytes: file.size_bytes,
      content_type: file.mime_type,
      sha256: file.sha256,
    },
    object,
  }
}

function singleFileDownloadPath(
  artifactKind: string,
  entrypointPath: string | null,
): string {
  if (entrypointPath?.startsWith('/')) return entrypointPath
  if (entrypointPath) return `/${entrypointPath}`
  return artifactKind === 'markdown_page' ? '/index.md' : '/index.html'
}

async function loadSingleFileVersionMetadata(
  db: Kysely<DB>,
  versionId: string,
): Promise<{ sizeBytes: number; sha256: string } | null> {
  const row = await db
    .selectFrom('versions')
    .select(['size_bytes', 'sha256'])
    .where('id', '=', versionId)
    .executeTakeFirst()
  if (!row) return null
  return { sizeBytes: row.size_bytes, sha256: row.sha256 }
}

function singleFileContentType(artifactKind: string): string {
  return artifactKind === 'markdown_page'
    ? 'text/markdown; charset=utf-8'
    : 'text/html; charset=utf-8'
}

function shareUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, '')}/a/${id}`
}

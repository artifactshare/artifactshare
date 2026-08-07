/*
 * Maps a file MIME type + filename to a render type.
 *
 * Upload sources label Markdown inconsistently. Falling back to the file
 * extension catches common `text/plain` / octet-stream cases.
 */

import type { ArtifactKind } from './shareable-types'

export type SingleFileArtifactType = 'html' | 'md'
export type ArtifactType = SingleFileArtifactType | 'static_site'

export const HTML_FILE_EXTENSIONS = ['.html', '.htm'] as const
export const MD_FILE_EXTENSIONS = ['.md', '.markdown'] as const

// 在席表示と全体コメントを出せる種別。本文範囲コメントは本文選択を要するため
// html / md のみで、これとは別 (textAnchorsEnabled)。viewer-chrome の入口と
// viewer-shell のパネル・live 接続が同じ判定を使うための単一の正。
export function artifactSupportsComments(
  renderType: ArtifactType | null,
): boolean {
  return (
    renderType === 'html' || renderType === 'md' || renderType === 'static_site'
  )
}

export function detectArtifactType(
  mimeType: string | null,
  fileName: string,
): SingleFileArtifactType | null {
  const mime = mimeType ?? ''
  if (mime.startsWith('text/html')) return 'html'
  if (mime === 'text/markdown') return 'md'
  if (
    (mime === 'text/plain' || mime === 'application/octet-stream') &&
    hasExtension(fileName, MD_FILE_EXTENSIONS)
  ) {
    return 'md'
  }
  return null
}

// Upload inverts the MIME-vs-extension preference of detectArtifactType:
// browsers report empty / wrong MIME for many drag-dropped .html / .md
// files, so the filename is the more trustworthy signal here.
export function detectArtifactTypeForUpload(
  mimeType: string | null,
  fileName: string,
): SingleFileArtifactType | null {
  if (hasExtension(fileName, HTML_FILE_EXTENSIONS)) return 'html'
  if (hasExtension(fileName, MD_FILE_EXTENSIONS)) return 'md'
  return detectArtifactType(mimeType, fileName)
}

// Inverse of detectArtifactType for the subset of artifact kinds that
// have a viewer renderer. Other kinds (static_site / spa / workspace_app)
// don't go through the single-file renderer; callers handle them upstream.
export function renderTypeFromKind(kind: ArtifactKind): ArtifactType | null {
  if (kind === 'markdown_page') return 'md'
  if (kind === 'html_page') return 'html'
  return null
}

export function hasExtension(
  fileName: string,
  extensions: ReadonlyArray<string>,
): boolean {
  const lowerName = fileName.toLowerCase()
  return extensions.some((extension) => lowerName.endsWith(extension))
}

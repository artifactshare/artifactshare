/*
 * Maps a file MIME type + filename to a render type.
 *
 * Upload sources label Markdown inconsistently. Falling back to the file
 * extension catches common `text/plain` / octet-stream cases.
 */

import type { ArtifactKind } from './shareable-types'

export type SingleFileArtifactType = 'html' | 'md' | 'pdf' | 'video'
export type ArtifactType = SingleFileArtifactType | 'static_site'

export const HTML_FILE_EXTENSIONS = ['.html', '.htm'] as const
export const MD_FILE_EXTENSIONS = ['.md', '.markdown'] as const
export const PDF_FILE_EXTENSIONS = ['.pdf'] as const
export const PDF_MIME_TYPE = 'application/pdf'
// ASCII "%PDF-" at byte zero. It only classifies the file: a file starting with
// it may still be corrupt or encrypted, and the viewer reports that state.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const

export function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_MAGIC.length &&
    PDF_MAGIC.every((value, index) => bytes[index] === value)
  )
}

export const VIDEO_FILE_EXTENSIONS = ['.mp4'] as const
export const VIDEO_MIME_TYPE = 'video/mp4'
// An ISO base media file starts with a box whose type, ASCII "ftyp", sits at
// bytes 4-7. Like the PDF header it only classifies the file: the movie may
// still be corrupt or use a codec the browser cannot decode.
const FTYP = [0x66, 0x74, 0x79, 0x70] as const

export function hasMp4Signature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    FTYP.every((value, index) => bytes[index + 4] === value)
  )
}

// 在席表示と全体コメントを出せる種別。本文範囲コメントは本文選択を要するため
// html / md のみで、これとは別 (textAnchorsEnabled)。PDF と動画は全体コメントのみ。
// viewer-chrome の入口と viewer-shell のパネル・live 接続が同じ判定を使うための単一の正。
export function artifactSupportsComments(
  renderType: ArtifactType | null,
): boolean {
  return (
    renderType === 'html' ||
    renderType === 'md' ||
    renderType === 'static_site' ||
    renderType === 'pdf' ||
    renderType === 'video'
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
// files, so the filename is the more trustworthy signal here. A PDF needs its
// `.pdf` suffix (any case) and, where bytes are checked, `%PDF-` magic; its
// MIME type alone never selects it (detectArtifactType does not return pdf).
// A video likewise needs its `.mp4` suffix and an `ftyp` box at offset 4.
export function detectArtifactTypeForUpload(
  mimeType: string | null,
  fileName: string,
): SingleFileArtifactType | null {
  if (hasExtension(fileName, HTML_FILE_EXTENSIONS)) return 'html'
  if (hasExtension(fileName, MD_FILE_EXTENSIONS)) return 'md'
  if (hasExtension(fileName, PDF_FILE_EXTENSIONS)) return 'pdf'
  if (hasExtension(fileName, VIDEO_FILE_EXTENSIONS)) return 'video'
  return detectArtifactType(mimeType, fileName)
}

// Inverse of detectArtifactType for the subset of artifact kinds that
// have a viewer renderer. Other kinds (static_site / spa / workspace_app)
// don't go through the single-file renderer; callers handle them upstream.
// A PDF is binary: callers needing text source must check html / md.
export function renderTypeFromKind(kind: ArtifactKind): ArtifactType | null {
  if (kind === 'markdown_page') return 'md'
  if (kind === 'html_page') return 'html'
  if (kind === 'pdf') return 'pdf'
  if (kind === 'video') return 'video'
  return null
}

export function hasExtension(
  fileName: string,
  extensions: ReadonlyArray<string>,
): boolean {
  const lowerName = fileName.toLowerCase()
  return extensions.some((extension) => lowerName.endsWith(extension))
}

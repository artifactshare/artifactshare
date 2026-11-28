import type { ArtifactKind } from './shareable-types'

export type SingleFileArtifactType = 'html' | 'md' | 'pdf' | 'video'
export type ArtifactType = SingleFileArtifactType | 'static_site'

export const HTML_FILE_EXTENSIONS = ['.html', '.htm'] as const
export const MD_FILE_EXTENSIONS = ['.md', '.markdown'] as const
export const PDF_FILE_EXTENSIONS = ['.pdf'] as const
export const PDF_MIME_TYPE = 'application/pdf'
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const

export function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_MAGIC.length &&
    PDF_MAGIC.every((value, index) => bytes[index] === value)
  )
}

export const VIDEO_FILE_EXTENSIONS = ['.mp4'] as const
export const VIDEO_MIME_TYPE = 'video/mp4'
const FTYP = [0x66, 0x74, 0x79, 0x70] as const

export function hasMp4Signature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    FTYP.every((value, index) => bytes[index + 4] === value)
  )
}

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
// files, so the filename is the more trustworthy signal here.
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

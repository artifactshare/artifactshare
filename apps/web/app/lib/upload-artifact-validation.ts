import {
  HTML_FILE_EXTENSIONS,
  MD_FILE_EXTENSIONS,
  hasExtension,
} from '~/lib/artifact-type'
import type { TKey } from '~/lib/i18n'
import { STATIC_SITE_UPLOAD_LIMITS } from '~/lib/product-contracts'

export { STATIC_SITE_UPLOAD_LIMITS } from '~/lib/product-contracts'
const MAX_UPLOAD_BYTES = STATIC_SITE_UPLOAD_LIMITS.totalBytes
const MAX_STATIC_SITE_FILE_BYTES = STATIC_SITE_UPLOAD_LIMITS.fileBytes
const ALLOWED_EXTENSIONS = [...HTML_FILE_EXTENSIONS, ...MD_FILE_EXTENSIONS]
const STATIC_SITE_ALLOWED_EXTENSIONS = [
  ...ALLOWED_EXTENSIONS,
  '.css',
  '.js',
  '.json',
  '.txt',
  '.xml',
  '.webmanifest',
  '.map',
  '.data',
  '.rsc',
  '.meta',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
]
export const ACCEPTED_FILE_UPLOAD_TYPES = ALLOWED_EXTENSIONS.join(',')
export const ACCEPTED_SITE_UPLOAD_TYPES =
  STATIC_SITE_ALLOWED_EXTENSIONS.join(',')
const PHASE_2_EXTENSIONS = ['.zip']
const IGNORED_UPLOAD_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
])
const IGNORED_UPLOAD_PATH_SEGMENTS = new Set(['__MACOSX'])

type Translate = (key: TKey) => string
type UploadFile = File & { webkitRelativePath?: string }

export function validateFiles(
  files: File[],
  t: Translate,
  options?: { staticSite?: boolean },
): string | null {
  const paths = uploadPathsForFiles(files)
  const staticSite = options?.staticSite ?? isStaticSiteUploadPathSet(paths)
  if (staticSite && files.length > STATIC_SITE_UPLOAD_LIMITS.files) {
    return t('upload.error.tooManyFiles')
  }
  let totalSize = 0
  const seenPaths = new Set<string>()
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    const path = paths[i]
    totalSize += file.size
    if (hasExtension(path, PHASE_2_EXTENSIONS)) {
      return t('upload.error.phase2')
    }
    if (staticSite) {
      if (file.size > MAX_STATIC_SITE_FILE_BYTES) {
        return t('upload.error.fileTooLarge')
      }
      if (!hasExtension(path, STATIC_SITE_ALLOWED_EXTENSIONS)) {
        return t('upload.error.unsupportedBundleType')
      }
      const preparedPath = path.startsWith('/') ? path : `/${path}`
      if (preparedPath.length > STATIC_SITE_UPLOAD_LIMITS.pathChars) {
        return t('upload.error.pathTooLong')
      }
      if (
        bundleFolderDepth(preparedPath) > STATIC_SITE_UPLOAD_LIMITS.folderDepth
      ) {
        return t('upload.error.pathTooDeep')
      }
      const lowerPath = preparedPath.toLowerCase()
      if (seenPaths.has(lowerPath)) return t('upload.error.duplicatePath')
      seenPaths.add(lowerPath)
    } else if (!hasExtension(path, ALLOWED_EXTENSIONS)) {
      return t('upload.error.unsupported')
    }
  }
  if (totalSize > MAX_UPLOAD_BYTES) return t('upload.error.tooLarge')
  // Static site entrypoints stay narrower than accepted file extensions.
  if (staticSite && !paths.some((path) => /^index\.(html|md)$/i.test(path))) {
    return t('upload.error.missingEntrypoint')
  }
  return null
}

export function isStaticSiteUpload(files: ReadonlyArray<File>): boolean {
  return isStaticSiteUploadPathSet(uploadPathsForFiles(files))
}

export function uploadPathsForFiles(files: ReadonlyArray<File>): string[] {
  const rawPaths = files.map((file) => rawUploadPath(file))
  const commonRoot = commonTopLevelDirectory(rawPaths)
  if (!commonRoot) return rawPaths
  return rawPaths.map((path) => path.slice(commonRoot.length + 1))
}

export function appendUploadFiles(form: FormData, files: ReadonlyArray<File>) {
  const paths = uploadPathsForFiles(files)
  for (let i = 0; i < files.length; i += 1) {
    form.append('file', files[i], paths[i])
  }
}

export function filterUploadFiles(files: ReadonlyArray<File>): File[] {
  return files.filter((file) => !isIgnoredUploadPath(rawUploadPath(file)))
}

function rawUploadPath(file: File): string {
  const relativePath = (file as UploadFile).webkitRelativePath
  return relativePath && relativePath.length > 0 ? relativePath : file.name
}

function isIgnoredUploadPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.at(-1) ?? path
  return (
    IGNORED_UPLOAD_FILE_NAMES.has(fileName) ||
    segments.some((segment) => IGNORED_UPLOAD_PATH_SEGMENTS.has(segment))
  )
}

function isStaticSiteUploadPathSet(paths: ReadonlyArray<string>): boolean {
  return paths.length > 1 || paths.some((path) => path.includes('/'))
}

function bundleFolderDepth(path: string): number {
  return Math.max(path.split('/').filter(Boolean).length - 1, 0)
}

function commonTopLevelDirectory(paths: ReadonlyArray<string>): string | null {
  let root: string | null = null
  for (const path of paths) {
    const slash = path.indexOf('/')
    if (slash <= 0) return null
    const top = path.slice(0, slash)
    if (root === null) root = top
    else if (root !== top) return null
  }
  return root
}

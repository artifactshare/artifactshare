import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  prepareUploadSelection,
  uploadReadError,
  type UploadBoundaryDependencies,
} from './upload-boundary.js'
import type { CliError, DownloadPlan, UploadPayloadResult } from './types.js'
import type {
  DownloadManifestFile,
  DownloadManifestResponse,
} from '@artifactshare/contract'
import {
  WriteBoundary,
  WriteBoundaryError,
  WriteFileSystemError,
} from './write-boundary.js'
import { cliError, validationError } from './errors.js'
import type { FormData } from 'undici'

export class DownloadManifestError extends Error {
  readonly error
  constructor(message: string) {
    super(message)
    this.error = validationError(
      message,
      'Retry later. If this repeats, report the artifact ID.',
    )
  }
}

let undiciModule: typeof import('undici') | undefined

export async function createUploadForm(): Promise<FormData> {
  const { FormData } = (undiciModule ??= await import('undici'))
  return new FormData()
}

export async function prepareUploadPayload(
  targetPath: string,
  dependencies?: UploadBoundaryDependencies,
): Promise<UploadPayloadResult> {
  try {
    const selection = await prepareUploadSelection(
      targetPath,
      false,
      dependencies,
    )
    if (selection.directory && selection.files.length === 0) {
      return {
        error: validationError(
          'Directory has no shareable files.',
          'Add index.html or index.md and retry.',
        ),
      }
    }
    const form = await createUploadForm()
    for (const file of selection.files) {
      form.append(
        'file',
        file.blob.slice(0, file.blob.size, contentTypeFor(file.name)),
        file.name,
      )
    }
    return {
      payload: {
        form,
        kind: selection.directory
          ? 'static_site'
          : artifactKindForFile(selection.files[0]!.name),
      },
    }
  } catch (error) {
    return { error: uploadReadError(error, targetPath) }
  }
}

export async function prepareDownloadPlan(
  manifest: DownloadManifestResponse,
  outputPath: string,
  force: boolean,
  boundary = new WriteBoundary(),
  treePreflighted = false,
): Promise<
  { value: DownloadPlan; error?: never } | { error: CliError; value?: never }
> {
  if (manifest.files.length === 0) {
    return {
      error: validationError(
        'Download manifest contains no files.',
        'Check the artifact and retry.',
      ),
    }
  }
  if (outputPath === '') {
    return {
      error: validationError(
        '--output requires a non-empty directory.',
        'Pass --output <path> or omit --output to use the artifact ID.',
      ),
    }
  }
  const root = resolve(outputPath)
  if (boundary.workspace) await boundary.record(dirname(root), true)
  else await boundary.outputParent(dirname(root))
  const existing = await boundary.record(root, true)
  if (existing && !force) {
    return {
      error: cliError({
        code: 'output_exists',
        message: 'Output path already exists.',
        why: 'Download will not write into an existing path unless --force is set.',
        hint: 'Choose a different --output path or retry with --force.',
        agentRecoverable: true,
        requiresHuman: false,
        recovery: { kind: 'change_input' },
      }),
    }
  }
  // Project preflight already enumerated the tree. Reuse those records, but
  // still verify every identity instead of treating preflight as a bypass.
  if (treePreflighted) await boundary.checkTree(root)
  else await boundary.tree(root)
  const seen = new Set<string>()
  const directories = new Set<string>()
  const foldCase = process.platform === 'win32' || process.platform === 'darwin'
  const relativeFiles: Array<DownloadManifestFile & { relativePath: string }> =
    []
  for (const file of manifest.files) {
    const relativePath = downloadRelativePath(file.path)
    const key = foldCase ? relativePath.toLowerCase() : relativePath
    const prefixes: string[] = []
    for (
      let slash = key.indexOf('/');
      slash !== -1;
      slash = key.indexOf('/', slash + 1)
    )
      prefixes.push(key.slice(0, slash))
    if (
      seen.has(key) ||
      directories.has(key) ||
      prefixes.some((prefix) => seen.has(prefix))
    ) {
      throw new DownloadManifestError(
        `Download manifest contains conflicting file path ${JSON.stringify(file.path)}.`,
      )
    }
    seen.add(key)
    for (const prefix of prefixes) directories.add(prefix)
    relativeFiles.push({ ...file, relativePath })
  }

  const parent = dirname(root)
  await boundary.directory(parent)
  boundary.workspace ??= await boundary.privateDirectory(parent)
  const tempRoot = await boundary.privateDirectory(boundary.workspace)
  const files: DownloadPlan['files'] = []
  for (const file of relativeFiles) {
    const targetPath = resolve(tempRoot, file.relativePath)
    files.push({ ...file, targetPath })
  }

  return {
    value: {
      root,
      tempRoot,
      files,
      boundary,
    },
  }
}

function downloadRelativePath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) {
    throw new DownloadManifestError(
      `Download manifest contains invalid file path ${JSON.stringify(path)}.`,
    )
  }
  const segments = path.split('/').slice(1)
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        (process.platform === 'win32' &&
          (/[:*?"<>|]/u.test(segment) ||
            /[. ]$/u.test(segment) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))),
    )
  ) {
    throw new DownloadManifestError(
      `Download manifest contains unsafe file path ${JSON.stringify(path)}.`,
    )
  }
  return segments.join('/')
}

export function verifyDownloadedBytes(
  file: DownloadManifestFile,
  bytes: Buffer,
): { ok: true; error?: never } | { error: CliError; ok?: never } {
  if (bytes.byteLength !== file.size_bytes) {
    return { error: downloadIntegrityError(file.path, 'size mismatch') }
  }
  if (file.sha256) {
    const sha256 = createHash('sha256').update(bytes).digest('base64url')
    if (sha256 !== file.sha256) {
      return { error: downloadIntegrityError(file.path, 'sha256 mismatch') }
    }
  }
  return { ok: true }
}

function downloadIntegrityError(path: string, reason: string): CliError {
  return cliError({
    code: 'download_integrity_failed',
    message: 'Downloaded file did not match the manifest.',
    why: `The downloaded file ${path} failed integrity verification: ${reason}.`,
    hint: 'Retry the download. If this repeats, report the artifact ID.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

export function downloadFileSystemError(error: unknown): CliError {
  if (
    error instanceof WriteBoundaryError ||
    error instanceof DownloadManifestError
  )
    return error.error
  return cliError({
    code: 'download_failed',
    message:
      error instanceof WriteFileSystemError
        ? error.message
        : 'Could not write downloaded files.',
    why: 'The local filesystem rejected a download operation. Check retained recovery paths before retrying.',
    hint: 'Check --output permissions and available disk space, then retry.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
  })
}

export function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html'
  if (path.endsWith('.md')) return 'text/markdown'
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  return 'application/octet-stream'
}

function artifactKindForFile(path: string): 'html_page' | 'markdown_page' {
  return path.endsWith('.md') ? 'markdown_page' : 'html_page'
}

import type { Buffer } from 'node:buffer'
import { lstat, mkdir, mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import type { PreparedUpload } from './upload-boundary.js'
import type { CliError, DownloadPlan, UploadPayloadResult } from './types.js'
import type {
  DownloadManifestFile,
  DownloadManifestResponse,
} from '@artifactshare/contract'
import { cliError, validationError } from './errors.js'
import type { FormData } from 'undici'

let undiciModule: typeof import('undici') | undefined

export async function createUploadForm(): Promise<FormData> {
  const { FormData } = (undiciModule ??= await import('undici'))
  return new FormData()
}

export async function prepareUploadPayload(
  prepared: PreparedUpload,
  initialForm?: FormData,
): Promise<UploadPayloadResult> {
  if (prepared.files.length === 0)
    return {
      error: validationError(
        'Directory has no shareable files.',
        'Add index.html or index.md and retry.',
      ),
    }
  const form = initialForm ?? (await createUploadForm())
  for (const file of prepared.files) form.append('file', file.blob, file.name)
  return {
    payload: {
      form,
      kind: prepared.directory
        ? 'static_site'
        : artifactKindForFile(prepared.files[0]!.name),
    },
  }
}

export async function prepareDownloadPlan(
  manifest: DownloadManifestResponse,
  outputPath: string,
  force: boolean,
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
  const existing = await lstat(root).catch(() => null)
  if (existing?.isSymbolicLink()) {
    return {
      error: validationError(
        'Output path must not be a symbolic link.',
        'Choose a regular directory path and retry.',
      ),
    }
  }
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
  if (existing && !existing.isDirectory()) {
    return {
      error: validationError(
        'Output path is not a directory.',
        'Choose a directory path or remove the existing file.',
      ),
    }
  }

  const seen = new Set<string>()
  const relativeFiles: Array<DownloadManifestFile & { relativePath: string }> =
    []
  for (const file of manifest.files) {
    const relativePath = downloadRelativePath(file.path)
    if (relativePath.error) return { error: relativePath.error }
    if (seen.has(relativePath.value)) {
      return {
        error: validationError(
          'Download manifest contains duplicate file paths.',
          'Retry later. If this repeats, report the artifact ID.',
        ),
      }
    }
    seen.add(relativePath.value)
    relativeFiles.push({ ...file, relativePath: relativePath.value })
  }

  const parent = dirname(root)
  await mkdir(parent, { recursive: true })
  const tempRoot = await mkdtemp(join(parent, `.${basename(root)}.tmp-`))
  const files: DownloadPlan['files'] = []
  for (const file of relativeFiles) {
    const targetPath = resolve(tempRoot, file.relativePath)
    files.push({ ...file, targetPath })
  }

  return {
    value: { root, tempRoot, replaceExisting: Boolean(existing), files },
  }
}

function downloadRelativePath(
  path: string,
): { value: string; error?: never } | { error: CliError; value?: never } {
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) {
    return {
      error: validationError(
        'Download manifest contains an invalid file path.',
        'Retry later. If this repeats, report the artifact ID.',
      ),
    }
  }
  const segments = path.split('/').slice(1)
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    return {
      error: validationError(
        'Download manifest contains an unsafe file path.',
        'Retry later. If this repeats, report the artifact ID.',
      ),
    }
  }
  return { value: segments.join('/') }
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

export function backupPathFor(root: string): string {
  return join(
    dirname(root),
    `.${basename(root)}.old-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
}

export async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

export function downloadFileSystemError(error: unknown): CliError {
  return cliError({
    code: 'download_failed',
    message: 'Could not write downloaded files.',
    why:
      error instanceof Error
        ? error.message
        : 'The local filesystem rejected a download operation.',
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

import { constants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Blob } from 'node:buffer'
import { EXCLUDED_DIR_NAMES, IGNORED_FILENAMES } from './constants.js'
import { validationError } from './errors.js'
import type { CliError } from './types.js'

const hints = {
  link: 'Copy the file into the selection or pass the target by absolute path.',
  escape:
    'Pass an absolute path to select content outside the current directory.',
  missing: 'Check the path and retry.',
  invalid: 'Check the path; an intermediate component must be a directory.',
  changed: 'The selection changed while reading. Retry with unchanged files.',
  unsupported:
    'Stable filesystem dev/ino identities are required; use a filesystem that provides them.',
  type: 'Select a regular file or directory (append requires a file).',
} as const

const messages = {
  link: 'Upload path contains a symbolic link or junction.',
  escape: 'Upload path leaves the current directory.',
  missing: 'Path was not found.',
  invalid: 'Upload path is invalid.',
  changed: 'Upload path changed while reading.',
  unsupported: 'Filesystem lacks stable dev/ino identities.',
  type: 'Path must be a regular file or directory.',
} as const

type Reason = keyof typeof hints
export class UploadBoundaryError extends Error {
  constructor(
    readonly reason: Reason,
    options?: ErrorOptions,
  ) {
    super(messages[reason], options)
  }
}

export function uploadBoundaryError(error: unknown): CliError {
  if (error instanceof UploadBoundaryError) {
    return {
      ...validationError(error.message, hints[error.reason]),
      details: { reason: error.reason },
    }
  }
  const code = (error as NodeJS.ErrnoException)?.code ?? 'filesystem_error'
  const result = {
    ...validationError(
      'Could not read upload files.',
      'Check filesystem permissions and retry.',
    ),
    code,
  }
  // Keep diagnostics available internally without serializing paths or raw causes.
  Object.defineProperty(result, 'cause', { value: error })
  return result
}

export type UploadCheckpoint =
  | 'enumerated'
  | 'beforeOpen'
  | 'afterOpen'
  | 'afterRead'
export type UploadBoundaryOptions = {
  cwd?: string
  checkpoint?: (stage: UploadCheckpoint, file: string) => void | Promise<void>
}

type Snapshot = { path: string; stat: BigIntStats }
type FileSnapshot = Snapshot & { name: string; parents: Snapshot[] }
const preparedBrand = Symbol('verified upload')
export type PreparedUpload = {
  readonly [preparedBrand]: true
  readonly directory: boolean
  readonly files: ReadonlyArray<{ name: string; blob: Blob }>
}

/** Drive-relative Windows inputs are explicit selections, resolved by path.resolve. */
export function explicitUploadPath(
  input: string,
  paths: typeof path = path,
): boolean {
  return (
    paths.isAbsolute(input) || (paths === path.win32 && /^[a-z]:/i.test(input))
  )
}

function identity(stat: BigIntStats): void {
  if (
    typeof stat.dev !== 'bigint' ||
    typeof stat.ino !== 'bigint' ||
    stat.ino <= 0n
  ) {
    throw new UploadBoundaryError('unsupported')
  }
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  identity(a)
  identity(b)
  return a.dev === b.dev && a.ino === b.ino
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  // ctime deliberately excluded: hydrating a cloud placeholder can change it.
  return (
    sameIdentity(a, b) &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs
  )
}
async function inspect(file: string): Promise<BigIntStats> {
  const stat = await fs.lstat(file, { bigint: true })
  if (stat.isSymbolicLink()) throw new UploadBoundaryError('link')
  identity(stat)
  return stat
}
async function checkParents(parents: Snapshot[]): Promise<void> {
  for (const parent of parents) {
    const current = await inspect(parent.path)
    if (
      !current.isDirectory() ||
      !sameIdentity(parent.stat, current) ||
      (await fs.realpath(parent.path)) !== parent.path
    ) {
      throw new UploadBoundaryError('changed')
    }
  }
}
/** Keep path policy separate from I/O so Windows drive resolution is testable on every host. */
export function resolveUploadInput(
  input: string,
  cwd: string,
  physicalCwd: string,
  paths: typeof path = path,
  resolveExplicit: typeof path.resolve = paths.resolve,
): { explicit: boolean; expected: string } {
  const explicit = explicitUploadPath(input, paths)
  const expected = explicit
    ? resolveExplicit(cwd, input)
    : paths.resolve(physicalCwd, input)
  const relative = paths.relative(physicalCwd, expected)
  if (
    !explicit &&
    (relative === '..' ||
      relative.startsWith(`..${paths.sep}`) ||
      paths.isAbsolute(relative))
  ) {
    throw new UploadBoundaryError('escape')
  }
  return { explicit, expected }
}

async function resolveSelection(
  input: string,
  cwd: string,
): Promise<{ root: string; stat: BigIntStats; parents: Snapshot[] }> {
  if (!input || input.includes('\0')) throw new UploadBoundaryError('invalid')
  const physicalCwd = await fs.realpath(cwd)
  const { explicit, expected } = resolveUploadInput(input, cwd, physicalCwd)
  // Give the OS the raw spelling before resolve can erase file/../other.
  // Win32 normalizes traversal before filesystem lookup; refuse ambiguous .. there.
  if (process.platform === 'win32' && input.split(/[\\/]/).includes('..'))
    throw new UploadBoundaryError('invalid')
  const raw = explicit
    ? path.isAbsolute(input)
      ? input
      : expected
    : `${cwd}${path.sep}${input}`
  const trimmed =
    raw.length <= path.parse(raw).root.length
      ? raw
      : raw.replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '') ||
        path.parse(raw).root
  const stat = await inspect(trimmed)
  const root = await fs.realpath(raw)
  let physicalExpected = expected
  if (explicit) {
    const selectedPath = path.join(
      await fs.realpath(path.dirname(expected)),
      path.basename(expected),
    )
    // Explicit selections trust their parents. Canonicalize the basename too:
    // realpath may return stored casing on a case-insensitive filesystem.
    // Inspect again before following it so a selected link is still rejected.
    const selectedStat = await inspect(selectedPath)
    if (!sameIdentity(stat, selectedStat))
      throw new UploadBoundaryError('changed')
    physicalExpected = await fs.realpath(selectedPath)
  }
  if (root !== physicalExpected) throw new UploadBoundaryError('link')
  if (!stat.isFile() && !stat.isDirectory())
    throw new UploadBoundaryError('type')
  const parents: Snapshot[] = []
  if (!explicit) {
    // Walk canonical parents, never input-string components.
    let parent = stat.isDirectory() ? root : path.dirname(root)
    while (true) {
      parents.unshift({ path: parent, stat: await inspect(parent) })
      if (parent === physicalCwd) break
      parent = path.dirname(parent)
    }
  } else if (stat.isDirectory()) parents.push({ path: root, stat })
  const current = await inspect(root)
  if (
    !(stat.isDirectory()
      ? sameIdentity(stat, current) && current.isDirectory()
      : sameFile(stat, current))
  )
    throw new UploadBoundaryError('changed')
  return { root, stat, parents }
}

async function snapshots(
  input: string,
  options: UploadBoundaryOptions,
  fileOnly: boolean,
): Promise<{ directory: boolean; files: FileSnapshot[] }> {
  const { root, stat, parents } = await resolveSelection(
    input,
    options.cwd ?? process.cwd(),
  )
  if (fileOnly && !stat.isFile()) throw new UploadBoundaryError('type')
  const files: FileSnapshot[] = []
  async function visit(dir: string, ancestors: Snapshot[]): Promise<void> {
    await checkParents(ancestors)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    await checkParents(ancestors)
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue
      if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue
      if (entry.isFile() && IGNORED_FILENAMES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      await checkParents(ancestors)
      const current = await inspect(full)
      if (current.isDirectory()) {
        await visit(full, [...ancestors, { path: full, stat: current }])
      } else if (current.isFile()) {
        files.push({
          path: full,
          stat: current,
          name: path.relative(root, full).split(path.sep).join('/'),
          parents: ancestors,
        })
      }
    }
  }
  try {
    if (stat.isDirectory()) await visit(root, parents)
    else files.push({ path: root, stat, name: path.basename(root), parents })
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new UploadBoundaryError('changed', { cause })
    throw cause
  }
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { directory: stat.isDirectory(), files }
}

async function readVerified(
  file: FileSnapshot,
  options: UploadBoundaryOptions,
): Promise<Buffer> {
  const checkpoint = options.checkpoint ?? (() => {})
  await checkpoint('beforeOpen', file.path)
  await checkParents(file.parents)
  const before = await inspect(file.path)
  if (!before.isFile() || !sameFile(file.stat, before))
    throw new UploadBoundaryError('changed')
  const handle = await fs.open(
    file.path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  )
  try {
    await checkpoint('afterOpen', file.path)
    async function verify(): Promise<void> {
      await checkParents(file.parents)
      const current = await inspect(file.path)
      const held = await handle.stat({ bigint: true })
      if (
        !current.isFile() ||
        !held.isFile() ||
        !sameFile(file.stat, current) ||
        !sameFile(file.stat, held)
      )
        throw new UploadBoundaryError('changed')
    }
    await verify()
    const bytes = await handle.readFile()
    await checkpoint('afterRead', file.path)
    await verify()
    if (BigInt(bytes.length) !== file.stat.size)
      throw new UploadBoundaryError('changed')
    return bytes
  } finally {
    await handle.close()
  }
}

async function prepare<T>(
  input: string,
  fileOnly: boolean,
  options: UploadBoundaryOptions,
  convert: (bytes: Buffer, name: string) => T,
): Promise<{ directory: boolean; files: Array<{ name: string; content: T }> }> {
  let enumerated = false
  try {
    const selection = await snapshots(input, options, fileOnly)
    enumerated = true
    for (const file of selection.files)
      await options.checkpoint?.('enumerated', file.path)
    const files = []
    for (const file of selection.files) {
      const content = convert(await readVerified(file, options), file.name)
      files.push({ name: file.name, content })
    }
    return { directory: selection.directory, files }
  } catch (cause) {
    if (cause instanceof UploadBoundaryError) throw cause
    const code = (cause as NodeJS.ErrnoException)?.code
    if (code === 'ELOOP') throw new UploadBoundaryError('link', { cause })
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new UploadBoundaryError(
        enumerated ? 'changed' : code === 'ENOENT' ? 'missing' : 'invalid',
        { cause },
      )
    throw cause
  }
}

export async function prepareUpload(
  input: string,
  contentType: (name: string) => string,
  options: UploadBoundaryOptions = {},
): Promise<PreparedUpload> {
  const result = await prepare(
    input,
    false,
    options,
    (bytes, name) => new Blob([bytes], { type: contentType(name) }),
  )
  return {
    [preparedBrand]: true,
    directory: result.directory,
    files: result.files.map(({ name, content }) => ({ name, blob: content })),
  }
}

export async function prepareAppend(
  input: string,
  options: UploadBoundaryOptions = {},
): Promise<string> {
  const result = await prepare(input, true, options, (bytes) =>
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  )
  return result.files[0]!.content
}

import { Blob } from 'node:buffer'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { EXCLUDED_DIR_NAMES, IGNORED_FILENAMES } from './constants.js'
import { cliError } from './errors.js'
import type { CliError } from './types.js'

type Reason =
  | 'parent_traversal'
  | 'link'
  | 'outside_cwd'
  | 'not_found'
  | 'changed'
  | 'unsupported_guarantee'
  | 'invalid_type'
const hints: Record<Reason, string> = {
  parent_traversal: 'Pass a direct absolute path without any .. component.',
  link: 'Copy the file into the selection or pass the target by absolute path.',
  outside_cwd:
    'Pass an absolute path to select a file outside the current directory.',
  not_found: 'Check the path and retry.',
  changed: 'The selection changed while reading. Retry the command.',
  unsupported_guarantee:
    'Stable file identity (dev/ino) and the available no-follow open guarantee are required. Select a filesystem that supports them.',
  invalid_type: 'Select a regular file or directory.',
}

const messages: Record<Reason, string> = {
  parent_traversal: 'Parent traversal (..) is not allowed',
  link: 'A symbolic link is not allowed',
  outside_cwd: 'The selection leaves the current directory',
  not_found: 'Path was not found',
  changed: 'The selection changed while reading',
  unsupported_guarantee: 'The filesystem cannot provide the required guarantee',
  invalid_type: 'Path must be a regular file or directory',
}

export class UploadBoundaryError extends Error {
  readonly error: CliError
  constructor(
    display: string,
    reason: Reason,
    cause?: unknown,
    guarantee?: string,
  ) {
    super(`Upload path ${display}: ${messages[reason]}.`, { cause })
    this.error = cliError({
      code: 'validation_failed',
      message: this.message,
      why: this.message,
      hint: guarantee
        ? `Required guarantee unavailable: ${guarantee}. Select a filesystem that supports it.`
        : hints[reason],
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: reason === 'changed' ? 'retry_later' : 'change_input' },
      details: { path: display, reason, ...(guarantee ? { guarantee } : {}) },
    })
    Object.defineProperty(this.error, 'cause', { value: cause })
  }
}

class UploadReadFailure extends Error {
  constructor(
    readonly error: CliError,
    cause: unknown,
  ) {
    super(error.message, { cause })
  }
}

export function uploadReadError(error: unknown, display: string): CliError {
  if (error instanceof UploadReadFailure) return error.error
  if (error instanceof UploadBoundaryError) return error.error
  const result = cliError({
    code: 'upload_read_failed',
    message: `Could not read upload path ${display}.`,
    why: 'The local filesystem rejected an upload read.',
    hint: 'Check filesystem availability and permissions, then retry.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
    details: { path: display, errno: (error as NodeJS.ErrnoException)?.code },
  })
  Object.defineProperty(result, 'cause', { value: error })
  return result
}

type RecordEntry = { path: string; display: string; stat: BigIntStats }
type Checkpoint = 'entry' | 'before_open' | 'after_open' | 'after_read'
/** Narrow injection seam for deterministic filesystem tests, never a CLI option. */
export type UploadBoundaryDependencies = {
  cwd?: string
  paths?: Pick<
    typeof path,
    'resolve' | 'join' | 'isAbsolute' | 'basename' | 'sep'
  >
  lstat?: (name: string) => Promise<BigIntStats>
  realpath?: (name: string) => Promise<string>
  readdir?: (name: string) => Promise<string[]>
  open?: typeof fs.open
  checkpoint?: (phase: Checkpoint, name: string) => Promise<void>
}

export async function prepareUploadSelection(
  input: string,
  singleFile = false,
  dependencies: UploadBoundaryDependencies = {},
): Promise<{ directory: boolean; files: Array<{ name: string; blob: Blob }> }> {
  const fail = (
    display: string,
    reason: Reason,
    cause?: unknown,
    guarantee?: string,
  ): never => {
    throw new UploadBoundaryError(display, reason, cause, guarantee)
  }
  // Check both separator forms before resolve, realpath, or any filesystem call.
  if (
    input
      .replace(/^[a-z]:/iu, '')
      .split(/[\\/]/u)
      .includes('..')
  )
    fail(input, 'parent_traversal')
  const paths = dependencies.paths ?? path
  const cwd = dependencies.cwd ?? process.cwd()
  const inspect =
    dependencies.lstat ?? ((name) => fs.lstat(name, { bigint: true }))
  const checkpoint = dependencies.checkpoint ?? (async () => {})
  const identity = (s: BigIntStats, display: string) => {
    if (typeof s.dev !== 'bigint' || typeof s.ino !== 'bigint' || s.ino <= 0n)
      fail(
        display,
        'unsupported_guarantee',
        undefined,
        'stable file identity (dev/ino)',
      )
  }
  const same = (a: BigIntStats, b: BigIntStats) =>
    a.dev === b.dev && a.ino === b.ino
  const checkType = (s: BigIntStats, display: string) => {
    if (s.isSymbolicLink()) fail(display, 'link')
    identity(s, display)
    if (!s.isFile() && !s.isDirectory()) fail(display, 'invalid_type')
  }
  const get = async (name: string, display: string, recorded = false) => {
    try {
      return await inspect(name)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR')
        fail(display, recorded ? 'changed' : 'not_found', error)
      if (code === 'ELOOP') fail(display, 'link', error)
      throw new UploadReadFailure(uploadReadError(error, display), error)
    }
  }
  const recheck = async (entry: RecordEntry, directory: boolean) => {
    const s = await get(entry.path, entry.display, true)
    if (s.isSymbolicLink()) fail(entry.display, 'link')
    identity(s, entry.display)
    if (
      !same(s, entry.stat) ||
      (directory
        ? !s.isDirectory()
        : !s.isFile() ||
          s.mode !== entry.stat.mode ||
          s.size !== entry.stat.size)
    )
      fail(entry.display, 'changed')
  }
  const checkChain = async (chain: RecordEntry[]) => {
    for (const entry of chain) await recheck(entry, true)
  }
  let offending = input
  try {
    // A drive prefix is explicit only on Windows; colons are ordinary POSIX names.
    const explicit =
      paths.isAbsolute(input) || (paths.sep === '\\' && /^[a-z]:/iu.test(input))
    let selectedPath = paths.resolve(cwd, input)
    const chain: RecordEntry[] = []
    let selected: BigIntStats
    if (!explicit) {
      const root = await (dependencies.realpath ?? fs.realpath)(cwd)
      const rootStat = await get(root, input)
      checkType(rootStat, input)
      chain.push({ path: root, display: input, stat: rootStat })
      let cursor = root
      const components = input
        .split(paths.sep === '\\' ? /[\\/]/u : /\//u)
        .filter((part) => part !== '' && part !== '.')
      selected = rootStat
      for (let index = 0; index < components.length; index++) {
        await checkChain(chain)
        cursor = paths.join(cursor, components[index]!)
        selected = await get(cursor, input)
        checkType(selected, input)
        await checkChain(chain)
        if (index < components.length - 1) {
          if (!selected.isDirectory()) fail(input, 'invalid_type')
          chain.push({ path: cursor, display: input, stat: selected })
        }
      }
      // With no named components, the selection is the physical boundary root.
      // Windows normalizes alias\/. to the junction itself before lstat.
      if (components.length > 0) {
        const typedPath = `${cwd}${cwd.endsWith(paths.sep) ? '' : paths.sep}${input}`
        const typed = await get(typedPath, input)
        checkType(typed, input)
        if (!same(selected, typed)) fail(input, 'outside_cwd')
      }
      selectedPath = cursor
    } else {
      selected = await get(selectedPath, input)
      checkType(selected, input)
    }
    if (singleFile && !selected.isFile()) fail(input, 'invalid_type')
    const leaves: Array<RecordEntry & { name: string; chain: RecordEntry[] }> =
      []
    const visit = async (
      dir: RecordEntry,
      parents: RecordEntry[],
      prefix: string,
    ) => {
      const current = [...parents, dir]
      await checkChain(current)
      offending = dir.display
      let names: string[]
      try {
        names = await (dependencies.readdir ?? fs.readdir)(dir.path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR')
          fail(dir.display, 'changed', error)
        if (code === 'ELOOP') fail(dir.display, 'link', error)
        throw error
      }
      await checkChain(current)
      for (const name of names) {
        if (
          name.startsWith('.') ||
          name === '__MACOSX' ||
          EXCLUDED_DIR_NAMES.has(name) ||
          IGNORED_FILENAMES.has(name)
        )
          continue
        const display = prefix ? `${prefix}/${name}` : name
        offending = display
        await checkpoint('entry', paths.join(dir.path, name))
        await checkChain(current)
        const entry = {
          path: paths.join(dir.path, name),
          display,
          stat: await get(paths.join(dir.path, name), display),
        }
        checkType(entry.stat, display)
        await checkChain(current)
        if (entry.stat.isDirectory()) await visit(entry, current, display)
        else leaves.push({ ...entry, name: display, chain: current })
      }
      await checkChain(current)
    }
    const root = { path: selectedPath, display: input, stat: selected }
    if (selected.isDirectory()) await visit(root, chain, '')
    else leaves.push({ ...root, name: paths.basename(selectedPath), chain })
    leaves.sort((a, b) => a.name.localeCompare(b.name))
    const files: Array<{ name: string; blob: Blob }> = []
    for (const leaf of leaves) {
      offending = leaf.display
      await checkpoint('before_open', leaf.path)
      await checkChain(leaf.chain)
      await recheck(leaf, false)
      let handle: fs.FileHandle
      try {
        handle = await (dependencies.open ?? fs.open)(
          leaf.path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ELOOP') fail(leaf.display, 'link', error)
        if (code === 'ENOENT' || code === 'ENOTDIR')
          fail(leaf.display, 'changed', error)
        if (
          constants.O_NOFOLLOW &&
          (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP')
        )
          fail(leaf.display, 'unsupported_guarantee', error, 'O_NOFOLLOW open')
        throw error
      }
      try {
        const checkHandle = async () => {
          const s = await handle.stat({ bigint: true })
          identity(s, leaf.display)
          if (
            !s.isFile() ||
            !same(s, leaf.stat) ||
            s.mode !== leaf.stat.mode ||
            s.size !== leaf.stat.size
          )
            fail(leaf.display, 'changed')
        }
        await checkpoint('after_open', leaf.path)
        await checkHandle()
        await checkChain(leaf.chain)
        await recheck(leaf, false)
        const bytes = await handle.readFile()
        await checkpoint('after_read', leaf.path)
        await checkHandle()
        await recheck(leaf, false)
        await checkChain(leaf.chain)
        if (BigInt(bytes.byteLength) !== leaf.stat.size)
          fail(leaf.display, 'changed')
        files.push({ name: leaf.name, blob: new Blob([bytes]) })
      } finally {
        await handle.close()
      }
    }
    return { directory: selected.isDirectory(), files }
  } catch (error) {
    if (
      error instanceof UploadBoundaryError ||
      error instanceof UploadReadFailure
    )
      throw error
    // Keep the original exception internal; never serialize filesystem messages.
    throw new UploadReadFailure(uploadReadError(error, offending), error)
  }
}

import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, readlink } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { EXCLUDED_DIR_NAMES, IGNORED_FILENAMES } from './constants.js'

export class UploadBoundaryError extends Error {
  readonly hint =
    'Copy the file into the directory, or share the link target directly using an absolute path.'
}

/** Test-only synchronization/observation seam; never controlled by CLI input. */
export interface UploadBoundaryHooks {
  checkpoint?: (
    phase: 'enumerated' | 'before-open' | 'opened' | 'read',
    path: string,
  ) => Promise<void>
  reading?: (path: string, identity: BigIntStats) => void
}

function fail(path: string, reason: string): never {
  throw new UploadBoundaryError(`Cannot upload ${path}: ${reason}.`)
}
function identity(path: string, stat: BigIntStats): void {
  if (
    typeof stat.ino !== 'bigint' ||
    typeof stat.dev !== 'bigint' ||
    stat.ino <= 0n ||
    stat.dev <= 0n
  )
    fail(path, 'filesystem identity guarantee unavailable')
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return (
    same(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  )
}
async function gitRoot(cwd: string): Promise<string | undefined> {
  let dir = cwd
  for (;;) {
    const markerPath = join(dir, '.git')
    const marker = await lstat(markerPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          return undefined
        fail(markerPath, 'repository boundary could not be verified')
      },
    )
    if (marker?.isFile() || marker?.isDirectory()) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * POSIX uses O_NOFOLLOW and O_NONBLOCK plus repeated component/handle checks.
 * The trust root itself is inspected with lstat. The fallback parent may be
 * macOS /tmp or /var only when its link points to the expected /private target;
 * both link and target identities are pinned. Ancestor aliases remain allowed.
 * Windows lstat detects symlinks/junctions but Node does not
 * expose all reparse tags. Therefore Windows fails closed before reading bytes:
 * resolved-path equality alone cannot establish the required reparse guarantee.
 * These checks are not an atomic snapshot: Node has no openat traversal and a
 * transient swap-and-restore between checks cannot always be detected.
 */
export async function readUploadBoundary(
  input: string,
  options: {
    fileOnly?: boolean
    cwd?: string
    hooks?: UploadBoundaryHooks
  } = {},
): Promise<{
  directory: boolean
  files: Array<{ path: string; relativePath: string; bytes: Buffer }>
}> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const target = resolve(cwd, input)
  const repo = await gitRoot(cwd)
  if (repo && !isAbsolute(input) && !contains(repo, target)) {
    fail(
      input,
      'relative path leaves the Git repository; select an absolute path explicitly',
    )
  }
  const repositoryBoundary = repo && contains(repo, target)
  const root = repositoryBoundary ? repo : dirname(target)
  // Only these OS-owned macOS aliases may be the fallback parent. The selected
  // input and arbitrary user-created parent links still follow the no-link rule.
  const systemAliasTarget =
    process.platform === 'darwin' && !repositoryBoundary && root !== target
      ? new Map([
          ['/tmp', '/private/tmp'],
          ['/var', '/private/var'],
        ]).get(root)
      : undefined
  let aliasIdentity: BigIntStats | undefined
  const evidence = new Map<string, BigIntStats>()
  let activePath = input
  async function inspect(path: string): Promise<BigIntStats> {
    activePath = path
    let info = await lstat(path, { bigint: true })
    if (info.isSymbolicLink()) {
      if (path !== root || !systemAliasTarget)
        fail(path, 'symbolic link or junction is not allowed')
      identity(path, info)
      if (aliasIdentity && !unchanged(aliasIdentity, info))
        fail(path, 'system alias identity changed')
      if (resolve(dirname(path), await readlink(path)) !== systemAliasTarget)
        fail(path, 'system alias target changed')
      const aliasAfter = await lstat(path, { bigint: true })
      if (!unchanged(info, aliasAfter))
        fail(path, 'system alias identity changed')
      aliasIdentity = info
      info = await lstat(systemAliasTarget, { bigint: true })
      if (!info.isDirectory())
        fail(path, 'system alias target is not a regular directory')
    } else if (path === root && aliasIdentity) {
      fail(path, 'system alias identity changed')
    }
    identity(path, info)
    const prior = evidence.get(path)
    if (prior && !same(prior, info)) fail(path, 'path identity changed')
    evidence.set(path, info)
    return info
  }
  async function walk(path: string): Promise<BigIntStats> {
    let current = root
    let stat = await inspect(current)
    const parts = relative(root, path).split(sep).filter(Boolean)
    for (const part of parts) {
      if (!stat.isDirectory()) fail(current, 'parent is not a directory')
      current = join(current, part)
      stat = await inspect(current)
    }
    return stat
  }
  try {
    // Inspect lexical components before normalization can erase a link/.. pair.
    const raw = isAbsolute(input) ? input : `${cwd}${sep}${input}`
    let cursor = parse(raw).root
    // Windows accepts both separators, even in one input. Splitting only on
    // path.sep would let join() erase a forward-slash link/.. component.
    const separators = process.platform === 'win32' ? /[\\/]+/ : /\/+/
    for (const component of raw
      .slice(cursor.length)
      .split(separators)
      .filter(Boolean)) {
      if (component === '.') continue
      if (component === '..') {
        if (contains(root, cursor)) await walk(cursor)
        cursor = dirname(cursor)
      } else {
        cursor = join(cursor, component)
        if (contains(root, cursor)) await walk(cursor)
      }
    }
    const selected = await walk(target)
    if (process.platform !== 'win32' && !constants.O_NOFOLLOW)
      fail(input, 'no-follow open guarantee unavailable on this platform')
    if (!selected.isFile() && !selected.isDirectory())
      fail(input, 'path must be a regular file or directory')
    if (options.fileOnly && !selected.isFile())
      fail(input, 'path must be a non-empty file')
    const paths: string[] = []
    async function visit(dir: string): Promise<void> {
      await walk(dir)
      for (const name of await readdir(dir)) {
        if (name === '__MACOSX') continue
        const path = join(dir, name)
        const stat = await walk(path)
        if (stat.isDirectory()) {
          if (EXCLUDED_DIR_NAMES.has(name) || name.startsWith('.')) continue
          await visit(path)
        } else if (
          stat.isFile() &&
          !IGNORED_FILENAMES.has(name) &&
          !name.startsWith('.')
        ) {
          paths.push(path)
        }
      }
      await walk(dir)
    }
    if (selected.isDirectory()) await visit(target)
    else paths.push(target)
    await options.hooks?.checkpoint?.('enumerated', target)
    const files = []
    for (const path of paths.sort()) {
      activePath = path
      const expected = await walk(path)
      await options.hooks?.checkpoint?.('before-open', path)
      const handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      )
      try {
        await options.hooks?.checkpoint?.('opened', path)
        const before = await handle.stat({ bigint: true })
        identity(path, before)
        const current = await walk(path)
        if (
          !before.isFile() ||
          !unchanged(expected, before) ||
          !unchanged(current, before)
        )
          fail(path, 'file identity or type changed')
        if (process.platform === 'win32')
          fail(
            path,
            'reparse-point detection guarantee unavailable on Windows with Node standard APIs; use a supported POSIX system',
          )
        options.hooks?.reading?.(path, before)
        const bytes = await handle.readFile()
        await options.hooks?.checkpoint?.('read', path)
        const after = await handle.stat({ bigint: true })
        if (
          !unchanged(before, after) ||
          after.size !== BigInt(bytes.length) ||
          !unchanged(after, await walk(path))
        )
          fail(path, 'file changed while reading')
        files.push({
          path,
          relativePath: selected.isDirectory()
            ? relative(target, path).split(sep).join('/')
            : basename(path),
          bytes,
        })
      } finally {
        await handle.close()
      }
    }
    if (process.platform === 'win32')
      fail(
        input,
        'reparse-point detection guarantee unavailable on Windows with Node standard APIs; use a supported POSIX system',
      )
    for (const path of evidence.keys()) await walk(path)
    return { directory: selected.isDirectory(), files }
  } catch (error) {
    if (error instanceof UploadBoundaryError) throw error
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      fail(activePath, 'Path was not found')
    fail(activePath, 'path could not be verified or read safely')
  }
}

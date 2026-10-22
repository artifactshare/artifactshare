import { constants, type BigIntStats } from 'node:fs'
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  stat as followedStat,
} from 'node:fs/promises'
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
  constructor(
    message: string,
    readonly hint: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Test-only synchronization/observation seam; never controlled by CLI input. */
export interface UploadBoundaryHooks {
  checkpoint?: (
    phase: 'enumerated' | 'before-open' | 'opened' | 'read',
    path: string,
  ) => Promise<void>
  reading?: (path: string, identity: BigIntStats) => void
}

type FailureKind =
  | 'link'
  | 'escape'
  | 'missing'
  | 'changed'
  | 'unsupported'
  | 'type'
  | 'read'

function fail(
  path: string,
  reason: string,
  kind: FailureKind = 'changed',
  cause?: unknown,
): never {
  const hints: Record<FailureKind, string> = {
    link: 'Copy the file into the directory, or share the link target directly using an absolute path.',
    escape: 'Pass the absolute path to share a file outside this repository.',
    missing: `Check the path and retry: ${path}`,
    changed: 'Retry once the files stop changing.',
    unsupported:
      'This platform or filesystem lacks the required upload safety guarantee. Use a filesystem and platform that support it.',
    type: 'Select a regular file or directory (append requires a regular file).',
    read: 'Check file permissions and available system resources, then retry.',
  }
  throw new UploadBoundaryError(
    `Cannot upload ${path}: ${reason}.`,
    hints[kind],
    { cause },
  )
}

function readFailure(path: string, error: unknown): never {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : undefined
  if (code === 'ENOENT')
    fail(path, 'path was not found (ENOENT)', 'missing', error)
  if (code === 'ELOOP')
    fail(path, 'symbolic link is not allowed (ELOOP)', 'link', error)
  const reasons: Record<string, string> = {
    EACCES: 'permission denied',
    EPERM: 'operation not permitted',
    EMFILE: 'too many open files',
    EISDIR: 'expected a regular file',
  }
  const reason =
    (code && reasons[code]) || 'path could not be verified or read safely'
  fail(
    path,
    `${reason}${code ? ` (${code})` : ''}`,
    code === 'EISDIR' ? 'type' : 'read',
    error,
  )
}
function identity(path: string, stat: BigIntStats): void {
  if (
    typeof stat.ino !== 'bigint' ||
    typeof stat.dev !== 'bigint' ||
    stat.ino <= 0n ||
    stat.dev <= 0n
  )
    fail(path, 'filesystem identity guarantee unavailable', 'unsupported')
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}
// Hydration may change ctime without changing the file content or identity.
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  )
}
async function gitRoot(
  cwd: string,
  establishedRoot?: string,
): Promise<string | undefined> {
  let dir = cwd
  let found: string | undefined
  let protectedAncestor: string | undefined
  const establishedPath = establishedRoot
    ? await realpath(establishedRoot)
    : undefined
  const established = establishedRoot
    ? await followedStat(establishedRoot, { bigint: true })
    : undefined
  for (;;) {
    if (establishedPath) {
      const resolved = await realpath(dir).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            return undefined
          readFailure(dir, error)
        },
      )
      // Discovery may follow aliases to recognize entry into cwd's worktree.
      // Keep the lexical ancestor for inspection: replacing it with realpath
      // would erase the very link that must not narrow the established boundary.
      // Check even ancestors without a Git marker (aliases into subdirectories).
      if (resolved && contains(establishedPath, resolved))
        protectedAncestor = dir
    }
    const markerPath = `${dir}${sep}.git`
    const marker = await lstat(markerPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          return undefined
        readFailure(markerPath, error)
      },
    )
    if (marker?.isFile() || marker?.isDirectory()) {
      found ??= dir
      if (!established) return dir
      // An ancestor alias can name cwd's worktree differently. Preserve that
      // established boundary too, without adopting unrelated outer repositories.
      if (same(established, await followedStat(dir, { bigint: true })))
        return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return protectedAncestor ?? found
    dir = parent
  }
}

// Preserve components until the lstat walk, including link/.. pairs. Resolving
// only a drive prefix also respects Windows' per-drive current directories.
export function uploadInputPath(
  input: string,
  cwd: string,
  paths = { isAbsolute, parse, resolve, sep },
): string {
  if (paths.isAbsolute(input)) return input
  const drive = paths.parse(input).root
  if (drive) {
    const base = paths.resolve(cwd, `${drive}.`)
    return `${base}${paths.sep}${input.slice(drive.length)}`
  }
  return `${cwd}${paths.sep}${input}`
}

/**
 * POSIX uses O_NOFOLLOW and O_NONBLOCK plus repeated component/handle checks.
 * The trust root itself is inspected with lstat. The fallback parent may be
 * macOS /tmp or /var only when its link points to the expected /private target;
 * both link and target identities are pinned. Ancestor aliases remain allowed.
 * Windows lstat rejects symlinks, junctions and app execution aliases. Without
 * O_NOFOLLOW, the post-open component/handle identity check guards the first read.
 * Non-redirecting reparse points (cloud-file placeholders, deduplication and
 * compression) may serve their own content. Stable dev/ino/mode identities are
 * required on every platform; unavailable identities fail closed.
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
  const raw = uploadInputPath(input, cwd)
  const target = resolve(cwd, input)
  const repo = await gitRoot(cwd)
  if (repo && !isAbsolute(input) && !contains(repo, target)) {
    fail(
      input,
      'relative path leaves the Git repository; select an absolute path explicitly',
      'escape',
    )
  }
  // Prefer the nearest repository, retaining cwd's established worktree even
  // through ancestor aliases. Do not normalize link/.. pairs during discovery.
  const repositoryBoundary = await gitRoot(raw, repo)
  let root = repositoryBoundary
    ? resolve(repositoryBoundary)
    : isAbsolute(input)
      ? dirname(target)
      : cwd
  // A discovered marker cannot narrow an already established boundary.
  if (repo && contains(repo, target) && contains(repo, root)) root = repo
  if (!isAbsolute(input) && contains(cwd, root)) root = cwd
  // Only these OS-owned macOS aliases may be the fallback parent. The selected
  // input and arbitrary user-created parent links still follow the no-link rule.
  const systemAliasTarget =
    process.platform === 'darwin' && !repositoryBoundary && root !== target
      ? new Map([
          ['/tmp', '/private/tmp'],
          ['/var', '/private/var'],
        ]).get(root)
      : undefined
  const establishedIdentity = repo
    ? await followedStat(repo, { bigint: true })
    : undefined
  let aliasIdentity: BigIntStats | undefined
  const evidence = new Map<string, BigIntStats>()
  let activePath = input
  async function inspect(path: string): Promise<BigIntStats> {
    activePath = path
    let info = await lstat(path, { bigint: true })
    if (info.isSymbolicLink()) {
      // An alias naming cwd's established worktree may address descendants,
      // but cannot narrow that boundary or make a linked selected input valid.
      const establishedAlias =
        path === root && path !== target && establishedIdentity
          ? same(
              establishedIdentity,
              await followedStat(path, { bigint: true }),
            )
          : false
      if (path !== root || (!systemAliasTarget && !establishedAlias))
        fail(path, 'symbolic link or junction is not allowed', 'link')
      identity(path, info)
      if (aliasIdentity && !unchanged(aliasIdentity, info))
        fail(path, 'alias identity changed')
      if (
        systemAliasTarget &&
        resolve(dirname(path), await readlink(path)) !== systemAliasTarget
      )
        fail(path, 'system alias target changed')
      const aliasAfter = await lstat(path, { bigint: true })
      if (!unchanged(info, aliasAfter)) fail(path, 'alias identity changed')
      aliasIdentity = info
      info = systemAliasTarget
        ? await lstat(systemAliasTarget, { bigint: true })
        : await followedStat(path, { bigint: true })
      if (establishedAlias && !same(establishedIdentity!, info))
        fail(path, 'worktree alias target changed')
      if (!info.isDirectory())
        fail(path, 'alias target is not a regular directory', 'type')
    } else if (path === root && aliasIdentity) {
      fail(path, 'alias identity changed')
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
      if (!stat.isDirectory())
        fail(current, 'parent is not a directory', 'type')
      current = join(current, part)
      stat = await inspect(current)
    }
    return stat
  }
  try {
    // Inspect lexical components before normalization can erase a link/.. pair.
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
      fail(
        input,
        'no-follow open guarantee unavailable on this platform',
        'unsupported',
      )
    if (!selected.isFile() && !selected.isDirectory())
      fail(input, 'path must be a regular file or directory', 'type')
    if (options.fileOnly && !selected.isFile())
      fail(input, 'path must be a non-empty file', 'type')
    const paths: string[] = []
    async function visit(dir: string): Promise<void> {
      await walk(dir)
      for (const name of await readdir(dir)) {
        // Excluded names are not upload inputs, even when they are links.
        if (
          name === '__MACOSX' ||
          name.startsWith('.') ||
          IGNORED_FILENAMES.has(name) ||
          EXCLUDED_DIR_NAMES.has(name)
        )
          continue
        const path = join(dir, name)
        const stat = await walk(path)
        if (stat.isDirectory()) {
          await visit(path)
        } else if (stat.isFile()) {
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
    for (const path of evidence.keys()) await walk(path)
    return { directory: selected.isDirectory(), files }
  } catch (error) {
    if (error instanceof UploadBoundaryError) throw error
    readFailure(activePath, error)
  }
}

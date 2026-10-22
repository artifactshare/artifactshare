import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validationError } from './errors.js'

export class WriteBoundaryError extends Error {
  readonly error
  constructor(
    readonly path: string,
    hint = 'Choose a regular directory without links, check retained recovery paths, and retry.',
    message = `Unsafe or changed write path ${path}.`,
  ) {
    super(message)
    this.error = validationError(this.message, hint)
  }
}

export class WriteFileSystemError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Could not complete a filesystem operation at ${path}.`, { cause })
  }
}

type Entry = { stat: BigIntStats; owned: boolean }
export type WriteBoundaryDependencies = {
  checkpoint?: (
    phase: 'create' | 'read' | 'rename' | 'remove' | 'rollback',
    path: string,
  ) => Promise<void>
  lstat?: (path: string) => Promise<BigIntStats>
  realpath?: (path: string) => Promise<string>
  open?: typeof fs.open
  rename?: typeof fs.rename
  unlink?: typeof fs.unlink
  rmdir?: typeof fs.rmdir
}
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.isDirectory() === b.isDirectory() &&
  a.isFile() === b.isFile()

/** Observed identity checks, not an atomic directory-relative filesystem API. */
export class WriteBoundary {
  private entries = new Map<string, Entry>()
  private children = new Map<string, Set<string>>()
  private trustedParents = new Set<string>()
  private absent = new Set<string>()
  private guards = new Set<string>()

  watch(...paths: string[]) {
    for (const path of paths) this.guards.add(resolve(path))
  }
  readonly backupPaths: string[] = []
  workspace?: string
  constructor(private dependencies: WriteBoundaryDependencies = {}) {}

  private setEntry(path: string, entry: Entry) {
    this.entries.set(path, entry)
    const parent = dirname(path)
    if (parent === path) return
    let children = this.children.get(parent)
    if (!children) this.children.set(parent, (children = new Set()))
    children.add(path)
  }

  private deleteEntry(path: string) {
    this.entries.delete(path)
    this.children.get(dirname(path))?.delete(path)
  }

  private *subtree(path: string): Generator<[string, Entry]> {
    const entry = this.entries.get(path)
    if (entry) yield [path, entry]
    for (const child of this.children.get(path) ?? [])
      yield* this.subtree(child)
  }

  // Record the chosen output parent without following links, then pin its
  // identity for subsequent operations. Missing parents are checked likewise.
  async outputParent(path: string): Promise<void> {
    path = resolve(path)
    if (this.entries.has(path)) {
      await this.record(path, true)
      return
    }
    this.trustedParents.add(path)
    this.watch(path)
    if (!(await this.record(path, true))) await this.outputParent(dirname(path))
  }

  private async io<T>(path: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (
        error instanceof WriteBoundaryError ||
        error instanceof WriteFileSystemError
      )
        throw error
      throw new WriteFileSystemError(path, error)
    }
  }

  private async stat(path: string) {
    try {
      const s = await (
        this.dependencies.lstat ??
        ((name: string) => fs.lstat(name, { bigint: true }))
      )(path)
      if (
        s.isSymbolicLink() ||
        (!s.isDirectory() && !s.isFile()) ||
        typeof s.dev !== 'bigint' ||
        typeof s.ino !== 'bigint' ||
        s.ino <= 0n
      )
        throw new WriteBoundaryError(path)
      return s
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new WriteBoundaryError(path)
    }
  }

  async record(path: string, directory = false): Promise<boolean> {
    path = resolve(path)
    if (this.entries.has(path) || this.absent.has(path)) {
      await this.check(path)
      if (
        directory &&
        this.entries.has(path) &&
        !this.entries.get(path)!.stat.isDirectory()
      )
        throw new WriteBoundaryError(path)
      return this.entries.has(path)
    }
    const s = await this.stat(path)
    if (!s) {
      this.absent.add(path)
      return false
    }
    if (directory && !s.isDirectory()) throw new WriteBoundaryError(path)
    this.setEntry(path, { stat: s, owned: false })
    await this.check(path)
    return true
  }

  async check(...paths: string[]) {
    // Follow only the operation endpoints and guards through their recorded
    // ancestry. Checking just the immediate parent misses an ancestor redirect
    // that preserves the identities of the descendants beneath it.
    const selected = new Set<string>()
    for (const target of [
      ...this.guards,
      ...paths,
      ...(this.workspace ? [this.workspace] : []),
    ]) {
      let path = resolve(target)
      selected.add(path)
      while (!this.trustedParents.has(path)) {
        const parent = dirname(path)
        if (parent === path || !this.entries.has(parent)) break
        selected.add(parent)
        path = parent
      }
    }
    const observed = new Map<string, BigIntStats | null>()
    const inspect = async (path: string) => {
      if (!observed.has(path)) observed.set(path, await this.stat(path))
      return observed.get(path)!
    }
    for (const path of selected) {
      const entry = this.entries.get(path)
      if (!entry) {
        if (this.absent.has(path) && (await inspect(path)))
          throw new WriteBoundaryError(path)
        continue
      }
      const s = await inspect(path)
      if (!s || !same(s, entry.stat)) throw new WriteBoundaryError(path)
      const parent = this.entries.get(dirname(path))
      if (parent && !this.trustedParents.has(path)) {
        // Compare physical parent identity, never normalized path spellings.
        const physical = await (this.dependencies.realpath ?? fs.realpath)(
          path,
        ).catch(() => {
          throw new WriteBoundaryError(path)
        })
        const actualEntry = await inspect(physical)
        if (!actualEntry || !same(actualEntry, s))
          throw new WriteBoundaryError(path)
        const actual = await inspect(dirname(physical))
        if (!actual || !same(actual, parent.stat))
          throw new WriteBoundaryError(path)
      }
    }
  }

  async directory(path: string) {
    path = resolve(path)
    if (this.entries.has(path)) {
      await this.check(path)
      if (!this.entries.get(path)!.stat.isDirectory())
        throw new WriteBoundaryError(path)
      return
    }
    if (await this.record(path, true)) return
    await this.directory(dirname(path))
    await this.before('create', path)
    await this.io(path, () => fs.mkdir(path))
    this.absent.delete(path)
    const s = await this.stat(path)
    if (!s?.isDirectory()) throw new WriteBoundaryError(path)
    this.setEntry(path, { stat: s, owned: true })
    await this.check(path)
  }

  async tree(path: string) {
    if (!(await this.record(path))) return
    const entry = this.entries.get(resolve(path))!
    if (entry.stat.isDirectory()) {
      for (const name of await this.io(path, () => fs.readdir(path)))
        await this.tree(join(path, name))
    }
    await this.check(path)
  }

  async before(
    phase: Parameters<NonNullable<WriteBoundaryDependencies['checkpoint']>>[0],
    path: string,
    ...otherPaths: string[]
  ) {
    await this.dependencies.checkpoint?.(phase, path)
    await this.check(path, ...otherPaths)
  }

  async privateDirectory(parent: string) {
    await this.directory(parent)
    await this.before('create', parent)
    const path = await this.io(parent, () =>
      fs.mkdtemp(join(parent, '.artifactshare-')),
    )
    const stat = await this.stat(path)
    if (!stat?.isDirectory()) throw new WriteBoundaryError(path)
    this.setEntry(path, { stat, owned: true })
    await this.check(path)
    return path
  }

  async read(path: string): Promise<string | null> {
    path = resolve(path)
    if (!(await this.record(path))) return null
    const entry = this.entries.get(path)!
    if (!entry.stat.isFile()) throw new WriteBoundaryError(path)
    await this.before('read', path)
    const handle = await this.io(path, () =>
      (this.dependencies.open ?? fs.open)(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      ),
    )
    try {
      const s = await handle.stat({ bigint: true })
      if (!same(s, entry.stat)) throw new WriteBoundaryError(path)
      const text = await this.io(path, () => handle.readFile('utf8'))
      await this.check(path)
      const after = await handle.stat({ bigint: true })
      if (
        !same(after, s) ||
        after.size !== s.size ||
        after.mtimeNs !== s.mtimeNs
      )
        throw new WriteBoundaryError(path)
      return text
    } finally {
      await this.io(path, () => handle.close())
    }
  }

  async write(path: string, content: string | Uint8Array, mode?: number) {
    path = resolve(path)
    await this.directory(dirname(path))
    if (await this.record(path)) throw new WriteBoundaryError(path)
    await this.before('create', path)
    const handle = await this.io(path, () =>
      (this.dependencies.open ?? fs.open)(path, 'wx', mode ?? 0o666),
    )
    try {
      const stat = await handle.stat({ bigint: true })
      this.absent.delete(path)
      this.setEntry(path, { stat, owned: true })
      await this.check(path)
      await this.io(path, () => handle.writeFile(content))
      if (mode !== undefined) await this.io(path, () => handle.chmod(mode))
      await this.check(path)
    } finally {
      await this.io(path, () => handle.close())
    }
  }

  async move(source: string, destination: string, replace = false) {
    source = resolve(source)
    destination = resolve(destination)
    if (!this.entries.has(source)) throw new WriteBoundaryError(source)
    for (const path of [source, destination]) {
      if (!this.entries.get(dirname(path))?.stat.isDirectory())
        throw new WriteBoundaryError(dirname(path))
    }
    await this.record(destination)
    if (!replace && this.entries.has(destination))
      throw new WriteBoundaryError(destination)
    await this.before('rename', destination, source)
    await this.io(destination, () =>
      (this.dependencies.rename ?? fs.rename)(source, destination),
    )
    this.deleteEntry(destination)
    this.absent.delete(destination)
    const moved = [...this.subtree(source)]
    for (const [path] of moved) this.deleteEntry(path)
    for (const [path, entry] of moved)
      this.setEntry(destination + path.slice(source.length), entry)
    this.absent.add(source)
    await this.check(source, destination)
  }

  async replace(source: string, destination: string, retain = true) {
    const guarded = this.guards.has(resolve(destination))
    this.watch(destination)
    try {
      let backup: string | undefined
      if (await this.record(destination)) {
        if (!retain) {
          await this.move(source, destination, true)
          return
        }
        if (!this.workspace) throw new WriteBoundaryError(destination)
        backup = join(this.workspace, `backup-${randomUUID()}`)
        await this.move(destination, backup)
        this.backupPaths.push(backup)
      }
      try {
        await this.move(source, destination)
      } catch (error) {
        if (backup) {
          try {
            await this.before('rollback', destination)
            await this.move(backup, destination)
            this.backupPaths.splice(this.backupPaths.indexOf(backup), 1)
          } catch (restoreError) {
            const failure = new WriteBoundaryError(
              destination,
              `Publication failed and backup restoration could not finish. Recover original data at ${backup}; inspect it before manual cleanup.`,
            )
            Object.defineProperty(failure, 'cause', {
              value: new AggregateError([error, restoreError]),
            })
            throw failure
          }
        }
        throw error
      }
    } finally {
      if (!guarded) this.guards.delete(resolve(destination))
    }
  }

  async atomicWrite(path: string, content: string, retain = false) {
    await this.record(path)
    const temp = join(dirname(path), `.artifactshare-${randomUUID()}.tmp`)
    const existing = this.entries.get(resolve(path))
    await this.write(
      temp,
      content,
      existing ? Number(existing.stat.mode & 0o777n) : undefined,
    )
    await this.replace(temp, path, retain)
  }

  async cleanup() {
    // Never recursively delete: unknown children and retained originals prevent
    // removing their containing directory. Verify each created entry separately.
    const retained = (path: string) =>
      this.backupPaths.some(
        (backup) => backup === path || backup.startsWith(`${path}${sep}`),
      )
    for (const [path, entry] of [...this.entries].reverse()) {
      if (!entry.owned || retained(path)) continue
      // Published entries are deliberately no longer owned by this run.
      await this.before('remove', path)
      if (entry.stat.isDirectory())
        await this.io(path, () => (this.dependencies.rmdir ?? fs.rmdir)(path))
      else
        await this.io(path, () => (this.dependencies.unlink ?? fs.unlink)(path))
      this.deleteEntry(path)
      this.absent.add(path)
    }
  }

  // Displaced originals remain recoverable after successful publication.
  // cleanup removes only owned entries outside their retained containers.
  async finish() {
    await this.cleanup()
  }

  keep(path: string) {
    path = resolve(path)
    for (const [, entry] of this.subtree(path)) entry.owned = false
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const entry = this.entries.get(parent)
      if (entry) entry.owned = false
      if (dirname(parent) === parent) break
    }
  }
}

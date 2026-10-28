import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  readFile,
  readdir,
  realpath,
  mkdir,
  writeFile,
  rename,
  unlink,
  rmdir,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import type { SkillFolderDiagnostic } from '../types.js'

export type ManagedState =
  | { kind: 'missing' | 'unmanaged' | 'broken' }
  | { kind: 'managed'; version: number }
export type SkillBundle = { files: Record<string, string>; version: number }
const MANIFEST = '.artifactshare-managed.json'
const PENDING = '.artifactshare-pending.json'
type Manifest = {
  schema_version: 1
  version: number
  files: Record<string, string>
  previous_files?: Record<string, string>
}
export function managedState(content: string | null): ManagedState {
  if (content === null) return { kind: 'missing' }
  if (!content.includes('artifactshare-skill')) return { kind: 'unmanaged' }
  const block = content.match(/<!--\s*artifactshare-skill([\s\S]*?)-->/)?.[1]
  const version = block?.match(/(?:^|\n)\s*version:\s*(\d+)\s*(?:\n|$)/)?.[1]
  if (
    version === undefined ||
    !/(?:^|\n)\s*managed:\s*true\s*(?:\n|$)/.test(block ?? '') ||
    !Number.isSafeInteger(Number(version))
  )
    return { kind: 'broken' }
  return { kind: 'managed', version: Number(version) }
}
const hash = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex')
const validPath = (path: string) =>
  (path === 'SKILL.md' || path.startsWith('references/')) &&
  !/[\\:]/.test(path) &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
async function info(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
// Only the configured folder boundary may be an alias. Descendants never are.
export function resolveSkillFolder(entry: string): Promise<string> {
  const resolveDirectory = async (path: string): Promise<string> => {
    try {
      const item = await info(path)
      if (!item)
        return join(await resolveDirectory(dirname(path)), basename(path))
      const canonical = await realpath(path)
      if (!(await lstat(canonical)).isDirectory())
        throw new Error('Not a directory')
      return canonical
    } catch {
      throw new Error(
        `Unsafe skill folder: ${path}. Restore or repoint the link to a directory, or replace it with a real directory, then retry.`,
      )
    }
  }
  return resolveDirectory(dirname(entry))
}
const rootFor = resolveSkillFolder
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const legacyTemp = new RegExp(`^\\.artifactshare-${uuid}\\.tmp$`, 'i')
const stagingName = new RegExp(`^\\.artifactshare-staging-${uuid}$`, 'i')
async function inspectTree(root: string, cleanup = false): Promise<void> {
  if (!(await info(root))) return
  for (const name of await readdir(root)) {
    const path = join(root, name)
    const item = await lstat(path)
    if (item.isSymbolicLink())
      throw new Error(
        `Unsafe skill path (link): ${path}. Preserve edits and replace the internal link with ordinary bundled content, then retry.`,
      )
    if (item.isDirectory()) await inspectTree(path, cleanup)
    else if (cleanup && item.isFile() && legacyTemp.test(name))
      await unlink(path)
  }
}
export async function cleanupSkillFolder(entry: string) {
  const root = await rootFor(entry)
  await inspectTree(root, true)
  const parent = dirname(root)
  if (await info(parent))
    for (const name of await readdir(parent))
      if (
        stagingName.test(name) &&
        (await lstat(join(parent, name))).isDirectory()
      )
        await rm(join(parent, name), { recursive: true, force: true })
}
async function safe(
  root: string,
  relative: string,
  retiredAncestors = new Set<string>(),
  replacedDirectories = new Set<string>(),
) {
  const parts = [
    dirname(root),
    root,
    ...relative
      .split('/')
      .map((_, i, all) => join(root, ...all.slice(0, i + 1))),
  ]
  for (let i = 0; i < parts.length; i++) {
    const item = await info(parts[i]!)
    // A validated retired file may become a directory during this update.
    if (
      i < parts.length - 1 &&
      item?.isFile() &&
      retiredAncestors.has(parts[i]!)
    )
      return
    if (
      i === parts.length - 1 &&
      item?.isDirectory() &&
      replacedDirectories.has(parts[i]!)
    )
      continue
    if (
      item &&
      (item.isSymbolicLink() ||
        (i === parts.length - 1 ? !item.isFile() : !item.isDirectory()))
    )
      throw new Error(
        `Unsafe skill path (type change or link): ${parts[i]}. Preserve edits and replace internal links with ordinary bundled content, then retry.`,
      )
  }
}
async function bytesAt(root: string, path: string) {
  await safe(root, path)
  return await readFile(join(root, path)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
}
async function textAt(root: string, path: string) {
  return (await bytesAt(root, path))?.toString('utf8') ?? null
}
async function stateAt(root: string): Promise<ManagedState> {
  try {
    return managedState(await textAt(root, 'SKILL.md'))
  } catch {
    return { kind: 'broken' }
  }
}
export async function readSkillState(entry: string): Promise<ManagedState> {
  try {
    return await stateAt(await rootFor(entry))
  } catch {
    return { kind: 'broken' }
  }
}
export async function loadSkillBundle(root: string): Promise<SkillBundle> {
  const files: Record<string, string> = {}
  const visit = async (relative: string) => {
    const path = join(root, relative)
    const item = await info(path)
    if (!item) return
    if (item.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(`${relative}/${name}`)
    } else if (item.isFile() && validPath(relative))
      files[relative] = await readFile(path, 'utf8')
    else throw new Error(`Invalid bundled skill path: ${relative}`)
  }
  await visit('SKILL.md')
  await visit('references')
  const state = managedState(files['SKILL.md'] ?? null)
  if (state.kind !== 'managed')
    throw new Error(
      'The bundled SKILL.md has a missing or invalid managed marker.',
    )
  if (
    new Set(Object.keys(files).map((path) => path.toLowerCase())).size !==
    Object.keys(files).length
  )
    throw new Error('Colliding bundled skill paths.')
  return { files, version: state.version }
}
async function ownership(
  root: string,
  state: ManagedState,
  record = MANIFEST,
  pending?: Manifest,
): Promise<{ status: 'absent' | 'valid' | 'invalid'; manifest?: Manifest }> {
  try {
    const text = await textAt(root, record)
    if (text === null) return { status: 'absent' }
    const value = JSON.parse(text) as Manifest
    if (
      value.schema_version !== 1 ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      (record === MANIFEST &&
        (state.kind === 'managed'
          ? value.version !== state.version &&
            value.version !== pending?.version
          : state.kind !== 'missing' || !pending)) ||
      !value.files ||
      typeof value.files !== 'object' ||
      Array.isArray(value.files) ||
      !Object.hasOwn(value.files, 'SKILL.md')
    )
      return { status: 'invalid' }
    for (const files of [
      value.files,
      ...(value.previous_files === undefined ? [] : [value.previous_files]),
    ]) {
      if (!files || typeof files !== 'object' || Array.isArray(files))
        return { status: 'invalid' }
      const paths = Object.keys(files)
      if (
        new Set(paths.map((path) => path.toLowerCase())).size !==
          paths.length ||
        !paths.every(
          (path) =>
            validPath(path) &&
            typeof files[path] === 'string' &&
            /^[a-f0-9]{64}$/.test(files[path]),
        )
      )
        return { status: 'invalid' }
    }
    return { status: 'valid', manifest: value }
  } catch {
    return { status: 'invalid' }
  }
}
// Only recorded intent hashes authorize partially committed content, never the bundle.
async function recoveryOwnership(root: string, state: ManagedState) {
  const pending = await ownership(root, state, PENDING)
  const owned = await ownership(root, state, MANIFEST, pending.manifest)
  const recorded = {
    ...(owned.manifest?.files ??
      (state.kind === 'managed' && pending.status === 'absent'
        ? { 'SKILL.md': hash((await bytesAt(root, 'SKILL.md'))!) }
        : {})),
  }
  // Preserve the old hashes across the manifest-before-entry commit window.
  for (const [path, expected] of Object.entries(
    pending.manifest?.previous_files ?? {},
  )) {
    const bytes = await bytesAt(root, path).catch(() => null)
    if (bytes !== null && hash(bytes) === expected) recorded[path] = expected
  }
  for (const [path, expected] of Object.entries(
    pending.manifest?.files ?? {},
  )) {
    const bytes = await bytesAt(root, path).catch(() => null)
    if (bytes !== null && hash(bytes) === expected) recorded[path] = expected
  }
  // A committed file replacement makes the old descendants inaccessible.
  for (const [path, expected] of Object.entries(
    pending.manifest?.files ?? {},
  )) {
    const bytes = await bytesAt(root, path).catch(() => null)
    if (bytes !== null && hash(bytes) === expected)
      for (const old of Object.keys(recorded))
        if (old.startsWith(`${path}/`)) delete recorded[old]
  }
  // Conversely, an intended descendant can replace an old file with a directory.
  for (const path of Object.keys(recorded))
    if (
      (await info(join(root, path)).catch(() => null))?.isDirectory() &&
      Object.keys(pending.manifest?.files ?? {}).some((next) =>
        next.startsWith(`${path}/`),
      )
    )
      delete recorded[path]
  return { owned, pending, recorded }
}
export async function folderDiagnostics(
  entry: string,
  bundle: SkillBundle,
): Promise<SkillFolderDiagnostic & { code?: string }> {
  let root: string | null = null
  try {
    root = await rootFor(entry)
    await inspectTree(root)
  } catch (error) {
    return {
      folder_path: dirname(entry),
      resolved_folder_path: root,
      complete: false,
      current: false,
      older_version: false,
      missing_files: [],
      different_files: [],
      modified_files: [],
      ownership_manifest: 'invalid' as const,
      code: 'skill_update_conflict',
      hint: (error as Error).message,
    }
  }
  const state = await stateAt(root)
  const { owned, pending, recorded } = await recoveryOwnership(root, state)
  const missing_files: string[] = [],
    different_files: string[] = [],
    modified_files: string[] = []
  for (const path of Object.keys(bundle.files).sort()) {
    const text = await bytesAt(root, path).catch(() => null)
    if (text === null) missing_files.push(path)
    else if (!text.equals(Buffer.from(bundle.files[path]!)))
      different_files.push(path)
  }
  for (const [path, expected] of Object.entries(recorded).sort()) {
    const text = await bytesAt(root, path).catch(() => null)
    if (
      expected &&
      (text === null ? pending.status === 'absent' : hash(text) !== expected)
    )
      modified_files.push(path)
  }
  const manifestMatches =
    owned.manifest !== undefined &&
    Object.keys(owned.manifest.files).length ===
      Object.keys(bundle.files).length &&
    Object.entries(bundle.files).every(
      ([path, text]) => owned.manifest?.files[path] === hash(text),
    )
  return {
    folder_path: dirname(entry),
    resolved_folder_path: root,
    complete: missing_files.length === 0,
    current:
      state.kind === 'managed' &&
      state.version === bundle.version &&
      !missing_files.length &&
      !different_files.length &&
      owned.status === 'valid' &&
      manifestMatches &&
      pending.status === 'absent',
    ...(pending.status !== 'absent' ? { interrupted_update: true } : {}),
    older_version: state.kind === 'managed' && state.version < bundle.version,
    missing_files,
    different_files,
    modified_files,
    ownership_manifest: owned.status,
  }
}
export async function preflightFolder(
  entry: string,
  bundle?: SkillBundle,
  force = false,
  forceRetirement = force,
) {
  const root = await rootFor(entry)
  const state = await stateAt(root)
  await inspectTree(root)
  await safe(root, 'SKILL.md')
  const { owned, pending, recorded } = await recoveryOwnership(root, state)
  if (
    ((owned.status === 'invalid' || pending.status === 'invalid') && !force) ||
    (!force && state.kind !== 'managed' && state.kind !== 'missing')
  )
    throw new Error(
      `Skill ownership conflict: ${join(root, state.kind === 'managed' ? MANIFEST : 'SKILL.md')} (${state.kind === 'managed' ? 'invalid ownership metadata' : 'user-edited file'}). Inspect the folder and use skills install --force to reinstall bundled paths.`,
    )
  const previous = recorded
  await safe(root, PENDING)
  await safe(root, MANIFEST)
  for (const path of Object.keys(previous)) await safe(root, path)
  if (!forceRetirement) {
    for (const [path, expected] of Object.entries(previous)) {
      const bytes = await bytesAt(root, path)
      if (expected && bytes !== null && hash(bytes) !== expected)
        throw new Error(
          `Modified skill file: ${path}. Preserve your edits before removing or retiring this file, or reinstall with skills install --force.`,
        )
    }
  }
  const blockers = Object.keys(previous).filter(
    (path) =>
      bundle &&
      !Object.hasOwn(bundle.files, path) &&
      Object.keys(bundle.files).some((next) => next.startsWith(`${path}/`)),
  )
  const retiredAncestors = new Set(blockers.map((path) => join(root, path)))
  const replacedDirectories = new Set<string>()
  const checkDirectory = async (relative: string) => {
    if (!Object.keys(previous).some((path) => path.startsWith(`${relative}/`)))
      throw new Error(
        `Unowned skill directory (type change): ${relative}. Preserve or move this entry before updating.`,
      )
    for (const name of await readdir(join(root, relative))) {
      const child = `${relative}/${name}`
      const item = await info(join(root, child))
      if (item?.isFile() && legacyTemp.test(name)) continue
      if (item?.isDirectory()) await checkDirectory(child)
      else if (!item?.isFile() || !Object.hasOwn(previous, child))
        throw new Error(
          `Unowned skill file or type change: ${child}. Preserve or move this entry before updating.`,
        )
    }
    replacedDirectories.add(join(root, relative))
  }
  for (const path of Object.keys(bundle?.files ?? {})) {
    if (!blockers.some((ancestor) => path.startsWith(`${ancestor}/`))) {
      // Check ancestors before inspecting or traversing the destination.
      await safe(root, path, retiredAncestors, new Set([join(root, path)]))
      if ((await info(join(root, path)))?.isDirectory())
        await checkDirectory(path)
    }
    await safe(root, path, retiredAncestors, replacedDirectories)
    if (
      !Object.hasOwn(previous, path) &&
      !replacedDirectories.has(join(root, path)) &&
      !blockers.some((ancestor) => path.startsWith(`${ancestor}/`)) &&
      (await info(join(root, path))) &&
      !force
    )
      throw new Error(
        `Unowned skill file: ${path}. Use skills install --force to take over bundled paths.`,
      )
  }
  return { root, previous, blockers, replacedDirectories }
}
async function prune(root: string, paths: string[]) {
  const dirs = new Set<string>()
  for (const path of paths) {
    let dir = dirname(join(root, path))
    while (dir.startsWith(root) && dir !== root) {
      dirs.add(dir)
      dir = dirname(dir)
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length))
    await rmdir(dir).catch(() => {})
}
export async function writeSkillFolder(
  entry: string,
  bundle: SkillBundle,
  force = false,
  forceRetirement = force,
  cleanup = true,
) {
  if (cleanup) await cleanupSkillFolder(entry)
  const { root, previous, blockers, replacedDirectories } =
    await preflightFolder(entry, bundle, force, forceRetirement)
  const files = {
    ...bundle.files,
    [MANIFEST]:
      JSON.stringify(
        {
          schema_version: 1,
          version: bundle.version,
          files: Object.fromEntries(
            Object.entries(bundle.files).map(([path, text]) => [
              path,
              hash(text),
            ]),
          ),
        },
        null,
        2,
      ) + '\n',
  }
  const stagingDir = join(
    dirname(root),
    `.artifactshare-staging-${randomUUID()}`,
  )
  const staged = new Map<string, string>()
  const backups = new Map<string, Buffer | null>()
  const changed = new Set<string>()
  const createdDirectories: string[] = []
  const removedDirectories: string[] = []
  const ensureDirectory = async (path: string): Promise<void> => {
    if (await info(path)) return
    await ensureDirectory(dirname(path))
    await mkdir(path)
    createdDirectories.push(path)
  }
  for (const path of new Set([
    ...Object.keys(previous),
    ...Object.keys(files),
    PENDING,
  ])) {
    const blocked = blockers.some((ancestor) => path.startsWith(`${ancestor}/`))
    backups.set(
      path,
      !blocked && (await info(join(root, path)))?.isFile()
        ? await readFile(join(root, path))
        : null,
    )
  }
  const intent =
    JSON.stringify({
      ...JSON.parse(files[MANIFEST]),
      previous_files: previous,
    }) + '\n'
  const retire = async (path: string) => {
    if (backups.get(path) !== null) {
      await unlink(join(root, path))
      changed.add(path)
    }
  }
  const commit = async (path: string) => {
    await ensureDirectory(dirname(join(root, path)))
    await rename(staged.get(path)!, join(root, path))
    changed.add(path)
  }
  try {
    await ensureDirectory(dirname(root))
    await mkdir(stagingDir, { mode: 0o700 })
    for (const [path, text] of Object.entries({
      ...files,
      [PENDING]: intent,
    })) {
      const temp = join(stagingDir, path)
      await mkdir(dirname(temp), { recursive: true })
      staged.set(path, temp)
      await writeFile(temp, text, { flag: 'wx' })
    }
    await commit(PENDING)
    const retired = Object.keys(previous).filter(
      (path) => !Object.hasOwn(bundle.files, path),
    )
    const earlyRetired = new Set(
      retired.filter(
        (path) =>
          blockers.includes(path) ||
          [...replacedDirectories].some((dir) =>
            join(root, path).startsWith(`${dir}${sep}`),
          ),
      ),
    )
    for (const path of earlyRetired) await retire(path)
    for (const dir of [...replacedDirectories].sort(
      (a, b) => b.length - a.length,
    )) {
      await rmdir(dir)
      removedDirectories.push(dir)
    }
    for (const path of Object.keys(bundle.files)
      .filter((relative) => relative !== 'SKILL.md')
      .sort())
      await commit(path)
    for (const path of retired) if (!earlyRetired.has(path)) await retire(path)
    await commit(MANIFEST)
    await commit('SKILL.md')
    await unlink(join(root, PENDING))
    await prune(root, retired)
  } catch (error) {
    // Undo new paths before restoring files that became directories (or vice versa).
    for (const path of [...changed].reverse()) {
      if (path === PENDING) continue
      if ((await info(join(root, path)))?.isFile())
        await unlink(join(root, path))
    }
    for (const dir of [...createdDirectories].reverse())
      await rmdir(dir).catch(() => {})
    for (const dir of removedDirectories.reverse())
      await mkdir(dir, { recursive: true })
    for (const path of changed) {
      if (path === PENDING) continue
      const bytes = backups.get(path)
      if (bytes !== null && bytes !== undefined) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), bytes)
      }
    }
    if (changed.has(PENDING)) {
      const previousIntent = backups.get(PENDING)
      if (previousIntent) await writeFile(join(root, PENDING), previousIntent)
      else await unlink(join(root, PENDING))
    }
    throw error
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
    for (const dir of [...createdDirectories].reverse())
      await rmdir(dir).catch(() => {})
  }
}

export async function removeSkillFolder(entry: string, retainRoot = false) {
  const { root, previous } = await preflightFolder(entry)
  for (const path of [...Object.keys(previous), MANIFEST, PENDING])
    await unlink(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  await prune(root, Object.keys(previous))
  // Keep configured aliases usable, including aliases on an ancestor.
  let path = dirname(entry)
  while (path !== dirname(path)) {
    if ((await info(path))?.isSymbolicLink()) retainRoot = true
    if (path === dirname(dirname(dirname(entry)))) break
    path = dirname(path)
  }
  if (!retainRoot) {
    await rmdir(root).catch(() => {})
    await rmdir(dirname(root)).catch(() => {})
  }
}

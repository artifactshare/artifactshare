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
import {
  basename,
  dirname,
  join,
  sep,
  relative as relativePath,
} from 'node:path'
import type { SkillFolderDiagnostic } from '../types.js'

export type ManagedState =
  | { kind: 'missing' | 'unmanaged' | 'broken'; hint?: string }
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
// Configured folder aliases are resolved; descendant user links are never followed.
class SkillFolderResolutionError extends Error {
  constructor(
    path: string,
    readonly missingAncestor = false,
  ) {
    super(
      `${missingAncestor ? 'Skill not installed; dangling ancestor link' : 'Unsafe skill folder'}: ${path}. Restore or repoint the link to a directory, or replace it with a real directory, then retry.`,
    )
  }
}
export function resolveSkillFolder(entry: string): Promise<string> {
  const resolveDirectory = async (path: string): Promise<string> => {
    let item
    try {
      item = await info(path)
      if (!item)
        return join(await resolveDirectory(dirname(path)), basename(path))
      const canonical = await realpath(path)
      if (!(await lstat(canonical)).isDirectory())
        throw new Error('Not a directory')
      return canonical
    } catch (error) {
      if (error instanceof SkillFolderResolutionError) throw error
      throw new SkillFolderResolutionError(
        path,
        item?.isSymbolicLink() === true &&
          (error as NodeJS.ErrnoException).code === 'ENOENT',
      )
    }
  }
  return resolveDirectory(dirname(entry))
}
const rootFor = resolveSkillFolder
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const legacyTemp = new RegExp(`^\\.artifactshare-${uuid}\\.tmp$`, 'i')
const stagingName = new RegExp(`^\\.artifactshare-staging-${uuid}$`, 'i')
const stale = (item: { mtimeMs: number }) =>
  item.mtimeMs < Date.now() - 10 * 60 * 1000
async function protectedPaths(
  root: string,
  bundle?: SkillBundle,
  observedState?: ManagedState,
) {
  await safe(root, MANIFEST)
  await safe(root, PENDING)
  const state = observedState ?? (await stateAt(root))
  const pending = await ownership(root, state, PENDING)
  const owned = await ownership(root, state, MANIFEST, pending.manifest)
  const paths = new Set(['SKILL.md', 'references', MANIFEST, PENDING])
  for (const path of [
    ...Object.keys(bundle?.files ?? {}),
    ...Object.keys(owned.manifest?.files ?? {}),
    ...Object.keys(pending.manifest?.files ?? {}),
    ...Object.keys(pending.manifest?.previous_files ?? {}),
  ]) {
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++)
      paths.add(parts.slice(0, i).join('/'))
  }
  return paths
}
// Resolve protected spellings one component at a time, stopping at links.
// This uses the filesystem's own name equivalence without visiting referents.
export async function isProtectedLink(
  root: string,
  item: { dev: number; ino: number },
  protectedEntries: Set<string>,
  lookup = info,
): Promise<boolean> {
  for (const entry of protectedEntries) {
    let path = root
    for (const part of entry.split('/')) {
      path = join(path, part)
      const candidate = await lookup(path)
      if (!candidate) break
      if (candidate.dev === item.dev && candidate.ino === item.ino) return true
      if (!candidate.isDirectory()) break
    }
  }
  return false
}
// Preserve the observed blocking entry kind independently of the public message.
export class SkillPathError extends Error {
  constructor(
    message: string,
    readonly isLink: boolean,
  ) {
    super(message)
  }
}
// Without protected entries (an unowned folder), every link is a user link.
async function inspectTree(
  root: string,
  cleanup = false,
  folderRoot = root,
  protectedEntries?: Set<string>,
  userLinks: string[] = [],
): Promise<string[]> {
  if (!(await info(root))) return userLinks
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name)
    const item = await lstat(path)
    if (item.isSymbolicLink()) {
      const entry = relativePath(folderRoot, path).split(sep).join('/')
      if (
        protectedEntries &&
        (protectedEntries.has(entry) ||
          (await isProtectedLink(folderRoot, item, protectedEntries)) ||
          name === MANIFEST ||
          name === PENDING ||
          stagingName.test(name) ||
          legacyTemp.test(name))
      )
        throw new SkillPathError(
          `Unsafe skill path (link): ${entry}. Replace the link with a regular file or directory or remove it, then retry.`,
          true,
        )
      userLinks.push(entry)
      continue
    }
    if (item.isDirectory() && root === folderRoot && stagingName.test(name)) {
      // Inspect staging descendants before recursive cleanup, too.
      await inspectTree(path, false, folderRoot, protectedEntries, userLinks)
      if (
        cleanup &&
        stale(item) &&
        !userLinks.some((link) => link.startsWith(`${name}/`))
      )
        await rm(path, { recursive: true, force: true })
    } else if (item.isDirectory())
      await inspectTree(path, cleanup, folderRoot, protectedEntries, userLinks)
    else if (cleanup && item.isFile() && legacyTemp.test(name) && stale(item))
      await unlink(path)
  }
  return userLinks.sort()
}
export async function cleanupSkillFolder(entry: string, bundle?: SkillBundle) {
  const root = await rootFor(entry)
  if (bundle) {
    const pending = await ownership(root, await stateAt(root), PENDING)
    if (pending.manifest && pending.manifest.version > bundle.version)
      throw new Error(newerIntentHint(pending.manifest.version))
  }
  const protection = await protectedPaths(root, bundle)
  await inspectTree(root, false, root, protection)
  await inspectTree(root, true, root, protection)
  const parent = dirname(root)
  if (await info(parent))
    for (const name of await readdir(parent)) {
      if (!stagingName.test(name)) continue
      const item = await lstat(join(parent, name))
      if (item.isDirectory() && stale(item))
        await rm(join(parent, name), { recursive: true, force: true })
    }
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
      throw new SkillPathError(
        `Unsafe skill path (type change or link): ${parts[i]}. Replace the link with a regular file or directory or remove it, then retry.`,
        item.isSymbolicLink(),
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
export type SkillFolderInspection = {
  root: string | null
  state: ManagedState
  unowned: boolean
  linkedEntry: boolean
  folderAbsent: boolean
  error?: Error
}
// Presence includes invalid and dangling records; never inspect their referents.
// Legacy authority affects folder ownership, not the entry's state or safety.
async function inspectAt(
  root: string,
  managedLegacy: boolean,
): Promise<SkillFolderInspection> {
  const entry = await info(join(root, 'SKILL.md'))
  const recordsAbsent =
    !(await info(join(root, MANIFEST))) && !(await info(join(root, PENDING)))
  const linkedEntry = entry?.isSymbolicLink() === true
  let state: ManagedState
  try {
    state =
      linkedEntry && recordsAbsent
        ? { kind: 'unmanaged' }
        : managedState(await textAt(root, 'SKILL.md'))
  } catch {
    state = { kind: 'broken' }
  }
  return {
    root,
    state,
    linkedEntry,
    folderAbsent: !(await info(root)),
    unowned:
      !managedLegacy &&
      recordsAbsent &&
      (!entry || linkedEntry || state.kind === 'unmanaged'),
  }
}
export async function inspectSkillFolder(
  entry: string,
  managedLegacy: boolean,
): Promise<SkillFolderInspection> {
  try {
    return await inspectAt(await rootFor(entry), managedLegacy)
  } catch (error) {
    return {
      root: null,
      state:
        error instanceof SkillFolderResolutionError && error.missingAncestor
          ? { kind: 'missing', hint: error.message }
          : { kind: 'broken' },
      unowned: false,
      linkedEntry: false,
      folderAbsent: false,
      error: error as Error,
    }
  }
}
export async function isUnownedFolder(entry: string, managedLegacy = false) {
  return (await inspectSkillFolder(entry, managedLegacy)).unowned
}
async function stateAt(root: string): Promise<ManagedState> {
  try {
    return (await inspectAt(root, false)).state
  } catch {
    return { kind: 'broken' }
  }
}
export async function readSkillState(entry: string): Promise<ManagedState> {
  return (await inspectSkillFolder(entry, false)).state
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
  context: boolean | SkillFolderInspection = false,
): Promise<SkillFolderDiagnostic & { code?: string }> {
  const inspection =
    typeof context === 'boolean'
      ? await inspectSkillFolder(entry, context)
      : context
  let root: string | null = inspection.root
  let user_links: string[] = []
  try {
    if (inspection.error) throw inspection.error
    root = inspection.root!
    user_links = await inspectTree(
      root,
      false,
      root,
      inspection.unowned
        ? undefined
        : await protectedPaths(root, bundle, inspection.state),
    )
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
      ...(error instanceof SkillFolderResolutionError && error.missingAncestor
        ? { ownership_manifest: 'absent' as const }
        : {
            ownership_manifest: 'invalid' as const,
            code: 'skill_update_conflict',
          }),
      hint: (error as Error).message,
    }
  }
  const state = inspection.state
  const { owned, pending, recorded } = await recoveryOwnership(root, state)
  const newerIntent =
    pending.manifest && pending.manifest.version > bundle.version
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
    user_links,
    missing_files,
    different_files,
    modified_files,
    ownership_manifest: owned.status,
    ...(newerIntent
      ? { hint: newerIntentHint(pending.manifest!.version) }
      : {}),
  }
}
function newerIntentHint(version: number) {
  return `Interrupted skill update requires a newer CLI with bundled skill version ${version} or later. Upgrade the CLI, then retry.`
}
export async function preflightFolder(
  entry: string,
  bundle?: SkillBundle,
  force = false,
  forceRetirement = force,
  removing = false,
) {
  const root = await rootFor(entry)
  const state = await stateAt(root)
  await inspectTree(root, false, root, await protectedPaths(root, bundle))
  await safe(root, 'SKILL.md')
  const { owned, pending, recorded } = await recoveryOwnership(root, state)
  if (
    !removing &&
    bundle &&
    pending.manifest &&
    pending.manifest.version > bundle.version
  )
    throw new Error(newerIntentHint(pending.manifest.version))

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
          `Modified skill file: ${path}. Preserve your edits before removing this file, or use skills update --force to replace edited managed files.`,
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
      if (item?.isFile() && legacyTemp.test(name)) {
        if (stale(item)) continue
        throw new Error(
          `Recent skill temporary file: ${child}. Retry after the active update has finished and temporary files are older than ten minutes.`,
        )
      }
      if (item?.isDirectory()) await checkDirectory(child)
      else if (!item?.isFile() || !Object.hasOwn(previous, child))
        throw new Error(
          `Unowned skill file or type change: ${child}. Preserve or move this entry before updating.`,
        )
    }
    replacedDirectories.add(join(root, relative))
  }
  for (const path of Object.keys(removing ? {} : (bundle?.files ?? {}))) {
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
  if (cleanup) await cleanupSkillFolder(entry, bundle)
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
  const stagingDirectories: string[] = []
  let internalStaging = false
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
  const stage = async (parent: string) => {
    await ensureDirectory(parent)
    const stagingDir = join(parent, `.artifactshare-staging-${randomUUID()}`)
    await mkdir(stagingDir, { mode: 0o700 })
    stagingDirectories.push(stagingDir)
    for (const [path, text] of Object.entries({
      ...files,
      [PENDING]: intent,
    })) {
      // Keep skill entry names out of every staging directory, including
      // nested references. Root-level UUID names cannot collide with bundle paths.
      const temp = join(
        stagingDir,
        basename(path) === 'SKILL.md' ? `${randomUUID()}.tmp` : path,
      )
      await mkdir(dirname(temp), { recursive: true })
      await writeFile(temp, text, { flag: 'wx' })
      staged.set(path, temp)
    }
  }
  const stageInside = async () => {
    internalStaging = true
    await stage(root)
  }
  const retire = async (path: string) => {
    if (backups.get(path) !== null) {
      await unlink(join(root, path))
      changed.add(path)
    }
  }
  const commit = async (path: string) => {
    await ensureDirectory(dirname(join(root, path)))
    try {
      await rename(staged.get(path)!, join(root, path))
    } catch (error) {
      if (internalStaging || (error as NodeJS.ErrnoException).code !== 'EXDEV')
        throw error
      // Restage known payloads on the destination filesystem, then retain the
      // same rename order and rollback bookkeeping. Never copy to live paths.
      await stageInside()
      await rename(staged.get(path)!, join(root, path))
    }
    changed.add(path)
  }
  try {
    try {
      await stage(dirname(root))
    } catch (error) {
      if (
        stagingDirectories.length !== 0 ||
        !['EACCES', 'EPERM', 'EROFS'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
      await stageInside()
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
    for (const dir of stagingDirectories)
      await rm(dir, { recursive: true, force: true })
    for (const dir of [...createdDirectories].reverse())
      await rmdir(dir).catch(() => {})
  }
}

export async function removeSkillFolder(
  entry: string,
  retainRoot = false,
  bundle?: SkillBundle,
) {
  const { root, previous } = await preflightFolder(
    entry,
    bundle,
    false,
    false,
    true,
  )
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

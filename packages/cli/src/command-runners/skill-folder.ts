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
} from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

export type ManagedState =
  | { kind: 'missing' | 'unmanaged' | 'broken' }
  | { kind: 'managed'; version: number }
export type SkillBundle = { files: Record<string, string>; version: number }
const MANIFEST = '.artifactshare-managed.json'
type Manifest = {
  schema_version: 1
  version: number
  files: Record<string, string>
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
// Resolve the configuration root, but never follow links in the skills tree.
async function rootFor(entry: string) {
  const config = dirname(dirname(dirname(entry)))
  const root = await realpath(config).catch(() => config)
  return join(root, 'skills', 'artifactshare')
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
        `Unsafe skill path (type change or link): ${parts[i]}. Inspect the path and reinstall the skill.`,
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
  return stateAt(await rootFor(entry))
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
): Promise<{ status: 'absent' | 'valid' | 'invalid'; manifest?: Manifest }> {
  try {
    const text = await textAt(root, MANIFEST)
    if (text === null) return { status: 'absent' }
    const value = JSON.parse(text) as Manifest
    if (
      state.kind !== 'managed' ||
      value.schema_version !== 1 ||
      value.version !== state.version ||
      !value.files ||
      typeof value.files !== 'object' ||
      Array.isArray(value.files) ||
      !Object.hasOwn(value.files, 'SKILL.md')
    )
      return { status: 'invalid' }
    const paths = Object.keys(value.files)
    if (
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
      !paths.every(
        (path) =>
          validPath(path) &&
          typeof value.files[path] === 'string' &&
          /^[a-f0-9]{64}$/.test(value.files[path]),
      )
    )
      return { status: 'invalid' }
    return { status: 'valid', manifest: value }
  } catch {
    return { status: 'invalid' }
  }
}
export async function folderDiagnostics(entry: string, bundle: SkillBundle) {
  const root = await rootFor(entry)
  const state = await stateAt(root)
  const owned = await ownership(root, state)
  const missing_files: string[] = [],
    different_files: string[] = [],
    modified_files: string[] = []
  for (const path of Object.keys(bundle.files).sort()) {
    const text = await bytesAt(root, path).catch(() => null)
    if (text === null) missing_files.push(path)
    else if (!text.equals(Buffer.from(bundle.files[path]!)))
      different_files.push(path)
  }
  if (owned.manifest)
    for (const path of Object.keys(owned.manifest.files).sort()) {
      const text = await bytesAt(root, path).catch(() => null)
      if (text === null || hash(text) !== owned.manifest.files[path])
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
    complete: missing_files.length === 0,
    current:
      state.kind === 'managed' &&
      state.version === bundle.version &&
      !missing_files.length &&
      !different_files.length &&
      owned.status === 'valid' &&
      manifestMatches,
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
) {
  const root = await rootFor(entry)
  const state = await stateAt(root)
  await safe(root, 'SKILL.md')
  const owned = await ownership(root, state)
  if (
    (owned.status === 'invalid' && !force) ||
    (!force && state.kind !== 'managed' && state.kind !== 'missing')
  )
    throw new Error(
      `Skill ownership conflict: ${join(root, state.kind === 'managed' ? MANIFEST : 'SKILL.md')} (${state.kind === 'managed' ? 'invalid ownership metadata' : 'user-edited file'}). Inspect the folder and use skills install --force to reinstall bundled paths.`,
    )
  const previous =
    owned.manifest?.files ??
    (state.kind === 'managed' ? { 'SKILL.md': '' } : {})
  await safe(root, MANIFEST)
  for (const path of Object.keys(previous)) await safe(root, path)
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
) {
  const { root, previous, blockers, replacedDirectories } =
    await preflightFolder(entry, bundle, force)
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
  ])) {
    const blocked = blockers.some((ancestor) => path.startsWith(`${ancestor}/`))
    backups.set(
      path,
      !blocked && (await info(join(root, path)))?.isFile()
        ? await readFile(join(root, path))
        : null,
    )
  }
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
    for (const [path, text] of Object.entries(files)) {
      const blocker = blockers.find((ancestor) =>
        path.startsWith(`${ancestor}/`),
      )
      const stagingDir = dirname(join(root, blocker ?? path))
      await ensureDirectory(stagingDir)
      const temp = join(stagingDir, `.artifactshare-${randomUUID()}.tmp`)
      staged.set(path, temp)
      await writeFile(temp, text, { flag: 'wx' })
    }
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
    await prune(root, retired)
  } catch (error) {
    // Undo new paths before restoring files that became directories (or vice versa).
    for (const path of [...changed].reverse()) {
      if ((await info(join(root, path)))?.isFile())
        await unlink(join(root, path))
    }
    for (const dir of [...createdDirectories].reverse())
      await rmdir(dir).catch(() => {})
    for (const dir of removedDirectories.reverse())
      await mkdir(dir, { recursive: true })
    for (const path of changed) {
      const bytes = backups.get(path)
      if (bytes !== null && bytes !== undefined) {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), bytes)
      }
    }
    throw error
  } finally {
    for (const path of staged.values()) await unlink(path).catch(() => {})
    for (const dir of [...createdDirectories].reverse())
      await rmdir(dir).catch(() => {})
  }
}

export async function removeSkillFolder(entry: string) {
  const { root, previous } = await preflightFolder(entry)
  for (const path of [...Object.keys(previous), MANIFEST])
    await unlink(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  await prune(root, Object.keys(previous))
  await rmdir(root).catch(() => {})
  await rmdir(dirname(root)).catch(() => {})
}

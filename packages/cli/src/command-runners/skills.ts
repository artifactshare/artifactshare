import {
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  CliError,
  DoctorSkillsData,
  OutputMode,
  ParsedArgs,
  SkillAutoUpdateData,
  SkillsActionData,
  SkillsListData,
  SkillsTargetAction,
} from '../types.js'
import {
  skillUpdateConflictError,
  unexpectedError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { arrayOption } from '../shared.js'
import { nonEmpty } from '../validators.js'
import { CLI_INVOCATION } from '../constants.js'

const SKILL_TOOLS = ['codex', 'claude', 'cursor'] as const
type SkillTool = (typeof SKILL_TOOLS)[number]
type SkillToolFilter = SkillTool | 'auto'
type SkillScope = 'project' | 'user'
type BundledSkillFile = 'SKILL.md' | 'artifactshare.mdc'

type ScopeTargetConfig = {
  relativePath: string
  bundledFile: BundledSkillFile
  // Directories created by install, innermost first; remove prunes them
  // when empty but never the tool root (.agents, .cursor, ...).
  pruneDirs: readonly string[]
}

type ToolConfig = {
  scopes: readonly SkillScope[]
  detectDirs: readonly string[]
}

const SKILL_FILE_PATH = join('skills', 'artifactshare', 'SKILL.md')
const TOOL_CONFIG: Record<SkillTool, ToolConfig> = {
  codex: {
    scopes: ['project', 'user'],
    detectDirs: ['.codex', '.agents'],
  },
  claude: {
    scopes: ['project', 'user'],
    detectDirs: ['.claude'],
  },
  cursor: {
    scopes: ['project', 'user'],
    detectDirs: ['.cursor'],
  },
}

function scopeTargetConfig(
  tool: SkillTool,
  scope: SkillScope,
): ScopeTargetConfig {
  if (tool === 'cursor') {
    if (scope === 'project') {
      return {
        relativePath: join('.cursor', 'rules', 'artifactshare.mdc'),
        bundledFile: 'artifactshare.mdc',
        pruneDirs: [],
      }
    }
    return {
      relativePath: join('.cursor', 'skills', 'artifactshare', 'SKILL.md'),
      bundledFile: 'SKILL.md',
      pruneDirs: ['artifactshare', 'skills'],
    }
  }
  const toolRoot = tool === 'codex' ? '.agents' : '.claude'
  return {
    relativePath: join(toolRoot, SKILL_FILE_PATH),
    bundledFile: 'SKILL.md',
    pruneDirs: ['artifactshare', 'skills'],
  }
}

type SkillTarget = {
  tool: SkillTool
  scope: SkillScope
  path: string
  absolutePath: string
}

type ManagedState =
  | { kind: 'missing' }
  | { kind: 'managed'; version: number }
  | { kind: 'unmanaged' }
  | { kind: 'broken' }

type BundledSkills = {
  contentsByFile: Record<BundledSkillFile, string>
  version: number
}

function skillTarget(tool: SkillTool, scope: SkillScope): SkillTarget {
  const relative = scopeTargetConfig(tool, scope).relativePath
  const path = scope === 'project' ? relative : join(homedir(), relative)
  return { tool, scope, path, absolutePath: resolve(path) }
}

function bundledContentForTarget(
  bundled: BundledSkills,
  target: SkillTarget,
): string {
  const file = scopeTargetConfig(target.tool, target.scope).bundledFile
  return bundled.contentsByFile[file]
}

function allTargets(): SkillTarget[] {
  return SKILL_TOOLS.flatMap((tool) =>
    TOOL_CONFIG[tool].scopes.map((scope) => skillTarget(tool, scope)),
  )
}

function managedState(content: string | null): ManagedState {
  if (content === null) return { kind: 'missing' }
  // A half-broken marker (e.g. lost "-->") must surface as a conflict, not
  // pass as an unmanaged file, so the marker name is checked separately.
  if (!content.includes('artifactshare-skill')) return { kind: 'unmanaged' }
  const block = content.match(/<!--\s*artifactshare-skill([\s\S]*?)-->/)?.[1]
  const version = block?.match(/(?:^|\n)\s*version:\s*(\d+)\s*(?:\n|$)/)?.[1]
  const managed =
    block !== undefined && /(?:^|\n)\s*managed:\s*true\s*(?:\n|$)/.test(block)
  if (version === undefined || !managed) return { kind: 'broken' }
  return { kind: 'managed', version: Number(version) }
}

async function readTarget(target: SkillTarget): Promise<ManagedState> {
  const content = await readFile(target.absolutePath, 'utf8').catch(() => null)
  return managedState(content)
}

async function loadBundledSkills(): Promise<BundledSkills> {
  const contentsByFile = {} as Record<BundledSkillFile, string>
  let version: number | undefined
  for (const file of ['SKILL.md', 'artifactshare.mdc'] as const) {
    const url = new URL(`../skills/artifactshare/${file}`, import.meta.url)
    const content = await readFile(url, 'utf8')
    const state = managedState(content)
    if (
      state.kind !== 'managed' ||
      (version ?? state.version) !== state.version
    ) {
      throw new Error(
        `The bundled ${file} has a missing or mismatched managed marker.`,
      )
    }
    version = state.version
    contentsByFile[file] = content
  }
  return { contentsByFile, version: version as number }
}

function parseTools(
  value: string | string[] | undefined,
  options: { allowAuto?: boolean } = {},
): { tools: SkillTool[]; auto: boolean; error?: never } | { error: CliError } {
  const raws = arrayOption(value)
  const tools: SkillToolFilter[] = []
  for (const raw of raws) {
    for (const item of raw.split(',')) {
      const trimmed = item.trim() as SkillToolFilter
      if (!trimmed) continue
      if (trimmed === 'auto') {
        if (!options.allowAuto) {
          return {
            error: validationError(
              `Unknown --tool value: ${trimmed}`,
              'Pass --tool codex, --tool claude, or --tool cursor.',
            ),
          }
        }
        tools.push(trimmed)
        continue
      }
      if (!SKILL_TOOLS.includes(trimmed)) {
        return {
          error: validationError(
            `Unknown --tool value: ${trimmed}`,
            'Pass --tool codex, --tool claude, or --tool cursor.',
          ),
        }
      }
      tools.push(trimmed)
    }
  }
  // A blank --tool must not silently widen update/remove to every target.
  if (raws.length > 0 && tools.length === 0) {
    return {
      error: validationError(
        '--tool has no value.',
        'Pass --tool codex, --tool claude, or --tool cursor.',
      ),
    }
  }
  const unique = [...new Set(tools)]
  const auto = unique.includes('auto')
  if (auto && unique.length > 1) {
    return {
      error: validationError(
        '--tool auto cannot be combined with explicit tools.',
        'Pass --tool auto by itself, or pass --tool codex, --tool claude, or --tool cursor.',
      ),
    }
  }
  return {
    tools: unique.filter((tool): tool is SkillTool => tool !== 'auto'),
    auto,
  }
}

function parseScope(
  value: string | undefined,
): { scope: SkillScope | undefined; error?: never } | { error: CliError } {
  const trimmed = nonEmpty(value)
  if (trimmed === undefined) return { scope: undefined }
  if (trimmed === 'project' || trimmed === 'user') return { scope: trimmed }
  return {
    error: validationError(
      `Unknown --scope value: ${trimmed}`,
      'Pass --scope project or --scope user.',
    ),
  }
}

function parseFilters(
  parsed: ParsedArgs,
  options: { allowAuto?: boolean } = {},
):
  | {
      tools: SkillTool[]
      auto: boolean
      scope: SkillScope | undefined
      error?: never
    }
  | { error: CliError } {
  const tools = parseTools(parsed.options.tool, options)
  if (tools.error) return { error: tools.error }
  const scope = parseScope(parsed.options.scope)
  if (scope.error) return { error: scope.error }
  if (tools.auto && scope.scope === 'project') {
    return {
      error: validationError(
        '--tool auto does not support project scope.',
        'Use --tool auto --scope user, or pass an explicit --tool for project scope.',
      ),
    }
  }
  const unsupported =
    scope.scope === undefined
      ? undefined
      : tools.tools.find(
          (tool) =>
            !TOOL_CONFIG[tool].scopes.includes(scope.scope as SkillScope),
        )
  if (unsupported) {
    return {
      error: validationError(
        `The ${unsupported} tool does not support --scope ${scope.scope}.`,
        `Use --tool ${unsupported} --scope project.`,
      ),
    }
  }
  return { tools: tools.tools, auto: tools.auto, scope: scope.scope }
}

function filteredTargets(
  tools: SkillTool[],
  scope: SkillScope | undefined,
): SkillTarget[] {
  return allTargets().filter(
    (target) =>
      (tools.length === 0 || tools.includes(target.tool)) &&
      (scope === undefined || target.scope === scope),
  )
}

function detectionBase(scope: SkillScope): string {
  return scope === 'project' ? process.cwd() : homedir()
}

async function isToolDetected(
  tool: SkillTool,
  scope: SkillScope,
): Promise<boolean> {
  const base = detectionBase(scope)
  for (const dir of TOOL_CONFIG[tool].detectDirs) {
    const info = await stat(join(base, dir)).catch(() => null)
    if (info?.isDirectory()) return true
  }
  return false
}

async function autoDetectedTools(): Promise<SkillTool[]> {
  const autoOrder: readonly SkillTool[] = ['claude', 'codex', 'cursor']
  const detected: SkillTool[] = []
  for (const tool of autoOrder) {
    if (await isToolDetected(tool, 'project')) {
      detected.push(tool)
    }
  }
  return detected.length > 0 ? detected : ['codex', 'claude', 'cursor']
}

async function autoTargets(
  scope: SkillScope | undefined,
): Promise<SkillTarget[]> {
  const targetScope = scope ?? 'user'
  const tools = await autoDetectedTools()
  return tools
    .filter((tool) => TOOL_CONFIG[tool].scopes.includes(targetScope))
    .map((tool) => skillTarget(tool, targetScope))
}

type PlannedAction = {
  target: SkillTarget
  action: SkillsTargetAction
  content?: string
  fallbackAction?: SkillsTargetAction
  installedVersion?: number
}

function targetPathKey(target: SkillTarget): Promise<string> {
  return realpath(target.absolutePath).catch(() => target.absolutePath)
}

async function applyAction({
  target,
  action,
  content,
}: PlannedAction): Promise<void> {
  if (content !== undefined) {
    await mkdir(dirname(target.absolutePath), { recursive: true })
    await writeFile(target.absolutePath, content)
    return
  }
  if (action === 'removed') {
    await rm(target.absolutePath, { force: true })
    await cleanupSkillDirs(target)
  }
}

async function cleanupSkillDirs(target: SkillTarget): Promise<void> {
  let dir = dirname(target.absolutePath)
  for (const expected of scopeTargetConfig(target.tool, target.scope)
    .pruneDirs) {
    if (basename(dir) !== expected) return
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

function skillUpdateCommand(target: SkillTarget): string {
  return `${CLI_INVOCATION} skills update --tool ${target.tool} --scope ${target.scope} --json`
}

async function finishActions(
  command:
    | 'skills install'
    | 'skills update'
    | 'skills remove'
    | 'skills ensure'
    | 'open'
    | 'init',
  planned: PlannedAction[],
  dryRun: boolean,
  mode: OutputMode,
): Promise<SkillsActionData | undefined> {
  const completed = [...planned]
  if (!dryRun) {
    for (const [index, item] of planned.entries()) {
      try {
        await applyAction(item)
        completed[index] = item
      } catch (error) {
        if (item.fallbackAction) {
          completed[index] = {
            target: item.target,
            action: item.fallbackAction,
          }
          continue
        }
        writeFailure(command, unexpectedError(error), mode, 1)
        return undefined
      }
    }
  }
  const data: SkillsActionData = {
    dry_run: dryRun,
    targets: completed.map(({ target, action }) => ({
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      action,
      ...(action === 'update_recommended'
        ? { update_command: skillUpdateCommand(target) }
        : {}),
    })),
  }
  return data
}

async function runActions(
  command:
    | 'skills install'
    | 'skills update'
    | 'skills remove'
    | 'skills ensure',
  planned: PlannedAction[],
  dryRun: boolean,
  mode: OutputMode,
): Promise<void> {
  const data = await finishActions(command, planned, dryRun, mode)
  if (data) writeSuccess(command, data, mode)
}

async function bundledOrFailure(
  command:
    | 'skills install'
    | 'skills list'
    | 'skills update'
    | 'skills ensure'
    | 'open'
    | 'init',
  mode: OutputMode,
): Promise<BundledSkills | undefined> {
  try {
    return await loadBundledSkills()
  } catch (error) {
    writeFailure(command, unexpectedError(error), mode, 1)
    return undefined
  }
}

export async function runSkillsInstall(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'skills install'
  const filters = parseFilters(parsed)
  if (filters.error) return writeFailure(command, filters.error, mode, 1)
  const { tools } = filters
  if (tools.length === 0) {
    return writeFailure(
      command,
      validationError(
        '--tool is required.',
        'Pass --tool codex, --tool claude, or --tool cursor; repeat for multiple tools.',
      ),
      mode,
      1,
    )
  }
  const scope = filters.scope ?? 'project'
  const force = parsed.options.force === true
  const bundled = await bundledOrFailure(command, mode)
  if (!bundled) return

  const planned: PlannedAction[] = []
  for (const tool of tools) {
    const target = skillTarget(tool, scope)
    const state = await readTarget(target)
    if ((state.kind === 'unmanaged' || state.kind === 'broken') && !force) {
      return writeFailure(
        command,
        skillUpdateConflictError(target.path),
        mode,
        1,
      )
    }
    const unchanged =
      state.kind === 'managed' && state.version === bundled.version && !force
    if (unchanged) {
      planned.push({ target, action: 'unchanged' })
      continue
    }
    planned.push({
      target,
      action: state.kind === 'missing' ? 'installed' : 'updated',
      content: bundledContentForTarget(bundled, target),
    })
  }
  await runActions(command, planned, parsed.options.dryRun === true, mode)
}

export async function ensureSkills(
  parsed: ParsedArgs,
  mode: OutputMode,
  options: {
    command?: 'skills ensure' | 'open' | 'init'
    autoUpdateUserManaged?: boolean
    skipBrokenUserSkills?: boolean
  } = {},
): Promise<SkillsActionData | undefined> {
  const command = options.command ?? 'skills ensure'
  const filters = parseFilters(parsed, { allowAuto: true })
  if (filters.error) {
    writeFailure(command, filters.error, mode, 1)
    return undefined
  }
  if (filters.tools.length === 0 && !filters.auto) {
    writeFailure(
      command,
      validationError(
        '--tool is required.',
        'Pass --tool auto, --tool codex, --tool claude, or --tool cursor; repeat explicit tools for multiple targets.',
      ),
      mode,
      1,
    )
    return undefined
  }
  const bundled = await bundledOrFailure(command, mode)
  if (!bundled) return undefined

  const targets = filters.auto
    ? await autoTargets(filters.scope)
    : filteredTargets(filters.tools, filters.scope ?? 'project')
  const planned: PlannedAction[] = []
  for (const target of targets) {
    const state = await readTarget(target)
    if (state.kind === 'unmanaged' || state.kind === 'broken') {
      if (options.skipBrokenUserSkills && state.kind === 'broken') {
        continue
      }
      writeFailure(command, skillUpdateConflictError(target.path), mode, 1)
      return undefined
    }
    const unchanged =
      state.kind === 'managed' && state.version === bundled.version
    planned.push(
      unchanged
        ? { target, action: 'unchanged' }
        : {
            target,
            action: state.kind === 'missing' ? 'installed' : 'updated',
            content: bundledContentForTarget(bundled, target),
          },
    )
  }
  if (options.autoUpdateUserManaged) {
    const plannedPaths = new Set(
      await Promise.all(planned.map((action) => targetPathKey(action.target))),
    )
    for (const target of allTargets().filter(
      (candidate) => candidate.scope === 'user',
    )) {
      if (plannedPaths.has(await targetPathKey(target))) continue
      const state = await readTarget(target)
      if (state.kind !== 'managed' || state.version === bundled.version) {
        continue
      }
      planned.push({
        target,
        action: 'updated',
        content: bundledContentForTarget(bundled, target),
        fallbackAction: 'update_recommended',
      })
    }
  }
  return finishActions(command, planned, parsed.options.dryRun === true, mode)
}

export async function autoUpdateUserManagedSkills(): Promise<
  SkillAutoUpdateData | undefined
> {
  try {
    const bundled = await loadBundledSkills()
    const planned: PlannedAction[] = []
    for (const target of allTargets().filter(
      (candidate) => candidate.scope === 'user',
    )) {
      const state = await readTarget(target)
      if (state.kind !== 'managed' || state.version >= bundled.version) {
        continue
      }
      planned.push({
        target,
        action: 'updated',
        content: bundledContentForTarget(bundled, target),
        fallbackAction: 'update_recommended',
        installedVersion: state.version,
      })
    }

    if (planned.length === 0) return undefined

    const completed = [...planned]
    for (const [index, item] of planned.entries()) {
      try {
        await applyAction(item)
        completed[index] = item
      } catch {
        completed[index] = {
          target: item.target,
          action: 'update_recommended',
          ...(item.installedVersion !== undefined
            ? { installedVersion: item.installedVersion }
            : {}),
        }
      }
    }

    return {
      targets: completed.map(({ target, action, installedVersion }) => ({
        tool: target.tool,
        scope: 'user',
        path: target.path,
        action: action === 'updated' ? 'updated' : 'update_recommended',
        installed_version: installedVersion ?? bundled.version,
        bundled_version: bundled.version,
        ...(action === 'update_recommended'
          ? { update_command: skillUpdateCommand(target) }
          : {}),
      })),
    }
  } catch {
    return undefined
  }
}

export async function runSkillsEnsure(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const data = await ensureSkills(parsed, mode)
  if (data) writeSuccess('skills ensure', data, mode)
}

export async function runSkillsList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const bundled = await bundledOrFailure('skills list', mode)
  if (!bundled) return
  const targets = []
  for (const target of allTargets()) {
    const state = await readTarget(target)
    targets.push({
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      detected: await isToolDetected(target.tool, target.scope),
      installed: state.kind !== 'missing',
      managed: state.kind === 'managed',
      installed_version: state.kind === 'managed' ? state.version : null,
      update_available:
        state.kind === 'managed' && state.version !== bundled.version,
    })
  }
  const data: SkillsListData = { bundled_version: bundled.version, targets }
  return writeSuccess('skills list', data, mode)
}

export async function skillDiagnostics(): Promise<DoctorSkillsData> {
  const bundled = await loadBundledSkills()
  const targets = []
  for (const target of allTargets()) {
    const state = await readTarget(target)
    const updateAvailable =
      state.kind === 'managed' && state.version !== bundled.version
    targets.push({
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      installed: state.kind !== 'missing',
      managed: state.kind === 'managed',
      installed_version: state.kind === 'managed' ? state.version : null,
      update_available: updateAvailable,
      update_command: updateAvailable ? skillUpdateCommand(target) : null,
    })
  }
  const updateTargets = targets.filter((target) => target.update_available)
  return {
    bundled_version: bundled.version,
    update_available: updateTargets.length > 0,
    update_command:
      updateTargets.length > 0
        ? `${CLI_INVOCATION} skills update --json`
        : null,
    targets,
  }
}

export async function runSkillsUpdate(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'skills update'
  const filters = parseFilters(parsed)
  if (filters.error) return writeFailure(command, filters.error, mode, 1)
  const force = parsed.options.force === true
  const bundled = await bundledOrFailure(command, mode)
  if (!bundled) return

  const planned: PlannedAction[] = []
  for (const target of filteredTargets(filters.tools, filters.scope)) {
    const state = await readTarget(target)
    if (state.kind === 'broken') {
      return writeFailure(
        command,
        skillUpdateConflictError(target.path),
        mode,
        1,
      )
    }
    if (state.kind === 'missing') {
      planned.push({ target, action: 'not_installed' })
    } else if (state.kind === 'unmanaged') {
      planned.push({ target, action: 'skipped_unmanaged' })
    } else if (state.version !== bundled.version || force) {
      planned.push({
        target,
        action: 'updated',
        content: bundledContentForTarget(bundled, target),
      })
    } else {
      planned.push({ target, action: 'unchanged' })
    }
  }
  await runActions(command, planned, parsed.options.dryRun === true, mode)
}

export async function runSkillsRemove(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'skills remove'
  const filters = parseFilters(parsed)
  if (filters.error) return writeFailure(command, filters.error, mode, 1)

  const planned: PlannedAction[] = []
  for (const target of filteredTargets(filters.tools, filters.scope)) {
    const state = await readTarget(target)
    const action: SkillsTargetAction =
      state.kind === 'missing'
        ? 'not_installed'
        : state.kind === 'managed'
          ? 'removed'
          : 'skipped_unmanaged'
    planned.push({ target, action })
  }
  await runActions(command, planned, parsed.options.dryRun === true, mode)
}

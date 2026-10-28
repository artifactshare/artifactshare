import { readFile, stat, lstat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  resolveSkillFolder,
  cleanupSkillFolder,
  isUnownedFolder,
  managedState,
  readSkillState,
  loadSkillBundle,
  folderDiagnostics,
  preflightFolder,
  writeSkillFolder,
  removeSkillFolder,
  type SkillBundle,
  type ManagedState,
} from './skill-folder.js'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

type ScopeTargetConfig = {
  relativePath: string
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
  _scope: SkillScope,
): ScopeTargetConfig {
  const toolRoot =
    tool === 'codex' ? '.agents' : tool === 'cursor' ? '.cursor' : '.claude'
  return {
    relativePath: join(toolRoot, SKILL_FILE_PATH),
    pruneDirs: ['artifactshare', 'skills'],
  }
}

type SkillAlias = {
  tool: string
  scope: string
  path: string | null
  folder_path: string | null
}
function aliases(target: ResolvedSkillTarget): SkillAlias[] {
  return (
    ('aliases' in target && target.aliases) || [
      {
        tool: target.tool,
        scope: target.scope,
        path: target.path,
        folder_path: target.path === null ? null : dirname(target.path),
      },
    ]
  )
}
function identity(target: ResolvedSkillTarget) {
  return {
    aliases: aliases(target),
    resolved_folder_path:
      'resolved_folder_path' in target
        ? (target.resolved_folder_path ?? null)
        : null,
  }
}
function targetOrder(a: SkillAlias, b: SkillAlias) {
  return (
    SKILL_TOOLS.indexOf(a.tool as SkillTool) -
      SKILL_TOOLS.indexOf(b.tool as SkillTool) ||
    (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1)
  )
}
async function cleanupTarget(target: SkillTarget, bundled: BundledSkills) {
  if (target.cleaned) return
  await cleanupSkillFolder(target.absolutePath, bundled)
  target.cleaned = true
}
async function groupTargets<T extends ResolvedSkillTarget>(
  targets: T[],
): Promise<T[]> {
  const groups = new Map<string, T>()
  const result: T[] = []
  for (const target of [...targets].sort((a, b) =>
    targetOrder(aliases(a)[0]!, aliases(b)[0]!),
  )) {
    if (!availableTarget(target)) {
      result.push(target)
      continue
    }
    const key = await resolveSkillFolder(target.absolutePath).catch(() => null)
    target.resolved_folder_path = key
    const existing = key === null ? undefined : groups.get(key)
    if (existing && availableTarget(existing))
      existing.aliases = [...aliases(existing), ...aliases(target)]
    else {
      target.aliases = aliases(target)
      result.push(target)
      if (key !== null) groups.set(key, target)
    }
  }
  return result
}
async function conflictFor(target: SkillTarget, removing = false) {
  const error = skillUpdateConflictError(target.path)
  try {
    await preflightFolder(
      target.absolutePath,
      await loadBundledSkills(),
      false,
      false,
      removing,
    )
  } catch (cause) {
    error.hint = (cause as Error).message
  }
  return error
}
type SkillTarget = {
  tool: SkillTool
  scope: SkillScope
  path: string
  absolutePath: string
  cleaned?: boolean
  aliases?: SkillAlias[]
  resolved_folder_path?: string | null
}

type UnavailableSkillTarget = {
  tool: SkillTool
  scope: SkillScope
  path: null
  error: CliError
}
type ResolvedSkillTarget = SkillTarget | UnavailableSkillTarget

const CLAUDE_CONFIG_HINT =
  'Set CLAUDE_CONFIG_DIR to a non-empty path or unset it to use ~/.claude.'

function claudeUserRoot():
  | { state: 'unset' | 'set'; path: string }
  | { state: 'blank'; path: undefined } {
  const value = process.env.CLAUDE_CONFIG_DIR
  if (value === undefined) {
    return { state: 'unset', path: join(homedir(), '.claude') }
  }
  return value.trim()
    ? { state: 'set', path: resolve(value) }
    : { state: 'blank', path: undefined }
}

function availableTarget(target: ResolvedSkillTarget): target is SkillTarget {
  return target.path !== null
}

function unavailableState(target: UnavailableSkillTarget) {
  return {
    ...identity(target),
    tool: target.tool,
    scope: target.scope,
    path: null,
    available: false as const,
    code: target.error.code,
    hint: target.error.hint,
    installed: false,
    managed: false,
    installed_version: null,
    update_available: false,
    folder_path: null,
    complete: false,
    current: false,
    older_version: false,
    missing_files: [],
    different_files: [],
    modified_files: [],
    ownership_manifest: 'absent' as const,
  }
}

function unavailableActionTargets(tools: SkillTool[], scope?: SkillScope) {
  return allTargets().filter(
    (target): target is UnavailableSkillTarget =>
      !availableTarget(target) &&
      (tools.length === 0 || tools.includes(target.tool)) &&
      scope !== 'project',
  )
}

function unavailableSelection(
  tools: SkillTool[],
  scope: SkillScope | undefined,
): CliError | undefined {
  if (!tools.includes('claude') || scope !== 'user') return undefined
  const target = skillTarget('claude', 'user')
  return availableTarget(target) ? undefined : target.error
}

type BundledSkills = SkillBundle

function skillTarget(tool: SkillTool, scope: SkillScope): ResolvedSkillTarget {
  if (tool === 'claude' && scope === 'user') {
    const root = claudeUserRoot()
    if (root.state === 'blank') {
      return {
        tool,
        scope,
        path: null,
        error: validationError(
          'Claude Code user skills are unavailable because CLAUDE_CONFIG_DIR is empty or whitespace-only.',
          CLAUDE_CONFIG_HINT,
        ),
      }
    }
    const path = join(root.path, SKILL_FILE_PATH)
    return { tool, scope, path, absolutePath: path }
  }
  const relative = scopeTargetConfig(tool, scope).relativePath
  const path = scope === 'project' ? relative : join(homedir(), relative)
  return { tool, scope, path, absolutePath: resolve(path) }
}

function allTargets(): ResolvedSkillTarget[] {
  return SKILL_TOOLS.flatMap((tool) =>
    TOOL_CONFIG[tool].scopes.map((scope) => skillTarget(tool, scope)),
  )
}

function readTarget(target: SkillTarget) {
  return readSkillState(target.absolutePath)
}
function loadBundledSkills(): Promise<BundledSkills> {
  return loadSkillBundle(
    fileURLToPath(new URL('../skills/artifactshare/', import.meta.url)),
  )
}
function cursorProjectAlias(target: SkillTarget) {
  return aliases(target).find(
    (alias) => alias.tool === 'cursor' && alias.scope === 'project',
  )
}
async function legacyRule(target: SkillTarget) {
  const cursor = cursorProjectAlias(target)
  if (!cursor) return undefined
  const path = join('.cursor', 'rules', 'artifactshare.mdc')
  const info = await lstat(path).catch(() => null)
  const parent = await lstat(dirname(path)).catch(() => null)
  const content =
    info?.isFile() && !parent?.isSymbolicLink()
      ? await readFile(path, 'utf8').catch(() => null)
      : null
  const present = info !== null
  const managed = managedState(content).kind === 'managed'
  const coexistence =
    present && (await lstat(resolve(cursor.path!)).catch(() => null)) !== null
  return {
    path,
    present,
    managed,
    coexistence,
    hint:
      present && !managed
        ? 'Inspect the legacy Cursor rule and manually remove it if the skill folder replaces it.'
        : null,
  }
}
async function legacyManagedVersion(
  target: SkillTarget,
): Promise<number | undefined> {
  const legacy = await legacyRule(target)
  if (!legacy?.managed) return undefined
  const state = managedState(await readFile(legacy.path, 'utf8'))
  return state.kind === 'managed' ? state.version : undefined
}
function isNewer(
  state: ManagedState,
  bundle: BundledSkills,
): state is ManagedState & { kind: 'managed'; version: number } {
  return state.kind === 'managed' && state.version > bundle.version
}
function newerCliHint(installed: number, bundled: number) {
  return `A newer CLI installed skill version ${installed}; this CLI bundles version ${bundled}. Keeping the installed version. Use --force only for an intentional downgrade.`
}
function downgradeHint(installed: number, bundled: number) {
  return `Intentional downgrade from skill version ${installed} to bundled version ${bundled}.`
}
async function diagnostic(target: SkillTarget, bundle: BundledSkills) {
  const legacy = await legacyRule(target)
  const state = await readTarget(target)
  const details = await folderDiagnostics(
    target.absolutePath,
    bundle,
    legacy?.managed,
  )
  return {
    ...details,
    folder_path: dirname(target.path),
    ...(isNewer(state, bundle)
      ? {
          hint: [details.hint, newerCliHint(state.version, bundle.version)]
            .filter(Boolean)
            .join(' '),
        }
      : {}),
    ...(legacy ? { legacy_rule: legacy } : {}),
  }
}
async function isCurrent(target: SkillTarget, bundle: BundledSkills) {
  return (await folderDiagnostics(target.absolutePath, bundle)).current
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
  return allTargets()
    .filter(availableTarget)
    .filter(
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
  if (tool === 'claude' && scope === 'user') {
    const root = claudeUserRoot()
    return (
      root.state !== 'blank' &&
      Boolean((await stat(root.path).catch(() => null))?.isDirectory())
    )
  }
  const base = detectionBase(scope)
  for (const dir of TOOL_CONFIG[tool].detectDirs) {
    const info = await stat(join(base, dir)).catch(() => null)
    if (info?.isDirectory()) return true
  }
  return false
}

async function autoDetectedTools(): Promise<{
  tools: SkillTool[]
  fallback: boolean
}> {
  const autoOrder: readonly SkillTool[] = ['claude', 'codex', 'cursor']
  const detected: SkillTool[] = []
  for (const tool of autoOrder) {
    if (await isToolDetected(tool, 'project')) detected.push(tool)
  }
  if (detected.length === 0) {
    return { tools: ['codex', 'claude', 'cursor'], fallback: true }
  }
  if (
    !detected.includes('claude') &&
    claudeUserRoot().state === 'set' &&
    (await isToolDetected('claude', 'user'))
  ) {
    detected.unshift('claude')
  }
  return { tools: detected, fallback: false }
}

async function autoTargets(
  scope: SkillScope | undefined,
): Promise<{ targets: SkillTarget[]; fallback: boolean }> {
  const targetScope = scope ?? 'user'
  const { tools, fallback } = await autoDetectedTools()
  const targets = tools
    .filter((tool) => TOOL_CONFIG[tool].scopes.includes(targetScope))
    .map((tool) => skillTarget(tool, targetScope))
    .filter(availableTarget)
  return { targets, fallback }
}

type PlannedAction = {
  target: SkillTarget
  action: SkillsTargetAction
  content?: BundledSkills
  force?: boolean
  forceRetirement?: boolean
  automatic?: boolean
  removeLegacy?: boolean
  legacy?: {
    path: string
    action: 'removed' | 'would_remove' | 'kept_unmanaged' | 'remove_failed'
    hint?: string
  }
  fallbackAction?: SkillsTargetAction
  hint?: string
  installedVersion?: number | null
  preserve?: boolean
}

function targetPathKey(target: SkillTarget): Promise<string> {
  return resolveSkillFolder(target.absolutePath).catch(
    () => target.absolutePath,
  )
}

async function prepareAction(item: PlannedAction, dryRun: boolean) {
  if (item.preserve || item.action === 'failed') return
  if (!dryRun && (item.content || item.action === 'unchanged'))
    await cleanupTarget(
      item.target,
      item.content ?? (await loadBundledSkills()),
    )
  if (item.content) {
    if (item.automatic) {
      const details = await diagnostic(item.target, item.content)
      if (details.modified_files.length)
        throw new Error(
          `Modified skill files: ${details.modified_files.join(', ')}`,
        )
    }
    await preflightFolder(
      item.target.absolutePath,
      item.content,
      item.force,
      item.forceRetirement,
    )
  }
  if (item.action === 'removed')
    await preflightFolder(
      item.target.absolutePath,
      await loadBundledSkills(),
      false,
      false,
      true,
    )
  const legacy = await legacyRule(item.target)
  if (
    legacy?.managed &&
    item.action === 'unchanged' &&
    !(await isCurrent(item.target, await loadBundledSkills()))
  ) {
    item.action = 'update_recommended'
    return
  }
  if (legacy?.present) {
    if (!legacy.managed)
      item.legacy = {
        path: legacy.path,
        action: 'kept_unmanaged',
        hint: legacy.hint ?? 'Inspect the legacy rule.',
      }
    else if (
      item.content ||
      item.action === 'unchanged' ||
      item.action === 'removed' ||
      item.action === 'not_installed' ||
      item.removeLegacy
    )
      item.legacy = {
        path: legacy.path,
        action: dryRun ? 'would_remove' : 'removed',
      }
  }
}
async function applyAction(item: PlannedAction): Promise<void> {
  if (item.preserve || item.action === 'failed') return
  if (item.content)
    await writeSkillFolder(
      item.target.absolutePath,
      item.content,
      item.force,
      item.forceRetirement,
      false,
    )
  if (item.action === 'removed')
    await removeSkillFolder(
      item.target.absolutePath,
      aliases(item.target).length > 1,
      await loadBundledSkills(),
    )
  if (item.legacy?.action === 'removed') {
    try {
      await unlink(item.legacy.path)
    } catch {
      item.legacy = {
        path: item.legacy.path,
        action: 'remove_failed',
        hint: 'Retry skills update --tool cursor --scope project --json to remove the legacy rule.',
      }
    }
  }
}

function skillUpdateCommand(target: SkillTarget): string {
  return `${CLI_INVOCATION} skills update --tool ${target.tool} --scope ${target.scope} --json`
}

async function recoveryRecommendation(
  target: SkillTarget,
  bundled: BundledSkills,
): Promise<{
  update_command?: string
  modified_files?: string[]
  hint?: string
}> {
  const state = await readTarget(target)
  const details = await diagnostic(target, bundled)
  if (await isUnownedFolder(target.absolutePath, details.legacy_rule?.managed))
    return {}
  if (isNewer(state, bundled))
    return {
      hint: details.hint ?? newerCliHint(state.version, bundled.version),
    }
  let update_command = skillUpdateCommand(target)
  try {
    await preflightFolder(target.absolutePath, bundled)
  } catch {
    try {
      await preflightFolder(target.absolutePath, bundled, false, true)
      update_command = update_command.replace(' --json', ' --force --json')
    } catch {
      try {
        await preflightFolder(target.absolutePath, bundled, true)
        update_command = `${CLI_INVOCATION} skills install --tool ${target.tool} --scope ${target.scope} --force --json`
      } catch (error) {
        return {
          hint: (error as Error).message,
          ...(details.modified_files.length
            ? { modified_files: details.modified_files }
            : {}),
        }
      }
    }
  }
  return {
    update_command,
    ...(details.modified_files.length
      ? {
          modified_files: details.modified_files,
          hint: `Modified skill files: ${details.modified_files.join(', ')}. Preserve your edits before running the recommended command.`,
        }
      : {}),
  }
}

async function skipAutomaticTarget(target: SkillTarget, state: ManagedState) {
  if ((await legacyManagedVersion(target)) !== undefined) return false
  if (state.kind === 'unmanaged') return true
  return (
    state.kind === 'missing' &&
    !(await lstat(
      join(dirname(target.absolutePath), '.artifactshare-pending.json'),
    ).catch(() => null))
  )
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
  planned.sort((a, b) =>
    targetOrder(aliases(a.target)[0]!, aliases(b.target)[0]!),
  )
  for (const item of planned) {
    try {
      await prepareAction(item, dryRun)
    } catch (error) {
      if (item.fallbackAction) {
        item.hint = (error as Error).message
        item.action = item.fallbackAction
        delete item.content
        delete item.legacy
        continue
      }
      const conflict = skillUpdateConflictError(item.target.path)
      if (error instanceof Error) conflict.hint = error.message
      writeFailure(command, conflict, mode, 1)
      return undefined
    }
  }
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
            hint: (error as Error).message,
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
    targets: await Promise.all(
      completed.map(async ({ target, action, legacy, hint }) => ({
        ...(hint ? { hint } : {}),
        tool: target.tool,
        scope: target.scope,
        path: target.path,
        ...identity(target),
        folder_path: dirname(target.path),
        ...(legacy ? { legacy_rule: legacy } : {}),
        action,
        ...(action === 'failed' ? { code: 'skill_update_conflict' } : {}),
        ...(action === 'update_recommended'
          ? await recoveryRecommendation(target, await loadBundledSkills())
          : {}),
      })),
    ),
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
  unavailableTargets: UnavailableSkillTarget[] = [],
): Promise<void> {
  const data = await finishActions(command, planned, dryRun, mode)
  if (data) {
    data.targets.push(
      ...unavailableTargets.map((target) => ({
        tool: target.tool,
        scope: target.scope,
        path: null,
        ...identity(target),
        folder_path: null,
        action: 'skipped' as const,
        code: target.error.code,
        hint: target.error.hint,
      })),
    )
    writeSuccess(command, data, mode)
    if (data.targets.some((target) => target.action === 'failed'))
      process.exitCode = 1
  }
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
  for (const target of await groupTargets(
    allTargets().filter(
      (candidate) =>
        tools.includes(candidate.tool) && candidate.scope === scope,
    ),
  )) {
    if (!availableTarget(target))
      return writeFailure(command, target.error, mode, 1)
    const state = await readTarget(target)
    if ((state.kind === 'unmanaged' || state.kind === 'broken') && !force) {
      return writeFailure(command, await conflictFor(target), mode, 1)
    }
    if (isNewer(state, bundled) && !force) {
      planned.push({
        target,
        action: 'unchanged',
        preserve: true,
        hint: newerCliHint(state.version, bundled.version),
      })
      continue
    }
    const details = await diagnostic(target, bundled)
    if (details.code === 'skill_update_conflict') {
      const conflict = skillUpdateConflictError(target.path)
      conflict.hint = details.hint ?? conflict.hint
      return writeFailure(command, conflict, mode, 1)
    }
    const unchanged = state.kind === 'managed' && details.current && !force
    if (unchanged) {
      planned.push({ target, action: 'unchanged' })
      continue
    }
    planned.push({
      target,
      action: state.kind === 'missing' ? 'installed' : 'updated',
      content: bundled,
      force,
      ...(isNewer(state, bundled)
        ? { hint: downgradeHint(state.version, bundled.version) }
        : {}),
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
  const unavailable = unavailableSelection(
    filters.tools,
    filters.scope ?? 'project',
  )
  if (unavailable) {
    writeFailure(command, unavailable, mode, 1)
    return undefined
  }
  const bundled = await bundledOrFailure(command, mode)
  if (!bundled) return undefined

  const automatic = filters.auto ? await autoTargets(filters.scope) : undefined
  const targets =
    automatic?.targets ??
    filteredTargets(filters.tools, filters.scope ?? 'project')
  const planned: PlannedAction[] = []
  for (const target of await groupTargets(targets)) {
    const state = await readTarget(target)
    if (
      filters.auto &&
      command === 'skills ensure' &&
      state.kind === 'broken'
    ) {
      const details = await diagnostic(target, bundled)
      if (details.code === 'skill_update_conflict') {
        planned.push({
          target,
          action: 'failed',
          hint: details.hint ?? skillUpdateConflictError(target.path).hint,
        })
        continue
      }
    }
    if (
      state.kind === 'unmanaged' &&
      (filters.auto || options.skipBrokenUserSkills) &&
      (await lstat(target.absolutePath).catch(() => null))?.isSymbolicLink()
    ) {
      // A linked SKILL.md without ownership records is the user's own folder.
      if (filters.auto) planned.push({ target, action: 'skipped_unmanaged' })
      continue
    }
    if (state.kind === 'unmanaged' || state.kind === 'broken') {
      if (options.skipBrokenUserSkills && state.kind === 'broken') {
        const details = await diagnostic(target, bundled)
        if (details.hint)
          planned.push({
            target,
            action: 'update_recommended',
            hint: details.hint,
            fallbackAction: 'update_recommended',
          })
        continue
      }
      writeFailure(command, await conflictFor(target), mode, 1)
      return undefined
    }
    const automaticUpdate =
      filters.auto || options.command === 'init' || options.command === 'open'
    if (automaticUpdate && state.kind === 'missing' && state.hint) continue
    if (
      automaticUpdate &&
      state.kind === 'managed' &&
      state.version > bundled.version
    )
      continue
    const details = await diagnostic(target, bundled)
    if (
      automaticUpdate &&
      state.kind === 'managed' &&
      details.modified_files.length
    ) {
      planned.push({ target, action: 'update_recommended' })
      continue
    }
    const unchanged =
      state.kind === 'managed' &&
      ((state.version >= bundled.version &&
        !details.interrupted_update &&
        automaticUpdate) ||
        state.version > bundled.version ||
        details.current)
    planned.push(
      unchanged
        ? {
            target,
            action: 'unchanged',
            ...(automaticUpdate
              ? { fallbackAction: 'update_recommended' as const }
              : {}),
          }
        : {
            target,
            action: state.kind === 'missing' ? 'installed' : 'updated',
            content: bundled,
            automatic: automaticUpdate,
            ...(automaticUpdate
              ? { fallbackAction: 'update_recommended' as const }
              : {}),
          },
    )
  }
  if (options.autoUpdateUserManaged || filters.auto) {
    const plannedPaths = new Set(
      await Promise.all(planned.map((action) => targetPathKey(action.target))),
    )
    for (const target of await groupTargets(await automaticTargets(bundled))) {
      if (plannedPaths.has(await targetPathKey(target))) {
        const existing = planned.find((item) =>
          target.resolved_folder_path !== null
            ? item.target.resolved_folder_path === target.resolved_folder_path
            : item.target.absolutePath === target.absolutePath,
        )
        if (existing) {
          existing.target.aliases = [
            ...aliases(existing.target),
            ...aliases(target).filter(
              (alias) =>
                !aliases(existing.target).some(
                  (old) => old.tool === alias.tool && old.scope === alias.scope,
                ),
            ),
          ].sort(targetOrder)
          const primary = existing.target.aliases[0]!
          existing.target.tool = primary.tool as SkillTool
          existing.target.scope = primary.scope as SkillScope
          existing.target.path = primary.path!
          existing.target.absolutePath = resolve(primary.path!)
        }
        continue
      }
      const state = await readTarget(target)
      if (await skipAutomaticTarget(target, state)) continue
      if (state.kind === 'managed' && state.version > bundled.version) continue
      if (parsed.options.dryRun !== true) {
        try {
          await cleanupTarget(target, bundled)
        } catch (error) {
          planned.push({
            target,
            action: 'update_recommended',
            hint: (error as Error).message,
            fallbackAction: 'update_recommended',
          })
          continue
        }
      }
      const details = await diagnostic(target, bundled)
      if (state.kind === 'managed' && details.modified_files.length) {
        planned.push({
          target,
          action: 'update_recommended',
          installedVersion: state.version,
        })
        continue
      }
      if (
        !cursorProjectAlias(target) &&
        ((state.kind !== 'managed' &&
          !(state.kind === 'missing' && details.interrupted_update)) ||
          (state.kind === 'managed' &&
            state.version >= bundled.version &&
            !details.interrupted_update) ||
          (await isCurrent(target, bundled)))
      ) {
        continue
      }
      planned.push({
        target,
        action:
          state.kind === 'managed' &&
          state.version >= bundled.version &&
          !details.interrupted_update
            ? 'unchanged'
            : 'updated',
        ...(state.kind === 'managed' &&
        state.version >= bundled.version &&
        !details.interrupted_update
          ? {}
          : { content: bundled }),
        automatic: true,
        fallbackAction: 'update_recommended',
      })
    }
  }
  return finishActions(command, planned, parsed.options.dryRun === true, mode)
}

async function automaticTargets(bundled: BundledSkills) {
  const targets = allTargets()
    .filter(availableTarget)
    .filter((target) => target.scope === 'user')
  const project = skillTarget('cursor', 'project')
  if (availableTarget(project)) {
    const version = await legacyManagedVersion(project)
    if (version !== undefined && version <= bundled.version)
      targets.push(project)
  }
  return targets
}

export async function autoUpdateUserManagedSkills(): Promise<
  SkillAutoUpdateData | undefined
> {
  try {
    const bundled = await loadBundledSkills()
    const planned: PlannedAction[] = []
    for (const target of await groupTargets(await automaticTargets(bundled))) {
      const state = await readTarget(target)
      if (await skipAutomaticTarget(target, state)) continue
      if (state.kind === 'managed' && state.version > bundled.version) continue
      try {
        await cleanupTarget(target, bundled)
      } catch (error) {
        planned.push({
          target,
          action: 'update_recommended',
          hint: (error as Error).message,
          ...(state.kind === 'managed'
            ? { installedVersion: state.version }
            : {}),
        })
        continue
      }
      const details = await diagnostic(target, bundled)
      if (details.hint) {
        planned.push({
          target,
          action: 'update_recommended',
          hint: details.hint,
          fallbackAction: 'update_recommended',
          ...(state.kind === 'managed'
            ? { installedVersion: state.version }
            : {}),
        })
        continue
      }
      if (state.kind === 'managed' && details.modified_files.length) {
        planned.push({
          target,
          action: 'update_recommended',
          installedVersion: state.version,
        })
        continue
      }
      if (
        !cursorProjectAlias(target) &&
        ((state.kind !== 'managed' &&
          !(state.kind === 'missing' && details.interrupted_update)) ||
          (state.kind === 'managed' &&
            state.version >= bundled.version &&
            !details.interrupted_update) ||
          (await isCurrent(target, bundled)))
      ) {
        continue
      }
      planned.push({
        target,
        action:
          state.kind === 'managed' &&
          state.version >= bundled.version &&
          !details.interrupted_update
            ? 'unchanged'
            : 'updated',
        ...(state.kind === 'managed' &&
        state.version >= bundled.version &&
        !details.interrupted_update
          ? {}
          : { content: bundled }),
        automatic: true,
        fallbackAction: 'update_recommended',
        installedVersion:
          state.kind === 'managed'
            ? state.version
            : ((await legacyManagedVersion(target)) ?? null),
      })
    }

    if (planned.length === 0) return undefined

    const completed = [...planned]
    for (const [index, item] of planned.entries()) {
      try {
        await prepareAction(item, false)
        await applyAction(item)
        completed[index] = item
      } catch (error) {
        completed[index] = {
          hint: (error as Error).message,
          target: item.target,
          action: 'update_recommended',
          ...(item.installedVersion !== undefined
            ? { installedVersion: item.installedVersion }
            : {}),
        }
      }
    }

    return {
      targets: await Promise.all(
        completed.map(
          async ({ target, action, installedVersion, legacy, hint }) => ({
            ...(hint ? { hint } : {}),
            tool: target.tool,
            scope: target.scope,
            path: target.path,
            ...identity(target),
            folder_path: dirname(target.path),
            ...(legacy ? { legacy_rule: legacy } : {}),
            action:
              action === 'update_recommended'
                ? 'update_recommended'
                : 'updated',
            installed_version:
              action === 'update_recommended'
                ? (installedVersion ?? null)
                : (installedVersion ?? bundled.version),
            bundled_version: bundled.version,
            ...(action === 'update_recommended'
              ? await recoveryRecommendation(target, bundled)
              : {}),
          }),
        ),
      ),
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
  if (data) {
    writeSuccess('skills ensure', data, mode)
    if (data.targets.some((target) => target.action === 'failed'))
      process.exitCode = 1
  }
}

export async function runSkillsList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const bundled = await bundledOrFailure('skills list', mode)
  if (!bundled) return
  const targets = []
  for (const target of await groupTargets(allTargets())) {
    if (!availableTarget(target)) {
      targets.push({ ...unavailableState(target), detected: false })
      continue
    }
    const state = await readTarget(target)
    targets.push({
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      ...identity(target),
      ...(await diagnostic(target, bundled)),
      detected: (
        await Promise.all(
          aliases(target).map((alias) =>
            isToolDetected(alias.tool as SkillTool, alias.scope as SkillScope),
          ),
        )
      ).some(Boolean),
      installed: state.kind !== 'missing',
      managed: state.kind === 'managed',
      installed_version: state.kind === 'managed' ? state.version : null,
      update_available:
        state.kind === 'managed' && state.version < bundled.version,
    })
  }
  const data: SkillsListData = { bundled_version: bundled.version, targets }
  return writeSuccess('skills list', data, mode)
}

export async function skillDiagnostics(): Promise<DoctorSkillsData> {
  const bundled = await loadBundledSkills()
  const targets = []
  for (const target of await groupTargets(allTargets())) {
    if (!availableTarget(target)) {
      targets.push({ ...unavailableState(target), update_command: null })
      continue
    }
    const state = await readTarget(target)
    const details = await diagnostic(target, bundled)
    const updateAvailable =
      state.kind === 'managed' && state.version < bundled.version
    const recommendation = await recoveryRecommendation(target, bundled)
    const recoveryCommand = recommendation.update_command ?? null
    targets.push({
      tool: target.tool,
      scope: target.scope,
      path: target.path,
      installed: state.kind !== 'missing',
      managed: state.kind === 'managed',
      installed_version: state.kind === 'managed' ? state.version : null,
      update_available: updateAvailable,
      ...identity(target),
      ...details,
      ...(!recoveryCommand && recommendation.hint
        ? { hint: recommendation.hint }
        : {}),
      update_command: details.hint
        ? null
        : updateAvailable ||
            details.interrupted_update ||
            (state.kind === 'managed' && !details.current)
          ? recoveryCommand
          : null,
    })
  }
  const updateTargets = targets.filter(
    (target) => target.update_command !== null,
  )
  const commonCommand = updateTargets[0]?.update_command?.replace(
    / --tool \S+ --scope \S+/,
    '',
  )
  const canUpdateTogether =
    commonCommand?.includes(' skills update ') &&
    updateTargets.every(
      (target) =>
        target.update_command?.replace(/ --tool \S+ --scope \S+/, '') ===
        commonCommand,
    ) &&
    !targets.some(
      (target) =>
        target.path !== null &&
        (target.installed ||
          ('interrupted_update' in target && target.interrupted_update)) &&
        target.hint,
    )
  return {
    bundled_version: bundled.version,
    update_available: targets.some((target) => target.update_available),
    update_command:
      updateTargets.length === 0
        ? null
        : canUpdateTogether &&
            (updateTargets.length > 1 || !commonCommand?.includes(' --force'))
          ? commonCommand!
          : updateTargets.map((target) => target.update_command).join(' && '),
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
  const unavailable = unavailableSelection(filters.tools, filters.scope)
  if (unavailable) return writeFailure(command, unavailable, mode, 1)
  const force = parsed.options.force === true
  const bundled = await bundledOrFailure(command, mode)
  if (!bundled) return

  const planned: PlannedAction[] = []
  for (const target of await groupTargets(
    filteredTargets(filters.tools, filters.scope),
  )) {
    const state = await readTarget(target)
    const details = await diagnostic(target, bundled)
    if (details.code === 'skill_update_conflict') {
      const conflict = skillUpdateConflictError(target.path)
      conflict.hint = details.hint ?? conflict.hint
      if (filters.tools.length) return writeFailure(command, conflict, mode, 1)
      planned.push({ target, action: 'failed', hint: conflict.hint })
      continue
    }
    if (state.kind === 'broken') {
      return writeFailure(command, await conflictFor(target), mode, 1)
    }
    if (isNewer(state, bundled) && !force) {
      planned.push({
        target,
        action: 'unchanged',
        preserve: true,
        hint: newerCliHint(state.version, bundled.version),
      })
      continue
    }
    if (state.kind === 'missing') {
      if (state.hint) {
        planned.push({ target, action: 'not_installed', hint: state.hint })
        continue
      }
      planned.push(
        (await legacyRule(target))?.managed ||
          (await diagnostic(target, bundled)).interrupted_update
          ? { target, action: 'installed', content: bundled }
          : { target, action: 'not_installed' },
      )
    } else if (state.kind === 'unmanaged') {
      planned.push({ target, action: 'skipped_unmanaged' })
    } else if (!(await isCurrent(target, bundled)) || force) {
      planned.push({
        target,
        action: 'updated',
        content: bundled,
        forceRetirement: force,
        ...(isNewer(state, bundled)
          ? {
              hint: downgradeHint(state.version, bundled.version),
            }
          : {}),
      })
    } else {
      planned.push({ target, action: 'unchanged' })
    }
  }
  if (!filters.tools.length)
    for (const item of planned) item.fallbackAction = 'failed'
  await runActions(
    command,
    planned,
    parsed.options.dryRun === true,
    mode,
    unavailableActionTargets(filters.tools, filters.scope),
  )
}

export async function runSkillsRemove(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'skills remove'
  const filters = parseFilters(parsed)
  if (filters.error) return writeFailure(command, filters.error, mode, 1)
  const unavailable = unavailableSelection(filters.tools, filters.scope)
  if (unavailable) return writeFailure(command, unavailable, mode, 1)

  const planned: PlannedAction[] = []
  for (const target of await groupTargets(
    filteredTargets(filters.tools, filters.scope),
  )) {
    const state = await readTarget(target)
    const details = await diagnostic(target, await loadBundledSkills())
    if (details.code === 'skill_update_conflict') {
      const conflict = skillUpdateConflictError(target.path)
      conflict.hint = details.hint ?? conflict.hint
      if (filters.tools.length) return writeFailure(command, conflict, mode, 1)
      planned.push({ target, action: 'failed', hint: conflict.hint })
      continue
    }
    if (state.kind === 'broken') {
      return writeFailure(command, await conflictFor(target, true), mode, 1)
    }
    if (state.kind === 'missing' && state.hint) {
      planned.push({ target, action: 'not_installed', hint: state.hint })
      continue
    }
    const managedLegacy = (await legacyRule(target))?.managed === true
    const action: SkillsTargetAction =
      state.kind === 'missing'
        ? managedLegacy ||
          (await diagnostic(target, await loadBundledSkills()))
            .interrupted_update
          ? 'removed'
          : 'not_installed'
        : state.kind === 'managed'
          ? 'removed'
          : 'skipped_unmanaged'
    planned.push({ target, action, removeLegacy: true })
  }
  if (!filters.tools.length)
    for (const item of planned) item.fallbackAction = 'failed'
  await runActions(
    command,
    planned,
    parsed.options.dryRun === true,
    mode,
    unavailableActionTargets(filters.tools, filters.scope),
  )
}

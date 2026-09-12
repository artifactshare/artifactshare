import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  ledgerPath,
  readLedger,
  recordDeferred,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

const taskUsageReportSchemaVersion = 2
const taskUsageReportKind = 'artifactshare.workflow_usage'
const taskUsageUsageFields = [
  'rawInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'inputTokens',
  'outputTokens',
  'totalTokens',
]
const taskUsageUsageFieldSet = new Set(taskUsageUsageFields)
const taskUsageCoverageFields = new Set(['status', 'reasons'])
const taskUsageTotalsFields = new Set(['measured', 'complete'])
const taskUsageProviders = new Set(['codex', 'claude'])
const taskUsageOutcomes = new Set(['active', 'succeeded', 'failed', 'aborted'])
const taskUsageNotReadyReasons = new Set([
  'task_inventory_not_sealed',
  'no_registered_executions',
  'execution_active',
])
const workflowUsageStart = '<!-- artifactshare:workflow-usage:start -->'
const workflowUsageEnd = '<!-- artifactshare:workflow-usage:end -->'
const legacyWorkflowUsageHeader =
  /^\|[ \t]*Execution[ \t]*\|[ \t]*Model[ \t]*\(requested[ \t]*→[ \t]*reported\)[ \t]*\|[ \t]*Effort[ \t]*\(requested[ \t]*→[ \t]*reported\)[ \t]*\|/imu
const workflowUsageTableHeader =
  /^\|[ \t]*Stage[ \t]*\|[ \t]*Attempt[ \t]*\|[ \t]*Provider[ \t]*\|[ \t]*Requested model[ \t]*\|[ \t]*Requested effort[ \t]*\|[ \t]*Reported effort[ \t]*\|[ \t]*Reported models[ \t]*\|[ \t]*Outcome[ \t]*\|[ \t]*Duration[ \t]*\|[ \t]*Usage source[ \t]*\|[ \t]*Tokens[ \t]*\|[ \t]*Reason[ \t]*\|/gimu
const taskUsageCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const taskUsageModelPattern =
  /^(?:(?:openai\/)?(?:gpt-6-astra|gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5)|(?:anthropic\/)?(?:claude-opus-5|claude-sonnet-5|claude-haiku-4-5-20251001))$/u
const taskUsageEffortPattern = /^(?:low|medium|high|xhigh|max|ultra)$/u
const taskUsageSourcePattern = /^(?:ccusage_interval|claude_final)$/u

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function safeReportText(value, field) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    value.includes('|') ||
    [...value].some((character) => {
      const code = character.codePointAt(0)
      return code !== undefined && (code < 0x20 || code === 0x7f)
    })
  )
    throw new Error(`Task usage report ${field} is invalid.`)
  return value
}

function nullableSafeInteger(value, field) {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Task usage report ${field} is invalid.`)
  return value
}

function validateReportUsage(value, field) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Task usage report ${field} is invalid.`)
  for (const name of Object.keys(value))
    if (!taskUsageUsageFieldSet.has(name))
      throw new Error(`Task usage report ${field}.${name} is not allowed.`)
  for (const name of taskUsageUsageFields)
    if (!Number.isSafeInteger(value[name]) || value[name] < 0)
      throw new Error(`Task usage report ${field}.${name} is invalid.`)
  if (
    value.inputTokens !==
      value.rawInputTokens +
        value.cacheReadInputTokens +
        value.cacheWriteInputTokens ||
    value.totalTokens !== value.inputTokens + value.outputTokens
  )
    throw new Error(`Task usage report ${field} totals are inconsistent.`)
  return value
}

function sameUsage(left, right) {
  if (left === null || right === null) return left === right
  return taskUsageUsageFields.every((field) => left[field] === right[field])
}

function sumReportRows(rows) {
  let sum = null
  for (const row of rows) {
    if (row.usage === null) continue
    if (sum === null)
      sum = Object.fromEntries(taskUsageUsageFields.map((field) => [field, 0]))
    for (const field of taskUsageUsageFields) {
      sum[field] += row.usage[field]
      if (!Number.isSafeInteger(sum[field]))
        throw new Error(`Task usage report rows.${field} exceeds safe range.`)
    }
  }
  return sum
}

function normalizeWorkflowUsageText(value) {
  return value.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
}

function markerCount(value, marker) {
  return value.split(marker).length - 1
}

function extractWorkflowUsageBlock(value, field) {
  if (typeof value !== 'string')
    throw new Error(`Task usage report ${field} is invalid.`)
  const normalized = normalizeWorkflowUsageText(value)
  if (
    markerCount(normalized, workflowUsageStart) !== 1 ||
    markerCount(normalized, workflowUsageEnd) !== 1
  )
    throw new Error(`Task usage report ${field} must contain one marker pair.`)
  const start = normalized.indexOf(workflowUsageStart)
  const end = normalized.indexOf(workflowUsageEnd)
  if (start < 0 || end < start)
    throw new Error(`Task usage report ${field} marker order is invalid.`)
  return normalized.slice(start, end + workflowUsageEnd.length)
}

function extractWorkflowUsageSection(value, field) {
  if (typeof value !== 'string')
    throw new Error(`Task usage report ${field} is invalid.`)
  const normalized = normalizeWorkflowUsageText(value)
  const matches = [...normalized.matchAll(/^##[ \t]+Workflow usage[ \t]*$/gmu)]
  const semanticMatches = [
    ...normalized.matchAll(/^##[ \t]+Workflow usage[ \t]*$/gimu),
  ]
  if (matches.length !== 1 || semanticMatches.length !== 1)
    throw new Error(
      `Task usage report ${field} must contain one workflow usage section.`,
    )
  const heading = matches[0]
  const start = heading.index + heading[0].length
  const rest = normalized.slice(start).replace(/^\n/u, '')
  const nextHeading = rest.search(/^##[ \t]+(?!#)/mu)
  return (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).trim()
}

function markdownCell(value) {
  return String(value ?? 'unknown')
    .replaceAll('|', '\\|')
    .replace(/[\r\n]+/gu, ' ')
}

function usageText(value) {
  return value
    ? `${value.inputTokens} in / ${value.outputTokens} out / ${value.totalTokens} total (cache read ${value.cacheReadInputTokens}, cache write ${value.cacheWriteInputTokens})`
    : 'unknown'
}

function durationText(value) {
  return value === null ? 'unknown' : `${value} ms`
}

export function renderCanonicalWorkflowUsageMarkdown(report) {
  const lines = [
    workflowUsageStart,
    `**Target commit:** \`${report.target.headSha}\``,
    `**Workflow usage coverage:** ${report.coverage.status}`,
    `**Measured total:** ${usageText(report.totals.measured)}`,
    `**Complete total:** ${usageText(report.totals.complete)}`,
    `**Wall elapsed:** ${durationText(report.wallElapsedMs)}`,
    `**Sum of invocation durations:** ${durationText(report.invocationDurationMs)}`,
    '',
    '| Stage | Attempt | Provider | Requested model | Requested effort | Reported effort | Reported models | Outcome | Duration | Usage source | Tokens | Reason |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |',
  ]
  for (const row of report.rows)
    lines.push(
      `| ${markdownCell(row.stage)} | ${row.attempt} | ${row.provider} | ${markdownCell(row.requestedModel)} | ${markdownCell(row.requestedEffort)} | ${markdownCell(row.reportedEffort)} | ${markdownCell(row.reportedModels.join(', ') || null)} | ${row.outcome} | ${durationText(row.durationMs)} | ${markdownCell(row.usageSource)} | ${usageText(row.usage)} | ${markdownCell(row.coverageReasons.join(', ') || '—')} |`,
    )
  if (report.coverage.reasons.length) {
    lines.push('', '**Coverage reasons:**')
    for (const reason of report.coverage.reasons)
      lines.push(`- ${markdownCell(reason)}`)
  }
  lines.push(workflowUsageEnd)
  return `${lines.join('\n')}\n`
}

function validateWorkflowUsageMarkdown(value) {
  const block = extractWorkflowUsageBlock(value, 'markdown')
  if (normalizeWorkflowUsageText(value) !== block)
    throw new Error(
      'Task usage report markdown must contain only its marker block.',
    )
}

function validateTaskUsageReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Task usage report must be an object.')
  const keys = new Set([
    'schemaVersion',
    'kind',
    'target',
    'coverage',
    'totals',
    'wallElapsedMs',
    'invocationDurationMs',
    'rows',
    'markdown',
  ])
  for (const key of Object.keys(value))
    if (!keys.has(key))
      throw new Error(`Task usage report field ${key} is not allowed.`)
  if (value.schemaVersion !== taskUsageReportSchemaVersion)
    throw new Error('Task usage report schema version is unsupported.')
  if (value.kind !== taskUsageReportKind)
    throw new Error('Task usage report kind is unsupported.')
  if (
    !value.target ||
    typeof value.target !== 'object' ||
    Array.isArray(value.target)
  )
    throw new Error('Task usage report target is invalid.')
  if (
    Object.keys(value.target).length !== 1 ||
    !Object.hasOwn(value.target, 'headSha') ||
    typeof value.target.headSha !== 'string' ||
    !taskUsageCommitPattern.test(value.target.headSha)
  )
    throw new Error('Task usage report target head is invalid.')
  if (
    !value.coverage ||
    typeof value.coverage !== 'object' ||
    Array.isArray(value.coverage)
  )
    throw new Error('Task usage report coverage is invalid.')
  for (const key of Object.keys(value.coverage))
    if (!taskUsageCoverageFields.has(key))
      throw new Error(`Task usage report coverage.${key} is not allowed.`)
  if (!['complete', 'partial'].includes(value.coverage.status))
    throw new Error('Task usage report coverage status is invalid.')
  if (!Array.isArray(value.coverage.reasons))
    throw new Error('Task usage report coverage reasons are invalid.')
  value.coverage.reasons.forEach((reason, index) =>
    safeReportText(reason, `coverage.reasons[${index}]`),
  )
  if (
    value.coverage.reasons.some((reason) =>
      taskUsageNotReadyReasons.has(reason),
    )
  )
    throw new Error(
      'Task usage report must have a sealed inventory and no active executions before Ready.',
    )
  if (
    value.coverage.status === 'partial' &&
    value.coverage.reasons.length === 0
  )
    throw new Error('Partial task usage coverage requires a reason.')
  if (value.coverage.status === 'complete' && value.coverage.reasons.length > 0)
    throw new Error('Complete task usage coverage cannot have reasons.')
  if (
    !value.totals ||
    typeof value.totals !== 'object' ||
    Array.isArray(value.totals)
  )
    throw new Error('Task usage report totals are invalid.')
  for (const key of Object.keys(value.totals))
    if (!taskUsageTotalsFields.has(key))
      throw new Error(`Task usage report totals.${key} is not allowed.`)
  validateReportUsage(value.totals.measured, 'totals.measured')
  const complete = validateReportUsage(value.totals.complete, 'totals.complete')
  if (value.coverage.status === 'complete' && complete === null)
    throw new Error('Complete task usage coverage requires complete totals.')
  if (value.coverage.status === 'partial' && complete !== null)
    throw new Error('Partial task usage coverage cannot have complete totals.')
  nullableSafeInteger(value.wallElapsedMs, 'wallElapsedMs')
  nullableSafeInteger(value.invocationDurationMs, 'invocationDurationMs')
  if (value.coverage.status === 'partial') {
    const timingUnknownReasons = [
      [
        value.wallElapsedMs === null,
        'wallElapsedMs',
        'wall_elapsed_unavailable',
      ],
      [
        value.invocationDurationMs === null,
        'invocationDurationMs',
        'invocation_duration_unavailable',
      ],
    ]
    for (const [unknown, field, reason] of timingUnknownReasons) {
      if (unknown && !value.coverage.reasons.includes(reason))
        throw new Error(
          `Task usage report ${field} is missing coverage reason ${reason}.`,
        )
      if (!unknown && value.coverage.reasons.includes(reason))
        throw new Error(
          `Task usage report coverage reason ${reason} requires ${field} to be unknown.`,
        )
    }
  }
  if (!Array.isArray(value.rows) || value.rows.length === 0)
    throw new Error('Task usage report must contain at least one row.')
  value.rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error(`Task usage report row ${index} is invalid.`)
    const rowKeys = new Set([
      'stage',
      'attempt',
      'provider',
      'outcome',
      'durationMs',
      'usageSource',
      'requestedModel',
      'requestedEffort',
      'reportedEffort',
      'reportedModels',
      'usage',
      'coverageReasons',
    ])
    for (const key of Object.keys(row))
      if (!rowKeys.has(key))
        throw new Error(`Task usage report row ${index}.${key} is not allowed.`)
    safeReportText(row.stage, `rows[${index}].stage`)
    if (!Number.isSafeInteger(row.attempt) || row.attempt < 1)
      throw new Error(`Task usage report row ${index}.attempt is invalid.`)
    if (!taskUsageProviders.has(row.provider))
      throw new Error(`Task usage report row ${index}.provider is invalid.`)
    if (!taskUsageOutcomes.has(row.outcome))
      throw new Error(`Task usage report row ${index}.outcome is invalid.`)
    nullableSafeInteger(row.durationMs, `rows[${index}].durationMs`)
    if (row.usageSource !== null) {
      safeReportText(row.usageSource, `rows[${index}].usageSource`)
      if (!taskUsageSourcePattern.test(row.usageSource))
        throw new Error(
          `Task usage report rows[${index}].usageSource is unsupported.`,
        )
    }
    if (row.requestedModel !== null) {
      safeReportText(row.requestedModel, `rows[${index}].requestedModel`)
      if (!taskUsageModelPattern.test(row.requestedModel))
        throw new Error(
          `Task usage report rows[${index}].requestedModel is unsupported.`,
        )
    }
    if (row.requestedEffort !== null) {
      safeReportText(row.requestedEffort, `rows[${index}].requestedEffort`)
      if (!taskUsageEffortPattern.test(row.requestedEffort))
        throw new Error(
          `Task usage report rows[${index}].requestedEffort is unsupported.`,
        )
    }
    if (row.reportedEffort !== null) {
      safeReportText(row.reportedEffort, `rows[${index}].reportedEffort`)
      if (!taskUsageEffortPattern.test(row.reportedEffort))
        throw new Error(
          `Task usage report rows[${index}].reportedEffort is unsupported.`,
        )
    }
    if (!Array.isArray(row.reportedModels))
      throw new Error(
        `Task usage report row ${index}.reportedModels is invalid.`,
      )
    row.reportedModels.forEach((model, modelIndex) =>
      safeReportText(model, `rows[${index}].reportedModels[${modelIndex}]`),
    )
    if (row.reportedModels.some((model) => !taskUsageModelPattern.test(model)))
      throw new Error(
        `Task usage report rows[${index}].reportedModels contains an unsupported model.`,
      )
    if (!Array.isArray(row.coverageReasons))
      throw new Error(
        `Task usage report row ${index}.coverageReasons is invalid.`,
      )
    if (row.outcome === 'active')
      throw new Error(
        `Task usage report row ${index} is still active and cannot be used for Ready.`,
      )
    row.coverageReasons.forEach((reason, reasonIndex) =>
      safeReportText(reason, `rows[${index}].coverageReasons[${reasonIndex}]`),
    )
    if (
      row.coverageReasons.some((reason) => taskUsageNotReadyReasons.has(reason))
    )
      throw new Error(
        `Task usage report row ${index} is still active or unsealed and cannot be used for Ready.`,
      )
    const rowUsage = validateReportUsage(row.usage, `rows[${index}].usage`)
    const unknownReasons = [
      [rowUsage === null, 'usage', 'usage_unavailable'],
      [row.durationMs === null, 'durationMs', 'duration_unavailable'],
      [row.usageSource === null, 'usageSource', 'usage_source_unavailable'],
      [
        row.requestedModel === null,
        'requestedModel',
        'requested_model_unrecorded',
      ],
      [
        row.requestedEffort === null,
        'requestedEffort',
        'requested_effort_unrecorded',
      ],
      [
        row.reportedEffort === null,
        'reportedEffort',
        'reported_effort_unavailable',
      ],
      [
        row.reportedModels.length === 0,
        'reportedModels',
        'reported_models_unavailable',
      ],
    ]
    const hasUnknown = unknownReasons.some(([unknown]) => unknown)
    if (hasUnknown && row.coverageReasons.length === 0)
      throw new Error(
        `Task usage report row ${index} has an unreasoned unknown value.`,
      )
    for (const [unknown, field, reason] of unknownReasons)
      if (unknown && !row.coverageReasons.includes(reason))
        throw new Error(
          `Task usage report row ${index}.${field} is missing coverage reason ${reason}.`,
        )
    for (const [unknown, field, reason] of unknownReasons)
      if (!unknown && row.coverageReasons.includes(reason))
        throw new Error(
          `Task usage report row ${index}.${field} has coverage reason ${reason} but the field is known.`,
        )
    if (
      rowUsage !== null &&
      row.usageSource === null &&
      !row.coverageReasons.includes('usage_source_unavailable')
    )
      throw new Error(
        `Task usage report row ${index} is missing a usage source.`,
      )
    if (
      value.coverage.status === 'complete' &&
      (rowUsage === null ||
        row.durationMs === null ||
        row.reportedEffort === null)
    )
      throw new Error(`Complete task usage row ${index} is incomplete.`)
  })
  if (
    typeof value.markdown !== 'string' ||
    value.markdown.length === 0 ||
    value.markdown.length > 1024 * 1024
  )
    throw new Error('Task usage report markdown block is invalid.')
  validateWorkflowUsageMarkdown(value.markdown)
  if (
    normalizeWorkflowUsageText(value.markdown) !==
    normalizeWorkflowUsageText(renderCanonicalWorkflowUsageMarkdown(value))
  )
    throw new Error('Task usage report markdown does not match report data.')
  const rowUsage = sumReportRows(value.rows)
  if (!sameUsage(value.totals.measured, rowUsage))
    throw new Error('Task usage report measured totals do not match rows.')
  if (
    value.coverage.status === 'complete' &&
    (!sameUsage(value.totals.complete, rowUsage) ||
      !sameUsage(value.totals.complete, value.totals.measured))
  )
    throw new Error('Complete task usage totals do not match rows.')
  const rowDurationMs = value.rows.reduce((sum, row) => {
    if (row.durationMs === null || sum === null) return null
    const next = sum + row.durationMs
    if (!Number.isSafeInteger(next))
      throw new Error('Task usage report row durations exceed safe range.')
    return next
  }, 0)
  const knownRowDurationMs = value.rows.reduce((sum, row) => {
    if (row.durationMs === null) return sum
    const next = sum + row.durationMs
    if (!Number.isSafeInteger(next))
      throw new Error(
        'Task usage report known row durations exceed safe range.',
      )
    return next
  }, 0)
  if (
    value.invocationDurationMs !== null &&
    value.invocationDurationMs < knownRowDurationMs
  )
    throw new Error('Task usage invocation duration does not cover known rows.')
  if (value.coverage.status === 'complete') {
    if (value.wallElapsedMs === null || value.invocationDurationMs === null)
      throw new Error('Complete task usage coverage requires timing totals.')
    if (value.invocationDurationMs !== rowDurationMs)
      throw new Error(
        'Complete task usage invocation duration does not match rows.',
      )
    const maxRowDurationMs = Math.max(
      ...value.rows.map((row) => row.durationMs),
    )
    if (value.wallElapsedMs < maxRowDurationMs)
      throw new Error(
        'Complete task usage wall elapsed duration is shorter than a row.',
      )
    if (
      value.rows.some(
        (row) =>
          row.usageSource === null ||
          row.coverageReasons.length > 0 ||
          row.requestedModel === null ||
          row.requestedEffort === null ||
          row.reportedEffort === null ||
          row.reportedModels.length === 0,
      )
    )
      throw new Error(
        'Complete task usage rows require complete source, reason, and model metadata.',
      )
  }
  const maxKnownRowDurationMs = Math.max(
    0,
    ...value.rows
      .map((row) => row.durationMs)
      .filter((durationMs) => durationMs !== null),
  )
  if (
    value.wallElapsedMs !== null &&
    value.wallElapsedMs < maxKnownRowDurationMs
  )
    throw new Error(
      'Task usage wall elapsed duration is shorter than a known row.',
    )
  if (
    rowDurationMs !== null &&
    value.invocationDurationMs !== null &&
    value.invocationDurationMs !== rowDurationMs
  )
    throw new Error('Task usage invocation duration does not match known rows.')
  return value
}

function readTaskUsageReport(path, readFile) {
  let value
  try {
    value = JSON.parse(readFile(path, 'utf8'))
  } catch {
    throw new Error('Task usage report is missing or invalid JSON.')
  }
  return validateTaskUsageReport(value)
}

function parseArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const flags = new Set(['--dry-run', '--ui-gate-complete', '--no-deferred'])
  const values = new Set([
    '--deferred',
    '--deferred-file',
    '--task-usage-report',
  ])
  const parsed = {
    deferred: [],
    deferredFile: undefined,
    taskUsageReport: undefined,
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index]
    if (flags.has(arg)) continue
    if (!values.has(arg)) throw new Error(usage())
    const value = normalized[++index]
    if (!value || value.startsWith('--')) throw new Error(usage())
    if (arg === '--deferred') parsed.deferred.push(value)
    else if (arg === '--deferred-file') parsed.deferredFile = value
    else parsed.taskUsageReport = value
  }
  return {
    ...parsed,
    dryRun: normalized.includes('--dry-run'),
    uiGateComplete: normalized.includes('--ui-gate-complete'),
    noDeferred: normalized.includes('--no-deferred'),
  }
}

function usage() {
  return 'Usage: pnpm pr:ready -- [--task-usage-report <path>] [--dry-run] [--ui-gate-complete] (--no-deferred | --deferred <text> ... | --deferred-file <path>)'
}

/** Every review finding this change chose not to fix has to be named here.
 * Recording it is not a fix and must not be reported as one; it is what makes
 * the deferral reachable again after the PR lands. */
function deferredItems(parsed, readFile) {
  const fromFile = parsed.deferredFile
    ? readFile(parsed.deferredFile, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  return [...parsed.deferred, ...fromFile]
}

function isUiFile(file) {
  if (file.startsWith('apps/web/public/')) return true
  if (/^apps\/web\/app\/.*\.css$/u.test(file)) return true
  if (/^apps\/web\/app\/i18n\/[^/]+\.json$/u.test(file)) return true
  if (/^apps\/web\/app\/(?:guides|legal|updates\/entries)\/.*\.md$/u.test(file))
    return true
  if (
    /^apps\/web\/app\/(?:components|hooks|lib)\/.*\.ts$/u.test(file) ||
    /^apps\/web\/app\/routes\/.*\/(?:\+components|\+hooks)\/.*\.ts$/u.test(file)
  )
    return !/\.(?:(?:test|spec)|server)\.ts$/u.test(file)
  if (!/^apps\/web\/app\/.*\.tsx$/u.test(file)) return false
  if (/\.(?:test|spec)\.tsx$/u.test(file)) return false
  if (file === 'apps/web/app/entry.server.tsx') return false
  return !/^apps\/web\/app\/routes\/api\./u.test(file)
}

function uiFiles(exec, base) {
  return output(exec, 'git', [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `origin/${base}...HEAD`,
  ])
    .split('\n')
    .filter(Boolean)
    .filter(isUiFile)
}

function openPullRequest(exec) {
  const raw = output(exec, 'gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,isDraft,baseRefName,headRefName,headRefOid,body',
  ])
  let rows
  try {
    rows = JSON.parse(raw)
  } catch {
    throw new Error('Exactly one open PR for the current branch is required.')
  }
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Exactly one open PR for the current branch is required.')
  return rows[0]
}

function samePullRequestBody(left, right) {
  return (
    typeof left?.body === 'string' &&
    typeof right?.body === 'string' &&
    normalizeWorkflowUsageText(left.body) ===
      normalizeWorkflowUsageText(right.body)
  )
}

function assertReadyPreparationState(pr, current, branch, head) {
  if (
    current.number !== pr.number ||
    !current.isDraft ||
    current.baseRefName !== pr.baseRefName ||
    current.headRefName !== branch ||
    current.headRefOid !== head ||
    !samePullRequestBody(pr, current)
  )
    throw new Error(
      'The PR changed while Ready was being prepared; rerun pr:ready.',
    )
}

function revertReadyAfterStateChange(exec, pr, error) {
  try {
    exec('gh', ['pr', 'ready', String(pr.number), '--undo'])
  } catch (revertError) {
    throw new Error(
      `The PR changed after Ready and could not be reverted: ${revertError instanceof Error ? revertError.message : String(revertError)}`,
      { cause: error },
    )
  }
  throw new Error(
    'The PR changed after Ready; Ready was reverted. Rerun pr:ready.',
    {
      cause: error,
    },
  )
}

function assertReadyResult(exec, pr, branch, head) {
  let current
  try {
    current = openPullRequest(exec)
  } catch (error) {
    return revertReadyAfterStateChange(exec, pr, error)
  }
  if (
    current.number !== pr.number ||
    current.isDraft ||
    current.baseRefName !== pr.baseRefName ||
    current.headRefName !== branch ||
    current.headRefOid !== head ||
    !samePullRequestBody(pr, current)
  )
    return revertReadyAfterStateChange(
      exec,
      pr,
      new Error('The PR state no longer matches the validated Ready state.'),
    )
}

function rejectUnmarkedWorkflowUsageTables(body, block) {
  const normalizedBody = normalizeWorkflowUsageText(body)
  const blockStart = normalizedBody.indexOf(block)
  const blockEnd = blockStart + block.length
  if (
    blockStart < 0 ||
    [...normalizedBody.matchAll(workflowUsageTableHeader)].some(
      ({ index }) => index < blockStart || index >= blockEnd,
    )
  )
    throw new Error(
      'The PR body must not contain an unmarked workflow usage table.',
    )
}

function ready({
  exec = execFileSync,
  parsed = parseArgs(process.argv.slice(2)),
  readFile = readFileSync,
  ledger = undefined,
} = {}) {
  const taskUsageReport = parsed.taskUsageReport
    ? readTaskUsageReport(parsed.taskUsageReport, readFile)
    : null
  const branch = output(exec, 'git', ['branch', '--show-current'])
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  if (taskUsageReport && taskUsageReport.target.headSha !== head)
    throw new Error(
      'The sanitized task usage report does not target the current local HEAD.',
    )
  if (output(exec, 'git', ['status', '--porcelain']))
    throw new Error('Working tree must be clean.')
  const pr = openPullRequest(exec)
  if (!pr.isDraft || pr.baseRefName !== 'main' || pr.headRefName !== branch)
    throw new Error(
      'PR must be a Draft targeting main from the current branch.',
    )
  if (
    pr.headRefOid !== head ||
    (taskUsageReport && taskUsageReport.target.headSha !== pr.headRefOid)
  )
    throw new Error('Push the current HEAD before making the PR ready.')
  const normalizedBody = normalizeWorkflowUsageText(pr.body)
  const hasWorkflowUsageMarker =
    markerCount(normalizedBody, workflowUsageStart) > 0 ||
    markerCount(normalizedBody, workflowUsageEnd) > 0
  if (legacyWorkflowUsageHeader.test(normalizeWorkflowUsageText(pr.body)))
    throw new Error(
      'The PR body must not contain the legacy workflow usage table.',
    )
  if (!hasWorkflowUsageMarker) {
    if (normalizedBody.search(workflowUsageTableHeader) >= 0)
      throw new Error(
        'The PR body must not contain an unmarked workflow usage table.',
      )
    if (taskUsageReport)
      throw new Error(
        'The PR body must contain exactly one workflow usage marker block from the supplied task usage report.',
      )
  } else {
    if (!taskUsageReport)
      throw new Error(
        'A workflow usage marker block requires a sanitized task usage report passed with --task-usage-report <path>.',
      )
    let reportBlock
    let bodyBlock
    let bodySection
    try {
      reportBlock = extractWorkflowUsageBlock(
        taskUsageReport.markdown,
        'markdown',
      )
      bodyBlock = extractWorkflowUsageBlock(pr.body, 'PR body')
      bodySection = extractWorkflowUsageSection(pr.body, 'PR body')
    } catch {
      throw new Error(
        'The PR body must contain exactly one workflow usage marker block from the supplied task usage report.',
      )
    }
    if (
      normalizeWorkflowUsageText(reportBlock) !==
      normalizeWorkflowUsageText(bodyBlock)
    )
      throw new Error(
        'The PR body must contain exactly the generated workflow usage block from the supplied task usage report.',
      )
    rejectUnmarkedWorkflowUsageTables(pr.body, bodyBlock)
    if (
      normalizeWorkflowUsageText(bodySection) !==
      normalizeWorkflowUsageText(bodyBlock)
    )
      throw new Error(
        'The PR body Workflow usage section must contain only the generated workflow usage block.',
      )
  }
  const changedUiFiles = uiFiles(exec, pr.baseRefName)
  if (changedUiFiles.length > 0 && !parsed.uiGateComplete)
    throw new Error(
      [
        'UI changes detected. Ready was not changed.',
        'Before retrying, confirm all of the following:',
        '- Every affected screen state and registered task has been captured at desktop and mobile.',
        '- Two-layer UI critique using walkthrough evidence, PNGs, task/persona context, and relevant source is complete; captures alone are not sufficient.',
        '- HEAD has no UI changes after that critique. If it does, recapture and repeat the critique.',
        'Then rerun with --ui-gate-complete and the deferral decision, for example:',
        '  pnpm pr:ready -- --ui-gate-complete --no-deferred',
      ].join('\n'),
    )
  const deferred = deferredItems(parsed, readFile)
  if (deferred.length === 0 && !parsed.noDeferred)
    throw new Error(
      [
        'Name the review findings this change did not fix, or state that there were none.',
        'They are recorded now and discharged after the PR lands; the next pr:publish refuses until then.',
        'Pass --deferred <text> for each, --deferred-file <path>, or --no-deferred.',
      ].join('\n'),
    )
  if (deferred.length > 0 && parsed.noDeferred)
    throw new Error('--no-deferred cannot be combined with deferred items.')
  exec('gh', ['pr', 'checks', String(pr.number), '--required'])
  if (!parsed.dryRun) {
    const current = openPullRequest(exec)
    assertReadyPreparationState(pr, current, branch, head)
    const path = ledger ?? ledgerPath()
    const state = readLedger(path)
    // Overwriting a ledger nobody could read would drop other changes'
    // outstanding deferrals, which is the loss this record exists to prevent.
    if (state.unreadable)
      throw new Error(
        `The landing ledger at ${path} could not be read; Ready was not changed. Repair or remove it, then retry.`,
      )
    writeLedgerAtomic(
      path,
      recordDeferred(state, {
        pr: pr.number,
        head,
        deferred,
      }),
    )
    exec('gh', ['pr', 'ready', String(pr.number)])
    assertReadyResult(exec, pr, branch, head)
  }
  return {
    number: pr.number,
    head,
    dryRun: parsed.dryRun,
    deferred: deferred.length,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = ready()
    process.stdout.write(
      `${result.dryRun ? 'Would mark' : 'Marked'} PR #${result.number} ready at ${result.head}.\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

export {
  deferredItems,
  extractWorkflowUsageSection,
  isUiFile,
  parseArgs,
  ready,
  validateTaskUsageReport,
}

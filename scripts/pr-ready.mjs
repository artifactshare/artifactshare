import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  ledgerPath,
  readLedger,
  recordDeferred,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

const taskUsageReportSchemaVersion = 1
const taskUsageReportKind = 'artifactshare.workflow_usage'
const taskUsageUsageFields = [
  'rawInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'inputTokens',
  'outputTokens',
  'totalTokens',
]
const taskUsageProviders = new Set(['codex', 'claude'])
const taskUsageOutcomes = new Set(['active', 'succeeded', 'failed', 'aborted'])
const workflowUsageStart = '<!-- artifactshare:workflow-usage:start -->'
const workflowUsageEnd = '<!-- artifactshare:workflow-usage:end -->'

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

function validateTaskUsageReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Task usage report must be an object.')
  const keys = new Set([
    'schemaVersion',
    'kind',
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
  if (!value.coverage || typeof value.coverage !== 'object')
    throw new Error('Task usage report coverage is invalid.')
  if (!['complete', 'partial'].includes(value.coverage.status))
    throw new Error('Task usage report coverage status is invalid.')
  if (!Array.isArray(value.coverage.reasons))
    throw new Error('Task usage report coverage reasons are invalid.')
  value.coverage.reasons.forEach((reason, index) =>
    safeReportText(reason, `coverage.reasons[${index}]`),
  )
  if (
    value.coverage.status === 'partial' &&
    value.coverage.reasons.length === 0
  )
    throw new Error('Partial task usage coverage requires a reason.')
  if (!value.totals || typeof value.totals !== 'object')
    throw new Error('Task usage report totals are invalid.')
  validateReportUsage(value.totals.measured, 'totals.measured')
  const complete = validateReportUsage(value.totals.complete, 'totals.complete')
  if (value.coverage.status === 'complete' && complete === null)
    throw new Error('Complete task usage coverage requires complete totals.')
  if (value.coverage.status === 'partial' && complete !== null)
    throw new Error('Partial task usage coverage cannot have complete totals.')
  nullableSafeInteger(value.wallElapsedMs, 'wallElapsedMs')
  nullableSafeInteger(value.invocationDurationMs, 'invocationDurationMs')
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
    if (row.usageSource !== null)
      safeReportText(row.usageSource, `rows[${index}].usageSource`)
    for (const field of ['requestedModel', 'requestedEffort'])
      if (row[field] !== null)
        safeReportText(row[field], `rows[${index}].${field}`)
    if (!Array.isArray(row.reportedModels))
      throw new Error(
        `Task usage report row ${index}.reportedModels is invalid.`,
      )
    row.reportedModels.forEach((model, modelIndex) =>
      safeReportText(model, `rows[${index}].reportedModels[${modelIndex}]`),
    )
    if (!Array.isArray(row.coverageReasons))
      throw new Error(
        `Task usage report row ${index}.coverageReasons is invalid.`,
      )
    row.coverageReasons.forEach((reason, reasonIndex) =>
      safeReportText(reason, `rows[${index}].coverageReasons[${reasonIndex}]`),
    )
    const rowUsage = validateReportUsage(row.usage, `rows[${index}].usage`)
    if (rowUsage === null && row.coverageReasons.length === 0)
      throw new Error(
        `Task usage report row ${index} has an unreasoned unknown usage.`,
      )
    if (rowUsage !== null && row.usageSource === null)
      throw new Error(
        `Task usage report row ${index} is missing a usage source.`,
      )
    if (
      value.coverage.status === 'complete' &&
      (rowUsage === null || row.durationMs === null)
    )
      throw new Error(`Complete task usage row ${index} is incomplete.`)
  })
  if (
    typeof value.markdown !== 'string' ||
    value.markdown.length === 0 ||
    value.markdown.length > 1024 * 1024 ||
    !value.markdown.includes(workflowUsageStart) ||
    !value.markdown.includes(workflowUsageEnd)
  )
    throw new Error('Task usage report markdown block is invalid.')
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
  return 'Usage: pnpm pr:ready -- --task-usage-report <path> [--dry-run] [--ui-gate-complete] (--no-deferred | --deferred <text> ... | --deferred-file <path>)'
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

function ready({
  exec = execFileSync,
  parsed = parseArgs(process.argv.slice(2)),
  readFile = readFileSync,
  ledger = undefined,
} = {}) {
  if (!parsed.taskUsageReport)
    throw new Error(
      'A sanitized task usage report is required. Generate one from the task-usage operation and pass --task-usage-report <path>.',
    )
  const taskUsageReport = readTaskUsageReport(parsed.taskUsageReport, readFile)
  const branch = output(exec, 'git', ['branch', '--show-current'])
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  if (output(exec, 'git', ['status', '--porcelain']))
    throw new Error('Working tree must be clean.')
  const rows = JSON.parse(
    output(exec, 'gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,isDraft,baseRefName,headRefName,headRefOid,body',
    ]),
  )
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Exactly one open PR for the current branch is required.')
  const pr = rows[0]
  if (!pr.isDraft || pr.baseRefName !== 'main' || pr.headRefName !== branch)
    throw new Error(
      'PR must be a Draft targeting main from the current branch.',
    )
  if (pr.headRefOid !== head)
    throw new Error('Push the current HEAD before making the PR ready.')
  if (
    typeof pr.body !== 'string' ||
    !pr.body.includes(taskUsageReport.markdown)
  )
    throw new Error(
      'The PR body must contain the exact generated workflow usage block from the supplied task usage report.',
    )
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

export { deferredItems, isUiFile, parseArgs, ready, validateTaskUsageReport }

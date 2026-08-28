import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  ledgerPath,
  readLedger,
  recordDeferred,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function parseArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const flags = new Set(['--dry-run', '--ui-gate-complete', '--no-deferred'])
  const values = new Set(['--deferred', '--deferred-file'])
  const parsed = { deferred: [], deferredFile: undefined }
  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index]
    if (flags.has(arg)) continue
    if (!values.has(arg)) throw new Error(usage())
    const value = normalized[++index]
    if (!value || value.startsWith('--')) throw new Error(usage())
    if (arg === '--deferred') parsed.deferred.push(value)
    else parsed.deferredFile = value
  }
  return {
    ...parsed,
    dryRun: normalized.includes('--dry-run'),
    uiGateComplete: normalized.includes('--ui-gate-complete'),
    noDeferred: normalized.includes('--no-deferred'),
  }
}

function usage() {
  return 'Usage: pnpm pr:ready -- [--dry-run] [--ui-gate-complete] (--no-deferred | --deferred <text> ... | --deferred-file <path>)'
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
      'number,isDraft,baseRefName,headRefName,headRefOid',
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

export { deferredItems, isUiFile, parseArgs, ready }

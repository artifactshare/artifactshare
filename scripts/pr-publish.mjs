import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireFileLock } from './os-file-lock.mjs'
import { inspectMetadata } from './public-development-guard.mjs'
import {
  ledgerPath,
  outstandingEntries,
  readLedger,
} from './landing-ledger.mjs'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function parsePullRequestRows(value, { includeBase }) {
  if (!Array.isArray(value))
    throw new Error(
      'GitHub PR query returned an unexpected result; no write performed',
    )
  const numbers = new Set()
  const branches = new Set()
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      !Number.isInteger(row.number) ||
      row.number <= 0 ||
      typeof row.headRefName !== 'string' ||
      row.headRefName.length === 0 ||
      typeof row.isCrossRepository !== 'boolean' ||
      (includeBase &&
        (typeof row.baseRefName !== 'string' ||
          row.baseRefName.length === 0)) ||
      numbers.has(row.number) ||
      (!row.isCrossRepository && branches.has(row.headRefName))
    )
      throw new Error(
        'GitHub PR query returned an unexpected result; no write performed',
      )
    numbers.add(row.number)
    if (!row.isCrossRepository) branches.add(row.headRefName)
  }
  return value
}

function branchPullRequest(exec, branch) {
  let rows
  try {
    rows = parsePullRequestRows(
      JSON.parse(
        output(exec, 'gh', [
          'pr',
          'list',
          '--state',
          'open',
          '--json',
          'number,baseRefName,headRefName,isCrossRepository',
        ]),
      ),
      { includeBase: true },
    )
  } catch (error) {
    throw new Error(
      `GitHub PR query failed; no write performed: ${error.message}`,
    )
  }
  if (rows.length > 3)
    throw new Error(
      'more than three open pull requests exist; no write performed',
    )
  const wrongBase = rows.find((row) => row.baseRefName !== 'main')
  if (wrongBase)
    throw new Error(
      `pull request #${wrongBase.number} base must be main, found ${wrongBase.baseRefName}; no write performed`,
    )
  const pr =
    rows.find((row) => !row.isCrossRepository && row.headRefName === branch) ??
    null
  if (!pr && rows.length === 3)
    throw new Error(
      'creating this pull request would exceed the three-open-PR limit; no write performed',
    )
  return pr
}

/** Swallowing a failure here would read this branch's own entry as a previous
 * change's and refuse the publish with advice that cannot work, so the query
 * failing is reported as itself. */
function currentPrNumber(exec, branch) {
  if (!branch) return null
  let rows
  try {
    rows = parsePullRequestRows(
      JSON.parse(
        output(exec, 'gh', [
          'pr',
          'list',
          '--state',
          'open',
          '--json',
          'number,headRefName,isCrossRepository',
        ]),
      ),
      { includeBase: false },
    )
  } catch (error) {
    throw new Error(
      `GitHub PR query failed; no write performed: ${error.message}`,
    )
  }
  return (
    rows.find((row) => !row.isCrossRepository && row.headRefName === branch)
      ?.number ?? null
  )
}

export function publishLockPath(exec) {
  return join(
    resolve(output(exec, 'git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'pr-publish.lock',
  )
}

/** A previous change deferred review findings and has not discharged them.
 * Starting the next change is the moment that deferral would otherwise be
 * forgotten, so it is also the moment the gate refuses. */
export function assertNoOutstandingLanding(exec, ledger, branch) {
  const path = ledger ?? ledgerPath()
  const state = readLedger(path)
  if (state.unreadable)
    throw new Error(
      `The landing ledger at ${path} could not be read; no write performed. Repair or remove it, then retry.`,
    )
  // The change being published now may already have recorded its own deferrals
  // at pr:ready; they are discharged after it lands, so they must not block
  // updating its own body in the meantime.
  const current = currentPrNumber(exec, branch)
  const outstanding = outstandingEntries(state).filter(
    (entry) => entry.pr !== current,
  )
  if (outstanding.length === 0) return
  const lines = outstanding.flatMap((entry) => [
    `PR #${entry.pr} (${entry.head.slice(0, 12)}):`,
    ...entry.deferred.map((item) => `  - ${item}`),
  ])
  throw new Error(
    [
      'A previous change deferred review findings that were never discharged; no write performed.',
      ...lines,
      'Finish the prior landing cleanup:',
      '  pnpm pr:landed -- --pr <number>',
    ].join('\n'),
  )
}

export async function publishPullRequest({
  bodyFile,
  title,
  exec = execFileSync,
  readFile = fs.readFileSync,
  dryRun = false,
  ledger = undefined,
  acquireLock = acquireFileLock,
} = {}) {
  if (!bodyFile || !title)
    throw new Error(
      'Usage: pnpm pr:publish -- --body-file <path> --title <title>',
    )
  let body
  try {
    body = readFile(bodyFile, 'utf8')
  } catch (error) {
    throw new Error(
      `could not read PR body; no write performed: ${error.message}`,
    )
  }
  inspectMetadata(title, 'pull request title')
  inspectMetadata(body, 'pull request body')

  const branch = output(exec, 'git', ['branch', '--show-current'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  assertNoOutstandingLanding(exec, ledger, branch)
  const release = await acquireLock(publishLockPath(exec))
  let operationError
  let result
  try {
    // This is the authoritative slot snapshot. Keep the shared lock until the
    // corresponding create or edit finishes so concurrent publishers cannot
    // both consume the same remaining slot.
    const pr = branchPullRequest(exec, branch)
    if (dryRun) {
      result = {
        mode: pr ? 'update' : 'create',
        number: pr?.number,
        dryRun: true,
      }
    } else if (pr) {
      exec('gh', [
        'pr',
        'edit',
        String(pr.number),
        '--title',
        title,
        '--body-file',
        bodyFile,
      ])
      result = { mode: 'update', number: pr.number }
    } else {
      exec('git', ['push', '--set-upstream', 'origin', branch])
      exec('gh', [
        'pr',
        'create',
        '--draft',
        '--base',
        'main',
        '--title',
        title,
        '--body-file',
        bodyFile,
      ])
      result = { mode: 'create' }
    }
  } catch (error) {
    operationError = error
  }
  try {
    await release()
  } catch (releaseError) {
    if (!operationError) throw releaseError
    const diagnostic =
      releaseError instanceof Error
        ? releaseError.message
        : String(releaseError)
    if (operationError instanceof Error)
      operationError.message += `\nAdditionally, publish-lock release failed: ${diagnostic}`
  }
  if (operationError) throw operationError
  return result
}

export function parsePublishArgs(args) {
  const values = { dryRun: false, help: false }
  const start = args[0] === '--' ? 1 : 0
  for (let index = start; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--help' || name === '-h') {
      values.help = true
      continue
    }
    if (name === '--dry-run') {
      values.dryRun = true
      continue
    }
    if (name !== '--body-file' && name !== '--title')
      throw new Error(`unknown argument: ${name}`)
    if (values[name]) throw new Error(`duplicate argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${name}`)
    values[name] = value
  }
  return {
    bodyFile: values['--body-file'],
    title: values['--title'],
    dryRun: values.dryRun,
    help: values.help,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parsePublishArgs(process.argv.slice(2))
  if (options.help)
    console.log(
      'Usage: pnpm pr:publish -- --body-file <path> --title <title> [--dry-run]',
    )
  else console.log(JSON.stringify(await publishPullRequest(options)))
}

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Queue a ready PR and watch the merge-group run it produces. The PR's own
// state stays OPEN while a queue run fails, so waiting on the PR alone hides
// failures; this watches the run that the queue entry created and reports a
// failure with its failed jobs and the failing log lines.

const LOG_MAX_BUFFER = 64 * 1024 * 1024
const TRANSIENT_ERROR_BUDGET = 3
const TRANSIENT_ERROR_TOTAL = 12
// Conclusions that end a queue run without a verdict on the change: the queue
// replaced the entry (a new run follows) or GitHub dropped it.
const REPLACED_CONCLUSIONS = new Set(['cancelled', 'skipped', 'stale'])
// How long a replaced run may go without a successor before it is reported.
const REPLACEMENT_GRACE_MS = 15 * 60_000
const RETRY_DELAY_MS = 5_000
// gh's wording when auto-merge is not enabled (observed: "Can't disable
// auto-merge for this pull request.").
const NOT_QUEUED =
  /can.t disable auto-merge|not enabled|not queued|is not in a merge queue|no auto-merge/iu
const GONE_STATES = new Set(['CLOSED', 'MERGED'])

/** The PR left the queue for good; no polling can recover from this. */
class QueueGoneError extends Error {}

/** One line of the useful part of a failed gh call (stderr when present). */
function errorText(error) {
  const stderr =
    error && typeof error === 'object' && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : ''
  const message = (
    stderr || (error instanceof Error ? error.message : String(error))
  ).trim()
  return message.split('\n')[0]
}

function output(exec, file, args, options = {}) {
  return exec(file, args, { encoding: 'utf8', ...options }).trim()
}

function usage() {
  return 'Usage: pnpm pr:queue -- --pr <number> [--interval <seconds>] [--timeout <minutes>] [--no-wait]'
}

function parseArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const values = { pr: undefined, interval: 30, timeout: 90, wait: true }
  for (let index = 0; index < normalized.length; index += 1) {
    const name = normalized[index]
    if (name === '--no-wait') {
      values.wait = false
      continue
    }
    const value = normalized[index + 1]
    if (!value || value.startsWith('--')) throw new Error(usage())
    if (name === '--pr') values.pr = Number.parseInt(value, 10)
    else if (name === '--interval') values.interval = Number.parseInt(value, 10)
    else if (name === '--timeout') values.timeout = Number.parseInt(value, 10)
    else throw new Error(usage())
    index += 1
  }
  if (!Number.isInteger(values.pr) || values.pr <= 0) throw new Error(usage())
  if (!Number.isInteger(values.interval) || values.interval < 5)
    throw new Error('--interval must be at least 5 seconds.')
  if (!Number.isInteger(values.timeout) || values.timeout < 1)
    throw new Error('--timeout must be at least 1 minute.')
  return values
}

/** Merge-group runs for this PR, newest first, excluding known run ids. */
function queueRuns(exec, pr, known = new Set()) {
  const rows = JSON.parse(
    output(exec, 'gh', [
      'run',
      'list',
      '--event',
      'merge_group',
      '--limit',
      '50',
      '--json',
      'databaseId,status,conclusion,headBranch,createdAt',
    ]),
  )
  return rows
    .filter(
      (row) =>
        typeof row.headBranch === 'string' &&
        row.headBranch.includes(`/pr-${pr}-`) &&
        !known.has(row.databaseId),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

function runView(exec, runId) {
  return JSON.parse(
    output(exec, 'gh', [
      'run',
      'view',
      String(runId),
      '--json',
      'databaseId,status,conclusion,headBranch,createdAt',
    ]),
  )
}

function failedJobs(exec, runId) {
  const run = JSON.parse(
    output(exec, 'gh', ['run', 'view', String(runId), '--json', 'jobs']),
  )
  return (run.jobs ?? [])
    .filter((job) => job.conclusion === 'failure')
    .map((job) => job.name)
}

const FAILURE_LINE = /(^|\s)(FAIL|Error:|error TS\d+|AssertionError|✖|×)/u
// gh prints "job<TAB>step<TAB>timestamp " before every log line.
const LOG_PREFIX = /^[^\t]*\t[^\t]*\t\S+\s?/u
// Built from the code point so the source carries no control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')

function failureSummary(exec, runId, limit = 20) {
  let log
  try {
    log = output(exec, 'gh', ['run', 'view', String(runId), '--log-failed'], {
      maxBuffer: LOG_MAX_BUFFER,
    })
  } catch (error) {
    return [`(failed log unavailable: ${errorText(error)})`]
  }
  const lines = []
  for (const raw of log.split('\n')) {
    const line = raw.replace(ANSI, '').replace(LOG_PREFIX, '').trim()
    if (!line || !FAILURE_LINE.test(line)) continue
    if (lines.includes(line)) continue
    lines.push(line)
    if (lines.length >= limit) break
  }
  return lines
}

function prState(exec, pr) {
  return JSON.parse(
    output(exec, 'gh', [
      'pr',
      'view',
      String(pr),
      '--json',
      'state,isDraft,mergeStateStatus',
    ]),
  )
}

function failureReport(exec, pr, run, log) {
  const jobs = failedJobs(exec, run.databaseId)
  const summary = failureSummary(exec, run.databaseId)
  log(
    `Merge queue run ${run.databaseId} for PR #${pr} ended with ${run.conclusion}.`,
  )
  for (const job of jobs) log(`  failed job: ${job}`)
  for (const line of summary) log(`  ${line}`)
  return {
    kind: 'failed',
    pr,
    run: run.databaseId,
    conclusion: run.conclusion,
    jobs,
    summary,
  }
}

/**
 * One poll. `watch` remembers the runs of this entry across polls so a run
 * that scrolls out of the list window is still checked by id. Returns a
 * terminal result or null to keep waiting.
 */
function poll(exec, pr, watch, log, now) {
  const current = prState(exec, pr)
  if (current.state === 'MERGED') {
    log(`PR #${pr} merged.`)
    return { kind: 'merged', pr }
  }
  if (GONE_STATES.has(current.state))
    throw new QueueGoneError(
      `PR #${pr} is ${current.state}; the queue entry is gone.`,
    )
  if (current.state !== 'OPEN')
    throw new Error(`Unexpected PR state ${JSON.stringify(current.state)}.`)
  const listed = queueRuns(exec, pr, watch.known)
  const newest = listed[0]
  if (newest && newest.headBranch !== watch.group) {
    // A new merge group for this PR: only runs on that branch count now.
    watch.group = newest.headBranch
    watch.replacedAt = null
    watch.runs.clear()
  }
  const group = watch.group
    ? listed.filter((run) => run.headBranch === watch.group)
    : []
  for (const run of group) watch.runs.set(run.databaseId, run)
  // Refresh remembered runs that no longer appear in the list window.
  for (const [id, remembered] of watch.runs) {
    if (remembered.status === 'completed') continue
    if (group.some((run) => run.databaseId === id)) continue
    watch.runs.set(id, runView(exec, id))
  }
  const runs = [...watch.runs.values()]
  if (runs.length === 0) {
    if (
      watch.replacedAt !== null &&
      now() - watch.replacedAt > REPLACEMENT_GRACE_MS
    )
      throw new QueueGoneError(
        `PR #${pr}: the queue cancelled its run and did not rebuild the entry within ${REPLACEMENT_GRACE_MS / 60_000} minutes.`,
      )
    return null
  }
  const failed = runs.find(
    (run) =>
      run.status === 'completed' &&
      run.conclusion !== 'success' &&
      !REPLACED_CONCLUSIONS.has(run.conclusion),
  )
  if (failed) return failureReport(exec, pr, failed, log)
  if (runs.every((run) => run.status === 'completed')) {
    if (runs.every((run) => run.conclusion === 'success')) return null
    // Every run of this group ended cancelled/skipped/stale: the queue rebuilt
    // the entry (a successor is coming) or dropped it. Wait a bounded time.
    if (watch.replacedAt === null) {
      watch.replacedAt = now()
      for (const run of runs) watch.known.add(run.databaseId)
      const replaced = runs.find((run) =>
        REPLACED_CONCLUSIONS.has(run.conclusion),
      )
      log(
        `Merge queue run ${replaced.databaseId} was ${replaced.conclusion}; waiting for its replacement.`,
      )
      watch.runs.clear()
      return null
    }
  }
  return null
}

async function ghWithRetries(
  fn,
  log,
  sleep,
  attempts = TRANSIENT_ERROR_BUDGET,
) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn()
    } catch (error) {
      lastError = error
      log(`gh call failed (${attempt}/${attempts}): ${errorText(error)}`)
      if (attempt < attempts) await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

async function queue({
  args = process.argv.slice(2),
  exec = execFileSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const parsed = parseArgs(args)
  const state = prState(exec, parsed.pr)
  if (state.state === 'MERGED') {
    log(`PR #${parsed.pr} is already merged.`)
    return { kind: 'merged', pr: parsed.pr }
  }
  if (state.state !== 'OPEN')
    throw new Error(`PR #${parsed.pr} is ${state.state}.`)
  if (state.isDraft)
    throw new Error(`PR #${parsed.pr} is a Draft; run pnpm pr:ready first.`)
  // Rebuild the queue entry so it runs the current head, not an old snapshot.
  // A previous entry that cannot be cleared is an error: continuing would
  // watch a run of the old snapshot.
  try {
    exec('gh', ['pr', 'merge', String(parsed.pr), '--disable-auto'], {
      encoding: 'utf8',
    })
  } catch (error) {
    const text = errorText(error)
    if (!NOT_QUEUED.test(text))
      throw new Error(
        `Could not clear the previous queue entry for PR #${parsed.pr}: ${text}`,
      )
  }
  // Runs that exist now belong to earlier entries (including the one just
  // cancelled); they are never this attempt's run.
  const known = new Set(
    (await ghWithRetries(() => queueRuns(exec, parsed.pr), log, sleep)).map(
      (run) => run.databaseId,
    ),
  )
  await ghWithRetries(
    () =>
      exec('gh', ['pr', 'merge', String(parsed.pr), '--auto'], {
        encoding: 'utf8',
      }),
    log,
    sleep,
  )
  log(`Queued PR #${parsed.pr}.`)
  if (!parsed.wait) return { kind: 'queued', pr: parsed.pr }

  const watch = { known, group: null, runs: new Map(), replacedAt: null }
  const deadline = now() + parsed.timeout * 60_000
  let consecutive = 0
  let total = 0
  while (now() < deadline) {
    let result
    try {
      result = poll(exec, parsed.pr, watch, log, now)
      consecutive = 0
    } catch (error) {
      if (error instanceof QueueGoneError) throw error
      consecutive += 1
      total += 1
      if (consecutive > TRANSIENT_ERROR_BUDGET || total > TRANSIENT_ERROR_TOTAL)
        throw error
      log(
        `gh call failed (${consecutive}/${TRANSIENT_ERROR_BUDGET}, ${total}/${TRANSIENT_ERROR_TOTAL} total); retrying: ${errorText(error)}`,
      )
    }
    if (result) return result
    await sleep(parsed.interval * 1000)
  }
  throw new Error(
    `Timed out after ${parsed.timeout} minutes waiting for PR #${parsed.pr} to merge; the queue entry may still be running.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  queue()
    .then((result) => {
      if (result.kind === 'failed') process.exitCode = 1
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })
}

export { failureSummary, parseArgs, queue, queueRuns }

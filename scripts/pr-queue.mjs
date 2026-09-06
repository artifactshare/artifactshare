import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Queue a ready PR and watch the merge-group run it produces. The PR's own
// state stays OPEN while a queue run fails, so waiting on the PR alone hides
// failures; this watches the run that the queue entry created and reports a
// failure with its failed jobs and the failing log lines.

const LOG_MAX_BUFFER = 64 * 1024 * 1024
const TRANSIENT_ERROR_BUDGET = 3
// Conclusions that end a queue run without a verdict on the change: the queue
// replaced the entry (a new run follows) or GitHub dropped it.
const REPLACED_CONCLUSIONS = new Set(['cancelled', 'skipped', 'stale'])

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
      '20',
      '--json',
      'databaseId,status,conclusion,headBranch,createdAt',
    ]),
  )
  return rows.filter(
    (row) =>
      typeof row.headBranch === 'string' &&
      row.headBranch.includes(`/pr-${pr}-`) &&
      !known.has(row.databaseId),
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
const ANSI = /\[[0-9;]*m/gu

function failureSummary(exec, runId, limit = 20) {
  let log
  try {
    log = output(exec, 'gh', ['run', 'view', String(runId), '--log-failed'], {
      maxBuffer: LOG_MAX_BUFFER,
    })
  } catch (error) {
    return [
      `(failed log unavailable: ${error instanceof Error ? error.message : String(error)})`,
    ]
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

/** One poll: returns a terminal result or null to keep waiting. */
function poll(exec, pr, known, log) {
  const current = prState(exec, pr)
  if (current.state === 'MERGED') {
    log(`PR #${pr} merged.`)
    return { kind: 'merged', pr }
  }
  if (current.state !== 'OPEN')
    throw new Error(`PR #${pr} is ${current.state}; the queue entry is gone.`)
  const run = queueRuns(exec, pr, known)[0]
  if (!run || run.status !== 'completed') return null
  if (REPLACED_CONCLUSIONS.has(run.conclusion)) {
    // The queue rebuilt the entry; forget this run and wait for its successor.
    known.add(run.databaseId)
    log(
      `Merge queue run ${run.databaseId} was ${run.conclusion}; waiting for its replacement.`,
    )
    return null
  }
  if (run.conclusion === 'success') return null
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
  // Runs that exist before requeueing belong to earlier entries, including the
  // one --disable-auto cancels below; they are never this attempt's run.
  const known = new Set(queueRuns(exec, parsed.pr).map((run) => run.databaseId))
  // Rebuild the queue entry so it runs the current head, not an old snapshot.
  try {
    exec('gh', ['pr', 'merge', String(parsed.pr), '--disable-auto'], {
      encoding: 'utf8',
    })
  } catch (error) {
    log(
      `Previous queue entry not cleared (${error instanceof Error ? error.message.trim() : String(error)}); continuing.`,
    )
  }
  exec('gh', ['pr', 'merge', String(parsed.pr), '--auto'], {
    encoding: 'utf8',
  })
  log(`Queued PR #${parsed.pr}.`)
  if (!parsed.wait) return { kind: 'queued', pr: parsed.pr }

  const deadline = now() + parsed.timeout * 60_000
  let transientErrors = 0
  while (now() < deadline) {
    let result
    try {
      result = poll(exec, parsed.pr, known, log)
      transientErrors = 0
    } catch (error) {
      if (
        error instanceof Error &&
        /is (CLOSED|MERGED|[A-Z]+); the queue entry is gone/u.test(
          error.message,
        )
      )
        throw error
      transientErrors += 1
      if (transientErrors > TRANSIENT_ERROR_BUDGET) throw error
      log(
        `gh call failed (${transientErrors}/${TRANSIENT_ERROR_BUDGET}); retrying: ${error instanceof Error ? error.message.trim() : String(error)}`,
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

export { failureSummary, parseArgs, poll, queue, queueRuns }

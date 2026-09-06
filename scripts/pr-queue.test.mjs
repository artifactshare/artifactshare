import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureSummary, parseArgs, queue, queueRuns } from './pr-queue.mjs'

const TAB = String.fromCharCode(9)
const ESC = String.fromCharCode(27)

function logLine(job, step, stamp, text) {
  return `${job}${TAB}${step}${TAB}${stamp} ${text}`
}

function run(databaseId, status, conclusion = null) {
  return {
    databaseId,
    status,
    conclusion,
    headBranch: 'gh-readonly-queue/main/pr-12-abc',
    createdAt: '2026-09-07T00:11:00Z',
  }
}

// `runLists` are returned in order by successive `gh run list` calls; the
// last one repeats. `states` behave the same for `gh pr view`.
function harness({
  states = ['OPEN', 'OPEN', 'MERGED'],
  runLists = [[]],
  jobs = [],
  logText = '',
  failing = () => false,
} = {}) {
  const calls = []
  let stateIndex = 0
  let runIndex = 0
  let clock = Date.parse('2026-09-07T00:10:00Z')
  const exec = (file, args) => {
    calls.push([file, args])
    if (failing(file, args)) throw new Error('gh: 502 Bad Gateway')
    if (file !== 'gh') return ''
    if (args[0] === 'pr' && args[1] === 'view') {
      const state = states[Math.min(stateIndex, states.length - 1)]
      stateIndex += 1
      return JSON.stringify({
        state,
        isDraft: false,
        mergeStateStatus: 'CLEAN',
      })
    }
    if (args[0] === 'pr' && args[1] === 'merge') return ''
    if (args[0] === 'run' && args[1] === 'list') {
      const rows = runLists[Math.min(runIndex, runLists.length - 1)]
      runIndex += 1
      return JSON.stringify(rows)
    }
    if (args[0] === 'run' && args[1] === 'view' && args[4] === 'jobs')
      return JSON.stringify({ jobs })
    if (args[0] === 'run' && args[1] === 'view') return logText
    return ''
  }
  const logs = []
  return {
    calls,
    exec,
    logs,
    log: (line) => logs.push(line),
    sleep: (ms) => {
      clock += ms
      return Promise.resolve()
    },
    now: () => clock,
  }
}

test('parses the PR number and polling options', () => {
  assert.deepEqual(parseArgs(['--', '--pr', '12']), {
    pr: 12,
    interval: 30,
    timeout: 90,
    wait: true,
  })
  assert.deepEqual(
    parseArgs(['--pr', '3', '--interval', '10', '--timeout', '5', '--no-wait']),
    { pr: 3, interval: 10, timeout: 5, wait: false },
  )
  assert.throws(() => parseArgs([]))
  assert.throws(() => parseArgs(['--pr', '3', '--interval', '1']))
})

test('filters queue runs to this PR and drops known run ids', () => {
  const exec = () =>
    JSON.stringify([
      run(1, 'completed', 'cancelled'),
      run(2, 'in_progress'),
      {
        ...run(3, 'in_progress'),
        headBranch: 'gh-readonly-queue/main/pr-120-xyz',
      },
    ])
  assert.deepEqual(
    queueRuns(exec, 12, new Set([1])).map((row) => row.databaseId),
    [2],
  )
})

test('rebuilds the queue entry and reports a merge', async () => {
  const h = harness()
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  const merges = h.calls.filter(([, a]) => a[0] === 'pr' && a[1] === 'merge')
  assert.deepEqual(
    merges.map(([, a]) => a[3]),
    ['--disable-auto', '--auto'],
  )
  assert.match(h.logs.at(-1), /merged/u)
})

test('ignores the run cancelled by the rebuild and waits for the replacement', async () => {
  // Run 1 existed before requeueing and is cancelled by --disable-auto; run 2
  // is this entry's run and is itself replaced once before run 3 succeeds.
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'MERGED'],
    runLists: [
      [run(1, 'in_progress')],
      [run(1, 'completed', 'cancelled')],
      [run(2, 'completed', 'cancelled'), run(1, 'completed', 'cancelled')],
      [run(3, 'in_progress'), run(2, 'completed', 'cancelled')],
    ],
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  assert.ok(h.logs.some((line) => /run 2 was cancelled/u.test(line)))
  assert.ok(!h.logs.some((line) => /ended with/u.test(line)))
})

test('reports a failed merge-group run with its jobs and log lines', async () => {
  const stamp = '2026-09-07T00:12:00.000Z'
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN'],
    runLists: [[], [run(9, 'completed', 'failure')]],
    jobs: [
      { name: 'Public Linux visual validation', conclusion: 'failure' },
      { name: 'Public full validation', conclusion: 'failure' },
      { name: 'Public CLI validation', conclusion: 'success' },
    ],
    logText: [
      logLine(
        'Public Linux visual validation',
        'Run visual',
        stamp,
        `${ESC}[31m×${ESC}[39m public-pricing desktop light`,
      ),
      logLine(
        'Public Linux visual validation',
        'Run visual',
        stamp,
        'Expected image dimensions to be 333×4653px',
      ),
      logLine(
        'Public Linux visual validation',
        'Run visual',
        stamp,
        'Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL',
      ),
    ].join('\n'),
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'failed')
  assert.equal(result.run, 9)
  assert.deepEqual(result.jobs, [
    'Public Linux visual validation',
    'Public full validation',
  ])
  assert.deepEqual(result.summary, [
    '× public-pricing desktop light',
    'Error: ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL',
  ])
  assert.ok(h.logs.some((line) => /ended with failure/u.test(line)))
})

test('tolerates a few transient gh errors and stops on a closed PR', async () => {
  // Fail the first two polls after queueing; the pre-queue snapshot must not.
  let queued = false
  let failures = 0
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN', 'MERGED'],
    failing: (file, args) => {
      if (args[0] === 'pr' && args[1] === 'merge') queued = true
      return queued && args[0] === 'run' && args[1] === 'list' && failures++ < 2
    },
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  assert.equal(h.logs.filter((line) => /retrying/u.test(line)).length, 2)

  const closed = harness({ states: ['OPEN', 'CLOSED'] })
  await assert.rejects(
    queue({ args: ['--pr', '12'], ...closed }),
    /CLOSED; the queue entry is gone/u,
  )
})

test('times out when the entry never settles', async () => {
  const h = harness({ states: ['OPEN', 'OPEN'] })
  await assert.rejects(
    queue({ args: ['--pr', '12', '--timeout', '1', '--interval', '30'], ...h }),
    /Timed out after 1 minutes/u,
  )
})

test('summarizes only failure lines, strips job prefixes, and survives an unreadable log', () => {
  const exec = () =>
    [
      logLine('job', 'step', '2026-09-07T00:00:00Z', 'ok line'),
      logLine(
        'job',
        'step',
        '2026-09-07T00:00:01Z',
        'FAIL integration/x.test.ts',
      ),
      logLine(
        'job',
        'step',
        '2026-09-07T00:00:01Z',
        'FAIL integration/x.test.ts',
      ),
    ].join('\n')
  assert.deepEqual(failureSummary(exec, 1), ['FAIL integration/x.test.ts'])
  const broken = () => {
    throw new Error('ENOBUFS')
  }
  assert.deepEqual(failureSummary(broken, 1), [
    '(failed log unavailable: ENOBUFS)',
  ])
})

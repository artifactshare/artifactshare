import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureSummary, parseArgs, queue, queueRuns } from './pr-queue.mjs'

const TAB = String.fromCharCode(9)
const ESC = String.fromCharCode(27)

function logLine(job, step, stamp, text) {
  return `${job}${TAB}${step}${TAB}${stamp} ${text}`
}

function harness({
  states = ['OPEN', 'OPEN', 'MERGED'],
  runs = [],
  runViews = {},
  jobs = [],
  logText = '',
} = {}) {
  const calls = []
  let stateIndex = 0
  const exec = (file, args) => {
    calls.push([file, args])
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
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs)
    if (args[0] === 'run' && args[1] === 'view' && args.includes('--json')) {
      if (args[4] === 'jobs') return JSON.stringify({ jobs })
      return JSON.stringify(runViews[args[2]] ?? { status: 'queued' })
    }
    if (args[0] === 'run' && args[1] === 'view') return logText
    return ''
  }
  const logs = []
  return {
    calls,
    exec,
    logs,
    log: (line) => logs.push(line),
    sleep: async () => {},
    now: () => Date.parse('2026-09-07T00:10:00Z'),
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

test('ignores queue runs from before this queue entry and other PRs', () => {
  const since = Date.parse('2026-09-07T00:00:00Z')
  const exec = () =>
    JSON.stringify([
      {
        databaseId: 1,
        headBranch: 'gh-readonly-queue/main/pr-12-abc',
        createdAt: '2026-09-06T23:00:00Z',
      },
      {
        databaseId: 2,
        headBranch: 'gh-readonly-queue/main/pr-12-def',
        createdAt: '2026-09-07T00:05:00Z',
      },
      {
        databaseId: 3,
        headBranch: 'gh-readonly-queue/main/pr-120-xyz',
        createdAt: '2026-09-07T00:05:00Z',
      },
    ])
  assert.deepEqual(
    queueRuns(exec, 12, since).map((run) => run.databaseId),
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

test('reports a failed merge-group run with its jobs and log lines', async () => {
  const stamp = '2026-09-07T00:12:00.000Z'
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN'],
    runs: [
      {
        databaseId: 9,
        headBranch: 'gh-readonly-queue/main/pr-12-abc',
        createdAt: '2026-09-07T00:11:00Z',
      },
    ],
    runViews: { 9: { status: 'completed', conclusion: 'failure' } },
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
  assert.match(h.logs[1], /ended with failure/u)
})

test('summarizes only failure lines and strips job prefixes', () => {
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
})

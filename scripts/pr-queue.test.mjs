import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureSummary, parseArgs, queue, queueRuns } from './pr-queue.mjs'

const TAB = String.fromCharCode(9)
const ESC = String.fromCharCode(27)

function logLine(job, step, stamp, text) {
  return `${job}${TAB}${step}${TAB}${stamp} ${text}`
}

function run(databaseId, status, conclusion = null, branch = 'abc') {
  return {
    databaseId,
    status,
    conclusion,
    headBranch: `gh-readonly-queue/main/pr-12-${branch}`,
    createdAt: `2026-09-07T00:1${databaseId % 10}:00Z`,
  }
}

// `runLists` are returned in order by successive `gh run list` calls; the
// last one repeats. `states` behave the same for `gh pr view`. `runViews`
// answers `gh run view <id> --json ...` for runs that left the list window.
function harness({
  states = ['OPEN', 'OPEN', 'MERGED'],
  runLists = [[]],
  runViews = {},
  jobs = [],
  logText = '',
  failing = () => false,
  graphql = null,
  entry = null,
  draft = false,
} = {}) {
  const calls = []
  let monitoring = false
  let stateIndex = 0
  let runIndex = 0
  let clock = Date.parse('2026-09-07T00:10:00Z')
  const exec = (file, args, options) => {
    calls.push([file, args, options])
    if (monitoring) {
      assert.ok(!args.some((arg) => arg.includes('mutation(')))
      assert.notEqual(args[1], 'merge')
    }
    if (failing(file, args)) throw new Error('gh: 502 Bad Gateway')
    if (file !== 'gh') return ''
    if (args[0] === 'api' && args[1] === 'graphql') {
      assert.equal(options.timeout, 30_000)
      assert.ok(args.includes('pullRequestId=PR_TEST'))
      const query = args[3]
      const operation = query.includes('dequeuePullRequest')
        ? 'dequeue'
        : query.includes('enqueuePullRequest')
          ? 'enqueue'
          : query.includes('headCommit')
            ? 'diagnostic'
            : 'read'
      if (graphql) {
        const response = graphql(operation)
        if (response !== undefined)
          return typeof response === 'string'
            ? response
            : JSON.stringify(response)
      }
      if (operation === 'dequeue') {
        assert.match(query, /input: \{ id: \$pullRequestId \}/u)
        entry = null
        return JSON.stringify({
          data: { dequeuePullRequest: { clientMutationId: null } },
        })
      }
      if (operation === 'enqueue') {
        assert.match(query, /input: \{ pullRequestId: \$pullRequestId \}/u)
        assert.equal(entry, null)
        entry = { id: 'ENTRY_NEW', enqueuedAt: new Date(clock).toISOString() }
        return JSON.stringify({
          data: { enqueuePullRequest: { mergeQueueEntry: entry } },
        })
      }
      return JSON.stringify({
        data: {
          node: { id: 'PR_TEST', state: 'OPEN', mergeQueueEntry: entry },
        },
      })
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const state = states[Math.min(stateIndex, states.length - 1)]
      stateIndex += 1
      return JSON.stringify({
        state,
        id: 'PR_TEST',
        isDraft: draft,
        mergeStateStatus: 'CLEAN',
      })
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      return ''
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const rows = runLists[Math.min(runIndex, runLists.length - 1)]
      runIndex += 1
      return JSON.stringify(rows)
    }
    if (args[0] === 'run' && args[1] === 'view' && args[4] === 'jobs')
      return JSON.stringify({ jobs })
    if (args[0] === 'run' && args[1] === 'view' && args[3] === '--json')
      return JSON.stringify(runViews[args[2]] ?? run(Number(args[2]), 'queued'))
    if (args[0] === 'run' && args[1] === 'view') return logText
    return ''
  }
  const logs = []
  return {
    calls,
    exec,
    logs,
    get entry() {
      return entry
    },
    log: (line) => {
      if (line.startsWith('Queued')) monitoring = true
      logs.push(line)
    },
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

test('isolates one of three concurrent PRs, drops known ids, and sorts newest first', () => {
  const exec = () =>
    JSON.stringify([
      run(1, 'completed', 'cancelled'),
      run(2, 'in_progress'),
      run(4, 'in_progress'),
      {
        ...run(3, 'in_progress'),
        headBranch: 'gh-readonly-queue/main/pr-11-xyz',
      },
      {
        ...run(5, 'in_progress'),
        headBranch: 'gh-readonly-queue/main/pr-13-xyz',
      },
    ])
  assert.deepEqual(
    queueRuns(exec, 12, new Set([1])).map((row) => row.databaseId),
    [4, 2],
  )
})

test('rebuilds the queue entry and reports a merge', async () => {
  const h = harness({ entry: oldEntry })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  assert.deepEqual(operations(h), ['read', 'dequeue', 'read', 'enqueue'])
  assert.equal(
    h.calls.filter(([, a]) => a[0] === 'pr' && a[1] === 'merge').length,
    0,
  )
  assert.match(h.logs.at(-1), /merged/u)
})

test('ignores the run cancelled by the rebuild and waits for the replacement', async () => {
  // Run 1 existed before requeueing and is cancelled by dequeue; run 2
  // is this entry's run and is itself replaced once before run 3 succeeds.
  const h = harness({
    entry: oldEntry,
    states: ['OPEN', 'OPEN', 'OPEN', 'OPEN', 'MERGED'],
    runLists: [
      [run(1, 'in_progress')],
      [run(1, 'completed', 'cancelled')],
      [
        run(2, 'completed', 'cancelled', 'def'),
        run(1, 'completed', 'cancelled'),
      ],
      [
        run(3, 'in_progress', null, 'ghi'),
        run(2, 'completed', 'cancelled', 'def'),
      ],
    ],
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  assert.ok(h.logs.some((line) => /run 2 was cancelled/u.test(line)))
  assert.ok(!h.logs.some((line) => /ended with/u.test(line)))
})

test('reports a cancelled run that is never rebuilt', async () => {
  const h = harness({
    states: ['OPEN', 'OPEN'],
    runLists: [[], [run(2, 'completed', 'cancelled')]],
  })
  await assert.rejects(
    queue({ args: ['--pr', '12', '--interval', '60'], ...h }),
    /did not rebuild the entry/u,
  )
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

test('catches a failing sibling workflow run in the same merge group', async () => {
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN'],
    runLists: [
      [],
      [run(6, 'completed', 'success'), run(5, 'completed', 'failure')],
    ],
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'failed')
  assert.equal(result.run, 5)
})

test('keeps checking a watched run after it leaves the list window', async () => {
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN', 'OPEN'],
    runLists: [[], [run(7, 'in_progress')], []],
    runViews: { 7: run(7, 'completed', 'failure') },
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'failed')
  assert.equal(result.run, 7)
})

test('waits while every run of the group is still succeeding', async () => {
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN', 'MERGED'],
    runLists: [[], [run(8, 'completed', 'success')]],
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
})

test('tolerates a few transient gh errors but not a flapping gh', async () => {
  let queued = false
  let failures = 0
  const h = harness({
    states: ['OPEN', 'OPEN', 'OPEN', 'MERGED'],
    failing: (file, args) => {
      if (args[0] === 'pr' && args[1] === 'merge' && args[3] === '--auto')
        queued = true
      return queued && args[0] === 'run' && args[1] === 'list' && failures++ < 2
    },
  })
  const result = await queue({ args: ['--pr', '12'], ...h })
  assert.equal(result.kind, 'merged')
  assert.equal(h.logs.filter((line) => /retrying/u.test(line)).length, 2)

  // Alternate one failure with one success: the consecutive budget never
  // trips, the total budget does.
  let polls = 0
  let armed = false
  const flapping = harness({
    states: Array.from({ length: 60 }, () => 'OPEN'),
    failing: (file, args) => {
      if (args[0] === 'pr' && args[1] === 'merge' && args[3] === '--auto')
        armed = true
      return (
        armed && args[0] === 'run' && args[1] === 'list' && polls++ % 2 === 0
      )
    },
  })
  await assert.rejects(
    queue({ args: ['--pr', '12', '--timeout', '60'], ...flapping }),
    /502/u,
  )
  assert.equal(
    flapping.logs.filter((line) => /retrying/u.test(line)).length,
    12,
  )
})

test('stops on a closed PR and times out when the entry never settles', async () => {
  const closed = harness({ states: ['OPEN', 'CLOSED'] })
  await assert.rejects(
    queue({ args: ['--pr', '12'], ...closed }),
    /CLOSED; the queue entry is gone/u,
  )
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
    throw new Error('ENOBUFS\nsecond line')
  }
  assert.deepEqual(failureSummary(broken, 1), [
    '(failed log unavailable: ENOBUFS)',
  ])
  const withStderr = () => {
    const error = new Error('Command failed: gh run view')
    error.stderr = 'HTTP 502: Bad Gateway\n'
    throw error
  }
  assert.deepEqual(failureSummary(withStderr, 1), [
    '(failed log unavailable: HTTP 502: Bad Gateway)',
  ])
})

const oldEntry = { id: 'ENTRY_OLD', enqueuedAt: '2026-09-07T00:00:00Z' }
const membership = (entry, state = 'OPEN') => ({
  data: { node: { id: 'PR_TEST', state, mergeQueueEntry: entry } },
})
function operations(h) {
  return h.calls
    .filter(([, a]) => a[0] === 'api')
    .map(([, a]) =>
      a[3].includes('dequeuePullRequest')
        ? 'dequeue'
        : a[3].includes('enqueuePullRequest')
          ? 'enqueue'
          : a[3].includes('headCommit')
            ? 'diagnostic'
            : 'read',
    )
}
const noWait = ['--pr', '12', '--no-wait']

test('absent entry uses auto; merged, closed and draft preflight never mutate', async () => {
  const h = harness()
  assert.deepEqual(await queue({ ...h, args: noWait }), {
    kind: 'queued',
    pr: 12,
  })
  assert.deepEqual(operations(h), ['read'])
  assert.deepEqual(
    h.calls.filter(([, a]) => a[1] === 'merge').map(([, a]) => a[3]),
    ['--auto'],
  )
  for (const state of ['MERGED', 'CLOSED', 'DRAFT']) {
    const preflight = harness({
      states: [state === 'DRAFT' ? 'OPEN' : state],
      draft: state === 'DRAFT',
    })
    if (state === 'MERGED')
      assert.equal((await queue({ ...preflight, args: noWait })).kind, 'merged')
    else
      await assert.rejects(
        queue({ ...preflight, args: noWait }),
        /CLOSED|Draft/u,
      )
    assert.equal(preflight.calls.length, 1)
  }
})

test('confirmed absence precedes old-run snapshot and fresh enqueue', async () => {
  let reads = 0
  const h = harness({
    entry: oldEntry,
    graphql: (op) => {
      if (op === 'read' && ++reads === 2) return membership(oldEntry)
    },
  })
  assert.equal((await queue({ ...h, args: noWait })).kind, 'queued')
  assert.deepEqual(operations(h), [
    'read',
    'dequeue',
    'read',
    'read',
    'enqueue',
  ])
  const snapshot = h.calls.findIndex(([, a]) => a[1] === 'list')
  assert.match(h.calls[snapshot - 1][1][3], /node/u)
  assert.match(h.calls[snapshot + 1][1][3], /enqueuePullRequest/u)
  assert.equal(h.now(), Date.parse('2026-09-07T00:10:05Z'))
  assert.equal(h.entry.id, 'ENTRY_NEW')
  assert.ok(Date.parse(h.entry.enqueuedAt) > Date.parse(oldEntry.enqueuedAt))
})

for (const failure of ['timeout', 'malformed', 'graphql']) {
  test(`ambiguous dequeue ${failure} restores absent membership and preserves failure`, async () => {
    let removed = false
    const h = harness({
      graphql: (op) => {
        if (op === 'read') return membership(removed ? null : oldEntry)
        if (op === 'dequeue') {
          removed = true
          if (failure === 'timeout') throw new Error('removal timeout')
          if (failure === 'malformed') return '{'
          return { errors: [{ message: 'removal rejected' }] }
        }
      },
    })
    await assert.rejects(
      queue({ ...h, args: noWait }),
      /Could not clear.*recovery: queued/u,
    )
    assert.deepEqual(operations(h), [
      'read',
      'dequeue',
      'read',
      'read',
      'enqueue',
    ])
    assert.equal(
      h.logs.some((line) => line.startsWith('Queued')),
      false,
    )
    assert.equal(
      h.calls.some(([, a]) => a[1] === 'list'),
      false,
    )
  })
}

test('failed dequeue and never-absent membership fail without enqueue', async () => {
  for (const throws of [true, false]) {
    const h = harness({
      graphql: (op) => {
        if (op === 'read') return membership(oldEntry)
        if (op === 'dequeue' && throws) throw new Error('removal failed')
      },
    })
    await assert.rejects(
      queue({ ...h, args: noWait }),
      /Could not clear.*recovery: queued/u,
    )
    assert.equal(
      operations(h).filter((op) => op === 'dequeue').length,
      throws ? 3 : 1,
    )
    assert.equal(operations(h).includes('enqueue'), false)
    assert.ok(h.calls.length < 12)
  }
})

for (const recovery of [
  'absent',
  'present',
  'unreadable',
  'MERGED',
  'CLOSED',
]) {
  test(`absence confirmation failure reconciles ${recovery}`, async () => {
    let reads = 0
    const h = harness({
      graphql: (op) => {
        if (op !== 'read') return
        reads += 1
        if (reads === 1) return membership(oldEntry)
        if (reads <= 4 || recovery === 'unreadable')
          throw new Error('confirmation unavailable')
        return membership(
          recovery === 'present' ? oldEntry : null,
          ['MERGED', 'CLOSED'].includes(recovery) ? recovery : 'OPEN',
        )
      },
    })
    if (recovery === 'MERGED')
      assert.deepEqual(await queue({ ...h, args: noWait }), {
        kind: 'merged',
        pr: 12,
      })
    else
      await assert.rejects(
        queue({ ...h, args: noWait }),
        new RegExp(
          `confirmation unavailable; recovery: ${recovery === 'CLOSED' ? 'closed' : 'queued'}`,
          'u',
        ),
      )
    assert.equal(operations(h).filter((op) => op === 'dequeue').length, 1)
    assert.equal(
      operations(h).includes('enqueue'),
      ['absent', 'unreadable'].includes(recovery),
    )
    assert.ok(reads <= 7)
  })
}

for (const outcome of ['queued', 'not queued', 'queue status unknown']) {
  test(`snapshot failure recovery reports ${outcome}`, async () => {
    let reads = 0
    const h = harness({
      failing: (_, a) => a[1] === 'list',
      graphql: (op) => {
        if (op === 'read') {
          reads += 1
          if (reads === 1) return membership(oldEntry)
          if (reads > 2 && outcome === 'queue status unknown')
            throw new Error('unreadable')
          return membership(null)
        }
        if (op === 'enqueue' && outcome !== 'queued')
          throw new Error('enqueue failed')
      },
    })
    await assert.rejects(
      queue({ ...h, args: noWait }),
      new RegExp(`snapshot.*502.*recovery: ${outcome}`, 'u'),
    )
    assert.equal(
      operations(h).filter((op) => op === 'enqueue').length,
      outcome === 'queued' ? 1 : 3,
    )
    assert.equal(operations(h).filter((op) => op === 'dequeue').length, 1)
  })
}

test('enqueue lost response is confirmed without another mutation', async () => {
  let enqueued = false
  let reads = 0
  const h = harness({
    graphql: (op) => {
      if (op === 'read')
        return membership(
          ++reads === 1
            ? oldEntry
            : enqueued
              ? { ...oldEntry, id: 'ENTRY_NEW' }
              : null,
        )
      if (op === 'enqueue') {
        enqueued = true
        throw new Error('lost response')
      }
    },
  })
  assert.equal((await queue({ ...h, args: noWait })).kind, 'queued')
  assert.deepEqual(operations(h), [
    'read',
    'dequeue',
    'read',
    'enqueue',
    'read',
  ])
})

test('discovery errors never mutate', async () => {
  for (const response of [
    '{',
    { data: { node: null } },
    { errors: [{ message: 'no access' }] },
  ]) {
    const h = harness({ graphql: () => response })
    await assert.rejects(queue({ ...h, args: noWait }))
    assert.deepEqual(operations(h), ['read', 'read', 'read'])
  }
})

test('timeout is passive and truthfully separates queue age from unknown state duration', async () => {
  const h = harness({
    states: ['OPEN'],
    graphql: (op) => {
      if (op === 'diagnostic')
        return membership({
          ...oldEntry,
          state: 'AWAITING_CHECKS',
          headCommit: { statusCheckRollup: { state: 'SUCCESS' } },
        })
    },
  })
  await assert.rejects(
    queue({ ...h, args: ['--pr', '12', '--timeout', '1'] }),
    (error) => {
      for (const text of [
        'AWAITING_CHECKS',
        'SUCCESS',
        'elapsed since enqueue: 660 seconds',
        'time in current state: unknown (GitHub does not expose a transition timestamp)',
        'pnpm pr:queue -- --pr 12',
        'may still be running',
      ])
        assert.ok(error.message.includes(text), text)
      return true
    },
  )
  assert.deepEqual(operations(h), ['read', 'diagnostic'])
})

test('timeout missing fields and failed diagnostic remain honest and bounded', async () => {
  for (const entry of [
    null,
    { id: 'ENTRY_NEW', enqueuedAt: 'invalid', headCommit: null },
    { id: 'ENTRY_NEW', headCommit: { statusCheckRollup: null } },
    'error',
  ]) {
    const h = harness({
      states: ['OPEN'],
      graphql: (op) => {
        if (op !== 'diagnostic') return
        if (entry === 'error') throw new Error('diagnostic failed')
        return membership(entry)
      },
    })
    await assert.rejects(
      queue({ ...h, args: ['--pr', '12', '--timeout', '1'] }),
      entry === null
        ? /Queue entry: absent/u
        : entry === 'error'
          ? /diagnostic unavailable/u
          : /rollup state: unknown.*elapsed since enqueue: unknown/u,
    )
    assert.deepEqual(operations(h), ['read', 'diagnostic'])
  }
})

for (const budget of ['consecutive', 'total']) {
  test(`single timeout read consumes the ${budget} monitoring budget`, async () => {
    let armed = false
    let polls = 0
    const h = harness({
      states: ['OPEN'],
      failing: (_, args) => {
        if (args[1] === 'merge') armed = true
        if (!armed || args[1] !== 'list') return false
        polls += 1
        return budget === 'consecutive' || polls % 2 === 1
      },
      graphql: (op) => {
        if (op === 'diagnostic') throw new Error('diagnostic budget exhausted')
      },
    })
    await assert.rejects(
      queue({
        ...h,
        args: [
          '--pr',
          '12',
          '--timeout',
          budget === 'consecutive' ? '1' : '2',
          '--interval',
          budget === 'consecutive' ? '20' : '5',
        ],
      }),
      /Timed out.*Queue entry state: unavailable.*diagnostic budget exhausted.*Transient error budget exceeded.*pnpm pr:queue -- --pr 12/u,
    )
    assert.equal(polls, budget === 'consecutive' ? 3 : 24)
    assert.equal(operations(h).filter((op) => op === 'diagnostic').length, 1)
  })
}

test('exhausted enqueue preserves its error even when restoration succeeds', async () => {
  let enqueues = 0
  const h = harness({
    entry: oldEntry,
    graphql: (op) => {
      if (op === 'enqueue' && ++enqueues <= 3)
        throw new Error('initial enqueue unavailable')
    },
  })
  await assert.rejects(
    queue({ ...h, args: noWait }),
    /initial enqueue unavailable.*recovery: queued/u,
  )
  assert.equal(enqueues, 4)
  assert.equal(operations(h).filter((op) => op === 'dequeue').length, 1)
  assert.equal(
    h.logs.some((line) => line.startsWith('Queued')),
    false,
  )
})

for (const state of ['OPEN', 'MERGED', 'CLOSED', 'unreadable']) {
  test(`ambiguous removal with ${state} reconciliation has bounded recovery`, async () => {
    let reads = 0
    const h = harness({
      graphql: (op) => {
        if (op === 'dequeue') throw new Error('removal timeout')
        if (op === 'read') {
          reads += 1
          if (reads === 1) return membership(oldEntry)
          if (state === 'unreadable') throw new Error('membership unavailable')
          return membership(null, state)
        }
      },
    })
    if (state === 'MERGED')
      assert.deepEqual(await queue({ ...h, args: noWait }), {
        kind: 'merged',
        pr: 12,
      })
    else
      await assert.rejects(
        queue({ ...h, args: noWait }),
        /removal timeout.*recovery:/u,
      )
    assert.equal(operations(h).filter((op) => op === 'dequeue').length, 1)
    assert.equal(
      operations(h).includes('enqueue'),
      ['OPEN', 'unreadable'].includes(state),
    )
    assert.ok(reads <= 5)
  })
}

test('confirmed closed during removal suppresses recovery even if later reads fail', async () => {
  let reads = 0
  const h = harness({
    graphql: (op) => {
      if (op !== 'read') return
      reads += 1
      if (reads === 1) return membership(oldEntry)
      if (reads === 2) return membership(null, 'CLOSED')
      throw new Error('later read unavailable')
    },
  })
  await assert.rejects(
    queue({ ...h, args: noWait }),
    /CLOSED.*recovery: closed/u,
  )
  assert.deepEqual(operations(h), ['read', 'dequeue', 'read'])
})

for (const phase of ['enqueue', 'restoration']) {
  test(`merged during ${phase} verification returns the merged result`, async () => {
    let reads = 0
    const h = harness({
      failing: (_, args) => phase === 'restoration' && args[1] === 'list',
      graphql: (op) => {
        if (op === 'read') {
          reads += 1
          if (reads === 1) return membership(oldEntry)
          if (reads === 2 || (phase === 'restoration' && reads === 3))
            return membership(null)
          if (reads === (phase === 'restoration' ? 4 : 3))
            return membership(null, 'MERGED')
          assert.fail('No further reads after confirmed merge')
        }
        if (op === 'enqueue') throw new Error('enqueue response lost')
      },
    })
    assert.deepEqual(await queue({ ...h, args: ['--pr', '12'] }), {
      kind: 'merged',
      pr: 12,
    })
    assert.equal(operations(h).filter((op) => op === 'enqueue').length, 1)
    assert.equal(operations(h).filter((op) => op === 'dequeue').length, 1)
    assert.ok(!h.logs.some((line) => line.startsWith('Queued')))
    assert.match(h.logs.at(-1), /merged/u)
  })
}

for (const state of ['MERGED', 'CLOSED']) {
  test(`deadline diagnostic respects terminal PR state ${state}`, async () => {
    const h = harness({
      states: ['OPEN'],
      graphql: (op) => {
        if (op === 'diagnostic') return membership(null, state)
      },
    })
    const result = queue({ ...h, args: ['--pr', '12', '--timeout', '1'] })
    if (state === 'MERGED')
      assert.deepEqual(await result, { kind: 'merged', pr: 12 })
    else
      await assert.rejects(result, (error) => {
        assert.match(error.message, /is CLOSED; the queue entry is gone/u)
        assert.doesNotMatch(error.message, /pr:queue|may still be running/u)
        return true
      })
    assert.deepEqual(operations(h), ['read', 'diagnostic'])
    assert.ok(!h.logs.some((line) => /pr:queue/u.test(line)))
  })
}

test('failed timeout diagnostic preserves timeout context within the budget', async () => {
  const h = harness({
    states: ['OPEN'],
    graphql: (op) => {
      if (op === 'diagnostic') return { errors: [{ message: 'read failed' }] }
    },
  })
  await assert.rejects(
    queue({ ...h, args: ['--pr', '12', '--timeout', '1'] }),
    (error) => {
      assert.match(error.message, /Timed out after 1 minutes/u)
      assert.match(error.message, /Queue entry state: unavailable/u)
      assert.match(error.message, /GraphQL: read failed/u)
      assert.match(error.message, /may still be running/u)
      assert.match(error.message, /pnpm pr:queue -- --pr 12/u)
      assert.doesNotMatch(error.message, /budget exceeded/u)
      return true
    },
  )
  assert.deepEqual(operations(h), ['read', 'diagnostic'])
})

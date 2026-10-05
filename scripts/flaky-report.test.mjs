import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { lanes } from './ci/flaky-runs.mjs'
import { aggregate, markdown, normalizeReport } from './ci/flaky-report.mjs'

const sha = 'example-sha'
const vitest = (
  status = 'passed',
  name = 'outer > leaf',
  file = '/repo/apps/web/a.test.ts',
  error = '',
) => ({
  schemaVersion: 1,
  reason: status === 'failed' ? 'failed' : 'passed',
  modules: [
    {
      moduleId: file,
      project: null,
      state: status,
      errors: [],
      suites: [],
      tests: [
        {
          namePath: [name],
          state: status,
          errors: error ? [{ message: error }] : [],
        },
      ],
    },
  ],
  unhandledErrors: [],
})

function fixture(t, count = 2) {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-report-'))
  t.after(() => fs.rmSync(results, { recursive: true, force: true }))
  const write = (lane, repetition, report = vitest(), changes = {}) => {
    const directory = path.join(results, lane.id, String(repetition))
    fs.mkdirSync(directory, { recursive: true })
    const status = {
      sha,
      repetitions: count,
      lane: lane.id,
      suite: lane.suite,
      project: lane.project,
      repetition,
      repositoryRoot: '/repo',
      workspaceRoot: '/repo/apps/web',
      format: 'vitest-structured',
      report: 'report.json',
      completed: true,
      exitCode: 0,
      signal: null,
      ...changes,
    }
    fs.writeFileSync(
      path.join(directory, 'status.json'),
      JSON.stringify(status),
    )
    if (typeof report !== 'string') {
      report = structuredClone(report)
      for (const module of report.modules ?? []) module.project = lane.project
    }
    fs.writeFileSync(
      path.join(directory, status.report),
      typeof report === 'string' ? report : JSON.stringify(report),
    )
    fs.writeFileSync(path.join(directory, 'diagnostic.log'), changes.log ?? '')
    return directory
  }
  for (const lane of lanes)
    for (let rep = 1; rep <= count; rep++) write(lane, rep)
  return {
    results,
    write,
    read: () => aggregate({ results, repetitions: count, sha }),
  }
}

test('all pass has explicit empty lists and observed coverage', (t) => {
  const report = fixture(t).read()
  assert.deepEqual(report.flaky, [])
  assert.deepEqual(report.consistentlyFailing, [])
  assert.ok(
    report.coverage.every((lane) => lane.completed === 2 && lane.reports === 2),
  )
  assert.ok(
    report.observations.every(
      (row) => row.passCount === 2 && row.absentCount === 0,
    ),
  )
})

test('flaky, consistent, deduplication, earliest error, paths and Markdown escaping', (t) => {
  const f = fixture(t)
  const failed = vitest(
    'failed',
    'test|name\nnext',
    '/repo/apps/web/a.test.ts',
    '\n\u001b[31mfirst|error\u001b[0m\nsecond',
  )
  failed.modules[0].tests.push(failed.modules[0].tests[0])
  f.write(lanes[0], 1, failed)
  for (const rep of [1, 2])
    f.write(
      lanes[1],
      rep,
      vitest(
        'failed',
        'same',
        '/repo/apps/web/b.test.ts',
        rep === 1 ? 'earliest' : 'later',
      ),
    )
  const report = f.read()
  assert.equal(report.flaky[0].failureCount, 1)
  assert.equal(report.flaky[0].repetitions, 2)
  assert.equal(report.flaky[0].absentCount, 1)
  assert.equal(report.flaky[0].firstError, 'first|error')
  assert.equal(report.flaky[0].file, 'apps/web/a.test.ts')
  assert.equal(report.consistentlyFailing[0].firstError, 'earliest')
  assert.match(markdown(report), /test&#124;name next/)
  assert.match(markdown(report), /1\/2/)
  assert.deepEqual(report, f.read())
})

test('missing report and entirely missing lane use requested denominators', (t) => {
  const f = fixture(t)
  fs.rmSync(path.join(f.results, lanes[0].id, '1', 'report.json'))
  fs.rmSync(path.join(f.results, 'd1'), { recursive: true })
  const report = f.read()
  assert.equal(report.flaky[0].testName, '[suite failure]')
  assert.equal(report.flaky[0].failureCount, 1)
  assert.equal(report.consistentlyFailing[0].suite, 'd1')
  assert.equal(report.consistentlyFailing[0].failureCount, 2)
})

for (const [label, report, changes] of [
  ['truncated', '{', {}],
  ['wrong shape', '{}', {}],
  ['incomplete', vitest(), { completed: false }],
  ['wrong sha', vitest(), { sha: 'other' }],
  ['nonzero', vitest(), { exitCode: 1 }],
  ['signal', vitest(), { exitCode: null, signal: 'SIGTERM' }],
  [
    'unexplained failure',
    { schemaVersion: 1, modules: [], unhandledErrors: [], reason: 'failed' },
    {},
  ],
])
  test(`${label} cannot pass`, (t) => {
    const f = fixture(t)
    f.write(lanes[0], 1, report, changes)
    assert.equal(f.read().flaky[0].diagnosticKind, 'suite')
  })

test('Node JSON Lines preserves same names in different files, skips and absent outcomes', (t) => {
  const f = fixture(t)
  const events = [
    {
      file: '/repo/scripts/a.test.mjs',
      testName: 'outer > child',
      status: 'failed',
      error: { message: 'node error' },
    },
    {
      file: '/repo/scripts/b.test.mjs',
      testName: 'outer > child',
      status: 'skipped',
    },
    { type: 'complete' },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')
  f.write(lanes[4], 1, events, {
    format: 'node-jsonl',
    report: 'report.jsonl',
    exitCode: 1,
  })
  const report = f.read()
  assert.equal(report.flaky[0].file, 'scripts/a.test.mjs')
  assert.equal(report.flaky[0].firstError, 'node error')
  assert.equal(report.flaky[0].absentCount, 1)
  assert.equal(
    report.observations.find((row) => row.file === 'scripts/b.test.mjs')
      .skipCount,
    1,
  )
  const partial = normalizeReport(events.replace('{"type":"complete"}', ''), {
    format: 'node-jsonl',
  })
  assert.ok(partial.some((row) => row.testName === 'outer > child'))
  assert.ok(partial.some((row) => row.error === 'Incomplete Node report'))
})

test('CLI writes JSON and summary before its success/failure exit', (t) => {
  const f = fixture(t)
  for (const fail of [false, true]) {
    if (fail) fs.rmSync(path.join(f.results, 'd1'), { recursive: true })
    const output = path.join(f.results, 'aggregate.json')
    const summary = path.join(f.results, 'summary.md')
    const run = spawnSync(
      process.execPath,
      ['scripts/ci/flaky-report.mjs', f.results, '2', sha, output, summary],
      { encoding: 'utf8' },
    )
    assert.equal(run.status, fail ? 1 : 0, run.stderr)
    assert.equal(
      JSON.parse(fs.readFileSync(output)).consistentlyFailing.length,
      fail ? 1 : 0,
    )
    assert.match(fs.readFileSync(summary, 'utf8'), /Consistently failing/)
  }
})

for (const timedOut of [false, true])
  test(`partial Node report retains assertions and interruption: timeout=${timedOut}`, (t) => {
    const f = fixture(t)
    const partial = [
      JSON.stringify({
        file: '/repo/scripts/a.test.mjs',
        testName: 'named failure',
        status: 'failed',
        error: { message: 'original assertion' },
      }),
      JSON.stringify({
        file: '/repo/scripts/a.test.mjs',
        testName: 'passed',
        status: 'passed',
      }),
      '{"file":',
    ].join('\n')
    f.write(lanes[4], 1, partial, {
      format: 'node-jsonl',
      report: 'report.jsonl',
      exitCode: null,
      signal: 'SIGKILL',
      timedOut,
      ...(timedOut ? { error: 'Repetition timed out' } : {}),
    })
    const report = f.read()
    const failure = report.flaky.find((row) => row.testName === 'named failure')
    assert.equal(failure.firstError, 'original assertion')
    assert.equal(failure.failureCount, 1)
    assert.equal(failure.repetitions, 2)
    assert.equal(failure.absentCount, 1)
    assert.equal(
      report.observations.find((row) => row.testName === 'passed').passCount,
      1,
    )
    assert.match(
      report.flaky.find((row) => row.testName === '[suite failure]').firstError,
      timedOut ? /timed out/ : /SIGKILL/,
    )
  })

test('structured identities separate hooks, assertions, modules, unhandled and infrastructure failures', (t) => {
  const f = fixture(t)
  const report = vitest(
    'failed',
    '[file failure]',
    undefined,
    'assertion error',
  )
  report.modules[0].errors = [{ message: 'module teardown failed' }]
  report.modules[0].suites = [
    {
      namePath: ['outer', 'same [ title ]'],
      state: 'failed',
      errors: [{ message: 'hook failed' }],
    },
    {
      namePath: ['other', 'same [ title ]'],
      state: 'failed',
      errors: [{ message: 'other hook' }],
    },
    { namePath: ['duplicate'], state: 'failed', errors: [] },
    { namePath: ['duplicate'], state: 'failed', errors: [] },
  ]
  report.modules[0].tests.push(
    {
      namePath: ['a > b', 'c'],
      state: 'failed',
      errors: [{ message: 'first path' }],
    },
    {
      namePath: ['a', 'b > c'],
      state: 'failed',
      errors: [{ message: 'second path' }],
    },
  )
  report.unhandledErrors = [
    { moduleId: null, error: { message: 'Unhandled rejection\nstack' } },
  ]
  f.write(lanes[0], 1, report, {
    error: 'Repetition timed out',
    timedOut: true,
  })
  const rows = f.read().flaky
  assert.equal(rows.length, 8)
  assert.equal(
    rows.filter((row) => row.testName === '[file failure]').length,
    2,
  )
  assert.equal(rows.filter((row) => row.testName === 'a > b > c').length, 2)
  assert.ok(
    rows.some(
      (row) => row.testName === '[suite failure] outer > same [ title ]',
    ),
  )
  assert.ok(
    rows.some(
      (row) => row.testName === '[suite failure] other > same [ title ]',
    ),
  )
  assert.ok(
    rows.some(
      (row) =>
        row.testName === '[unhandled error]' &&
        row.firstError === 'Unhandled rejection',
    ),
  )
  assert.ok(rows.every((row) => row.failureCount === 1))
})

for (const message of [
  'Browser connection was closed',
  'Failed to run the test',
])
  test(`structured browser errors retain file attribution: ${message}`, (t) => {
    const f = fixture(t)
    const report = vitest('failed', 'assertion', undefined, 'assertion failed')
    report.unhandledErrors = [
      {
        moduleId: '/repo/apps/web/app/routes/share.$id.behavior.test.tsx',
        error: { message },
      },
    ]
    f.write(lanes[0], 1, report)
    report.unhandledErrors[0].moduleId = null
    f.write(lanes[1], 1, report)
    const rows = f.read().flaky
    assert.ok(
      rows.some(
        (row) =>
          row.file === 'apps/web/app/routes/share.$id.behavior.test.tsx' &&
          row.diagnosticKind === 'file',
      ),
    )
    assert.equal(
      rows.filter((row) => row.diagnosticKind === 'unhandled').length,
      2,
    )
    assert.equal(rows.filter((row) => row.testName === 'assertion').length, 2)
  })

test('collection failure with no tests emits just one module diagnostic', (t) => {
  const f = fixture(t)
  const report = vitest('failed')
  report.modules[0].tests = []
  report.modules[0].errors = [{ message: 'load failed' }]
  f.write(lanes[0], 1, report)
  assert.deepEqual(
    f.read().flaky.map((row) => [row.testName, row.firstError]),
    [['[file failure]', 'load failed']],
  )
})

test('unhandled error identity ignores changing messages and module attribution', (t) => {
  const f = fixture(t)
  for (const repetition of [1, 2]) {
    const report = vitest()
    report.unhandledErrors = [
      { moduleId: null, error: { message: `request ${repetition} failed` } },
    ]
    f.write(lanes[3], repetition, report)
  }
  const report = f.read()
  assert.equal(report.flaky.length, 0)
  assert.equal(report.consistentlyFailing.length, 1)
  assert.equal(report.consistentlyFailing[0].firstError, 'request 1 failed')
})

test('console output cannot invent failures; missing structured output includes exit and log tail', (t) => {
  const f = fixture(t)
  f.write(lanes[0], 1, vitest(), {
    log: 'FAIL a.test.ts > title [ location ]\nBrowser connection was closed',
  })
  assert.deepEqual(f.read().flaky, [])
  const directory = f.write(lanes[0], 1, vitest(), {
    exitCode: 7,
    log: 'startup\nreporter could not load',
  })
  fs.rmSync(path.join(directory, 'report.json'))
  const rows = f.read().flaky
  assert.equal(rows.length, 1)
  assert.equal(rows[0].file, '[suite]')
  assert.match(
    rows[0].firstError,
    /process exited 7.*log tail: startup \/ reporter could not load/,
  )
})

test('pending cases remain absent and force an incomplete-run diagnostic', (t) => {
  const f = fixture(t)
  f.write(lanes[0], 1, vitest('pending'))
  f.write(lanes[0], 2, vitest('skipped'))
  const report = f.read()
  const row = report.observations.find(
    (item) => item.project === 'chromium' && item.testName === 'outer > leaf',
  )
  assert.equal(row.absentCount, 1)
  assert.equal(row.skipCount, 1)
  assert.equal(row.passCount, 0)
  assert.equal(report.flaky[0].firstError, 'Vitest run incomplete')
})

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
  success: status !== 'failed',
  testResults: [
    {
      name: file,
      status,
      message: '',
      assertionResults: [
        { fullName: name, status, failureMessages: error ? [error] : [] },
      ],
    },
  ],
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
      format: 'vitest-json',
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
  failed.testResults[0].assertionResults.push(
    failed.testResults[0].assertionResults[0],
  )
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
  ['unhandled', { testResults: [], success: false }, {}],
])
  test(`${label} cannot pass`, (t) => {
    const f = fixture(t)
    f.write(lanes[0], 1, report, changes)
    assert.equal(f.read().flaky[0].diagnosticKind, 'suite')
  })

for (const message of [
  'Browser connection was closed',
  'Failed to run the test',
])
  test(`file and unattributed crash: ${message}`, (t) => {
    const f = fixture(t)
    f.write(lanes[0], 1, {
      testResults: [
        {
          name: '/repo/apps/web/crash.test.ts',
          status: 'failed',
          message,
          assertionResults: [],
        },
      ],
    })
    f.write(lanes[1], 1, vitest(), { log: message })
    f.write(lanes[2], 1, '{', {
      log: `/repo/apps/web/crash.test.ts: ${message}`,
    })
    const rows = f.read().flaky
    assert.ok(
      rows.some(
        (row) =>
          row.project === 'chromium' &&
          row.file === 'apps/web/crash.test.ts' &&
          row.testName === '[file failure]',
      ),
    )
    assert.ok(
      rows.some(
        (row) => row.project === 'firefox' && row.diagnosticKind === 'suite',
      ),
    )
    assert.ok(
      rows.some(
        (row) =>
          row.project === 'webkit' && row.file === 'apps/web/crash.test.ts',
      ),
    )
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
  assert.throws(
    () =>
      normalizeReport(events.replace('{"type":"complete"}', ''), {
        format: 'node-jsonl',
      }),
    /Incomplete/,
  )
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

for (const message of [
  'Browser connection was closed',
  'Failed to run the test',
]) {
  for (const truncated of [false, true]) {
    test(`crash attribution preserves dollar route filenames: ${message}, truncated=${truncated}`, (t) => {
      const f = fixture(t)
      const file = 'apps/web/app/routes/share.$id.behavior.test.tsx'
      f.write(lanes[0], 1, truncated ? '{' : vitest(), {
        exitCode: 1,
        log: `Error: ${message} in \`/repo/${file}\``,
      })
      const rows = f.read().flaky.filter((row) => row.diagnosticKind === 'file')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].file, file)
      assert.equal(rows[0].testName, '[file failure]')
      assert.equal(rows[0].failureCount, 1)
      assert.equal(rows[0].repetitions, 2)
    })
  }
}

test('script fixture console messages are not browser crashes', (t) => {
  const f = fixture(t)
  f.write(lanes[4], 1, vitest(), {
    log: 'Error: Browser connection was closed while running tests\n',
  })
  assert.deepEqual(f.read().flaky, [])
})

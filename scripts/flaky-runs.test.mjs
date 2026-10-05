import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  lanes,
  plan,
  validateCount,
  runShard,
  suiteCommand,
} from './ci/flaky-runs.mjs'
import reporter, { serializeError } from './ci/node-test-json-reporter.mjs'
import { aggregate } from './ci/flaky-report.mjs'

for (const count of [1, 20, 50])
  test(`plans six complete lanes for ${count}`, () => {
    const shards = plan(count)
    assert.equal(shards.length, 6 * Math.ceil(count / 2))
    assert.ok(shards.length <= 150)
    for (const lane of lanes)
      assert.deepEqual(
        shards
          .filter((shard) => shard.id === lane.id)
          .flatMap((shard) => shard.runs),
        Array.from({ length: count }, (_, i) => i + 1),
      )
  })

test('rejects invalid counts without clamping', () => {
  for (const value of [
    '',
    '0',
    '51',
    '-1',
    '1.5',
    '2e1',
    '20x',
    ' 20',
    '01',
    null,
    undefined,
  ])
    assert.throws(() => validateCount(value), /integer/)
  assert.equal(validateCount('20'), 20)
})

test('runner continues after failed and thrown children, with separate evidence', async (t) => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-runs-'))
  t.after(() => fs.rmSync(results, { recursive: true, force: true }))
  const calls = []
  await runShard({
    shard: plan(2)[0],
    repetitions: 2,
    sha: 'example-sha',
    results,
    executor: (command, args, options, output) => {
      calls.push({ command, args, options })
      output('synthetic diagnostic\n')
      if (calls.length === 1) throw new Error('injected failure')
      return { exitCode: 1, signal: null }
    },
  })
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].args.at(-1), calls[1].args.at(-1))
  assert.equal(calls[0].options.env.DEBUG, 'pw:browser')
  for (const repetition of [1, 2]) {
    const directory = path.join(results, lanes[0].id, String(repetition))
    const status = JSON.parse(
      fs.readFileSync(path.join(directory, 'status.json')),
    )
    assert.equal(status.completed, repetition === 2)
    assert.equal(status.repetition, repetition)
    assert.equal(status.sha, 'example-sha')
    assert.equal(status.exitCode, repetition === 2 ? 1 : null)
    assert.match(
      fs.readFileSync(path.join(directory, 'diagnostic.log'), 'utf8'),
      /synthetic diagnostic/,
    )
  }
})

test('commands preserve whole-suite selection and environment', () => {
  for (const lane of lanes) {
    const command = suiteCommand(lane, '/tmp/result.json', '/repo')
    assert.doesNotMatch(
      command.args.join(' '),
      /retry|concurrency|testNamePattern/,
    )
    if (lane.suite === 'scripts') {
      const root = JSON.parse(fs.readFileSync('package.json'))
        .scripts['test:scripts'].split(' ')
        .slice(2)
      assert.deepEqual(command.args.slice(-3), root)
      assert.equal(command.command, process.execPath)
    } else {
      assert.deepEqual(command.args.slice(0, 4), [
        '--filter',
        '@artifactshare/web',
        'exec',
        'vitest',
      ])
      assert.ok(command.args.includes('--run'))
      assert.deepEqual(
        command.args.filter((argument) => argument.startsWith('--reporter=')),
        ['--reporter=default', '--reporter=json'],
      )
      assert.equal(command.args.at(-1), '--outputFile=/tmp/result.json')
      if (lane.project)
        assert.ok(command.args.includes(`--project=${lane.project}`))
      if (lane.suite === 'd1')
        assert.ok(command.args.includes('app/test/vitest.d1.config.ts'))
      if (lane.suite === 'web-unit')
        assert.deepEqual(command.env, { PUBLIC_TEST: '1' })
    }
  }
})

test('Node reporter retains hierarchy, skips and process errors without suite rollups', async () => {
  const event = (type, name, nesting, details = {}, extra = {}) => ({
    type: `test:${type}`,
    data: { file: '/repo/a.test.mjs', name, nesting, details, ...extra },
  })
  const error = Object.assign(
    new Error('leaf error', { cause: new Error('root cause') }),
    { failureType: 'testCodeFailure' },
  )
  const events = [
    event('start', 'outer', 0),
    event('start', 'inner', 1),
    event('start', 'leaf', 2),
    event('fail', 'leaf', 2, { error }),
    event('pass', 'skip', 2, {}, { skip: true }),
    event('fail', 'inner', 1, {
      type: 'suite',
      error: { failureType: 'subtestsFailed' },
    }),
    event('fail', 'outer', 0, { error: { failureType: 'subtestsFailed' } }),
    event('fail', '/repo/a.test.mjs', 0, { error }),
  ]
  const output = []
  for await (const line of reporter(events)) output.push(JSON.parse(line))
  assert.equal(output.length, 4)
  assert.equal(output[0].testName, 'outer > inner > leaf')
  assert.equal(output[0].error.cause.message, 'root cause')
  assert.match(output[0].error.stack, /leaf error/)
  assert.equal(output[1].status, 'skipped')
  assert.equal(output[2].diagnosticKind, 'file')
  assert.equal(output[3].type, 'complete')
  const circular = new Error('cycle')
  circular.cause = circular
  assert.equal(serializeError(circular).cause.message, '[circular error]')
})

test('ordinary nonzero exits do not skip the following repetition', async (t) => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-exit-'))
  t.after(() => fs.rmSync(results, { recursive: true, force: true }))
  let calls = 0
  await runShard({
    shard: plan(2).find((shard) => shard.id === 'd1'),
    repetitions: 2,
    sha: 'example-sha',
    results,
    executor: () => ({ exitCode: calls++ === 0 ? 1 : 0, signal: null }),
  })
  assert.equal(calls, 2)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(results, 'd1/1/status.json')))
      .exitCode,
    1,
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(results, 'd1/2/status.json')))
      .exitCode,
    0,
  )
})

test('Node parent IDs disambiguate interleaved siblings and retain hook failures', async () => {
  const event = (type, data) => ({
    type: `test:${type}`,
    data: { file: '/repo/a.test.mjs', nesting: 0, ...data },
  })
  const events = [
    event('enqueue', { name: 'left', testId: 1 }),
    event('enqueue', { name: 'right', testId: 2 }),
    event('pass', { name: 'same', testId: 3, parentId: 2, nesting: 1 }),
    event('pass', { name: 'same', testId: 4, parentId: 1, nesting: 1 }),
    event('fail', {
      name: 'suite',
      testId: 5,
      details: {
        type: 'suite',
        error: { message: 'hook failed', failureType: 'hookFailed' },
      },
    }),
  ]
  const rows = []
  for await (const line of reporter(events)) rows.push(JSON.parse(line))
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.testName),
    ['right > same', 'left > same'],
  )
  assert.equal(rows[2].testName, '[file failure]')
  assert.equal(rows[2].error.message, 'hook failed')
})

test('Vitest console crashes survive alongside JSON assertion failures', async (t) => {
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-diagnostics-'))
  t.after(() => fs.rmSync(results, { recursive: true, force: true }))
  const crash = 'Error: Browser connection was closed while running tests'
  await runShard({
    shard: plan(1)[0],
    repetitions: 1,
    sha: 'example-sha',
    results,
    executor: (_command, args, _options, output) => {
      // Model the installed Vitest reporters: JSON writes assertions, while
      // the default reporter prints unhandled browser errors to the console.
      assert.ok(args.includes('--reporter=json'))
      fs.writeFileSync(
        args
          .find((arg) => arg.startsWith('--outputFile='))
          .slice('--outputFile='.length),
        JSON.stringify({
          success: false,
          testResults: [
            {
              name: 'app/example.test.ts',
              status: 'failed',
              message: '',
              assertionResults: [
                {
                  fullName: 'ordinary assertion',
                  status: 'failed',
                  failureMessages: ['assertion failed'],
                },
              ],
            },
          ],
        }),
      )
      if (args.includes('--reporter=default')) output(`${crash}\n`)
      return { exitCode: 1, signal: null }
    },
  })
  const rows = aggregate({
    results,
    repetitions: 1,
    sha: 'example-sha',
  }).consistentlyFailing.filter((row) => row.project === 'chromium')
  assert.equal(rows.length, 2)
  assert.ok(rows.some((row) => row.testName === 'ordinary assertion'))
  assert.ok(
    rows.some(
      (row) => row.testName === '[suite failure]' && row.firstError === crash,
    ),
  )
  assert.match(
    fs.readFileSync(
      path.join(results, 'behavior-browser-chromium/1/diagnostic.log'),
      'utf8',
    ),
    /Browser connection was closed/,
  )
})

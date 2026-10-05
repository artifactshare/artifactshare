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
  terminateTree,
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
        [
          '--reporter=default',
          '--reporter=/repo/scripts/ci/vitest-flaky-reporter.mjs',
        ],
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

test('timeout removes reparented detached descendants before the next repetition', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Reparented ownership discovery requires Linux /proc')
    return
  }
  const { execute, repetitionTimeoutMs } = await import('./ci/flaky-runs.mjs')
  assert.ok(2 * repetitionTimeoutMs <= 40 * 60 * 1000)
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-timeout-'))
  const pidFile = path.join(results, 'descendant.pid')
  t.after(() => {
    try {
      if (fs.existsSync(pidFile))
        process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    } finally {
      fs.rmSync(results, { recursive: true, force: true })
    }
  })
  let calls = 0
  await runShard({
    shard: plan(2).find((shard) => shard.id === 'd1'),
    repetitions: 2,
    sha: 'example-sha',
    results,
    timeoutMs: 1000,
    executor: (_command, _args, options, output) => {
      calls++
      if (calls === 2) {
        const pid = Number(fs.readFileSync(pidFile))
        let living = false
        try {
          process.kill(pid, 0)
          living =
            process.platform !== 'linux' ||
            !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
        } catch (error) {
          if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error
        }
        assert.equal(living, false, 'detached descendant survived cleanup')
        return { exitCode: 0, signal: null }
      }
      // The intermediary exits immediately after launching a detached browser.
      // By timeout, ancestry no longer connects that browser to the suite.
      return execute(
        process.execPath,
        [
          '-e',
          `
        const { spawn } = require('node:child_process')
        const intermediary = spawn(process.execPath, ['-e', ${JSON.stringify(`
          const { spawn } = require('node:child_process')
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
          require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
          child.unref()
        `)}], { stdio: 'ignore' })
        intermediary.on('exit', () => console.log('grandchild ready; intermediary exited'))
        setInterval(() => {}, 1000)
      `,
        ],
        options,
        output,
      )
    },
  })
  assert.equal(calls, 2)
  const directory = path.join(results, 'd1/1')
  const status = JSON.parse(
    fs.readFileSync(path.join(directory, 'status.json')),
  )
  assert.equal(status.timedOut, true)
  assert.equal(status.signal, 'SIGKILL')
  assert.match(status.error, /timed out after 1000 ms/)
  assert.match(
    fs.readFileSync(path.join(directory, 'diagnostic.log'), 'utf8'),
    /grandchild ready[\s\S]*timed out/,
  )
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(results, 'd1/2/status.json')))
      .exitCode,
    0,
  )
  assert.match(
    aggregate({
      results,
      repetitions: 2,
      sha: 'example-sha',
    }).consistentlyFailing.find((row) => row.suite === 'd1').firstError,
    /timed out/,
  )
})

test('Node file failures resolve relative CLI paths against absolute event files', async () => {
  const rows = []
  for await (const line of reporter([
    {
      type: 'test:fail',
      data: {
        name: 'scripts/example.test.mjs',
        file: path.resolve('scripts/example.test.mjs'),
        nesting: 0,
        details: {
          error: { message: 'process crashed', failureType: 'testCodeFailure' },
        },
      },
    },
  ]))
    rows.push(JSON.parse(line))
  assert.equal(rows[0].testName, '[file failure]')
  assert.equal(rows[0].diagnosticKind, 'file')
})

for (const asynchronous of [false, true])
  test(`timeout contains ${asynchronous ? 'rejected' : 'thrown'} termination errors`, async (t) => {
    const { execute } = await import('./ci/flaky-runs.mjs')
    const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-kill-error-'))
    t.after(() => fs.rmSync(results, { recursive: true, force: true }))
    let calls = 0
    await runShard({
      shard: plan(2).find((shard) => shard.id === 'd1'),
      repetitions: 2,
      sha: 'example-sha',
      results,
      executor: (_command, _args, options, output) => {
        if (++calls === 2) return { exitCode: 0, signal: null }
        const fail = () => {
          throw new Error('injected termination error')
        }
        return execute(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          {
            ...options,
            timeoutMs: 100,
            terminate: asynchronous ? () => Promise.resolve().then(fail) : fail,
          },
          output,
        )
      },
    })
    assert.equal(calls, 2)
    const status = JSON.parse(
      fs.readFileSync(path.join(results, 'd1/1/status.json')),
    )
    assert.equal(status.timedOut, true)
    assert.match(status.error, /Termination failed: injected termination error/)
    assert.match(
      fs.readFileSync(path.join(results, 'd1/1/diagnostic.log'), 'utf8'),
      /injected termination error/,
    )
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(results, 'd1/2/status.json')))
        .exitCode,
      0,
    )
  })

test('tree cleanup discovers separate groups and waits for descendants to exit', async () => {
  const signals = []
  let reads = 0
  const diagnostics = await terminateTree(100, {
    readProcesses: () => {
      reads++
      // A second generation appears after the first discovery snapshot.
      if (reads === 1) return [{ pid: 101, parent: 100, state: 'S' }]
      if (reads <= 3)
        return [
          { pid: 101, parent: 100, state: 'T' },
          { pid: 102, parent: 101, state: 'T' },
        ]
      if (reads === 4) return [{ pid: 102, parent: 1, state: 'R' }]
      return []
    },
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  assert.deepEqual(diagnostics, [])
  assert.equal(reads, 5)
  assert.deepEqual(signals, [
    [100, 'SIGSTOP'],
    [101, 'SIGSTOP'],
    [102, 'SIGSTOP'],
    [102, 'SIGKILL'],
    [101, 'SIGKILL'],
    [100, 'SIGKILL'],
    [-100, 'SIGKILL'],
  ])
})

test('tree cleanup retains signal errors and still terminates other descendants', async () => {
  let reads = 0
  const signals = []
  const diagnostics = await terminateTree(100, {
    readProcesses: () =>
      ++reads <= 2 ? [{ pid: 101, parent: 100, state: 'S' }] : [],
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (pid === 101 && signal === 'SIGKILL') throw new Error('signal denied')
    },
  })
  assert.deepEqual(diagnostics, ['signal denied'])
  assert.ok(
    signals.some(([pid, signal]) => pid === 100 && signal === 'SIGKILL'),
  )
})

test('cleanup includes marked orphans whose ancestry disappeared before discovery', async () => {
  const signals = []
  let reads = 0
  const diagnostics = await terminateTree(100, {
    ownership: 'repetition-one',
    readProcesses: (ownership) => {
      assert.equal(ownership, 'repetition-one')
      return ++reads <= 2
        ? [
            { pid: 102, parent: 1, state: 'S', owned: true },
            { pid: 103, parent: 1, state: 'S', owned: false },
          ]
        : []
    },
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  assert.deepEqual(diagnostics, [])
  assert.ok(
    signals.some(([pid, signal]) => pid === 102 && signal === 'SIGKILL'),
  )
  assert.ok(!signals.some(([pid]) => pid === 103))
})

test('each repetition passes its inherited ownership marker to timeout cleanup', async () => {
  const { execute } = await import('./ci/flaky-runs.mjs')
  const markers = []
  for (let repetition = 0; repetition < 2; repetition++) {
    let output = ''
    let cleanupMarker
    const result = await execute(
      process.execPath,
      [
        '-e',
        `
      console.log(process.env.ARTIFACTSHARE_FLAKY_REPETITION)
      setInterval(() => {}, 1000)
    `,
      ],
      {
        timeoutMs: 500,
        stdio: ['ignore', 'pipe', 'pipe'],
        terminate: (pid, { ownership }) => {
          cleanupMarker = ownership
          process.kill(pid, 'SIGKILL')
          return []
        },
      },
      (chunk) => {
        output += chunk
      },
    )
    assert.equal(result.timedOut, true)
    assert.ok(cleanupMarker)
    assert.equal(output.split('\n')[0], cleanupMarker)
    markers.push(cleanupMarker)
  }
  assert.notEqual(markers[0], markers[1])
})

test('direct exit cleans inherited pipes before timeout and the next repetition', async (t) => {
  const { execute } = await import('./ci/flaky-runs.mjs')
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-leftovers-'))
  let descendant
  let cleaned = false
  t.after(() => {
    if (descendant) {
      try {
        process.kill(descendant, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    fs.rmSync(results, { recursive: true, force: true })
  })
  let calls = 0
  await runShard({
    shard: plan(2).find((shard) => shard.id === 'scripts'),
    repetitions: 2,
    sha: 'example-sha',
    results,
    executor: (_command, _args, options, output) => {
      if (++calls === 2) {
        assert.equal(cleaned, true)
        return { exitCode: 0, signal: null }
      }
      let stdout = ''
      return execute(
        process.execPath,
        [
          '-e',
          `
        const { spawn } = require('node:child_process')
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { detached: true, stdio: ['ignore', 1, 2] })
        console.log(child.pid)
        child.unref()
      `,
        ],
        {
          ...options,
          timeoutMs: 2000,
          terminate: async (_pid, { afterExit }) => {
            descendant = Number(stdout.trim())
            assert.ok(descendant > 0)
            process.kill(descendant, 'SIGKILL')
            assert.equal(afterExit, true, 'must clean up on exit, not timeout')
            await new Promise((resolve) => setTimeout(resolve, 30))
            cleaned = true
            return ['Remaining descendant after suite exit']
          },
        },
        (chunk) => {
          stdout += chunk
          output(chunk)
        },
      )
    },
  })
  assert.equal(calls, 2)
  const status = JSON.parse(
    fs.readFileSync(path.join(results, 'scripts/1/status.json')),
  )
  assert.equal(status.exitCode, 0)
  assert.equal(status.timedOut, false)
  assert.match(status.error, /Remaining descendant/)
  assert.match(
    fs.readFileSync(path.join(results, 'scripts/1/diagnostic.log'), 'utf8'),
    /Remaining descendant/,
  )
})

test('post-exit tree cleanup diagnoses surviving descendants', async () => {
  const signals = []
  let killed = false
  const diagnostics = await terminateTree(100, {
    afterExit: true,
    readProcesses: () =>
      !killed ? [{ pid: 101, parent: 1, state: 'S', owned: true }] : [],
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (pid === 101 && signal === 'SIGKILL') killed = true
    },
  })
  assert.deepEqual(diagnostics, ['Remaining descendant after suite exit'])
  assert.ok(
    signals.some(([pid, signal]) => pid === 101 && signal === 'SIGKILL'),
  )
  assert.ok(!signals.some(([pid]) => pid === 100))
})

test('post-exit cleanup lets exiting descendants finish without signals or diagnostics', async () => {
  const signals = []
  const started = Date.now()
  const diagnostics = await terminateTree(100, {
    afterExit: true,
    readProcesses: () =>
      Date.now() - started < 600
        ? [{ pid: 101, parent: 1, state: 'S', owned: true }]
        : [],
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(signals, [])
})

test('Vitest reporter uses 4.1.11 entities and writes complete structured results', async (t) => {
  const { default: VitestReporter } =
    await import('./ci/vitest-flaky-reporter.mjs')
  const results = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-vitest-'))
  t.after(() => fs.rmSync(results, { recursive: true, force: true }))
  const module = {
    type: 'module',
    moduleId: '/repo/apps/web/app/example.test.ts',
    project: { name: 'chromium' },
    state: () => 'failed',
    errors: () => [new Error('module error')],
  }
  const suite = (name, parent, errors = []) => ({
    type: 'suite',
    name,
    parent,
    state: () => 'failed',
    errors: () => errors,
  })
  const outer = suite('outer', module)
  const inner = suite('same [ title ]', outer, [new Error('hook error')])
  const duplicate = suite('same [ title ]', outer)
  const leaf = (parent, state) => ({
    type: 'test',
    name: 'leaf',
    parent,
    result: () => ({
      state,
      errors: state === 'failed' ? [new Error('assertion error')] : [],
    }),
  })
  module.children = {
    allSuites: () => [outer, inner, duplicate],
    allTests: () => [leaf(inner, 'failed'), leaf(duplicate, 'skipped')],
  }
  const vitestReporter = new VitestReporter()
  const output = path.join(results, 'report.json')
  vitestReporter.onInit({ config: { outputFile: output } })
  vitestReporter.onTestRunEnd(
    [module],
    [
      new Error(
        'Failed to run the test /repo/apps/web/app/routes/share.$id.behavior.test.tsx.',
        { cause: new Error('Browser connection was closed') },
      ),
      Object.assign(new Error('Browser connection was closed'), {
        VITEST_TEST_PATH: module.moduleId,
      }),
      new Error('unattributed error'),
    ],
    'failed',
  )
  const report = JSON.parse(fs.readFileSync(output))
  assert.deepEqual(report.modules[0].tests[0].namePath, [
    'outer',
    'same [ title ]',
    'leaf',
  ])
  assert.equal(report.modules[0].tests[1].state, 'skipped')
  assert.equal(report.modules[0].errors[0].message, 'module error')
  assert.equal(report.modules[0].suites[1].errors[0].message, 'hook error')
  assert.equal(
    report.unhandledErrors[0].moduleId,
    '/repo/apps/web/app/routes/share.$id.behavior.test.tsx',
  )
  assert.equal(
    report.unhandledErrors[0].error.cause.message,
    'Browser connection was closed',
  )
  assert.equal(report.unhandledErrors[1].moduleId, module.moduleId)
  assert.equal(report.unhandledErrors[2].moduleId, null)
})

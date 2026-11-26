import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  UsageError,
  containerSummary,
  delayEnvironment,
  dockerInvocation,
  dockerSummary,
  holdPoints,
  mismatched,
  onSignals,
  parseOptions,
  pinnedRuntime,
  prepareResults,
  readRun,
  repositoryRoot,
  runOutcome,
  summarize,
  unusable,
  usage,
  vitestInvocation,
} from './ci/flaky-repro.mjs'

const file = 'apps/web/app/lib/preview-security.behavior.browser.test.tsx'
const point = Object.keys(holdPoints())[0]
const parse = (...argv) => parseOptions(argv)
const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-repro-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const report = (modules, reason = 'passed', unhandledErrors = []) =>
  JSON.stringify({
    schemaVersion: 1,
    reason,
    unhandledErrors,
    modules: modules.map((module) => ({
      state: 'passed',
      errors: [],
      suites: [],
      project: 'firefox',
      ...module,
    })),
  })
const testCase = (name, state, errors = []) => ({
  namePath: [name],
  state,
  errors,
})
// What `runLocally` collects for one repetition, without running one.
const run = (number, result) => ({
  run: number,
  holds: [],
  captures: [],
  others: [],
  observed: 1,
  failed: 0,
  durationMs: 1000 * number,
  ...result,
})

test('a run that cannot prove anything is refused before it starts', () => {
  for (const argv of [
    ['--project', 'firefox'],
    ['--file', 'scripts/flaky-repro.test.mjs', '--project', 'firefox'],
    ['--file', file, '--project', 'opera'],
    ['--file', file, '--project', 'firefox', '--repeat', '51'],
    ['--file', file, '--project', 'firefox', '--delay', 'typo=400'],
    ['--file', file, '--project', 'firefox', '--delay', `${point}=0`],
    ['--file', file, '--project', 'firefox', '--load', '99'],
    ['--file', file, '--project', 'firefox', '--results', '../elsewhere'],
    ['--file', file, '--project', 'firefox', '--results', 'reports/run'],
    ['--file', file, '--project', 'firefox', '--results', '.flaky-repro'],
    ['--file', file, '--project', 'firefox', '--volume-prefix', 'a b;rm -rf'],
    ['--file', file, '--project', 'firefox', '--volume-prefix', '-flag'],
    ['--file', file, '--project', 'firefox', '--cpus', '1', '--no-docker'],
    ['--file', file, '--project', 'firefox', '--unknown-flag'],
  ])
    assert.throws(() => parseOptions(argv), UsageError, argv.join(' '))
})

test('the packaged entry point takes the options pnpm hands it', () => {
  const { scripts } = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  )
  const [command, ...entry] = scripts['test:flaky-repro'].split(' ')
  assert.equal(command, 'node')
  // `pnpm run <script> -- <options>` forwards the separator to the script, so
  // the entry point has to read the options with it and without it.
  assert.ok(usage.startsWith('pnpm test:flaky-repro --file '))
  for (const [argv, printed] of [
    [['--help'], /--delay <point>=<ms>/u],
    [['--', '--help'], /--delay <point>=<ms>/u],
    [['--list'], new RegExp(point, 'u')],
    [['--', '--list'], new RegExp(point, 'u')],
  ]) {
    const result = spawnSync(process.execPath, [...entry, ...argv], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${argv.join(' ')}: ${result.stderr}`)
    assert.match(result.stdout, printed)
  }
  const refused = spawnSync(
    process.execPath,
    [...entry, '--', '--project', 'firefox'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /--file is required/u)
})

test('a run holds nothing and writes no state unless it is asked to', () => {
  const options = parse('--file', file, '--project', 'firefox')
  assert.equal(options.delays.size, 0)
  assert.equal(delayEnvironment(options.delays), '')
  const held = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--delay',
    `${point}=400`,
  )
  assert.equal(delayEnvironment(held.delays), `${point}=400`)
  // The helper in the page splits this on the comma, one point per entry.
  assert.equal(
    delayEnvironment(
      new Map([
        ['first-point', 400],
        ['second-point', 500],
      ]),
    ),
    'first-point=400,second-point=500',
  )
})

test('the repetition runs the requested test in the requested engine only', () => {
  const options = parse(
    '--file',
    file,
    '--project',
    'webkit',
    '--test',
    'a reader can rewrite element and selected text (quickly)',
  )
  const invocation = vitestInvocation(options, { report: '/tmp/report.json' })
  assert.deepEqual(
    invocation.args.filter((argument) => argument.includes('--project')),
    ['--project=webkit'],
  )
  const pattern =
    invocation.args[invocation.args.indexOf('--testNamePattern') + 1]
  assert.match(
    'a reader can rewrite element and selected text (quickly)',
    new RegExp(pattern, 'u'),
  )
  assert.doesNotMatch(
    'a reader can rewrite element and selected text quickly',
    new RegExp(pattern, 'u'),
  )
  assert.equal(invocation.args.at(-1), path.join(repositoryRoot, file))
})

test('the container runtime stays the one the compose file pins', () => {
  const runtime = pinnedRuntime(
    fs.readFileSync(
      path.join(repositoryRoot, 'compose.playwright.yml'),
      'utf8',
    ),
  )
  assert.match(runtime.image, /^mcr\.microsoft\.com\/playwright:.+@sha256:/u)
  assert.match(runtime.toolchain, /^node@[\d.]+ pnpm@[\d.]+$/u)
  assert.throws(
    () =>
      pinnedRuntime(
        'services:\n  a:\n    image: one@sha256:a\n  b:\n    image: two@sha256:b\n' +
          'npm install --global --prefix /opt/toolchain node@1.2.3 pnpm@4.5.6\n',
      ),
    /exactly one/u,
  )
})

test('the container repeats the same run on this checkout, under its own limits', () => {
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--repeat',
    '20',
    '--cpus',
    '1',
    '--load',
    '2',
    '--delay',
    `${point}=400`,
    '--results',
    '.flaky-repro/run',
    '--volume-prefix',
    'warm_prefix.1',
  )
  const { command, args } = dockerInvocation(options, {
    root: '/checkout',
    runtime: { image: 'image@sha256:a', toolchain: 'node@1.2.3 pnpm@4.5.6' },
    name: 'flaky-repro-test',
    environment: { HTTPS_PROXY: 'http://127.0.0.1:1/', PATH: '/usr/bin' },
  })
  assert.equal(command, 'docker')
  assert.ok(args.includes('--cpus=1'))
  assert.ok(args.includes('/checkout:/workspace'))
  assert.ok(args.includes('warm_prefix.1-toolchain:/opt/toolchain'))
  assert.ok(args.includes('HTTPS_PROXY=http://127.0.0.1:1/'))
  assert.ok(!args.includes('PATH=/usr/bin'))
  const inner = args.at(-1)
  // The container applies neither limit, so its summary must take both back.
  assert.deepEqual(
    dockerSummary({ where: 'local', cpus: null, load: 0 }, options),
    { where: 'docker', cpus: '1', load: 2 },
  )
  assert.match(inner, /node scripts\/ci\/flaky-repro\.mjs .*'--no-docker'/u)
  assert.match(inner, /'--repeat' '20'/u)
  assert.match(inner, new RegExp(`'--delay' '${point}=400'`, 'u'))
  assert.match(inner, /'--results' '\.flaky-repro\/run'/u)
  assert.doesNotMatch(inner, /--cpus|--load/u)
})

test('a repetition reports the failures of its own file and the state it captured', (t) => {
  const root = temporary(t)
  const directory = path.join(root, '1')
  fs.mkdirSync(directory)
  const options = parse('--file', file, '--project', 'firefox')
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    report(
      [
        {
          moduleId: path.join(root, 'apps/web', file.slice(9)),
          state: 'failed',
          tests: [
            testCase('interactive documents', 'failed', [
              { message: 'Timeout 30000ms exceeded.\nat frame.waitFor' },
            ]),
            testCase('a reader can rewrite', 'skipped'),
          ],
        },
        {
          moduleId: path.join(root, 'apps/web/app/lib/other.test.tsx'),
          tests: [testCase('unrelated', 'passed')],
        },
      ],
      'failed',
    ),
  )
  fs.writeFileSync(path.join(directory, 'state-screens-1.json'), '{}')
  fs.appendFileSync(
    path.join(directory, 'holds.jsonl'),
    `{"${point}":3}\n{"truncated`,
  )
  const result = readRun({ directory, run: 1, options, root })
  assert.equal(result.failed, 1)
  assert.equal(result.observed, 1)
  assert.equal(result.error, 'Timeout 30000ms exceeded.')
  assert.deepEqual(result.others, ['apps/web/app/lib/other.test.tsx'])
  assert.deepEqual(result.captures, ['1/state-screens-1.json'])
  assert.deepEqual(result.holds, [{ [point]: 3 }])
  fs.writeFileSync(path.join(directory, 'report.json'), 'not a report')
  assert.ok(readRun({ directory, run: 2, options, root }).incomplete)
})

test('a suite-level failure counts, and a repetition that was stopped reports nothing else', (t) => {
  const root = temporary(t)
  const directory = path.join(root, '1')
  fs.mkdirSync(directory)
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--timeout',
    '5',
  )
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    report(
      [
        {
          moduleId: path.join(root, 'apps/web', file.slice(9)),
          tests: [testCase('interactive documents', 'passed')],
        },
      ],
      'failed',
      [{ error: { message: 'worker exited unexpectedly' }, moduleId: null }],
    ),
  )
  const outcome = runOutcome({
    directory,
    run: 1,
    options,
    root,
    status: { exitCode: 1, timedOut: false },
    durationMs: 7,
  })
  // A diagnostic that belongs to no file still breaks this repetition.
  assert.equal(outcome.failed, 1)
  assert.equal(outcome.error, 'worker exited unexpectedly')
  assert.equal(outcome.observed, 1)
  assert.equal(outcome.durationMs, 7)
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.incomplete, undefined)
  const stopped = runOutcome({
    directory,
    run: 2,
    options,
    root,
    status: { exitCode: null, timedOut: true },
    durationMs: 9,
  })
  assert.equal(stopped.incomplete, 'Timed out after 5 ms')
})

test('a summary keeps the repetitions apart', () => {
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--repeat',
    '3',
    '--delay',
    `${point}=400`,
  )
  const summary = summarize(
    options,
    [
      run(1, {
        holds: [{ [point]: 2 }],
        captures: ['1/state-screens-1.json'],
        failed: 1,
        error: 'held',
      }),
      run(2, { holds: [{ [point]: 3 }] }),
      run(3, {
        holds: [],
        observed: 0,
        incomplete: 'Timed out after 5 ms',
      }),
    ],
    { where: 'local' },
  )
  assert.deepEqual(
    [summary.runs, summary.failures, summary.failedRuns],
    [3, 1, [1]],
  )
  assert.equal(summary.firstError, 'held')
  assert.deepEqual(summary.incompleteRuns, [3])
  assert.equal(summary.firstIncomplete, 'Timed out after 5 ms')
  assert.equal(summary.observed, 2)
  assert.deepEqual(summary.holds, [
    { run: 1, counts: { [point]: 2 } },
    { run: 2, counts: { [point]: 3 } },
    { run: 3, counts: { [point]: 0 } },
  ])
  assert.deepEqual(summary.captures, ['1/state-screens-1.json'])
  assert.deepEqual(summary.durationsMs, [1000, 2000, 3000])
  assert.equal(unusable(summary), null)
})

test('failures are a result, while an unobserved test or an idle hold is not', (t) => {
  const root = temporary(t)
  const directory = path.join(root, '1')
  fs.mkdirSync(directory)
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--delay',
    `${point}=400`,
  )
  fs.writeFileSync(
    path.join(directory, 'report.json'),
    report(
      [
        {
          moduleId: path.join(root, 'apps/web', file.slice(9)),
          state: 'failed',
          tests: [
            testCase('interactive documents', 'failed', [{ message: 'held' }]),
          ],
        },
      ],
      'failed',
    ),
  )
  fs.writeFileSync(path.join(directory, 'holds.jsonl'), `{"${point}":2}\n`)
  const reproduced = summarize(
    options,
    [readRun({ directory, run: 1, options, root })],
    { where: 'local' },
  )
  assert.deepEqual(
    [reproduced.runs, reproduced.failures, reproduced.failedRuns],
    [1, 1, [1]],
  )
  assert.equal(reproduced.firstError, 'held')
  assert.deepEqual(reproduced.holds, [{ run: 1, counts: { [point]: 2 } }])
  assert.equal(unusable(reproduced), null)

  fs.rmSync(path.join(directory, 'holds.jsonl'))
  const idle = summarize(
    options,
    [readRun({ directory, run: 1, options, root })],
    { where: 'local' },
  )
  assert.match(unusable(idle), new RegExp(`Hold ${point} never ran`, 'u'))

  fs.writeFileSync(path.join(directory, 'report.json'), report([]))
  const unobserved = summarize(
    options,
    [readRun({ directory, run: 1, options, root })],
    { where: 'local' },
  )
  assert.match(unusable(unobserved), /No test ran/u)
})

test('a repetition that failed while holding nothing is not the reproduction', () => {
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--repeat',
    '2',
    '--delay',
    `${point}=400`,
  )
  const summary = summarize(
    options,
    [
      run(1, { holds: [], failed: 1, error: 'another race entirely' }),
      run(2, { holds: [{ [point]: 7 }], failed: 1, error: 'held' }),
    ],
    { where: 'local' },
  )
  assert.deepEqual(summary.holds, [
    { run: 1, counts: { [point]: 0 } },
    { run: 2, counts: { [point]: 7 } },
  ])
  assert.match(unusable(summary), /Run 1 failed while holding nothing/u)
})

test('a rerun reads nothing the last run left behind', (t) => {
  const root = temporary(t)
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--results',
    '.flaky-repro/run',
  )
  const directory = path.join(root, options.results)
  fs.mkdirSync(path.join(directory, '1'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'summary.json'), '{"failures":0}')
  fs.writeFileSync(path.join(directory, '1', 'holds.jsonl'), `{"${point}":9}\n`)
  fs.writeFileSync(path.join(directory, 'docker.log'), 'kept')
  assert.equal(prepareResults(options, root), directory)
  assert.ok(!fs.existsSync(path.join(directory, 'summary.json')))
  assert.ok(!fs.existsSync(path.join(directory, '1')))
  assert.equal(
    fs.readFileSync(path.join(directory, 'docker.log'), 'utf8'),
    'kept',
  )
})

test('only a summary the container wrote for this run is reported as its result', (t) => {
  const root = temporary(t)
  const options = parse(
    '--file',
    file,
    '--project',
    'firefox',
    '--repeat',
    '2',
    '--delay',
    `${point}=400`,
    '--results',
    '.flaky-repro/run',
  )
  const directory = prepareResults(options, root)
  const log = path.join(directory, 'docker.log')
  fs.writeFileSync(log, 'pnpm install failed\n')
  const read = (status) => containerSummary({ status, options, root, log })
  const summaryFile = path.join(directory, 'summary.json')
  const write = (summary) =>
    fs.writeFileSync(summaryFile, JSON.stringify(summary))

  assert.throws(() => read({ exitCode: 0 }), /wrote no summary/u)
  const held = summarize(
    options,
    [run(1, { holds: [{ [point]: 4 }] }), run(2, { holds: [{ [point]: 4 }] })],
    { where: 'local' },
  )
  write(held)
  assert.deepEqual(read({ exitCode: 0 }), held)
  // A container that did not finish leaves the last run's summary in place.
  assert.throws(() => read({ exitCode: 1 }), /exited 1/u)
  assert.throws(
    () => read({ exitCode: null, timedOut: true }),
    /exited without a code/u,
  )
  // Except when the container refused its own summary: that is this run's
  // result, and this runner refuses it again.
  write(summarize(options, [run(1), run(2)], { where: 'local' }))
  assert.match(unusable(read({ exitCode: 1 })), /never ran/u)

  for (const [field, value] of [
    ['repeat', 1],
    ['file', 'apps/web/app/lib/other.behavior.browser.test.tsx'],
    ['test', 'some other test'],
    ['project', 'webkit'],
    ['delays', {}],
    ['results', '.flaky-repro/elsewhere'],
  ]) {
    write({ ...held, [field]: value })
    assert.throws(() => read({ exitCode: 0 }), new RegExp(field, 'u'))
  }
  write({ ...held, delays: { [point]: 400 } })
  assert.equal(mismatched(read({ exitCode: 0 }), options), null)
  fs.writeFileSync(summaryFile, 'half a sum')
  assert.throws(() => read({ exitCode: 0 }), /unreadable/u)
})

test('stopping the runner stops its busy loops and its container', () => {
  const cleaned = []
  const exits = []
  // A real signal name would reach this test runner's own handlers; the
  // handler takes the name it would be given.
  const detach = onSignals(() => cleaned.push('cleanup'), {
    signals: ['SIGHUP'],
    exit: (code) => exits.push(code),
  })
  process.emit('SIGHUP', 'SIGTERM')
  process.emit('SIGHUP', 'SIGINT')
  assert.deepEqual(cleaned, ['cleanup', 'cleanup'])
  assert.deepEqual(exits, [143, 130])
  detach()
  process.emit('SIGHUP', 'SIGINT')
  assert.deepEqual(cleaned, ['cleanup', 'cleanup'])
})

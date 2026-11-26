import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  UsageError,
  delayEnvironment,
  dockerInvocation,
  dockerSummary,
  holdPoints,
  parseOptions,
  pinnedRuntime,
  readRun,
  repositoryRoot,
  summarize,
  unusable,
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
const report = (modules, reason = 'passed') =>
  JSON.stringify({
    schemaVersion: 1,
    reason,
    unhandledErrors: [],
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
    ['--file', file, '--project', 'firefox', '--cpus', '1', '--no-docker'],
    ['--file', file, '--project', 'firefox', '--unknown-flag'],
  ])
    assert.throws(() => parseOptions(argv), UsageError, argv.join(' '))
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
  const run = readRun({ directory, run: 1, options, root })
  assert.equal(run.failed, 1)
  assert.equal(run.observed, 1)
  assert.equal(run.error, 'Timeout 30000ms exceeded.')
  assert.deepEqual(run.others, ['apps/web/app/lib/other.test.tsx'])
  assert.deepEqual(run.captures, ['1/state-screens-1.json'])
  assert.deepEqual(run.holds, [{ [point]: 3 }])
  fs.writeFileSync(path.join(directory, 'report.json'), 'not a report')
  assert.ok(readRun({ directory, run: 2, options, root }).incomplete)
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
  assert.deepEqual(reproduced.holds, { [point]: 2 })
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

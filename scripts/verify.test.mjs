import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runVerify, VERIFY_STAGES } from './verify.mjs'

const ok = () => ({ status: 0, signal: null, error: undefined })

test('every verify stage is a package script', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
  )
  for (const stage of VERIFY_STAGES)
    assert.ok(scripts[stage.args[0]], `${stage.args[0]} exists`)
  assert.deepEqual(
    VERIFY_STAGES.map((stage) => stage.name),
    [
      'format',
      'lint',
      'check:public-development-guard',
      'audit:tests',
      'test:scripts',
      'public:scan',
    ],
  )
})

test('verify runs the stages in order and reports success on stdout', () => {
  const calls = []
  const logs = []
  const reports = []
  const result = runVerify({
    run: (args) => {
      calls.push(args.join(' '))
      return ok()
    },
    log: (line) => logs.push(line),
    report: (line) => reports.push(line),
  })
  assert.equal(result, null)
  assert.deepEqual(calls, [
    'format',
    'lint',
    'check:public-development-guard',
    'audit:tests',
    'test:scripts',
    'public:scan .',
  ])
  assert.equal(
    reports.at(-1),
    'verify: ok (format, lint, check:public-development-guard, audit:tests, test:scripts, public:scan)',
  )
  assert.doesNotMatch(logs.join('\n'), /verify: ok/u)
})

test('verify stops at the first failing stage and names what did not run', () => {
  const calls = []
  const logs = []
  const result = runVerify({
    run: (args) => {
      calls.push(args[0])
      return args[0] === 'lint' ? { status: 3, signal: null } : ok()
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(result, { stage: 'lint', status: 3 })
  assert.deepEqual(calls, ['format', 'lint'])
  assert.equal(
    logs.at(-1),
    'verify: lint failed (exit 3); not run: check:public-development-guard, audit:tests, test:scripts, public:scan.',
  )
})

test('verify reports a signal or spawn error on the failing stage', () => {
  const logs = []
  const killed = runVerify({
    stages: VERIFY_STAGES.slice(-1),
    run: () => ({ status: null, signal: 'SIGINT' }),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(killed, { stage: 'public:scan', status: 1 })
  assert.equal(logs.at(-1), 'verify: public:scan failed (killed by SIGINT).')
  const missing = runVerify({
    stages: VERIFY_STAGES.slice(0, 1),
    run: () => ({
      status: null,
      signal: null,
      error: new Error('spawn pnpm ENOENT'),
    }),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(missing, { stage: 'format', status: 1 })
  assert.equal(logs.at(-1), 'verify: format failed: spawn pnpm ENOENT.')
})

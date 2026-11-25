import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runVerify, VERIFY_STAGES } from './verify.mjs'

const ok = () => ({ status: 0, signal: null, error: undefined })

// Injected stages keep the behavior tests independent of which checks the
// default list happens to run, and of their order.
const stages = [
  { name: 'first', args: ['first'] },
  { name: 'second', args: ['second', '.'] },
  { name: 'third', args: ['third'] },
]

test('every verify stage runs a package script that exists', () => {
  const { scripts } = JSON.parse(
    readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'),
  )
  assert.ok(VERIFY_STAGES.length > 0)
  for (const stage of VERIFY_STAGES)
    assert.ok(scripts[stage.args[0]], `${stage.args[0]} exists`)
})

test('verify runs the stages in order and reports success on stdout', () => {
  const calls = []
  const logs = []
  const reports = []
  const result = runVerify({
    stages,
    run: (args) => {
      calls.push(args.join(' '))
      return ok()
    },
    log: (line) => logs.push(line),
    report: (line) => reports.push(line),
  })
  assert.equal(result, null)
  assert.deepEqual(calls, ['first', 'second .', 'third'])
  assert.equal(reports.at(-1), 'verify: ok (first, second, third)')
  assert.doesNotMatch(logs.join('\n'), /verify: ok/u)
})

test('verify stops at the first failing stage and names what did not run', () => {
  const calls = []
  const logs = []
  const result = runVerify({
    stages,
    run: (args) => {
      calls.push(args[0])
      return args[0] === 'second' ? { status: 3, signal: null } : ok()
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(result, { stage: 'second', status: 3 })
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(logs.at(-1), 'verify: second failed (exit 3); not run: third.')
})

test('verify reports a signal or spawn error on the failing stage', () => {
  const logs = []
  const killed = runVerify({
    stages: stages.slice(-1),
    run: () => ({ status: null, signal: 'SIGINT' }),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(killed, { stage: 'third', status: 1 })
  assert.equal(logs.at(-1), 'verify: third failed (killed by SIGINT).')
  assert.throws(() => runVerify({ stages: [], run: ok }), /no stages/u)
  const missing = runVerify({
    stages: stages.slice(0, 1),
    run: () => ({
      status: null,
      signal: null,
      error: new Error('spawn pnpm ENOENT'),
    }),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(missing, { stage: 'first', status: 1 })
  assert.equal(logs.at(-1), 'verify: first failed: spawn pnpm ENOENT.')
})

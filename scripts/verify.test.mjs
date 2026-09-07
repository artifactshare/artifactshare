import test from 'node:test'
import assert from 'node:assert/strict'
import { runVerify, VERIFY_STAGES } from './verify.mjs'

test('verify runs the four stages in order and reports success', () => {
  const calls = []
  const logs = []
  const result = runVerify({
    run: (args) => {
      calls.push(args.join(' '))
      return 0
    },
    log: (line) => logs.push(line),
  })
  assert.equal(result, null)
  assert.deepEqual(calls, ['format', 'lint', 'test:scripts', 'public:scan .'])
  assert.match(
    logs.at(-1),
    /^verify: ok \(format, lint, test:scripts, public:scan\)$/u,
  )
})

test('verify stops at the first failing stage and names it', () => {
  const calls = []
  const logs = []
  const result = runVerify({
    run: (args) => {
      calls.push(args[0])
      return args[0] === 'lint' ? { status: 3 } : 0
    },
    log: (line) => logs.push(line),
  })
  assert.deepEqual(result, { stage: 'lint', status: 3 })
  assert.deepEqual(calls, ['format', 'lint'])
  assert.match(
    logs.at(-1),
    /^verify: lint failed \(exit 3\); the later stages did not run\.$/u,
  )
})

test('verify treats a spawn error as a failure of that stage', () => {
  const logs = []
  const result = runVerify({
    stages: VERIFY_STAGES.slice(0, 1),
    run: () => ({ status: null, error: new Error('spawn pnpm ENOENT') }),
    log: (line) => logs.push(line),
  })
  assert.deepEqual(result, { stage: 'format', status: 1 })
  assert.match(logs.at(-1), /spawn pnpm ENOENT/u)
})

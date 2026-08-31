import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendTail,
  main,
  parseArgs,
  waitForBoth,
  withoutReminder,
} from './implementation-review-gate.mjs'
import { reviewReminder } from './codex-review.mjs'

test('accepts only the zero-option implementation gate', () => {
  assert.deepEqual(parseArgs([]), { help: false })
  assert.deepEqual(parseArgs(['--', '--help']), { help: true })
  assert.throws(() => parseArgs(['--base', 'main']), /Usage/u)
})

test('waits for both reviewers before reporting a failure', async () => {
  let secondFinished = false
  const second = Promise.resolve().then(() => {
    secondFinished = true
    return 'done'
  })
  await assert.rejects(
    () => waitForBoth([Promise.reject(new Error('failed')), second]),
    /failed/u,
  )
  assert.equal(secondFinished, true)
})

test('bounds captured diagnostic output to its tail', () => {
  const capture = appendTail({ text: '012345', truncated: false }, '6789', 6)
  assert.deepEqual(capture, { text: '456789', truncated: true })
})

test('prints both final results together and one reminder', async () => {
  const logs = []
  const timings = []
  let headReads = 0
  const code = await main({
    readCleanHead: () => {
      headReads += 1
      return 'a'.repeat(40)
    },
    review: (name) =>
      Promise.resolve({
        name,
        stdout: `${name} findings\n${reviewReminder}`,
        stderr: `${name} timing`,
      }),
    log: (value) => logs.push(value),
    timingLog: (value) => timings.push(value),
  })
  assert.equal(code, 0)
  assert.equal(headReads, 2)
  assert.deepEqual(logs, [
    '## Codex\n\ncodex findings',
    '## Claude\n\nclaude findings',
    reviewReminder,
  ])
  assert.deepEqual(timings, ['codex timing', 'claude timing'])
})

test('does not print either result until both reviewers succeed', async () => {
  const logs = []
  await assert.rejects(
    () =>
      main({
        readCleanHead: () => 'a'.repeat(40),
        review: (name) =>
          name === 'codex'
            ? Promise.reject(new Error('codex failed'))
            : Promise.resolve({ name, stdout: 'claude result', stderr: '' }),
        log: (value) => logs.push(value),
      }),
    /codex failed/u,
  )
  assert.deepEqual(logs, [])
})

test('removes only the exact shared reminder suffix', () => {
  assert.equal(withoutReminder(`Finding\n${reviewReminder}`), 'Finding')
  assert.equal(withoutReminder('Finding'), 'Finding')
})

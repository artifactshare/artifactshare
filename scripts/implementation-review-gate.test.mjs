import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  appendTail,
  main,
  parseArgs,
  recordCompletedRounds,
  runReviewer,
  waitForBoth,
  withoutReminder,
} from './implementation-review-gate.mjs'
import { reviewReminder } from './codex-review.mjs'
import { readRounds, roundsPath } from './review-rounds.mjs'

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
  const capture = appendTail(
    { buffer: Buffer.from('012345'), truncated: false },
    '6789',
    6,
  )
  assert.deepEqual(capture, {
    buffer: Buffer.from('456789'),
    truncated: true,
  })
})

test('preserves successful output and bounds UTF-8 diagnostics', async () => {
  const stdout = 'f'.repeat(70 * 1024)
  const stderr = '前'.repeat(30 * 1024)
  const result = await runReviewer('codex', {
    spawnProcess: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stdout.end(stdout)
        child.stderr.end(stderr)
        child.emit('close', 0)
      })
      return child
    },
  })
  assert.equal(result.stdout, stdout)
  assert.match(result.stderr, /^\[earlier output omitted\]\n/u)
  assert.doesNotMatch(result.stderr, /�/u)
})

test('records both reviewer rounds only after coordinated success', () => {
  const common = mkdtempSync(join(tmpdir(), 'implementation-rounds-'))
  const run = (_file, args) => {
    if (args[0] === 'branch') return 'fix/review-gate'
    if (args[0] === 'rev-parse') return common
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  }
  try {
    const head = 'a'.repeat(40)
    recordCompletedRounds(head, run)
    for (const reviewer of ['codex', 'claude'])
      assert.equal(
        readRounds(roundsPath('fix/review-gate', reviewer, run)).rounds[0].head,
        head,
      )
  } finally {
    rmSync(common, { recursive: true, force: true })
  }
})

test('prints both final results together and one reminder', async () => {
  const logs = []
  const timings = []
  const events = []
  let headReads = 0
  let recorded = 0
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
    log: (value) => {
      logs.push(value)
      events.push(`log:${value}`)
    },
    timingLog: (value) => timings.push(value),
    recordRounds: () => {
      recorded += 1
      events.push('record')
    },
  })
  assert.equal(code, 0)
  assert.equal(headReads, 2)
  assert.equal(recorded, 1)
  assert.deepEqual(logs, [
    '## Codex\n\ncodex findings',
    '## Claude\n\nclaude findings',
    reviewReminder,
  ])
  assert.deepEqual(timings, ['codex timing', 'claude timing'])
  assert.equal(events.at(-1), 'record')
})

test('does not print either result until both reviewers succeed', async () => {
  const logs = []
  let recorded = 0
  await assert.rejects(
    () =>
      main({
        readCleanHead: () => 'a'.repeat(40),
        review: (name) =>
          name === 'codex'
            ? Promise.reject(new Error('codex failed'))
            : Promise.resolve({ name, stdout: 'claude result', stderr: '' }),
        log: (value) => logs.push(value),
        recordRounds: () => (recorded += 1),
      }),
    /codex failed/u,
  )
  assert.deepEqual(logs, [])
  assert.equal(recorded, 0)
})

test('removes only the exact shared reminder suffix', () => {
  assert.equal(withoutReminder(`Finding\n${reviewReminder}`), 'Finding')
  assert.equal(withoutReminder('Finding'), 'Finding')
})

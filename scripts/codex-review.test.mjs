import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultBase,
  defaultModel,
  defaultTimeoutMs,
  main,
  parseArgs,
  reviewArgs,
} from './codex-review.mjs'

const head = 'a'.repeat(40)

function cleanGit(_file, args) {
  if (args[0] === 'status') return ''
  if (args[0] === 'rev-parse') return `${head}\n`
  if (args[0] === 'merge-base') return `${head}\n`
  throw new Error(`Unexpected git call: ${args.join(' ')}`)
}

test('parses the small supported option set', () => {
  assert.deepEqual(parseArgs([]), {
    model: defaultModel,
    base: defaultBase,
    timeoutMs: defaultTimeoutMs,
    dryRun: false,
  })
  assert.deepEqual(
    parseArgs([
      '--',
      '--model',
      'custom',
      '--base',
      'main',
      '--timeout-ms',
      '25',
      '--dry-run',
    ]),
    { model: 'custom', base: 'main', timeoutMs: 25, dryRun: true },
  )
  assert.throws(() => parseArgs(['extra protocol']), /Unknown option/u)
})

test('builds a native base review command without MCP configuration', () => {
  assert.deepEqual(reviewArgs({ model: 'm', base: 'b' }), [
    '-m',
    'm',
    'review',
    '--base',
    'b',
  ])
})

test('requires a clean committed checkout before review', () => {
  let ran = false
  const errors = []
  const code = main({
    exec: (_file, args) => (args[0] === 'status' ? ' M file' : `${head}\n`),
    run: () => {
      ran = true
    },
    errorLog: (message) => errors.push(message),
  })
  assert.equal(code, 1)
  assert.equal(ran, false)
  assert.match(errors[0], /clean/u)
})

test('runs native review and verifies the checkout did not change', () => {
  const calls = []
  const code = main({
    exec: cleanGit,
    run: (file, args, options) => {
      calls.push([file, args, options])
      return { status: 0 }
    },
  })
  assert.equal(code, 0)
  assert.deepEqual(calls[0][0], 'codex')
  assert.deepEqual(
    calls[0][1],
    reviewArgs({ model: defaultModel, base: defaultBase }),
  )
  assert.equal(calls[0][2].timeout, defaultTimeoutMs)
})

test('rejects a review result when HEAD changes', () => {
  let reads = 0
  const errors = []
  const code = main({
    exec: (_file, args) => {
      if (args[0] === 'status') return ''
      if (args[0] === 'merge-base') return `${head}\n`
      reads += 1
      return `${(reads === 1 ? 'a' : 'b').repeat(40)}\n`
    },
    run: () => ({ status: 0 }),
    errorLog: (message) => errors.push(message),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /changed during review/u)
})

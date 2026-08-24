import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultBase,
  defaultModel,
  invocation,
  main,
  parseArgs,
  reviewPrompt,
} from './cursor-review.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const root = '/repo'

function cleanGit(_file, args) {
  if (args[0] === 'status') return ''
  if (args[0] === 'merge-base') return `${base}\n`
  if (args[0] === 'diff') return 'diff --git a/file b/file\n+change\n'
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
    return `${root}\n`
  throw new Error(`Unexpected git call: ${args.join(' ')}`)
}

test('parses the supported options', () => {
  assert.deepEqual(parseArgs([]), {
    model: defaultModel,
    base: defaultBase,
    dryRun: false,
  })
  assert.deepEqual(
    parseArgs(['--', '--model', 'custom', '--base', 'main', '--dry-run']),
    { model: 'custom', base: 'main', dryRun: true },
  )
  assert.throws(() => parseArgs(['--phase', 'spec']), /Unknown option/u)
})

test('uses Cursor Ask mode for a read-only review', () => {
  const prompt = reviewPrompt({
    base: defaultBase,
    head,
    diff: 'diff --git a/file b/file',
  })
  const request = invocation({
    model: defaultModel,
    workspace: root,
    prompt,
  })
  assert.deepEqual(request.args.slice(0, 10), [
    '--print',
    '--mode',
    'ask',
    '--sandbox',
    'enabled',
    '--trust',
    '--model',
    defaultModel,
    '--output-format',
    'json',
  ])
  assert.equal(request.args.at(-1), root)
  assert.equal(request.input, prompt)
  assert.match(request.input, /origin\/main\.\.\.[a-f0-9]{40}/u)
  assert.match(request.input, /A blocker means/u)
  assert.match(request.input, /Do not edit files/u)
  assert.match(request.input, /diff --git a\/file b\/file/u)
  assert.match(request.input, /untrusted data/u)
})

test('runs Cursor review, prints its result, and reports wall time', () => {
  const calls = []
  const logs = []
  const errors = []
  const times = [1_000, 13_400]
  const code = main({
    exec: cleanGit,
    now: () => times.shift(),
    run: (file, args, options) => {
      calls.push([file, args, options])
      return {
        status: 0,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'GO',
        }),
      }
    },
    log: (message) => logs.push(message),
    errorLog: (message) => errors.push(message),
  })
  assert.equal(code, 0)
  assert.equal(calls[0][0], 'cursor-agent')
  assert.equal(calls[0][2].cwd, root)
  assert.match(calls[0][2].input, /diff --git/u)
  assert.match(calls[0][2].input, new RegExp(`${base}\\.\\.\\.${head}`))
  assert.deepEqual(logs, ['GO'])
  assert.deepEqual(errors, [
    `Cursor implementation review: ${head.slice(0, 12)}, 12s`,
  ])
})

test('requires a clean checkout and rejects checkout mutation', () => {
  let ran = false
  const errors = []
  const dirty = main({
    exec: (_file, args) => (args[0] === 'status' ? ' M file' : `${head}\n`),
    run: () => {
      ran = true
    },
    errorLog: (message) => errors.push(message),
  })
  assert.equal(dirty, 1)
  assert.equal(ran, false)
  assert.match(errors[0], /clean/u)

  let headReads = 0
  const changed = main({
    exec: (_file, args) => {
      if (args[0] === 'status') return ''
      if (args[0] === 'merge-base') return `${head}\n`
      if (args[0] === 'diff') return 'diff --git a/file b/file\n+change\n'
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
        return `${root}\n`
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return `${(headReads++ === 0 ? 'a' : 'b').repeat(40)}\n`
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    },
    run: () => ({
      status: 0,
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'GO',
      }),
    }),
    errorLog: (message) => errors.push(message),
  })
  assert.equal(changed, 1)
  assert.match(errors.at(-1), /changed during review/u)
})

test('rejects unsuccessful or malformed Cursor output', () => {
  for (const result of [
    { status: 2, stderr: 'failed' },
    { status: 0, stdout: '{}' },
  ]) {
    const errors = []
    const code = main({
      exec: cleanGit,
      run: () => result,
      errorLog: (message) => errors.push(message),
    })
    assert.equal(code, 1)
    assert.ok(errors[0])
  }
})

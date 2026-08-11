import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultBase,
  defaultModel,
  main,
  parseArgs,
  reviewRequest,
  usage,
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
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    dryRun: false,
  })
  assert.deepEqual(
    parseArgs(['--', '--model', 'custom', '--base', 'main', '--dry-run']),
    {
      model: 'custom',
      base: 'main',
      phase: 'implementation',
      artifactUrl: undefined,
      versionId: undefined,
      dryRun: true,
    },
  )
  assert.deepEqual(
    parseArgs([
      '--phase',
      'spec',
      '--artifact-url',
      'https://example.test/a/spec',
      '--version-id',
      'v1',
    ]),
    {
      model: defaultModel,
      base: defaultBase,
      phase: 'spec',
      artifactUrl: 'https://example.test/a/spec',
      versionId: 'v1',
      dryRun: false,
    },
  )
  assert.throws(() => parseArgs(['--phase', 'spec']), /requires/u)
  assert.throws(() => parseArgs(['extra protocol']), /Unknown option/u)
})

test('builds a native base review command without MCP configuration', () => {
  assert.deepEqual(
    reviewRequest({ model: 'm', base: 'b', phase: 'implementation' }),
    { args: ['-m', 'm', 'review', '--base', 'b'] },
  )
})

test('builds a read-only spec review from stdin', () => {
  assert.deepEqual(reviewRequest({ model: 'm', phase: 'spec' }, 'prompt'), {
    args: ['exec', '-m', 'm', '--sandbox', 'read-only', '-'],
    input: 'prompt',
  })
})

test('documents both review phases and fixed spec inputs', () => {
  assert.match(usage(), /phase implementation/u)
  assert.match(usage(), /phase spec/u)
  assert.match(usage(), /--artifact-url/u)
  assert.match(usage(), /--version-id/u)
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
    reviewRequest({
      model: defaultModel,
      base: defaultBase,
      phase: 'implementation',
    }).args,
  )
  assert.deepEqual(calls[0][2], { input: undefined, stdio: 'inherit' })
})

test('reads the fixed spec version and runs Codex against the same clean HEAD', () => {
  const calls = []
  const code = main({
    argv: [
      '--phase',
      'spec',
      '--artifact-url',
      'https://example.test/a/spec',
      '--version-id',
      'v1',
    ],
    exec: (file, args, options) => {
      if (file === 'git') return cleanGit(file, args)
      assert.equal(file, 'npm')
      assert.equal(options.maxBuffer, 16 * 1024 * 1024)
      return JSON.stringify({
        ok: true,
        data: {
          content: 'Requirement',
          version_id: 'v1',
          truncated: false,
          comments_has_more: false,
          comments: [],
        },
      })
    },
    run: (file, args, options) => {
      calls.push([file, args, options])
      return { status: 0 }
    },
  })
  assert.equal(code, 0)
  assert.equal(calls[0][0], 'codex')
  assert.deepEqual(calls[0][1], [
    'exec',
    '-m',
    defaultModel,
    '--sandbox',
    'read-only',
    '-',
  ])
  assert.match(calls[0][2].input, /Artifact Share version: v1/u)
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'inherit', 'inherit'])
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

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  allowedTools,
  buildInvocation,
  claudeVersion,
  main,
  parseArgs,
  reviewLevel,
  runClaude,
  splitRange,
} from './claude-review.mjs'

test('maps workflow depth and risk to native code-review levels', () => {
  assert.equal(reviewLevel('loop', 'normal'), 'low')
  assert.equal(reviewLevel('gate', 'normal'), 'high')
  assert.equal(reviewLevel('gate', 'high'), 'xhigh')
  assert.throws(() => reviewLevel('loop', 'high'))
})

test('parses the retained CLI and rejects unsafe combinations', () => {
  assert.deepEqual(parseArgs([]), {
    target: undefined,
    depth: 'loop',
    risk: 'normal',
    note: undefined,
    timeoutMs: 1_800_000,
    dryRun: false,
  })
  assert.equal(parseArgs(['--note', 'check --dry-run']).note, 'check --dry-run')
  assert.throws(() => parseArgs(['--target', '']))
  assert.throws(() => parseArgs(['--note', '--depth', 'gate']))
  assert.throws(() => parseArgs(['--depth', 'loop', '--risk', 'high']))
  assert.throws(() => parseArgs(['--depth', 'gate', '--target', 'a..b']))
  assert.throws(() => parseArgs(['--note', 'a\nb']))
})

test('builds the exact native prompt separately from system guidance', () => {
  const invocation = buildInvocation({
    level: 'xhigh',
    target: 'origin/main...abc',
    note: 'focus here',
  })
  assert.equal(invocation.prompt, '/code-review xhigh origin/main...abc')
  assert.equal(invocation.prompt.split(/\s+/u).length, 3)
  assert.ok(invocation.systemPrompt.endsWith(' Additional focus: focus here'))
  assert.equal(invocation.args.at(-3), invocation.prompt)
  assert.deepEqual(
    invocation.args.slice(
      invocation.args.indexOf('--allowedTools') + 1,
      invocation.args.indexOf('--permission-mode'),
    ),
    allowedTools,
  )
})

test('validates dotted and ordinary Git ranges', () => {
  assert.deepEqual(splitRange('v1.2...HEAD'), { left: 'v1.2', right: 'HEAD' })
  assert.deepEqual(splitRange('HEAD~1..HEAD'), {
    left: 'HEAD~1',
    right: 'HEAD',
  })
  for (const target of ['a', 'a..', '..b', '-a..b', 'a..-b', 'a..b...c'])
    assert.throws(() => splitRange(target), target)
})

test('pins the verified Claude Code version', () => {
  assert.equal(claudeVersion, '2.1.226 (Claude Code)')
})

test('preserves timeout outcome when termination closes the child first', async () => {
  const child = new EventEmitter()
  child.pid = 12345
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const killImpl = () => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
  }
  const result = await runClaude({
    args: [],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1,
    spawnImpl: () => child,
    killImpl,
  })
  assert.deepEqual(result, { timedOut: true })
})

function mainHarness(envelope) {
  const sha = 'a'.repeat(40)
  const outputs = []
  const errors = []
  const run = (file, args) => {
    if (file === 'claude')
      return {
        code: 0,
        stdout: `${claudeVersion}\n`,
        stderr: '',
      }
    if (args.includes('--show-toplevel'))
      return { code: 0, stdout: '/repo\n', stderr: '' }
    if (args.includes('--git-path'))
      return { code: 0, stdout: `/repo/.git/${args.at(-1)}\n`, stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'diff') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'rev-parse')
      return { code: 0, stdout: `${sha}\n`, stderr: '' }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  return {
    sha,
    outputs,
    errors,
    options: {
      run,
      reviewRunner: () =>
        Promise.resolve({
          code: 0,
          stdout: Buffer.from(JSON.stringify(envelope)),
          stderr: Buffer.alloc(0),
        }),
      stdout: { write: (value) => outputs.push(Buffer.from(value).toString()) },
      stderr: { write: (value) => errors.push(String(value)) },
    },
  }
}

test('main emits a valid native review result unchanged', async () => {
  const harness = mainHarness({
    is_error: false,
    subtype: 'success',
    permission_denials: [],
    result: '指摘なし\n',
  })
  assert.equal(await main(harness.options), 0)
  assert.deepEqual(harness.outputs, ['指摘なし\n'])
  assert.deepEqual(harness.errors, [])
})

test('main fails closed and exposes a review with permission denials', async () => {
  const harness = mainHarness({
    is_error: false,
    subtype: 'success',
    permission_denials: [{ tool_name: 'Write' }],
    result: 'review result',
  })
  assert.equal(await main(harness.options), 1)
  assert.deepEqual(harness.outputs, ['review result'])
  assert.match(harness.errors.join(''), /permission denials/u)
})

test('gate preflight failure preserves existing valid evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-review-test-'))
  const resultPath = join(directory, 'review.txt')
  const receiptPath = join(directory, 'review.json')
  writeFileSync(resultPath, 'existing result')
  writeFileSync(receiptPath, 'existing receipt')
  const run = (file, args) => {
    if (file === 'claude')
      return { code: 0, stdout: 'newer version\n', stderr: '' }
    if (args.includes('--show-toplevel'))
      return { code: 0, stdout: '/repo\n', stderr: '' }
    if (args.includes('claude-gate-review.txt'))
      return { code: 0, stdout: `${resultPath}\n`, stderr: '' }
    if (args.includes('claude-gate-review.json'))
      return { code: 0, stdout: `${receiptPath}\n`, stderr: '' }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`)
  }
  try {
    assert.equal(
      await main({
        argv: ['--depth', 'gate'],
        run,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
      }),
      1,
    )
    assert.equal(readFileSync(resultPath, 'utf8'), 'existing result')
    assert.equal(readFileSync(receiptPath, 'utf8'), 'existing receipt')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

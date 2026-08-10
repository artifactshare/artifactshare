import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowedTools,
  buildInvocation,
  claudeVersion,
  parseArgs,
  reviewLevel,
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

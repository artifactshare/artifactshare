import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultBase,
  defaultEffort,
  defaultModel,
  main,
  parseArgs,
  reviewReminder,
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
    effort: defaultEffort,
    base: defaultBase,
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    dryRun: false,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
  })
  assert.deepEqual(
    parseArgs(['--', '--model', 'custom', '--base', 'main', '--dry-run']),
    {
      model: 'custom',
      effort: defaultEffort,
      base: 'main',
      phase: 'implementation',
      artifactUrl: undefined,
      versionId: undefined,
      dryRun: true,
      reviewRound: 1,
      baselineSize: undefined,
      baselineConcepts: undefined,
      dispositionsFile: undefined,
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
      effort: defaultEffort,
      base: defaultBase,
      phase: 'spec',
      artifactUrl: 'https://example.test/a/spec',
      versionId: 'v1',
      dryRun: false,
      reviewRound: 1,
      baselineSize: undefined,
      baselineConcepts: undefined,
      dispositionsFile: undefined,
    },
  )
  assert.throws(() => parseArgs(['--phase', 'spec']), /requires/u)
  assert.throws(() => parseArgs(['extra protocol']), /Unknown option/u)
})

test('builds a native base review command without MCP configuration', () => {
  assert.deepEqual(
    reviewRequest({
      model: 'm',
      effort: 'xhigh',
      base: 'b',
      phase: 'implementation',
    }),
    {
      args: [
        '-m',
        'm',
        '-c',
        'model_reasoning_effort="xhigh"',
        'review',
        '--base',
        'b',
      ],
    },
  )
})

test('builds a read-only spec review from stdin', () => {
  assert.deepEqual(
    reviewRequest({ model: 'm', effort: 'xhigh', phase: 'spec' }, 'prompt'),
    {
      args: [
        'exec',
        '-m',
        'm',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--sandbox',
        'read-only',
        '-',
      ],
      input: 'prompt',
    },
  )
})

test('documents both review phases and fixed spec inputs', () => {
  assert.match(usage(), /phase implementation/u)
  assert.match(usage(), /phase spec/u)
  assert.match(usage(), /--artifact-url/u)
  assert.match(usage(), /--version-id/u)
  assert.match(usage(), /--effort/u)
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
  const logs = []
  const timings = []
  const times = [1_000, 9_600]
  const code = main({
    exec: cleanGit,
    now: () => times.shift(),
    log: (message) => logs.push(message),
    timingLog: (message) => timings.push(message),
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
      effort: defaultEffort,
      base: defaultBase,
      phase: 'implementation',
    }).args,
  )
  assert.deepEqual(calls[0][2], {
    input: undefined,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  assert.deepEqual(logs, [reviewReminder])
  assert.deepEqual(timings, [
    `Codex implementation review: ${head.slice(0, 12)}, 9s`,
  ])
})

test('reminds maintainers to combine both reviews and limit blockers to current breakage', () => {
  assert.match(reviewReminder, /Wait for both Codex and Claude/u)
  assert.match(reviewReminder, /classify all findings together/u)
  assert.match(
    reviewReminder,
    /in one sentence what current acceptance criterion/u,
  )
  assert.match(reviewReminder, /follow-up or non-actionable, not a blocker/u)
  assert.match(reviewReminder, /Fix all blockers together in one pass/u)
  assert.match(reviewReminder, /future reuse, generalization/u)
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
          content: `## Scope lock
### Owner decisions
- Current behavior.
### Non-goals
- Generalization.
### Acceptance criteria
- Requirement works.
## Requirement
Requirement`,
          version_id: 'v1',
          truncated: false,
          comments_has_more: false,
          comments: [],
        },
      })
    },
    run: (file, args, options) => {
      calls.push([file, args, options])
      return {
        status: 0,
        stdout: JSON.stringify({ verdict: 'GO', findings: [] }),
      }
    },
  })
  assert.equal(code, 0)
  assert.equal(calls[0][0], 'codex')
  assert.deepEqual(calls[0][1], [
    'exec',
    '-m',
    defaultModel,
    '-c',
    `model_reasoning_effort="${defaultEffort}"`,
    '--sandbox',
    'read-only',
    '-',
  ])
  assert.match(calls[0][2].input, /Artifact Share version: v1/u)
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe'])
})

test('rejects a review result when HEAD changes', () => {
  let reads = 0
  const errors = []
  const logs = []
  const code = main({
    exec: (_file, args) => {
      if (args[0] === 'status') return ''
      if (args[0] === 'merge-base') return `${head}\n`
      reads += 1
      return `${(reads === 1 ? 'a' : 'b').repeat(40)}\n`
    },
    run: () => ({ status: 0 }),
    log: (message) => logs.push(message),
    errorLog: (message) => errors.push(message),
  })
  assert.equal(code, 1)
  assert.match(errors[0], /changed during review/u)
  assert.deepEqual(logs, [])
})

test('does not print the reminder for help or dry-run', () => {
  for (const argv of [['--help'], ['--dry-run']]) {
    const logs = []
    const code = main({
      argv,
      exec: cleanGit,
      log: (message) => logs.push(message),
    })
    assert.equal(code, 0)
    assert.equal(logs.includes(reviewReminder), false)
  }
})

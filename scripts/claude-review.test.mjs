import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cliPackage,
  defaultBase,
  defaultEffort,
  defaultModel,
  invocation,
  launchClaudeReview,
  parseArgs,
  review,
  reviewReminder,
  usage,
} from './claude-review.mjs'
import { acquireActivityLock } from './worktree-activity-lock.mjs'

test('async launcher preserves provider diagnostics and revokes with its capability', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-context-'))
  const contextFile = join(directory, 'context.txt')
  writeFileSync(
    contextFile,
    'Purpose: review.\nAcceptance: correct.\n\n## Dispositions\n\nNone yet\n',
  )
  const head = 'a'.repeat(40)
  const run = (_file, args) =>
    args[1] === '--show-toplevel' ? '/repo' : '/repo/.git'
  const capability = await acquireActivityLock('test', {
    run,
    acquire: () => Promise.resolve(() => Promise.resolve()),
  })
  const execute = (_file, args) => {
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (args[0] === 'merge-base') return head
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  }
  try {
    const result = await launchClaudeReview(
      parseArgs([
        '--phase',
        'implementation',
        '--base',
        head,
        '--context-file',
        contextFile,
      ]),
      capability,
      {
        execute,
        readCleanHead: () => head,
        provider: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              is_error: false,
              subtype: 'success',
              result: 'GO',
              permission_denials: [],
            }),
            stderr: 'warning\n',
            code: 0,
          }),
      },
    )
    assert.match(result.stdout, /^GO/u)
    assert.match(result.stderr, /warning/u)
  } finally {
    await capability()
    rmSync(directory, { recursive: true, force: true })
  }
  await assert.rejects(
    launchClaudeReview(parseArgs(['--phase', 'implementation']), capability, {
      execute,
      readCleanHead: () => head,
    }),
    /live worktree activity-lock capability/u,
  )
})

test('parses the two review phases', () => {
  assert.deepEqual(parseArgs(['--phase', 'implementation']), {
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    model: defaultModel,
    level: 'high',
    effort: defaultEffort,
    base: undefined,
    expectedHead: undefined,
    contextFile: undefined,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
    snapshotFile: undefined,
    deferRoundRecord: false,
  })
  assert.deepEqual(
    parseArgs([
      '--phase',
      'spec',
      '--artifact-url',
      'https://example.test/a/example',
      '--version-id',
      'version',
      '--level',
      'low',
    ]),
    {
      phase: 'spec',
      artifactUrl: 'https://example.test/a/example',
      versionId: 'version',
      model: defaultModel,
      level: 'low',
      effort: 'low',
      base: undefined,
      expectedHead: undefined,
      contextFile: undefined,
      reviewRound: 1,
      baselineSize: undefined,
      baselineConcepts: undefined,
      dispositionsFile: undefined,
      snapshotFile: undefined,
      deferRoundRecord: false,
    },
  )
})

test('rejects incomplete or mixed phase arguments', () => {
  assert.throws(() => parseArgs([]), /phase/u)
  assert.throws(() => parseArgs(['--phase', 'spec']), /requires/u)
  assert.throws(
    () =>
      parseArgs([
        '--phase',
        'implementation',
        '--artifact-url',
        'https://example.test',
      ]),
    /does not accept/u,
  )
  assert.equal(
    parseArgs(['--phase', 'implementation', '--level', 'xhigh']).effort,
    'xhigh',
  )
  assert.throws(
    () =>
      parseArgs([
        '--phase',
        'implementation',
        '--level',
        'high',
        '--effort',
        'xhigh',
      ]),
    /must match/u,
  )
  assert.equal(
    parseArgs(['--phase', 'implementation', '--defer-round-record'])
      .deferRoundRecord,
    true,
  )
})

test('builds a direct implementation code-review invocation', () => {
  const request = invocation(
    {
      phase: 'implementation',
      artifactUrl: undefined,
      versionId: undefined,
      model: defaultModel,
      level: 'high',
      effort: defaultEffort,
      base: 'a'.repeat(40),
      expectedHead: undefined,
      contextFile: undefined,
      reviewRound: 1,
      baselineSize: undefined,
      baselineConcepts: undefined,
      dispositionsFile: undefined,
    },
    'a'.repeat(40),
  )
  assert.match(
    request.args.join(' '),
    new RegExp(`/code-review ${defaultEffort} ${'a'.repeat(40)}\\.\\.\\.`),
  )
  assert.deepEqual(
    request.args.slice(
      request.args.indexOf('--model'),
      request.args.indexOf('--tools'),
    ),
    ['--model', defaultModel, '--effort', defaultEffort],
  )
  assert.equal(request.args.includes('--no-session-persistence'), false)
})

test('passes the fixed target and review context through the safe-mode prompt', () => {
  const head = 'b'.repeat(40)
  const request = invocation(
    {
      phase: 'implementation',
      model: defaultModel,
      level: 'high',
      effort: defaultEffort,
      base: 'a'.repeat(40),
      expectedHead: head,
      context: 'Acceptance: preserve the current behavior.',
    },
    head,
  )
  const systemPrompt =
    request.args[request.args.indexOf('--append-system-prompt') + 1]
  assert.match(systemPrompt, /Review only/u)
  assert.match(systemPrompt, /Acceptance: preserve the current behavior/u)
  assert.match(
    systemPrompt,
    new RegExp(`Fixed review base SHA: ${'a'.repeat(40)}`),
  )
  assert.match(systemPrompt, new RegExp(`Expected review HEAD SHA: ${head}`))
  assert.match(
    request.args[request.args.indexOf('-p') + 1],
    new RegExp(
      `/code-review ${defaultEffort} ${'a'.repeat(40)}[.][.][.]${head}`,
    ),
  )
})

test('keeps the Artifact Share CLI pin and concise usage explicit', () => {
  assert.match(cliPackage, /^@artifactshare\/cli@\d/u)
  assert.match(usage(), /phase spec/u)
  assert.match(usage(), /phase implementation/u)
  assert.match(usage(), /--base/u)
  assert.match(usage(), /--effort/u)
})

test('prints the reminder only after a successful unchanged review', () => {
  const head = 'a'.repeat(40)
  const output = []
  const code = review({
    argv: ['--phase', 'implementation'],
    cleanHead: () => head,
    locateRounds: () => null,
    run: () =>
      JSON.stringify({
        is_error: false,
        subtype: 'success',
        result: 'No findings.',
        permission_denials: [],
      }),
    stdout: { write: (value) => output.push(value) },
    stderr: { write: () => {} },
  })
  assert.equal(code, 0)
  assert.deepEqual(output, ['No findings.\n', `${reviewReminder}\n`])
})

test('uses the same combined-review classification guidance as Codex', async () => {
  const { reviewReminder: codexReviewReminder } =
    await import('./codex-review.mjs')
  assert.equal(reviewReminder, codexReviewReminder)
})

test('does not print the reminder when the checkout changes', () => {
  const output = []
  let read = 0
  assert.throws(
    () =>
      review({
        argv: ['--phase', 'implementation'],
        cleanHead: () => `${read++}`.repeat(40),
        locateRounds: () => null,
        run: () =>
          JSON.stringify({
            is_error: false,
            subtype: 'success',
            result: 'No findings.',
            permission_denials: [],
          }),
        stdout: { write: (value) => output.push(value) },
        stderr: { write: () => {} },
      }),
    /changed during review/u,
  )
  assert.equal(output.includes(`${reviewReminder}\n`), false)
})

test('does not print the reminder for help', () => {
  const output = []
  const code = review({
    argv: ['--help'],
    stdout: { write: (value) => output.push(value) },
  })
  assert.equal(code, 0)
  assert.equal(output.includes(`${reviewReminder}\n`), false)
})

test('standalone review never narrows or writes coordinated round history', () => {
  // Intermediate helpers always read the requested base. Pair history belongs
  // to the implementation coordinator.
  const roundsFile = join(
    mkdtempSync(join(tmpdir(), 'as-claude-rounds-')),
    'rounds.json',
  )
  const firstHead = 'a'.repeat(40)
  const secondHead = 'b'.repeat(40)
  let current = firstHead
  const prompts = []
  const runReview = () =>
    review({
      argv: ['--phase', 'implementation'],
      cleanHead: () => current,
      locateRounds: () => roundsFile,
      run: (file, args) => {
        if (file === 'git') {
          return '/repo'
        }
        prompts.push(args[args.indexOf('-p') + 1])
        return JSON.stringify({
          is_error: false,
          subtype: 'success',
          result: 'No findings.',
          permission_denials: [],
        })
      },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    })

  assert.equal(runReview(), 0)
  assert.ok(prompts[0].includes(`origin/main...${firstHead}`))

  current = secondHead
  assert.equal(runReview(), 0)
  assert.ok(prompts[1].includes(`origin/main...${secondHead}`))
})

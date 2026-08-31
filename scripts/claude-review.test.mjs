import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cliPackage,
  defaultBase,
  defaultEffort,
  invocation,
  parseArgs,
  review,
  reviewReminder,
  usage,
} from './claude-review.mjs'

test('parses the two review phases', () => {
  assert.deepEqual(parseArgs(['--phase', 'implementation']), {
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    level: 'high',
    effort: defaultEffort,
    base: undefined,
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
      level: 'low',
      effort: defaultEffort,
      base: undefined,
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
  assert.throws(
    () => parseArgs(['--phase', 'implementation', '--level', 'xhigh']),
    /level/u,
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
      level: 'high',
      effort: defaultEffort,
      base: 'a'.repeat(40),
      reviewRound: 1,
      baselineSize: undefined,
      baselineConcepts: undefined,
      dispositionsFile: undefined,
    },
    'a'.repeat(40),
  )
  assert.match(
    request.args.join(' '),
    new RegExp(`/code-review high ${'a'.repeat(40)}\\.\\.\\.`),
  )
  assert.deepEqual(
    request.args.slice(
      request.args.indexOf('--model'),
      request.args.indexOf('--tools'),
    ),
    ['--model', 'opus', '--effort', defaultEffort],
  )
  assert.equal(request.args.includes('--no-session-persistence'), false)
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

test('a second round narrows the base to the head the first one read', () => {
  // Round state must be exercised, not disabled: turning it off in every test
  // is how a missing import reached a real review.
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
          if (args[0] === 'cat-file') return ''
          if (args[0] === 'rev-list') return '2'
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
  assert.ok(prompts[1].includes(`${firstHead}...${secondHead}`))
})

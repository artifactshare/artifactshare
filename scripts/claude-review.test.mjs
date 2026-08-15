import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cliPackage,
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
})

test('builds a direct implementation code-review invocation', () => {
  const request = invocation(
    {
      phase: 'implementation',
      artifactUrl: undefined,
      versionId: undefined,
      level: 'high',
    },
    'a'.repeat(40),
  )
  assert.match(request.args.join(' '), /\/code-review high origin\/main\.\.\./u)
  assert.equal(request.args.includes('--no-session-persistence'), false)
})

test('keeps the Artifact Share CLI pin and concise usage explicit', () => {
  assert.match(cliPackage, /^@artifactshare\/cli@\d/u)
  assert.match(usage(), /phase spec/u)
  assert.match(usage(), /phase implementation/u)
})

test('prints the reminder only after a successful unchanged review', () => {
  const head = 'a'.repeat(40)
  const output = []
  const code = review({
    argv: ['--phase', 'implementation'],
    cleanHead: () => head,
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

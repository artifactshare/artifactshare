import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultEffort,
  defaultModel,
  invocation,
  launchClaudeReview,
  parseArgs,
} from './claude-review.mjs'
import { acquireActivityLock } from './worktree-activity-lock.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
function execute(_file, args) {
  if (args[0] === 'status') return ''
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
  if (args[0] === 'rev-parse' && args[1] === '--verify') return base
  if (args[0] === 'merge-base') return base
  throw new Error(`Unexpected git call: ${args.join(' ')}`)
}
const capability = () =>
  acquireActivityLock('test', {
    run: (_file, args) =>
      args[1] === '--show-toplevel' ? '/repo' : '/repo/.git',
    acquire: () => Promise.resolve(() => Promise.resolve()),
  })
const fakeEvidence = ({ directory }) => ({
  baseRoot: join(directory, 'base'),
  headRoot: join(directory, 'head'),
  diffPath: join(directory, 'diff.patch'),
})

test('parses phases and preserves the level compatibility alias', () => {
  const parsed = parseArgs(['--phase', 'implementation'])
  assert.equal(parsed.model, defaultModel)
  assert.equal(parsed.effort, defaultEffort)
  assert.equal(
    parseArgs(['--phase', 'implementation', '--level', 'xhigh']).effort,
    'xhigh',
  )
  assert.throws(() => parseArgs([]), /phase/u)
  assert.throws(() => parseArgs(['--phase', 'spec']), /requires/u)
})

test('ordinary Claude invocation has only narrow read tools and no built-in review', () => {
  const request = invocation({ model: 'opus', effort: 'high' }, head, {
    prompt: 'direct role prompt',
  })
  const joined = request.args.join(' ')
  assert.doesNotMatch(joined, /\/code-review|Agent|ReportFindings|Bash/u)
  assert.match(joined, /Read Grep Glob/u)
  assert.equal(
    request.args[request.args.indexOf('-p') + 1],
    'direct role prompt',
  )
  const schema = JSON.parse(
    request.args[request.args.indexOf('--json-schema') + 1],
  )
  assert.deepEqual(schema.required, [
    'status',
    'candidates',
    'existing_matches',
  ])
  assert.equal(schema.properties.candidates.type, 'array')
  assert.equal(schema.properties.existing_matches.type, 'array')
})

test('launcher uses separate finder and verifier sessions and rejects permissions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-review-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const prompts = []
  try {
    const result = await launchClaudeReview(
      parseArgs([
        '--phase',
        'implementation',
        '--base',
        base,
        '--expected-head',
        head,
        '--context-file',
        contextFile,
      ]),
      lock,
      {
        execute,
        readCleanHead: () => head,
        prepareEvidence: fakeEvidence,
        provider: (_command, args, options) => {
          assert.equal(options.cwd, '/repo')
          const prompt = args[args.indexOf('-p') + 1]
          prompts.push(prompt)
          const schema = JSON.parse(args[args.indexOf('--json-schema') + 1])
          assert.equal(
            prompts.length === 1
              ? schema.properties.candidates.type
              : schema.properties.candidate_results.type,
            'array',
          )
          assert.match(prompt, /No Git command is required/u)
          let structuredOutput
          if (prompts.length === 1)
            structuredOutput = {
              status: 'COMPLETE',
              candidates: [{ id: 'F1' }],
              existing_matches: [],
            }
          else {
            const id = prompt.match(/"id": "([^"]+:F1)"/u)?.[1]
            assert.ok(id)
            structuredOutput = {
              status: 'COMPLETE',
              verdict: 'GO',
              candidate_results: [
                {
                  candidate_id: id,
                  technical_verdict: 'PLAUSIBLE',
                  evidence: 'mechanism exists',
                  scope_applicability: 'current scope',
                  prior_disposition: 'none',
                  unknowns: 'runtime frequency',
                },
              ],
              findings: [{ id, severity: 'follow_up' }],
              existing_matches: [],
            }
          }
          return Promise.resolve({
            stdout: JSON.stringify({
              is_error: false,
              subtype: 'success',
              result: 'Prose before a JSON fence is ignored.',
              structured_output: structuredOutput,
              permission_denials: [],
            }),
            stderr: '',
            code: 0,
          })
        },
      },
    )
    assert.equal(prompts.length, 2)
    assert.match(result.stdout, /PLAUSIBLE/u)
    assert.match(result.stdout, /Caller decides/u)
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('permission denial fails the controlled review', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-denial-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  try {
    await assert.rejects(
      launchClaudeReview(
        parseArgs([
          '--phase',
          'implementation',
          '--base',
          base,
          '--context-file',
          contextFile,
        ]),
        lock,
        {
          execute,
          readCleanHead: () => head,
          prepareEvidence: fakeEvidence,
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: false,
                subtype: 'success',
                result: '{}',
                structured_output: { status: 'COMPLETE' },
                permission_denials: ['Bash'],
              }),
              stderr: '',
              code: 0,
            }),
        },
      ),
      /Permission denials/u,
    )
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing structured output fails even when prose result looks valid', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-structure-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  try {
    await assert.rejects(
      launchClaudeReview(
        parseArgs([
          '--phase',
          'implementation',
          '--base',
          base,
          '--context-file',
          contextFile,
        ]),
        lock,
        {
          execute,
          readCleanHead: () => head,
          prepareEvidence: fakeEvidence,
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: false,
                subtype: 'success',
                result: '{"status":"COMPLETE"}',
                permission_denials: [],
              }),
              stderr: '',
              code: 0,
            }),
        },
      ),
      /Claude review failed/u,
    )
    await assert.rejects(
      launchClaudeReview(
        parseArgs([
          '--phase',
          'implementation',
          '--base',
          base,
          '--context-file',
          contextFile,
        ]),
        lock,
        {
          execute,
          readCleanHead: () => head,
          prepareEvidence: fakeEvidence,
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: true,
                subtype: 'error',
                result: 'provider error',
                structured_output: { status: 'COMPLETE' },
                permission_denials: [],
              }),
              stderr: '',
              code: 0,
            }),
        },
      ),
      /Claude review failed/u,
    )
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

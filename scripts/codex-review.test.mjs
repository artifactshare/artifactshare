import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultEffort,
  defaultModel,
  launchCodexReview,
  parseArgs,
  reviewRequest,
} from './codex-review.mjs'
import { acquireActivityLock } from './worktree-activity-lock.mjs'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
function git(_file, args) {
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

test('parses existing implementation and spec CLI options', () => {
  assert.equal(parseArgs([]).model, defaultModel)
  assert.equal(parseArgs([]).effort, defaultEffort)
  assert.equal(
    parseArgs([
      '--phase',
      'spec',
      '--artifact-url',
      'https://example.test/a/spec',
      '--version-id',
      'v1',
    ]).phase,
    'spec',
  )
  assert.throws(() => parseArgs(['--phase', 'spec']), /requires/u)
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/u)
})

test('ordinary request disables both Codex multi-agent features', () => {
  const request = reviewRequest(
    { model: 'm', effort: 'high' },
    'direct role prompt',
    '/tmp/output',
  )
  assert.deepEqual(request.args.slice(0, 3), ['exec', '-m', 'm'])
  assert.match(request.args.join(' '), /--disable multi_agent/u)
  assert.match(request.args.join(' '), /--disable multi_agent_v2/u)
  assert.equal(request.args.includes('review'), false)
  assert.equal(request.args.at(-1), '-')
  assert.equal(request.input, 'direct role prompt')
})

test('launcher runs one finder and one fresh verifier against a fixed clean target', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-review-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const calls = []
  try {
    const result = await launchCodexReview(
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
        exec: git,
        provider: (_command, args, options) => {
          calls.push({ args, options })
          assert.equal(options.cwd, '/repo')
          assert.equal(options.stdoutMode, 'tail')
          assert.equal(args.includes('review'), false)
          const output = args[args.indexOf('--output-last-message') + 1]
          if (calls.length === 1) {
            assert.match(options.input, /line-scan/u)
            assert.match(options.input, /conventions/u)
            writeFileSync(
              output,
              JSON.stringify({
                status: 'COMPLETE',
                candidates: [{ id: 'F1', summary: 'candidate' }],
                existing_matches: [],
              }),
            )
          } else {
            const id = options.input.match(/"id": "([^"]+:F1)"/u)?.[1]
            assert.ok(id)
            writeFileSync(
              output,
              JSON.stringify({
                status: 'COMPLETE',
                verdict: 'GO',
                candidate_results: [
                  {
                    candidate_id: id,
                    technical_verdict: 'REFUTED',
                    evidence: 'guard prevents it',
                    scope_applicability: 'current scope',
                    prior_disposition: 'none',
                    unknowns: 'none',
                  },
                ],
                findings: [],
                existing_matches: [],
              }),
            )
          }
          return Promise.resolve({ stdout: '', stderr: '', code: 0 })
        },
      },
    )
    assert.equal(calls.length, 2)
    assert.match(result.stdout, /REFUTED/u)
    assert.match(result.stdout, /Caller decides/u)
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('launcher rejects a stale expected HEAD before provider work', async () => {
  const lock = await capability()
  try {
    await assert.rejects(
      launchCodexReview(
        parseArgs([
          '--phase',
          'implementation',
          '--expected-head',
          'c'.repeat(40),
        ]),
        lock,
        { exec: git },
      ),
      /does not match/u,
    )
  } finally {
    await lock()
  }
})

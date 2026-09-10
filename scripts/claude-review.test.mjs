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
  assert.doesNotMatch(joined, /\/code-review|Agent|ReportFindings/u)
  assert.match(joined, /Bash\(git show:\*\)/u)
  assert.match(joined, /Bash\(git diff:\*\)/u)
  assert.equal(
    request.args[request.args.indexOf('-p') + 1],
    'direct role prompt',
  )
  assert.equal(request.args.includes('Bash'), false)
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
        provider: (_command, args, options) => {
          assert.equal(options.cwd, '/repo')
          const prompt = args[args.indexOf('-p') + 1]
          prompts.push(prompt)
          let body
          if (prompts.length === 1)
            body = JSON.stringify({
              status: 'COMPLETE',
              candidates: [{ id: 'F1' }],
              existing_matches: [],
            })
          else {
            const id = prompt.match(/"id": "([^"]+:F1)"/u)?.[1]
            assert.ok(id)
            body = JSON.stringify({
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
            })
          }
          return Promise.resolve({
            stdout: JSON.stringify({
              is_error: false,
              subtype: 'success',
              result: body,
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
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: false,
                subtype: 'success',
                result: '{}',
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

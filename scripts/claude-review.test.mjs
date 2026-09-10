import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import {
  defaultEffort,
  defaultModel,
  formatReviewUsageEvent,
  invocation,
  launchClaudeReview,
  parseArgs,
  projectModelUsage,
  review,
  reviewUsagePrefix,
  writeReviewUsageLine,
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
const candidate = (id = 'F1') => ({
  id,
  angle: 'line-scan',
  severity: 'P1',
  type: 'bug',
  file: 'file.mjs',
  lines: '1',
  trigger: 'supported input',
  impact: 'wrong result',
  evidence: 'changed path returns the wrong value',
  base_behavior: 'base returns the expected value',
  causality: 'the change causes the result',
  acceptance_impact: 'breaks the criterion',
  prior_finding_id: 'none: first review',
  new_evidence: 'this diff',
  unknowns: 'none',
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

test('standalone review writes usage events to stderr without changing stdout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-standalone-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let stdoutText = ''
  let stderrText = ''
  stdout.on('data', (chunk) => (stdoutText += chunk))
  stderr.on('data', (chunk) => (stderrText += chunk))
  try {
    const code = await review({
      argv: [
        '--phase',
        'implementation',
        '--base',
        base,
        '--context-file',
        contextFile,
      ],
      stdout,
      stderr,
      capability: lock,
      execute,
      readCleanHead: () => head,
      prepareEvidence: fakeEvidence,
      createCallId: () => 'standalone-invocation',
      provider: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            is_error: false,
            subtype: 'success',
            structured_output: {
              status: 'COMPLETE',
              candidates: [],
              existing_matches: [],
            },
            permission_denials: [],
            session_id: 'standalone-invocation',
            duration_ms: 20,
            modelUsage: {
              'claude-opus': { inputTokens: 2, outputTokens: 1 },
            },
          }),
          stderr: '',
          code: 0,
        }),
    })
    assert.equal(code, 0)
    assert.match(stdoutText, /Caller decides/u)
    assert.doesNotMatch(stdoutText, /ARTIFACTSHARE_REVIEW_USAGE/u)
    assert.equal(stderrText.match(/ARTIFACTSHARE_REVIEW_USAGE/gu)?.length, 2)
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('in-flight usage write failure preserves the accepted review result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-write-failure-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  let launches = 0
  const usageStream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('synthetic-write-failure'))
    },
  })
  try {
    const result = await launchClaudeReview(
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
        createCallId: () => 'write-failure-invocation',
        emitUsageEvent: (value) => writeReviewUsageLine(usageStream, value),
        provider: () => {
          launches += 1
          return Promise.resolve({
            stdout: JSON.stringify({
              is_error: false,
              subtype: 'success',
              structured_output: {
                status: 'COMPLETE',
                candidates: [],
                existing_matches: [],
              },
              permission_denials: [],
              session_id: 'write-failure-invocation',
              modelUsage: {
                'claude-opus': { inputTokens: 1, outputTokens: 1 },
              },
            }),
            stderr: '',
            code: 0,
          })
        },
      },
    )
    await new Promise(setImmediate)
    assert.equal(launches, 1)
    assert.equal(result.code, 0)
    assert.equal(usageStream.destroyed, true)
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('ordinary Claude invocation has only narrow read tools and no built-in review', () => {
  const request = invocation(
    { model: 'opus', effort: 'high', sessionId: 'invocation-id' },
    head,
    { prompt: 'direct role prompt' },
  )
  const joined = request.args.join(' ')
  assert.doesNotMatch(joined, /\/code-review|Agent|ReportFindings|Bash/u)
  assert.match(joined, /Read Grep Glob/u)
  assert.equal(
    request.args[request.args.indexOf('-p') + 1],
    'direct role prompt',
  )
  assert.equal(
    request.args[request.args.indexOf('--session-id') + 1],
    'invocation-id',
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
  assert.ok(schema.properties.candidates.items.required.includes('evidence'))
  assert.equal(
    schema.properties.candidates.items.properties.evidence.minLength,
    1,
  )
  const verifierSchema = JSON.parse(
    invocation({ model: 'opus', effort: 'high' }, head, {
      prompt: 'verify',
      role: 'verifier',
    }).args.at(-1),
  )
  assert.equal(verifierSchema.properties.findings.items.oneOf.length, 2)
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
  const diagnostics = []
  let clock = Date.parse('2026-09-10T00:00:00.000Z')
  let invocationNumber = 0
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
        now: () => (clock += 10),
        createCallId: () => `invocation-${++invocationNumber}`,
        emitUsageEvent: (value) => diagnostics.push(value),
        provider: (_command, args, options) => {
          assert.equal(options.cwd, '/repo')
          const prompt = args[args.indexOf('-p') + 1]
          prompts.push(prompt)
          assert.equal(
            args[args.indexOf('--session-id') + 1],
            `invocation-${prompts.length}`,
          )
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
              candidates: [candidate()],
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
              session_id: `invocation-${prompts.length}`,
              duration_ms: 125,
              modelUsage: {
                'claude-opus-4-1': {
                  inputTokens: 10,
                  cacheReadInputTokens: 4,
                  cacheCreationInputTokens: 2,
                  outputTokens: 6,
                  costUSD: 99,
                },
                'claude-haiku-utility': {
                  inputTokens: 3,
                  outputTokens: 1,
                },
              },
            }),
            stderr: '',
            code: 0,
          })
        },
      },
    )
    assert.equal(prompts.length, 2)
    assert.equal(diagnostics.length, 4)
    const events = diagnostics.map((line) => {
      assert.ok(line.startsWith(reviewUsagePrefix))
      assert.doesNotMatch(line, /Prose before|costUSD|structured_output/u)
      return JSON.parse(line.slice(reviewUsagePrefix.length))
    })
    assert.deepEqual(
      events.map(({ event, invocation_id }) => [event, invocation_id]),
      [
        ['start', 'invocation-1'],
        ['completion', 'invocation-1'],
        ['start', 'invocation-2'],
        ['completion', 'invocation-2'],
      ],
    )
    assert.deepEqual(events[1].model_usage, [
      {
        model: 'claude-opus-4-1',
        input_tokens: 10,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
        output_tokens: 6,
      },
      {
        model: 'claude-haiku-utility',
        input_tokens: 3,
        output_tokens: 1,
      },
    ])
    assert.equal(events[1].native_session_id, 'invocation-1')
    assert.equal(events[1].native_duration_ms, 125)
    assert.equal(events[1].review_output_outcome, 'accepted')
    assert.match(result.stdout, /"finder_call_id": "invocation-1"/u)
    assert.match(result.stdout, /"verifier_call_id": "invocation-2"/u)
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
  const diagnostics = []
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
          emitUsageEvent: (value) => diagnostics.push(value),
          createCallId: () => 'permission-invocation',
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: false,
                subtype: 'success',
                result: '{}',
                structured_output: { status: 'COMPLETE' },
                permission_denials: ['Bash'],
                session_id: 'permission-invocation',
                duration_ms: 250,
                modelUsage: {
                  'claude-opus': { inputTokens: 8, outputTokens: 2 },
                },
              }),
              stderr: '',
              code: 0,
            }),
        },
      ),
      /Permission denials/u,
    )
    const completion = JSON.parse(
      diagnostics.at(-1).slice(reviewUsagePrefix.length),
    )
    assert.equal(completion.review_output_outcome, 'permission_denied')
    assert.deepEqual(completion.model_usage, [
      { model: 'claude-opus', input_tokens: 8, output_tokens: 2 },
    ])
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('provider exception usage and diagnostic failures preserve the review outcome', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-exception-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const diagnostics = []
  let launches = 0
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
          createCallId: () => 'failed-invocation',
          emitUsageEvent: (value) => diagnostics.push(value),
          provider: () => {
            launches += 1
            throw new Error('provider unavailable')
          },
        },
      ),
      /provider unavailable/u,
    )
    assert.equal(launches, 1)
    const completion = JSON.parse(
      diagnostics.at(-1).slice(reviewUsagePrefix.length),
    )
    assert.equal(completion.provider_outcome, 'exception')
    assert.equal(completion.usage_missing_reason, 'no_final_result')

    launches = 0
    let writes = 0
    const result = await launchClaudeReview(
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
        createCallId: () => 'unrecorded-invocation',
        emitUsageEvent: () => {
          writes += 1
          throw new Error('output closed')
        },
        provider: (_command, args) => {
          launches += 1
          return Promise.resolve({
            stdout: JSON.stringify({
              is_error: false,
              subtype: 'success',
              structured_output: {
                status: 'COMPLETE',
                candidates: [],
                existing_matches: [],
              },
              permission_denials: [],
              session_id: args[args.indexOf('--session-id') + 1],
              modelUsage: {
                'claude-opus': { inputTokens: 1, outputTokens: 1 },
              },
            }),
            stderr: '',
            code: 0,
          })
        },
      },
    )
    assert.equal(result.code, 0)
    assert.equal(launches, 1)
    assert.equal(writes, 2)

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
          createCallId: () => 'masked-error-invocation',
          emitUsageEvent: () => {
            throw new Error('output closed')
          },
          provider: () => {
            throw new Error('original provider failure')
          },
        },
      ),
      /original provider failure/u,
    )
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('pending diagnostic delivery does not delay accepted results or provider errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-pending-usage-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const pendingDelivery = new Promise(() => {})
  let launches = 0
  const options = {
    execute,
    readCleanHead: () => head,
    prepareEvidence: fakeEvidence,
    createCallId: () => `pending-invocation-${launches + 1}`,
    emitUsageEvent: () => pendingDelivery,
  }
  const parsed = parseArgs([
    '--phase',
    'implementation',
    '--base',
    base,
    '--context-file',
    contextFile,
  ])
  try {
    const accepted = launchClaudeReview(parsed, lock, {
      ...options,
      provider: (_command, args) => {
        launches += 1
        return Promise.resolve({
          stdout: JSON.stringify({
            is_error: false,
            subtype: 'success',
            structured_output: {
              status: 'COMPLETE',
              candidates: [],
              existing_matches: [],
            },
            permission_denials: [],
            session_id: args[args.indexOf('--session-id') + 1],
            modelUsage: {
              'claude-opus': { inputTokens: 1, outputTokens: 1 },
            },
          }),
          stderr: '',
          code: 0,
        })
      },
    })
    await new Promise(setImmediate)
    assert.equal(launches, 1)
    assert.equal((await accepted).code, 0)

    const failed = assert.rejects(
      launchClaudeReview(parsed, lock, {
        ...options,
        provider: () => {
          launches += 1
          throw new Error('original provider failure')
        },
      }),
      /original provider failure/u,
    )
    await new Promise(setImmediate)
    assert.equal(launches, 2)
    await failed
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejected provider preserves a complete attached native envelope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-rejected-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const diagnostics = []
  try {
    const providerError = new Error('claude timed out after 50ms.')
    providerError.result = {
      stdout: JSON.stringify({
        is_error: true,
        subtype: 'error_max_budget_usd',
        session_id: 'rejected-invocation',
        duration_ms: 300,
        modelUsage: {
          'claude-opus': { inputTokens: 12, outputTokens: 3 },
        },
      }),
      stderr: 'original provider diagnostic',
      code: 2,
    }
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
          createCallId: () => 'rejected-invocation',
          emitUsageEvent: (value) => diagnostics.push(value),
          provider: () => {
            throw providerError
          },
        },
      ),
      /timed out after 50ms.*original provider diagnostic/su,
    )
    assert.equal(diagnostics.length, 2)
    const completion = JSON.parse(
      diagnostics[1].slice(reviewUsagePrefix.length),
    )
    assert.equal(completion.provider_outcome, 'timeout')
    assert.equal(completion.native_session_id, 'rejected-invocation')
    assert.deepEqual(completion.model_usage, [
      { model: 'claude-opus', input_tokens: 12, output_tokens: 3 },
    ])
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('provider nonzero preserves a final native usage envelope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-nonzero-test-'))
  const contextFile = join(directory, 'context.md')
  writeFileSync(
    contextFile,
    'Purpose: review.\n\n## Dispositions\n\nNone yet\n',
  )
  const lock = await capability()
  const diagnostics = []
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
          createCallId: () => 'nonzero-invocation',
          emitUsageEvent: (value) => diagnostics.push(value),
          provider: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                is_error: true,
                subtype: 'error_max_budget_usd',
                session_id: 'nonzero-invocation',
                duration_ms: 300,
                modelUsage: {
                  'claude-opus': { inputTokens: 12, outputTokens: 3 },
                },
              }),
              stderr: 'provider failed',
              code: 2,
            }),
        },
      ),
      /provider failed/u,
    )
    const completion = JSON.parse(
      diagnostics.at(-1).slice(reviewUsagePrefix.length),
    )
    assert.equal(completion.provider_outcome, 'nonzero')
    assert.equal(completion.review_output_outcome, 'provider_error')
    assert.equal(completion.native_is_error, true)
    assert.equal(completion.native_subtype, 'error_max_budget_usd')
    assert.deepEqual(completion.model_usage, [
      { model: 'claude-opus', input_tokens: 12, output_tokens: 3 },
    ])

    diagnostics.length = 0
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
          createCallId: () => 'falsy-json-invocation',
          emitUsageEvent: (value) => diagnostics.push(value),
          provider: () =>
            Promise.resolve({ stdout: 'null', stderr: 'failed', code: 2 }),
        },
      ),
      /failed/u,
    )
    assert.equal(diagnostics.length, 2)
    const falsyCompletion = JSON.parse(
      diagnostics[1].slice(reviewUsagePrefix.length),
    )
    assert.equal(falsyCompletion.event, 'completion')
    assert.equal(falsyCompletion.provider_outcome, 'nonzero')
    assert.equal(falsyCompletion.usage_missing_reason, 'no_final_result')
  } finally {
    await lock()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('error_during_execution all-zero usage is unknown and formatting is stable', () => {
  assert.deepEqual(
    projectModelUsage({
      subtype: 'error_during_execution',
      modelUsage: {
        'claude-opus': {
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
        },
      },
    }),
    {
      usage_missing_reason: 'error_during_execution_zero_usage_unreliable',
    },
  )
  const event = { schema_version: 1, invocation_id: 'same-id' }
  assert.equal(
    formatReviewUsageEvent(event),
    'ARTIFACTSHARE_REVIEW_USAGE {"schema_version":1,"invocation_id":"same-id"}',
  )
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

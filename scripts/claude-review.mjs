#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { finalReviews, specificationDrafting } from './agent-role-settings.mjs'
import {
  candidateFields,
  controlledReviewConditions,
  controlledReviewOutput,
  runControlledReview,
} from './controlled-review-runner.mjs'
import {
  implementationReviewInstructions,
  readImplementationContext,
} from './implementation-review-input.mjs'
import {
  cliPackage,
  conciseReviewOutput,
  specReviewPrompt,
} from './spec-review-input.mjs'
import {
  assertActivityLockCapability,
  runUnderActivityLock,
} from './worktree-activity-lock.mjs'
import { boundedProviderDiagnostic, runProvider } from './provider-process.mjs'

const defaultBase = 'origin/main'
const defaultModel = finalReviews.claude.model
const defaultEffort = finalReviews.claude.effort
const specDefaultModel = specificationDrafting.claude.model
const specDefaultEffort = specificationDrafting.claude.effort
const reviewUsagePrefix = 'ARTIFACTSHARE_REVIEW_USAGE '
const nativeUsageFields = Object.freeze({
  inputTokens: 'input_tokens',
  cacheReadInputTokens: 'cache_read_input_tokens',
  cacheCreationInputTokens: 'cache_creation_input_tokens',
  outputTokens: 'output_tokens',
})
const reviewReminder = [
  'Before applying findings:',
  '- Wait for both Codex and Claude reviews to finish, then classify all findings together.',
  '- For each finding, state in one sentence what current acceptance criterion, correctness, or safety property would remain broken without a fix.',
  '- If no such breakage can be named concretely, classify it as follow-up or non-actionable, not a blocker.',
  '- Fix all blockers together in one pass after considering both reviews.',
  '- Do not add future reuse, generalization, or defenses for unreachable cases to the current change.',
].join('\n')

function usage() {
  return `Usage:
  pnpm review:claude -- --phase implementation [options]
  pnpm review:claude -- --phase spec --artifact-url <url> --version-id <id> [options]`
}

function parseArgs(argv) {
  const options = {
    phase: undefined,
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
  }
  let levelProvided = false
  let effortProvided = false
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const keys = {
    '--phase': 'phase',
    '--artifact-url': 'artifactUrl',
    '--version-id': 'versionId',
    '--model': 'model',
    '--level': 'level',
    '--effort': 'effort',
    '--base': 'base',
    '--expected-head': 'expectedHead',
    '--context-file': 'contextFile',
    '--review-round': 'reviewRound',
    '--baseline-size': 'baselineSize',
    '--baseline-concepts': 'baselineConcepts',
    '--dispositions-file': 'dispositionsFile',
    '--snapshot-file': 'snapshotFile',
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--defer-round-record') {
      options.deferRoundRecord = true
      continue
    }
    const key = keys[arg]
    if (!key) throw new Error(`Unknown option: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    options[key] = ['reviewRound', 'baselineSize', 'baselineConcepts'].includes(
      key,
    )
      ? Number(value)
      : value
    if (key === 'level') levelProvided = true
    if (key === 'effort') effortProvided = true
  }
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
  if (!options.model) throw new Error('Model must not be empty.')
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.level))
    throw new Error('--level must be low, medium, high, xhigh, or max.')
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort))
    throw new Error('--effort must be low, medium, high, xhigh, or max.')
  if (levelProvided && effortProvided && options.level !== options.effort)
    throw new Error('--level and --effort must match when both are supplied.')
  if (levelProvided && !effortProvided) options.effort = options.level
  if (options.base === '') throw new Error('Base must not be empty.')
  if (options.expectedHead && !/^[0-9a-f]{40}$/u.test(options.expectedHead))
    throw new Error('--expected-head must be a 40-character commit SHA.')
  if (options.phase === 'spec') {
    if (!options.artifactUrl || !options.versionId)
      throw new Error('spec review requires --artifact-url and --version-id.')
    if (options.expectedHead || options.contextFile)
      throw new Error('spec review does not accept implementation options.')
  } else if (
    options.artifactUrl ||
    options.versionId ||
    options.reviewRound !== 1 ||
    options.baselineSize !== undefined ||
    options.baselineConcepts !== undefined ||
    options.dispositionsFile ||
    options.snapshotFile
  )
    throw new Error('implementation review does not accept spec options.')
  if (!Number.isInteger(options.reviewRound) || options.reviewRound < 1)
    throw new Error('--review-round must be a positive integer.')
  if (options.phase === 'spec' && options.deferRoundRecord)
    throw new Error('spec review does not accept --defer-round-record.')
  Object.defineProperties(options, {
    levelExplicit: { value: levelProvided, enumerable: false },
    effortExplicit: { value: effortProvided, enumerable: false },
  })
  return options
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
  return result
}
function gitOutput(execute, args) {
  return execute('git', args).trim()
}
function cleanHead(execute = run) {
  const head = gitOutput(execute, ['rev-parse', 'HEAD'])
  if (gitOutput(execute, ['status', '--porcelain']))
    throw new Error('Review requires a clean worktree.')
  return head
}
function resolveBaseSha(base, execute = run) {
  if (/^[0-9a-f]{40}$/u.test(base)) return base
  const resolved = gitOutput(execute, [
    'rev-parse',
    '--verify',
    `${base}^{commit}`,
  ])
  if (!/^[0-9a-f]{40}$/u.test(resolved))
    throw new Error('Could not resolve the committed review base SHA.')
  return resolved
}

const allowedTools = ['Read', 'Grep', 'Glob']
const reportStringProperties = Object.freeze({
  angle: { type: 'string' },
  severity: { type: 'string' },
  type: { type: 'string' },
  file: { type: 'string' },
  lines: { type: 'string' },
  trigger: { type: 'string' },
  impact: { type: 'string' },
  evidence: { type: 'string' },
  base_behavior: { type: 'string' },
  causality: { type: 'string' },
  acceptance_impact: { type: 'string' },
  prior_finding_id: { type: 'string' },
  new_evidence: { type: 'string' },
  unknowns: { type: 'string' },
  summary: { type: 'string' },
  disposition: { type: 'string' },
  matched_fact: { type: 'string' },
  reason: { type: 'string' },
})
const candidateProperties = Object.freeze(
  Object.fromEntries(
    candidateFields.map((field) => [field, { type: 'string', minLength: 1 }]),
  ),
)
const existingMatchSchema = Object.freeze({
  type: 'object',
  properties: reportStringProperties,
  additionalProperties: true,
})
const roleJsonSchemas = Object.freeze({
  finder: {
    type: 'object',
    required: ['status', 'candidates', 'existing_matches'],
    properties: {
      status: { type: 'string', enum: ['COMPLETE', 'INCOMPLETE'] },
      reason: { type: 'string' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          required: candidateFields,
          properties: candidateProperties,
          additionalProperties: true,
        },
      },
      existing_matches: { type: 'array', items: existingMatchSchema },
    },
    additionalProperties: true,
  },
  verifier: {
    type: 'object',
    required: [
      'status',
      'verdict',
      'candidate_results',
      'findings',
      'existing_matches',
    ],
    properties: {
      status: { type: 'string', enum: ['COMPLETE', 'INCOMPLETE'] },
      reason: { type: 'string' },
      verdict: { type: 'string', enum: ['GO', 'FINDINGS'] },
      candidate_results: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'candidate_id',
            'technical_verdict',
            'evidence',
            'scope_applicability',
            'prior_disposition',
            'unknowns',
          ],
          properties: {
            candidate_id: { type: 'string' },
            technical_verdict: {
              type: 'string',
              enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'],
            },
            evidence: { type: 'string' },
            scope_applicability: { type: 'string' },
            prior_disposition: { type: 'string' },
            unknowns: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      findings: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              required: ['id', 'severity', 'minimal_fix'],
              properties: {
                id: { type: 'string', minLength: 1 },
                severity: { type: 'string', const: 'blocker' },
                summary: { type: 'string' },
                broken_acceptance_criterion: {
                  type: 'string',
                  minLength: 1,
                },
                new_evidence: { type: 'string', minLength: 1 },
                minimal_fix: { type: 'string', minLength: 1 },
              },
              anyOf: [
                { required: ['broken_acceptance_criterion'] },
                { required: ['new_evidence'] },
              ],
              additionalProperties: true,
            },
            {
              type: 'object',
              required: ['id', 'severity'],
              properties: {
                id: { type: 'string', minLength: 1 },
                severity: {
                  type: 'string',
                  enum: ['follow_up', 'non_actionable'],
                },
                summary: { type: 'string' },
              },
              additionalProperties: true,
            },
          ],
        },
      },
      existing_matches: { type: 'array', items: existingMatchSchema },
    },
    additionalProperties: true,
  },
})
function invocation(options, _head, { prompt = '', role = 'finder' } = {}) {
  return {
    input: undefined,
    args: [
      '--safe-mode',
      '--model',
      options.model,
      '--effort',
      options.effort,
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      ...allowedTools,
      '--session-id',
      options.sessionId,
      '--permission-mode',
      'dontAsk',
      '-p',
      prompt,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(roleJsonSchemas[role]),
    ],
  }
}

function safeNativeNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function safeNativeString(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : undefined
}

function projectModelUsage(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    return { usage_missing_reason: 'no_final_result' }
  const source = envelope.modelUsage
  if (!source || typeof source !== 'object' || Array.isArray(source))
    return { usage_missing_reason: 'model_usage_missing' }
  const modelUsage = []
  for (const [model, values] of Object.entries(source)) {
    const safeModel = safeNativeString(model)
    if (
      !safeModel ||
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values)
    )
      continue
    const projected = { model: safeModel }
    for (const [nativeField, field] of Object.entries(nativeUsageFields)) {
      const value = safeNativeNumber(values[nativeField])
      if (value !== undefined) projected[field] = value
    }
    if (Object.keys(projected).length > 1) modelUsage.push(projected)
  }
  if (!modelUsage.length)
    return { usage_missing_reason: 'model_usage_invalid_or_empty' }
  if (
    envelope.subtype === 'error_during_execution' &&
    modelUsage.every((entry) =>
      Object.values(entry).every(
        (value) => typeof value !== 'number' || value === 0,
      ),
    )
  )
    return {
      usage_missing_reason: 'error_during_execution_zero_usage_unreliable',
    }
  return { model_usage: modelUsage }
}

function formatReviewUsageEvent(event) {
  return `${reviewUsagePrefix}${JSON.stringify(event)}`
}

function writeReviewUsageLine(stream, value) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      stream.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onError = (error) => settle(error)
    stream.once('error', onError)
    stream.write(`${value}\n`, (error) => settle(error))
  })
}

function providerOutcome(error, signal) {
  if (signal?.aborted) return 'canceled'
  if (/timed out after \d+ms/u.test(error?.message ?? '')) return 'timeout'
  return 'exception'
}

function reviewContext(parsed, execute, repository, head) {
  const conditions = controlledReviewConditions({
    repository,
    model: parsed.model,
    effort: parsed.effort,
    phase: parsed.phase,
    base: parsed.base,
    head,
  })
  if (parsed.phase === 'implementation')
    return {
      context: `${implementationReviewInstructions({
        context: readImplementationContext(parsed.contextFile),
        base: parsed.base,
        expectedHead: parsed.expectedHead,
      })}\n\n${conditions}`,
    }
  const spec = specReviewPrompt({
    ...parsed,
    snapshot: parsed.snapshotFile
      ? JSON.parse(readFileSync(parsed.snapshotFile, 'utf8'))
      : undefined,
    dispositions: parsed.dispositionsFile
      ? JSON.parse(readFileSync(parsed.dispositionsFile, 'utf8'))
      : undefined,
    run: execute,
  })
  return {
    context: `${spec.prompt}\n\nFor this specification review, the fixed Artifact version and snapshot are the target. The checkout is reference material only. Apply code-oriented lenses to described behavior and call paths; mark a lens N/A with a reason instead of inventing a missing implementation defect.\n\n${conditions}`,
    scopeLock: spec.scopeLock,
    metrics: spec.metrics,
  }
}

async function launchClaudeReview(
  parsed,
  capability,
  {
    execute = run,
    readCleanHead = () => cleanHead(execute),
    provider = runProvider,
    signal,
    now = Date.now,
    createCallId,
    emitUsageEvent = async () => {},
    controlledRunner = runControlledReview,
    prepareEvidence,
  } = {},
) {
  assertActivityLockCapability(capability, (file, args) =>
    execute(file, args).trim(),
  )
  const head = readCleanHead()
  if (parsed.expectedHead && parsed.expectedHead !== head)
    throw new Error('HEAD does not match --expected-head.')
  parsed = { ...parsed }
  if (parsed.phase === 'implementation') {
    parsed.expectedHead = parsed.expectedHead ?? head
    parsed.base = resolveBaseSha(parsed.base ?? defaultBase, execute)
    gitOutput(execute, ['merge-base', parsed.base, head])
  }
  const repository = gitOutput(execute, ['rev-parse', '--show-toplevel'])
  const prepared = reviewContext(parsed, execute, repository, head)
  const started = now()
  const controlled = await controlledRunner({
    context: prepared.context,
    phase: parsed.phase,
    now,
    repository,
    base: parsed.base ?? head,
    head,
    prepareEvidence,
    createCallId,
    invoke: async (prompt, { role, callId, timeoutMs }) => {
      const invocationId = callId
      const startedAt = now()
      const commonEvent = {
        schema_version: 1,
        kind: 'claude_review_invocation',
        invocation_id: invocationId,
        phase: parsed.phase,
        role,
        requested_model: parsed.model,
        requested_effort: parsed.effort,
        started_at: new Date(startedAt).toISOString(),
      }
      const emit = (event) => {
        try {
          Promise.resolve(emitUsageEvent(formatReviewUsageEvent(event))).catch(
            () => {},
          )
        } catch {}
      }
      emit({ ...commonEvent, event: 'start' })
      const request = invocation({ ...parsed, sessionId: invocationId }, head, {
        prompt,
        role,
      })
      let result
      let envelope
      const completion = (providerResult, reviewOutputOutcome) => {
        const endedAt = now()
        const nativeDuration = safeNativeNumber(envelope?.duration_ms)
        const nativeSessionId = safeNativeString(envelope?.session_id)
        const nativeSubtype = safeNativeString(envelope?.subtype)
        const roleStatus = ['COMPLETE', 'INCOMPLETE'].includes(
          envelope?.structured_output?.status,
        )
          ? envelope.structured_output.status
          : undefined
        emit({
          ...commonEvent,
          event: 'completion',
          ended_at: new Date(endedAt).toISOString(),
          elapsed_ms: Math.max(0, Math.round(endedAt - startedAt)),
          provider_outcome: providerResult,
          review_output_outcome: reviewOutputOutcome,
          ...(nativeSessionId === undefined
            ? {}
            : { native_session_id: nativeSessionId }),
          ...(nativeDuration === undefined
            ? {}
            : { native_duration_ms: nativeDuration }),
          ...(typeof envelope?.is_error === 'boolean'
            ? { native_is_error: envelope.is_error }
            : {}),
          ...(nativeSubtype === undefined
            ? {}
            : { native_subtype: nativeSubtype }),
          ...(roleStatus === undefined ? {} : { role_status: roleStatus }),
          ...projectModelUsage(envelope),
        })
      }
      try {
        result = await provider('claude', request.args, {
          cwd: repository,
          signal,
          timeoutMs,
        })
      } catch (error) {
        try {
          envelope = JSON.parse(error?.result?.stdout ?? '')
        } catch {}
        completion(providerOutcome(error, signal), 'provider_error')
        const diagnostic = boundedProviderDiagnostic(
          error?.result?.stderr || error?.result?.stdout || '',
        )
        throw new Error(
          `${error.message}${diagnostic ? `\n${diagnostic.trim()}` : ''}`,
          { cause: error },
        )
      }
      try {
        envelope = JSON.parse(result.stdout)
      } catch (error) {
        if (result.code === 0) {
          completion('success', 'invalid_json')
          throw error
        }
      }
      if (result.code !== 0) {
        completion('nonzero', 'provider_error')
        throw new Error(
          boundedProviderDiagnostic(
            result.stderr || result.stdout || `claude exited ${result.code}`,
          ).trim(),
        )
      }
      const structured = envelope?.structured_output
      if (
        envelope?.is_error !== false ||
        envelope?.subtype !== 'success' ||
        !structured ||
        typeof structured !== 'object' ||
        Array.isArray(structured) ||
        !Array.isArray(envelope?.permission_denials) ||
        envelope.permission_denials.length
      ) {
        const reviewOutputOutcome =
          Array.isArray(envelope?.permission_denials) &&
          envelope.permission_denials.length
            ? 'permission_denied'
            : !structured ||
                typeof structured !== 'object' ||
                Array.isArray(structured)
              ? 'missing_structured_output'
              : envelope?.is_error !== false || envelope?.subtype !== 'success'
                ? 'provider_error'
                : 'invalid_envelope'
        completion('success', reviewOutputOutcome)
        throw new Error(
          `Claude review failed.${boundedProviderDiagnostic(`${typeof envelope?.result === 'string' ? `\n${envelope.result}` : ''}${Array.isArray(envelope?.permission_denials) ? `\nPermission denials: ${JSON.stringify(envelope.permission_denials)}` : ''}`)}`,
        )
      }
      completion('success', 'accepted')
      return JSON.stringify(structured)
    },
  })
  if (readCleanHead() !== head)
    throw new Error('HEAD or worktree changed during review.')
  const raw = controlledReviewOutput(controlled)
  const output =
    parsed.phase === 'spec'
      ? conciseReviewOutput(prepared.scopeLock, raw, prepared.metrics)
      : `${raw}\n${reviewReminder}`
  return {
    stdout: `${output}\n`,
    stderr: `Claude ${parsed.phase} review requested: provider=claude model=${parsed.model} effort=${parsed.effort}\nClaude ${parsed.phase} review: ${head.slice(0, 12)}, ${Math.round((now() - started) / 1000)}s\n`,
    code: 0,
  }
}

async function review({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  capability,
  emitUsageEvent,
  ...options
} = {}) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  const result = await launchClaudeReview(parsed, capability, {
    ...options,
    emitUsageEvent:
      emitUsageEvent ?? ((value) => writeReviewUsageLine(stderr, value)),
  })
  stdout.write(result.stdout)
  stderr.write(result.stderr)
  return result.code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runUnderActivityLock(
    'claude review',
    { parse: () => parseArgs(process.argv.slice(2)) },
    async (options, capability) => {
      if (options.help) {
        process.stdout.write(`${usage()}\n`)
        return 0
      }
      const result = await launchClaudeReview(options, capability, {
        emitUsageEvent: (value) => writeReviewUsageLine(process.stderr, value),
      })
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      return result.code
    },
  )
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })

export {
  cliPackage,
  defaultBase,
  defaultEffort,
  defaultModel,
  formatReviewUsageEvent,
  invocation,
  launchClaudeReview,
  parseArgs,
  projectModelUsage,
  resolveBaseSha,
  review,
  reviewReminder,
  reviewUsagePrefix,
  roleJsonSchemas,
  usage,
  writeReviewUsageLine,
}

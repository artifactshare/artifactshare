#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { finalReviews, specificationDrafting } from './agent-role-settings.mjs'
import {
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

const allowedTools = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git show:*)',
  'Bash(git diff:*)',
  'Bash(git rev-parse:*)',
  'Bash(git status:*)',
  'Bash(git ls-tree:*)',
  'Bash(git grep:*)',
]
function invocation(options, _head, { prompt = '' } = {}) {
  return {
    input: undefined,
    args: [
      '--safe-mode',
      '--model',
      options.model,
      '--effort',
      options.effort,
      '--tools',
      'Bash,Read,Grep,Glob',
      '--allowedTools',
      ...allowedTools,
      '--permission-mode',
      'dontAsk',
      '-p',
      prompt,
      '--output-format',
      'json',
    ],
  }
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
    controlledRunner = runControlledReview,
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
    invoke: async (prompt, { timeoutMs }) => {
      const request = invocation(parsed, head, { prompt })
      let result
      try {
        result = await provider('claude', request.args, {
          cwd: repository,
          signal,
          timeoutMs,
        })
      } catch (error) {
        const diagnostic = boundedProviderDiagnostic(
          error?.result?.stderr || error?.result?.stdout || '',
        )
        throw new Error(
          `${error.message}${diagnostic ? `\n${diagnostic.trim()}` : ''}`,
          { cause: error },
        )
      }
      if (result.code !== 0)
        throw new Error(
          boundedProviderDiagnostic(
            result.stderr || result.stdout || `claude exited ${result.code}`,
          ).trim(),
        )
      const envelope = JSON.parse(result.stdout)
      const body =
        typeof envelope.result === 'string' ? envelope.result : undefined
      if (
        envelope.is_error !== false ||
        envelope.subtype !== 'success' ||
        !body?.trim() ||
        !Array.isArray(envelope.permission_denials) ||
        envelope.permission_denials.length
      )
        throw new Error(
          `Claude review failed.${boundedProviderDiagnostic(`${body ? `\n${body}` : ''}${Array.isArray(envelope.permission_denials) ? `\nPermission denials: ${JSON.stringify(envelope.permission_denials)}` : ''}`)}`,
        )
      return body.trim()
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
  ...options
} = {}) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  const result = await launchClaudeReview(parsed, capability, options)
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
      const result = await launchClaudeReview(options, capability)
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
  invocation,
  launchClaudeReview,
  parseArgs,
  resolveBaseSha,
  review,
  reviewReminder,
  usage,
}

#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { conciseReviewOutput, specReviewPrompt } from './spec-review-input.mjs'
import {
  assertActivityLockCapability,
  runUnderActivityLock,
} from './worktree-activity-lock.mjs'
import { boundedProviderDiagnostic, runProvider } from './provider-process.mjs'

const defaultModel = finalReviews.codex.model
const defaultBase = 'origin/main'
const defaultEffort = finalReviews.codex.effort
const specDefaultModel = specificationDrafting.codex.model
const specDefaultEffort = specificationDrafting.codex.effort
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
  pnpm review:codex -- --phase implementation [options]
  pnpm review:codex -- --phase spec --artifact-url <url> --version-id <id> [options]`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    effort: defaultEffort,
    base: undefined,
    expectedHead: undefined,
    contextFile: undefined,
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    dryRun: false,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
    snapshotFile: undefined,
    deferRoundRecord: false,
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const keys = {
    '--model': 'model',
    '--effort': 'effort',
    '--base': 'base',
    '--expected-head': 'expectedHead',
    '--context-file': 'contextFile',
    '--phase': 'phase',
    '--artifact-url': 'artifactUrl',
    '--version-id': 'versionId',
    '--review-round': 'reviewRound',
    '--baseline-size': 'baselineSize',
    '--baseline-concepts': 'baselineConcepts',
    '--dispositions-file': 'dispositionsFile',
    '--snapshot-file': 'snapshotFile',
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run' || arg === '--defer-round-record') {
      options[arg === '--dry-run' ? 'dryRun' : 'deferRoundRecord'] = true
      continue
    }
    const key = keys[arg]
    if (!key) throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    options[key] = ['reviewRound', 'baselineSize', 'baselineConcepts'].includes(
      key,
    )
      ? Number(value)
      : value
  }
  if (!options.model) throw new Error('Model must not be empty.')
  if (options.base === '') throw new Error('Base must not be empty.')
  if (
    !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)
  )
    throw new Error('--effort must be low, medium, high, xhigh, max, or ultra.')
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
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
  return options
}

function commandOutput(exec, file, args) {
  return exec(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}
function gitOutput(exec, args) {
  return commandOutput(exec, 'git', args)
}
function resolveBaseSha(exec, base) {
  if (/^[0-9a-f]{40}$/u.test(base)) return base
  const resolved = gitOutput(exec, [
    'rev-parse',
    '--verify',
    `${base}^{commit}`,
  ])
  if (!/^[0-9a-f]{40}$/u.test(resolved))
    throw new Error('Could not resolve the committed review base SHA.')
  return resolved
}

function reviewRequest(options, prompt, lastMessageFile) {
  return {
    args: [
      'exec',
      '-m',
      options.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
      '--disable',
      'multi_agent',
      '--disable',
      'multi_agent_v2',
      '--sandbox',
      'read-only',
      ...(lastMessageFile ? ['--output-last-message', lastMessageFile] : []),
      '-',
    ],
    input: prompt,
  }
}

function reviewContext(parsed, exec, repository, head) {
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
    run: (file, args) => commandOutput(exec, file, args),
  })
  return {
    context: `${spec.prompt}\n\nFor this specification review, the fixed Artifact version and snapshot are the target. The checkout is reference material only. Apply code-oriented lenses to described behavior and call paths; mark a lens N/A with a reason instead of inventing a missing implementation defect.\n\n${conditions}`,
    scopeLock: spec.scopeLock,
    metrics: spec.metrics,
  }
}

async function launchCodexReview(
  parsed,
  capability,
  {
    exec = execFileSync,
    provider = runProvider,
    signal,
    now = Date.now,
    controlledRunner = runControlledReview,
    prepareEvidence,
  } = {},
) {
  assertActivityLockCapability(capability, (file, args) =>
    commandOutput(exec, file, args),
  )
  if (gitOutput(exec, ['status', '--porcelain']))
    throw new Error('Working tree must be clean before review.')
  const head = gitOutput(exec, ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the committed review SHA.')
  if (parsed.expectedHead && parsed.expectedHead !== head)
    throw new Error('HEAD does not match --expected-head.')
  parsed = { ...parsed }
  if (parsed.phase === 'implementation') {
    parsed.expectedHead = parsed.expectedHead ?? head
    parsed.base = resolveBaseSha(exec, parsed.base ?? defaultBase)
    gitOutput(exec, ['merge-base', parsed.base, head])
  }
  if (parsed.dryRun)
    return {
      stdout: `${JSON.stringify({ executable: 'codex', phase: parsed.phase, model: parsed.model, effort: parsed.effort, roles: ['finder', 'verifier'] })}\n`,
      stderr: '',
      code: 0,
    }
  const repository = gitOutput(exec, ['rev-parse', '--show-toplevel'])
  const prepared = reviewContext(parsed, exec, repository, head)
  const started = now()
  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-codex-review-'))
  let call = 0
  try {
    const controlled = await controlledRunner({
      context: prepared.context,
      phase: parsed.phase,
      now,
      repository,
      base: parsed.base ?? head,
      head,
      prepareEvidence,
      invoke: async (prompt, { role, timeoutMs }) => {
        const outputPath = join(directory, `${++call}-${role}.txt`)
        const request = reviewRequest(parsed, prompt, outputPath)
        let result
        try {
          result = await provider('codex', request.args, {
            cwd: repository,
            input: request.input,
            signal,
            timeoutMs,
            stdoutMode: 'tail',
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
              result.stderr || result.stdout || `codex exited ${result.code}`,
            ).trim(),
          )
        const output = readFileSync(outputPath, 'utf8').trim()
        if (!output) throw new Error(`Codex ${role} returned no final message.`)
        return output
      },
    })
    if (
      gitOutput(exec, ['rev-parse', 'HEAD']) !== head ||
      gitOutput(exec, ['status', '--porcelain'])
    )
      throw new Error(
        'Working tree or HEAD changed during review; review the current commit again.',
      )
    const raw = controlledReviewOutput(controlled)
    const output =
      parsed.phase === 'spec'
        ? conciseReviewOutput(prepared.scopeLock, raw, prepared.metrics)
        : `${raw}\n${reviewReminder}`
    return {
      stdout: `${output}\n`,
      stderr: `Codex ${parsed.phase} review requested: provider=codex model=${parsed.model} effort=${parsed.effort}\nCodex ${parsed.phase} review: ${head.slice(0, 12)}, ${Math.round((now() - started) / 1000)}s\n`,
      code: 0,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function main({
  argv = process.argv.slice(2),
  capability,
  log = console.log,
  timingLog = console.error,
  ...options
} = {}) {
  const parsed = parseArgs(argv)
  if (parsed.help) {
    log(usage())
    return 0
  }
  const result = await launchCodexReview(parsed, capability, options)
  log(result.stdout.trimEnd())
  if (result.stderr) timingLog(result.stderr.trimEnd())
  return result.code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runUnderActivityLock(
    'codex review',
    { parse: () => parseArgs(process.argv.slice(2)) },
    async (options, capability) => {
      if (options.help) {
        process.stdout.write(`${usage()}\n`)
        return 0
      }
      const result = await launchCodexReview(options, capability)
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
  defaultBase,
  defaultEffort,
  defaultModel,
  launchCodexReview,
  main,
  parseArgs,
  resolveBaseSha,
  reviewReminder,
  reviewRequest,
  usage,
}

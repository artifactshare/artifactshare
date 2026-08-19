#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { conciseReviewOutput, specReviewPrompt } from './spec-review-input.mjs'

const defaultModel = 'gpt-5.6-sol'
const defaultBase = 'origin/main'
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
  pnpm review:codex -- --phase spec --artifact-url <url> --version-id <id> [options]

Options:
  --phase <phase>       Review phase: implementation or spec
  --artifact-url <url> Artifact Share URL for spec review
  --version-id <id>    Exact Artifact Share version for spec review
  --review-round <n>   Initial review is 1; at most two correction rounds
  --baseline-size <n>  Original specification byte size
  --baseline-concepts <n> Original exception/state concept count
  --dispositions-file <path> JSON dispositions from the previous round
  --model <model>       Review model. Default: ${defaultModel}
  --base <ref>          Git base ref. Default: ${defaultBase}
  --dry-run             Print the invocation without starting review
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    base: defaultBase,
    phase: 'implementation',
    artifactUrl: undefined,
    versionId: undefined,
    dryRun: false,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (
      ![
        '--model',
        '--base',
        '--phase',
        '--artifact-url',
        '--version-id',
        '--review-round',
        '--baseline-size',
        '--baseline-concepts',
        '--dispositions-file',
      ].includes(arg)
    )
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--model') options.model = value
    if (arg === '--base') options.base = value
    if (arg === '--phase') options.phase = value
    if (arg === '--artifact-url') options.artifactUrl = value
    if (arg === '--version-id') options.versionId = value
    if (arg === '--review-round') options.reviewRound = Number(value)
    if (arg === '--baseline-size') options.baselineSize = Number(value)
    if (arg === '--baseline-concepts') options.baselineConcepts = Number(value)
    if (arg === '--dispositions-file') options.dispositionsFile = value
  }
  if (!options.model || !options.base)
    throw new Error('Model and base must not be empty.')
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
  if (options.phase === 'spec') {
    if (!options.artifactUrl || !options.versionId)
      throw new Error('spec review requires --artifact-url and --version-id.')
  } else if (
    options.artifactUrl ||
    options.versionId ||
    options.reviewRound !== 1 ||
    options.baselineSize !== undefined ||
    options.baselineConcepts !== undefined ||
    options.dispositionsFile
  ) {
    throw new Error('implementation review does not accept spec options.')
  }
  if (!Number.isInteger(options.reviewRound) || options.reviewRound < 1)
    throw new Error('--review-round must be a positive integer.')
  return options
}

function reviewRequest(options, prompt) {
  if (options.phase === 'spec')
    return {
      args: ['exec', '-m', options.model, '--sandbox', 'read-only', '-'],
      input: prompt,
    }
  return { args: ['-m', options.model, 'review', '--base', options.base] }
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

function main({
  argv = process.argv.slice(2),
  exec = execFileSync,
  run = spawnSync,
  log = console.log,
  errorLog = console.error,
} = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      log(usage())
      return 0
    }
    if (gitOutput(exec, ['status', '--porcelain']))
      throw new Error('Working tree must be clean before review.')
    const head = gitOutput(exec, ['rev-parse', 'HEAD'])
    if (!/^[0-9a-f]{40}$/u.test(head))
      throw new Error('Could not resolve the committed review SHA.')
    if (options.phase === 'implementation')
      gitOutput(exec, ['merge-base', options.base, head])
    const prompt =
      options.phase === 'spec' && !options.dryRun
        ? specReviewPrompt({
            ...options,
            dispositions: options.dispositionsFile
              ? JSON.parse(readFileSync(options.dispositionsFile, 'utf8'))
              : undefined,
            run: (file, args) => commandOutput(exec, file, args),
          })
        : undefined
    const request = reviewRequest(options, prompt?.prompt)
    if (options.dryRun) {
      log(
        JSON.stringify({
          executable: 'codex',
          args: request.args,
          phase: options.phase,
          artifactUrl: options.artifactUrl,
          versionId: options.versionId,
        }),
      )
      return 0
    }
    const captureSpec = options.phase === 'spec'
    const runOptions = {
      input: request.input,
      stdio: captureSpec
        ? ['pipe', 'pipe', 'pipe']
        : ['ignore', 'inherit', 'inherit'],
    }
    if (captureSpec) {
      runOptions.encoding = 'utf8'
      runOptions.maxBuffer = 16 * 1024 * 1024
    }
    const result = run('codex', request.args, runOptions)
    if (result.error) throw result.error
    if (result.status !== 0) {
      if (captureSpec && result.stderr?.trim()) errorLog(result.stderr.trim())
      if (captureSpec && result.stdout?.trim()) errorLog(result.stdout.trim())
      return result.status ?? 1
    }
    const finalHead = gitOutput(exec, ['rev-parse', 'HEAD'])
    const finalStatus = gitOutput(exec, ['status', '--porcelain'])
    if (finalHead !== head || finalStatus)
      throw new Error(
        'Working tree or HEAD changed during review; review the current commit again.',
      )
    if (captureSpec)
      log(conciseReviewOutput(prompt.scopeLock, result.stdout, prompt.metrics))
    else log(reviewReminder)
    return 0
  } catch (error) {
    errorLog(error instanceof Error ? error.message : 'Codex review failed.')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main()

export {
  defaultBase,
  defaultModel,
  main,
  parseArgs,
  reviewReminder,
  reviewRequest,
  usage,
}

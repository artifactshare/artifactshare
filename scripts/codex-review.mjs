#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { finalReviews, specificationDrafting } from './agent-role-settings.mjs'
import {
  implementationReviewInstructions,
  readImplementationContext,
} from './implementation-review-input.mjs'
import { conciseReviewOutput, specReviewPrompt } from './spec-review-input.mjs'

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
  pnpm review:codex -- --phase spec --artifact-url <url> --version-id <id> [options]

Options:
  --phase <phase>       Review phase: implementation or spec
  --artifact-url <url> Artifact Share URL for spec review
  --version-id <id>    Exact Artifact Share version for spec review
  --snapshot-file <path> Coordinator-provided immutable spec input
  --review-round <n>   Initial review is 1; at most two correction rounds
  --baseline-size <n>  Original specification byte size
  --baseline-concepts <n> Original exception/state concept count
  --dispositions-file <path> JSON dispositions from the previous round
  --model <model>       Review model. Default: ${defaultModel}
  --effort <effort>     Reasoning effort. Default: ${defaultEffort}
  --base <ref>          Git base ref. Default: ${defaultBase}
  --expected-head <sha> Fixed committed HEAD expected by the coordinator
  --context-file <path> Current scope, criteria, and a required Dispositions section (prior findings and outcomes)
  --dry-run             Print the invocation without starting review
  -h, --help            Show this help.`
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--defer-round-record') {
      options.deferRoundRecord = true
      continue
    }
    if (
      ![
        '--model',
        '--effort',
        '--base',
        '--expected-head',
        '--context-file',
        '--phase',
        '--artifact-url',
        '--version-id',
        '--review-round',
        '--baseline-size',
        '--baseline-concepts',
        '--dispositions-file',
        '--snapshot-file',
      ].includes(arg)
    )
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--model') options.model = value
    if (arg === '--effort') options.effort = value
    if (arg === '--base') options.base = value
    if (arg === '--expected-head') options.expectedHead = value
    if (arg === '--context-file') options.contextFile = value
    if (arg === '--phase') options.phase = value
    if (arg === '--artifact-url') options.artifactUrl = value
    if (arg === '--version-id') options.versionId = value
    if (arg === '--review-round') options.reviewRound = Number(value)
    if (arg === '--baseline-size') options.baselineSize = Number(value)
    if (arg === '--baseline-concepts') options.baselineConcepts = Number(value)
    if (arg === '--dispositions-file') options.dispositionsFile = value
    if (arg === '--snapshot-file') options.snapshotFile = value
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
  ) {
    throw new Error('implementation review does not accept spec options.')
  }
  if (!Number.isInteger(options.reviewRound) || options.reviewRound < 1)
    throw new Error('--review-round must be a positive integer.')
  if (options.phase === 'spec' && options.deferRoundRecord)
    throw new Error('spec review does not accept --defer-round-record.')
  return options
}

function reviewRequest(
  options,
  prompt,
  lastMessageFile,
  { context = '' } = {},
) {
  if (options.phase === 'spec')
    return {
      args: [
        'exec',
        '-m',
        options.model ?? specDefaultModel,
        '-c',
        `model_reasoning_effort=${JSON.stringify(options.effort ?? specDefaultEffort)}`,
        '--sandbox',
        'read-only',
        '-',
      ],
      input: prompt,
    }
  return {
    args: [
      'exec',
      '-m',
      options.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
      '-c',
      `developer_instructions=${JSON.stringify(
        implementationReviewInstructions({
          context,
          base: options.base,
          expectedHead: options.expectedHead,
        }),
      )}`,
      '--sandbox',
      'read-only',
      ...(lastMessageFile ? ['--output-last-message', lastMessageFile] : []),
      'review',
      '--base',
      options.base,
    ],
  }
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

function readDiagnosticTail(path, limit = 8 * 1024) {
  const size = statSync(path).size
  if (size === 0) return ''
  const length = Math.min(size, limit)
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(path, 'r')
  try {
    readSync(descriptor, buffer, 0, length, size - length)
  } finally {
    closeSync(descriptor)
  }
  let start = 0
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  const output = buffer.subarray(start).toString('utf8').trim()
  return size > length ? `[earlier output omitted]\n${output}` : output
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

function main({
  argv = process.argv.slice(2),
  exec = execFileSync,
  run = spawnSync,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
  timingLog = console.error,
} = {}) {
  let temporaryDirectory
  const descriptors = []
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
    if (options.expectedHead && options.expectedHead !== head)
      throw new Error('HEAD does not match --expected-head.')
    if (options.phase === 'implementation') {
      const coordinatorTarget = Boolean(options.expectedHead)
      options.expectedHead = options.expectedHead ?? head
      options.base = options.base ?? defaultBase
      if (coordinatorTarget) options.base = resolveBaseSha(exec, options.base)
      gitOutput(exec, ['merge-base', options.base, head])
    }
    const context =
      options.phase === 'implementation'
        ? readImplementationContext(options.contextFile)
        : ''
    const prompt =
      options.phase === 'spec' && !options.dryRun
        ? specReviewPrompt({
            ...options,
            snapshot: options.snapshotFile
              ? JSON.parse(readFileSync(options.snapshotFile, 'utf8'))
              : undefined,
            dispositions: options.dispositionsFile
              ? JSON.parse(readFileSync(options.dispositionsFile, 'utf8'))
              : undefined,
            run: (file, args) => commandOutput(exec, file, args),
          })
        : undefined
    let request = reviewRequest(options, prompt?.prompt, undefined, { context })
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
    let lastMessageFile
    let progressOutputFile
    let progressErrorFile
    if (options.phase === 'implementation') {
      temporaryDirectory = mkdtempSync(
        join(tmpdir(), 'artifactshare-codex-review-'),
      )
      lastMessageFile = join(temporaryDirectory, 'last-message.txt')
      progressOutputFile = join(temporaryDirectory, 'stdout.log')
      progressErrorFile = join(temporaryDirectory, 'stderr.log')
      request = reviewRequest(options, prompt?.prompt, lastMessageFile, {
        context,
      })
    }
    const started = now()
    timingLog(
      `Codex ${options.phase} review requested: provider=codex model=${options.model} effort=${options.effort}${options.phase === 'implementation' ? ` base=${options.base} head=${options.expectedHead}` : ` artifact=${options.artifactUrl} version=${options.versionId}`}`,
    )
    const runOptions = { input: request.input }
    if (options.phase === 'spec') {
      runOptions.stdio = ['pipe', 'pipe', 'pipe']
      runOptions.encoding = 'utf8'
      runOptions.maxBuffer = 16 * 1024 * 1024
    } else {
      const stdoutDescriptor = openSync(progressOutputFile, 'wx', 0o600)
      descriptors.push(stdoutDescriptor)
      const stderrDescriptor = openSync(progressErrorFile, 'wx', 0o600)
      descriptors.push(stderrDescriptor)
      runOptions.stdio = ['ignore', stdoutDescriptor, stderrDescriptor]
    }
    const result = run('codex', request.args, runOptions)
    while (descriptors.length) closeSync(descriptors.pop())
    if (result.error) throw result.error
    if (result.status !== 0) {
      const stderr = progressErrorFile
        ? readDiagnosticTail(progressErrorFile)
        : result.stderr?.trim()
      const stdout = progressOutputFile
        ? readDiagnosticTail(progressOutputFile)
        : result.stdout?.trim()
      if (stderr) errorLog(stderr)
      if (stdout) errorLog(stdout)
      return result.status ?? 1
    }
    const implementationOutput = lastMessageFile
      ? readFileSync(lastMessageFile, 'utf8').trim()
      : undefined
    if (lastMessageFile && !implementationOutput)
      throw new Error('Codex review returned no final message.')
    const finalHead = gitOutput(exec, ['rev-parse', 'HEAD'])
    const finalStatus = gitOutput(exec, ['status', '--porcelain'])
    if (finalHead !== head || finalStatus)
      throw new Error(
        'Working tree or HEAD changed during review; review the current commit again.',
      )
    timingLog(
      `Codex ${options.phase} review: ${head.slice(0, 12)}, ${Math.round((now() - started) / 1000)}s`,
    )
    if (options.phase === 'spec') {
      log(conciseReviewOutput(prompt.scopeLock, result.stdout, prompt.metrics))
    } else {
      log(implementationOutput)
      log(reviewReminder)
    }
    return 0
  } catch (error) {
    errorLog(error instanceof Error ? error.message : 'Codex review failed.')
    return 1
  } finally {
    while (descriptors.length) closeSync(descriptors.pop())
    if (temporaryDirectory)
      rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main()

export {
  defaultBase,
  defaultEffort,
  defaultModel,
  main,
  parseArgs,
  resolveBaseSha,
  readDiagnosticTail,
  reviewReminder,
  reviewRequest,
  usage,
}

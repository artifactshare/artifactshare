#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { conciseReviewOutput, specReviewPrompt } from './spec-review-input.mjs'

const defaultModel = 'gpt-5.6-sol'
const defaultBase = 'origin/main'
const defaultEffort = 'xhigh'
import {
  baseIsReachable,
  readRounds,
  recordRound,
  rangeIsEmpty,
  resolveReviewBase,
  roundsPath,
  writeRounds,
} from './review-rounds.mjs'

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
  --dry-run             Print the invocation without starting review
  -h, --help            Show this help.`
}

function parseArgs(argv) {
  const options = {
    model: defaultModel,
    effort: defaultEffort,
    base: undefined,
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
  if (options.phase === 'spec') {
    if (!options.artifactUrl || !options.versionId)
      throw new Error('spec review requires --artifact-url and --version-id.')
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

function reviewRequest(options, prompt, lastMessageFile) {
  if (options.phase === 'spec')
    return {
      args: [
        'exec',
        '-m',
        options.model,
        '-c',
        `model_reasoning_effort="${options.effort}"`,
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
      `model_reasoning_effort="${options.effort}"`,
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

function defaultLocateRounds(exec) {
  const branch = commandOutput(exec, 'git', ['branch', '--show-current'])
  return branch
    ? roundsPath(branch, 'codex', (file, args) =>
        commandOutput(exec, file, args),
      )
    : null
}

function main({
  argv = process.argv.slice(2),
  exec = execFileSync,
  run = spawnSync,
  now = Date.now,
  log = console.log,
  errorLog = console.error,
  timingLog = console.error,
  locateRounds = defaultLocateRounds,
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
    let rounds
    let roundsFile
    // Injectable so a test never reaches the real .git: writing stub heads
    // there would silently narrow the next real review's base to a commit
    // nobody has. A detached checkout has no branch to key rounds by, so it
    // reads the whole change rather than guessing which head came before.
    roundsFile = options.phase === 'implementation' ? locateRounds(exec) : null
    if (roundsFile) {
      rounds = readRounds(roundsFile)
      const gitOut = (file, args) => commandOutput(exec, file, args)
      const resolved = resolveReviewBase({
        state: rounds,
        reviewer: 'codex',
        defaultBase,
        explicitBase: options.base,
        head,
      })
      // A recorded head that no longer exists must not become the review
      // range: it either aborts git or yields an empty range that reads clean.
      if (resolved.previousHead && !baseIsReachable(resolved.base, gitOut)) {
        resolved.base = defaultBase
        resolved.previousHead = null
      }
      // Not before --dry-run below: that mode promises the invocation JSON.
      if (
        !options.dryRun &&
        rangeIsEmpty(resolved.previousHead, head, gitOut)
      ) {
        timingLog(
          `Codex implementation review: nothing new since the last round at ${head.slice(0, 12)}.`,
        )
        return 0
      }
      options.base = resolved.base
    } else if (!options.base) {
      options.base = defaultBase
    }
    if (!/^[0-9a-f]{40}$/u.test(head))
      throw new Error('Could not resolve the committed review SHA.')
    if (options.phase === 'implementation')
      gitOutput(exec, ['merge-base', options.base, head])
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
    let request = reviewRequest(options, prompt?.prompt)
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
      request = reviewRequest(options, prompt?.prompt, lastMessageFile)
    }
    const started = now()
    const runOptions = { input: request.input }
    if (options.phase === 'spec') {
      runOptions.stdio = ['pipe', 'pipe', 'pipe']
      runOptions.encoding = 'utf8'
      runOptions.maxBuffer = 16 * 1024 * 1024
    } else {
      const stdoutDescriptor = openSync(progressOutputFile, 'wx', 0o600)
      const stderrDescriptor = openSync(progressErrorFile, 'wx', 0o600)
      descriptors.push(stdoutDescriptor, stderrDescriptor)
      runOptions.stdio = ['ignore', stdoutDescriptor, stderrDescriptor]
    }
    const result = run('codex', request.args, runOptions)
    while (descriptors.length) closeSync(descriptors.pop())
    if (result.error) throw result.error
    if (result.status !== 0) {
      const stderr = progressErrorFile
        ? readFileSync(progressErrorFile, 'utf8').trim()
        : result.stderr?.trim()
      const stdout = progressOutputFile
        ? readFileSync(progressOutputFile, 'utf8').trim()
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
      // Recorded only after a review that actually completed, so an aborted
      // run does not narrow the next round's base past code nobody read.
      if (roundsFile && rounds && !options.deferRoundRecord)
        writeRounds(
          roundsFile,
          recordRound(rounds, { head, reviewer: 'codex' }),
        )
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
  reviewReminder,
  reviewRequest,
  usage,
}

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  cliPackage,
  conciseReviewOutput,
  specReviewPrompt,
} from './spec-review-input.mjs'
import {
  baseIsReachable,
  readRounds,
  recordRound,
  rangeIsEmpty,
  resolveReviewBase,
  roundsPath,
  writeRounds,
} from './review-rounds.mjs'

const timeoutMs = 1_800_000
const defaultBase = 'origin/main'
const defaultEffort = 'xhigh'
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
  pnpm review:claude -- --phase implementation [--base <ref>] [--level low|high] [--effort low|medium|high|xhigh|max]
  pnpm review:claude -- --phase spec --artifact-url <url> --version-id <id> [--level low|high]

Spec correction options:
  --review-round <n> --baseline-size <n> --baseline-concepts <n>
  --dispositions-file <path>
  --snapshot-file <path>`
}

function parseArgs(argv) {
  const options = {
    phase: undefined,
    artifactUrl: undefined,
    versionId: undefined,
    level: 'high',
    effort: defaultEffort,
    base: undefined,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
    snapshotFile: undefined,
    deferRoundRecord: false,
  }
  for (let index = argv[0] === '--' ? 1 : 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '-h' || name === '--help') return { ...options, help: true }
    if (name === '--defer-round-record') {
      options.deferRoundRecord = true
      continue
    }
    if (
      ![
        '--phase',
        '--artifact-url',
        '--version-id',
        '--level',
        '--effort',
        '--base',
        '--review-round',
        '--baseline-size',
        '--baseline-concepts',
        '--dispositions-file',
        '--snapshot-file',
      ].includes(name)
    )
      throw new Error(`Unknown option: ${name}`)
    const value = argv[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${name}`)
    if (name === '--phase') options.phase = value
    if (name === '--artifact-url') options.artifactUrl = value
    if (name === '--version-id') options.versionId = value
    if (name === '--level') options.level = value
    if (name === '--effort') options.effort = value
    if (name === '--base') options.base = value
    if (name === '--review-round') options.reviewRound = Number(value)
    if (name === '--baseline-size') options.baselineSize = Number(value)
    if (name === '--baseline-concepts') options.baselineConcepts = Number(value)
    if (name === '--dispositions-file') options.dispositionsFile = value
    if (name === '--snapshot-file') options.snapshotFile = value
  }
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
  if (!['low', 'high'].includes(options.level))
    throw new Error('--level must be low or high.')
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort))
    throw new Error('--effort must be low, medium, high, xhigh, or max.')
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `${command} exited ${result.status}`,
    )
  return result.stdout
}

function git(args) {
  return run('git', args).trim()
}

function cleanHead() {
  const head = git(['rev-parse', 'HEAD'])
  if (git(['status', '--porcelain']))
    throw new Error('Review requires a clean worktree.')
  return head
}

function defaultLocateRounds() {
  const branch = git(['branch', '--show-current'])
  return branch ? roundsPath(branch, 'claude') : null
}

function invocation(options, head) {
  if (options.phase === 'implementation') {
    return {
      args: [
        '--safe-mode',
        '--model',
        'opus',
        '--effort',
        options.effort,
        '--tools',
        'Bash,Read,Grep,Glob,Agent,ReportFindings',
        '--allowedTools',
        'Bash',
        'Read',
        'Grep',
        'Glob',
        'Agent',
        'ReportFindings',
        '--permission-mode',
        'dontAsk',
        '--append-system-prompt',
        'Review only. Do not checkout, edit, test, commit, push, or write to GitHub.',
        '-p',
        `/code-review ${options.level} ${options.base}...${head}`,
        '--output-format',
        'json',
      ],
    }
  }
  const spec = specReviewPrompt({
    ...options,
    snapshot: options.snapshotFile
      ? JSON.parse(readFileSync(options.snapshotFile, 'utf8'))
      : undefined,
    run,
    dispositions: options.dispositionsFile
      ? JSON.parse(readFileSync(options.dispositionsFile, 'utf8'))
      : undefined,
  })
  return {
    input: spec.prompt,
    scopeLock: spec.scopeLock,
    metrics: spec.metrics,
    args: [
      '--safe-mode',
      '--model',
      'opus',
      '--effort',
      options.level,
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--permission-mode',
      'dontAsk',
      '-p',
      '--output-format',
      'json',
    ],
  }
}

function review(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const execute = options.run ?? run
  const readCleanHead = options.cleanHead ?? cleanHead
  const parsed = parseArgs(argv)
  if (parsed.help) {
    stdout.write(`${usage()}\n`)
    return 0
  }
  const head = readCleanHead()
  const started = Date.now()
  let rounds
  let path
  // Injectable so a test never reaches the real .git: writing stub heads there
  // would silently narrow the next real review's base to a commit nobody has.
  // A detached checkout has no branch to key rounds by, so it reads the whole
  // change rather than guessing which head came before.
  const locate = options.locateRounds ?? defaultLocateRounds
  path = parsed.phase === 'implementation' ? locate() : null
  if (path) {
    rounds = readRounds(path)
    const resolved = resolveReviewBase({
      state: rounds,
      reviewer: 'claude',
      defaultBase,
      explicitBase: parsed.base,
      head,
    })
    const gitOut = (file, args) => execute(file, args).trim()
    // A recorded head that no longer exists must not become the review range:
    // it would be swallowed as an empty range and report clean unread.
    if (resolved.previousHead && !baseIsReachable(resolved.base, gitOut)) {
      resolved.base = defaultBase
      resolved.previousHead = null
    }
    if (rangeIsEmpty(resolved.previousHead, head, gitOut)) {
      stderr.write(
        `Claude implementation review: nothing new since the last round at ${head.slice(0, 12)}.\n`,
      )
      return 0
    }
    parsed.base = resolved.base
  } else if (!parsed.base) {
    parsed.base = defaultBase
  }
  const request = invocation(parsed, head)
  const raw = execute('claude', request.args, {
    cwd: git(['rev-parse', '--show-toplevel']),
    input: request.input,
  })
  const envelope = JSON.parse(raw)
  const result =
    typeof envelope.result === 'string' ? envelope.result : undefined
  if (
    envelope.is_error !== false ||
    envelope.subtype !== 'success' ||
    !result?.trim() ||
    !Array.isArray(envelope.permission_denials) ||
    envelope.permission_denials.length > 0
  )
    throw new Error(
      `Claude review failed.${result ? `\n${result}` : ''}${Array.isArray(envelope.permission_denials) ? `\nPermission denials: ${JSON.stringify(envelope.permission_denials)}` : ''}`,
    )
  const output =
    parsed.phase === 'spec'
      ? conciseReviewOutput(request.scopeLock, result, request.metrics)
      : result
  stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  stderr.write(
    `Claude ${parsed.phase} review: ${head.slice(0, 12)}, ${Math.round((Date.now() - started) / 1000)}s\n`,
  )
  if (readCleanHead() !== head)
    throw new Error('HEAD or worktree changed during review.')
  if (parsed.phase === 'implementation') {
    // Recorded only after a review that actually completed, so an aborted run
    // does not narrow the next round's base past code nobody read.
    if (path && rounds && !parsed.deferRoundRecord)
      writeRounds(path, recordRound(rounds, { head, reviewer: 'claude' }))
    stdout.write(`${reviewReminder}\n`)
  }
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = review()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

export {
  cliPackage,
  defaultBase,
  defaultEffort,
  invocation,
  parseArgs,
  review,
  reviewReminder,
  usage,
}

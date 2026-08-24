import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  cliPackage,
  conciseReviewOutput,
  specReviewPrompt,
} from './spec-review-input.mjs'

const timeoutMs = 1_800_000
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
  pnpm review:claude -- --phase implementation [--base <ref>] [--level low|high]
  pnpm review:claude -- --phase spec --artifact-url <url> --version-id <id> [--level low|high]

Spec correction options:
  --review-round <n> --baseline-size <n> --baseline-concepts <n>
  --dispositions-file <path>`
}

function parseArgs(argv) {
  const options = {
    phase: undefined,
    artifactUrl: undefined,
    versionId: undefined,
    level: 'high',
    base: defaultBase,
    reviewRound: 1,
    baselineSize: undefined,
    baselineConcepts: undefined,
    dispositionsFile: undefined,
  }
  for (let index = argv[0] === '--' ? 1 : 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '-h' || name === '--help') return { ...options, help: true }
    if (
      ![
        '--phase',
        '--artifact-url',
        '--version-id',
        '--level',
        '--base',
        '--review-round',
        '--baseline-size',
        '--baseline-concepts',
        '--dispositions-file',
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
    if (name === '--base') options.base = value
    if (name === '--review-round') options.reviewRound = Number(value)
    if (name === '--baseline-size') options.baselineSize = Number(value)
    if (name === '--baseline-concepts') options.baselineConcepts = Number(value)
    if (name === '--dispositions-file') options.dispositionsFile = value
  }
  if (!['spec', 'implementation'].includes(options.phase))
    throw new Error('--phase must be spec or implementation.')
  if (!['low', 'high'].includes(options.level))
    throw new Error('--level must be low or high.')
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

function invocation(options, head) {
  if (options.phase === 'implementation') {
    return {
      args: [
        '--safe-mode',
        '--model',
        'opus',
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
  if (parsed.phase === 'implementation') stdout.write(`${reviewReminder}\n`)
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
  invocation,
  parseArgs,
  review,
  reviewReminder,
  usage,
}

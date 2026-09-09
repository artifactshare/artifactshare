import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { finalReviews, specificationDrafting } from './agent-role-settings.mjs'
import {
  assertActivityLockCapability,
  runUnderActivityLock,
} from './worktree-activity-lock.mjs'
import { runProvider } from './provider-process.mjs'
import {
  implementationReviewInstructions,
  readImplementationContext,
} from './implementation-review-input.mjs'
import {
  cliPackage,
  conciseReviewOutput,
  specReviewPrompt,
} from './spec-review-input.mjs'

const timeoutMs = 1_800_000
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
  pnpm review:claude -- --phase implementation [--base <ref>] [--expected-head <sha>] [--context-file <path> (scope, criteria, and a required Dispositions section)] [--level low|medium|high|xhigh|max] [--effort low|medium|high|xhigh|max]
  pnpm review:claude -- --phase spec --artifact-url <url> --version-id <id> [--model <model>] [--level low|medium|high|xhigh|max] [--effort low|medium|high|xhigh|max]

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
        '--model',
        '--level',
        '--effort',
        '--base',
        '--expected-head',
        '--context-file',
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
    if (name === '--model') options.model = value
    if (name === '--level') {
      options.level = value
      levelProvided = true
    }
    if (name === '--effort') {
      options.effort = value
      effortProvided = true
    }
    if (name === '--base') options.base = value
    if (name === '--expected-head') options.expectedHead = value
    if (name === '--context-file') options.contextFile = value
    if (name === '--review-round') options.reviewRound = Number(value)
    if (name === '--baseline-size') options.baselineSize = Number(value)
    if (name === '--baseline-concepts') options.baselineConcepts = Number(value)
    if (name === '--dispositions-file') options.dispositionsFile = value
    if (name === '--snapshot-file') options.snapshotFile = value
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
  ) {
    throw new Error('implementation review does not accept spec options.')
  }
  if (!Number.isInteger(options.reviewRound) || options.reviewRound < 1)
    throw new Error('--review-round must be a positive integer.')
  if (options.phase === 'spec' && options.deferRoundRecord)
    throw new Error('spec review does not accept --defer-round-record.')
  // Keep these flags out of normal JSON output while retaining the information
  // for callers that need to distinguish the compatibility alias from the
  // default effort.
  Object.defineProperties(options, {
    levelExplicit: { value: levelProvided, enumerable: false },
    effortExplicit: { value: effortProvided, enumerable: false },
  })
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

function resolveBaseSha(base, execute = run) {
  if (/^[0-9a-f]{40}$/u.test(base)) return base
  const resolved = execute('git', ['rev-parse', '--verify', `${base}^{commit}`])
  if (!/^[0-9a-f]{40}$/u.test(resolved.trim()))
    throw new Error('Could not resolve the committed review base SHA.')
  return resolved.trim()
}

function invocation(options, head, { execute = run } = {}) {
  if (options.phase === 'implementation') {
    const expectedHead = options.expectedHead ?? head
    return {
      args: [
        '--safe-mode',
        '--model',
        options.model ?? defaultModel,
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
        implementationReviewInstructions({
          context: options.context ?? '',
          base: options.base,
          expectedHead: options.expectedHead ?? head,
        }),
        '-p',
        `/code-review ${options.effort} ${options.base}...${expectedHead}`,
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
    run: execute,
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
      options.model ?? specDefaultModel,
      '--effort',
      options.effort ?? specDefaultEffort,
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
  if (parsed.expectedHead && parsed.expectedHead !== head)
    throw new Error('HEAD does not match --expected-head.')
  const started = Date.now()
  const coordinatorTarget = Boolean(parsed.expectedHead)
  parsed.expectedHead = parsed.expectedHead ?? head
  parsed.base = parsed.base ?? defaultBase
  if (parsed.phase === 'implementation' && coordinatorTarget)
    parsed.base = resolveBaseSha(parsed.base, execute)
  if (parsed.phase === 'implementation')
    execute('git', ['merge-base', parsed.base, head])
  if (parsed.phase === 'implementation')
    parsed.context = readImplementationContext(parsed.contextFile)
  const request = invocation(parsed, head, { execute })
  stderr.write(
    `Claude ${parsed.phase} review requested: provider=claude model=${parsed.model} effort=${parsed.effort}${parsed.phase === 'implementation' ? ` base=${parsed.base} head=${parsed.expectedHead}` : ` artifact=${parsed.artifactUrl} version=${parsed.versionId}`}\n`,
  )
  const raw = execute('claude', request.args, {
    cwd: execute('git', ['rev-parse', '--show-toplevel']).trim(),
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
  if (readCleanHead() !== head)
    throw new Error('HEAD or worktree changed during review.')
  stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  stderr.write(
    `Claude ${parsed.phase} review: ${head.slice(0, 12)}, ${Math.round((Date.now() - started) / 1000)}s\n`,
  )
  if (parsed.phase === 'implementation') {
    stdout.write(`${reviewReminder}\n`)
  }
  return 0
}

async function launchClaudeReview(
  parsed,
  capability,
  {
    execute = run,
    readCleanHead = cleanHead,
    provider = runProvider,
    signal,
    now = Date.now,
  } = {},
) {
  assertActivityLockCapability(capability, (file, args) =>
    execute(file, args).trim(),
  )
  const head = readCleanHead()
  if (parsed.expectedHead && parsed.expectedHead !== head)
    throw new Error('HEAD does not match --expected-head.')
  const started = now()
  const coordinatorTarget = Boolean(parsed.expectedHead)
  parsed = {
    ...parsed,
    expectedHead: parsed.expectedHead ?? head,
    base: parsed.base ?? defaultBase,
  }
  if (parsed.phase === 'implementation' && coordinatorTarget)
    parsed.base = resolveBaseSha(parsed.base, execute)
  if (parsed.phase === 'implementation')
    execute('git', ['merge-base', parsed.base, head])
  if (parsed.phase === 'implementation')
    parsed.context = readImplementationContext(parsed.contextFile)
  const request = invocation(parsed, head, { execute })
  const workspace = execute('git', ['rev-parse', '--show-toplevel']).trim()
  const requested = `Claude ${parsed.phase} review requested: provider=claude model=${parsed.model} effort=${parsed.effort}${parsed.phase === 'implementation' ? ` base=${parsed.base} head=${parsed.expectedHead}` : ` artifact=${parsed.artifactUrl} version=${parsed.versionId}`}\n`
  let result
  try {
    result = await provider('claude', request.args, {
      cwd: workspace,
      input: request.input,
      signal,
    })
  } catch (error) {
    const diagnostic = error?.result?.stderr || error?.result?.stdout
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${diagnostic ? `\n${diagnostic.trim()}` : ''}`,
      { cause: error },
    )
  }
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `claude exited ${result.code}`)
  const envelope = JSON.parse(result.stdout)
  const body = typeof envelope.result === 'string' ? envelope.result : undefined
  if (
    envelope.is_error !== false ||
    envelope.subtype !== 'success' ||
    !body?.trim() ||
    !Array.isArray(envelope.permission_denials) ||
    envelope.permission_denials.length
  )
    throw new Error(
      `Claude review failed.${body ? `\n${body}` : ''}${Array.isArray(envelope.permission_denials) ? `\nPermission denials: ${JSON.stringify(envelope.permission_denials)}` : ''}`,
    )
  if (readCleanHead() !== head)
    throw new Error('HEAD or worktree changed during review.')
  const output =
    parsed.phase === 'spec'
      ? conciseReviewOutput(request.scopeLock, body, request.metrics)
      : `${body.endsWith('\n') ? body : `${body}\n`}${reviewReminder}\n`
  return {
    stdout: output.endsWith('\n') ? output : `${output}\n`,
    stderr: `${requested}${result.stderr}Claude ${parsed.phase} review: ${head.slice(0, 12)}, ${Math.round((now() - started) / 1000)}s\n`,
    code: 0,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // A standalone review checks that HEAD and the worktree stay unchanged, so
  // it takes the worktree activity lock like the gate (help needs none; a
  // gate's child runs under the gate's lock).
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
  ).then((code) => {
    process.exitCode = code
  })
}

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

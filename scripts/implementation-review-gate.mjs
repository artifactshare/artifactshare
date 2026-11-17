#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { finalReviews, roundCapConsultation } from './agent-role-settings.mjs'
import { collectTestChanges, renderTestChanges } from './test-change-review.mjs'
import {
  launchCodexReview,
  parseArgs as parseCodexArgs,
  reviewReminder,
} from './codex-review.mjs'
import { localInstructionsFile } from './claude-code-review.mjs'
import {
  launchClaudeReview,
  parseArgs as parseClaudeArgs,
} from './claude-review.mjs'
import {
  isAncestorOrSelf,
  matchingPairHistory,
  allWorkaroundPair,
  pairCoversBranch,
  refusedHead,
  completedPairs,
  readRounds,
  recordRound,
  rangeIsEmpty,
  resolvePairReviewBase,
  roundsPath,
  writeConsultation,
  writeRounds,
} from './review-rounds.mjs'
import {
  acquireActivityLock,
  normalizeOperationError,
  releaseActivityLock,
} from './worktree-activity-lock.mjs'
import {
  acquireTaskScopeLock,
  admitTaskCandidate,
  currentTaskBranch,
  taskScopeContext,
} from './task-scope.mjs'

import {
  CONTEXT_DELIMITERS,
  assertWorkaroundFinding,
} from './implementation-review-input.mjs'
import { runProvider } from './provider-process.mjs'

const defaultBase = 'origin/main'
const implementationReviewProfile = Object.freeze({
  ...finalReviews,
  method: { codex: 'controlled-review', claude: 'code-review' },
})
// Five completed pairs per branch under the current profile; the sixth is
// refused so the orchestrator settles what remains instead of looping.
const implementationRoundCap = 5
const maxCapturedBytes = 8 * 1024
const consultationTimeoutMs = 1_800_000

function usage() {
  return 'Usage: pnpm review:implementation -- [--base <ref>] [--dispositions-file <path>] [--consult-workarounds]'
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const options = {
    base: undefined,
    dispositionsFile: undefined,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--consult-workarounds') {
      options.consultWorkarounds = true
      continue
    }
    if (!['--base', '--dispositions-file'].includes(arg))
      throw new Error(`${usage()}\n\nUnknown option: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${arg}`)
    if (arg === '--base') options.base = value
    if (arg === '--dispositions-file') options.dispositionsFile = value
  }
  return options
}

function readDispositionsBody(path) {
  if (!path) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Implementation review dispositions could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function commandOutput(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function writeText(stream, value) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const onError = (error) => settle(error)
    stream.once('error', onError)
    stream.write(`${value}\n`, (error) => {
      if (error) {
        settle(error)
        return
      }
      stream.off('error', onError)
      settle()
    })
  })
}

function cleanHead(run = commandOutput) {
  if (run('git', ['status', '--porcelain']))
    throw new Error('Implementation review requires a clean worktree.')
  const head = run('git', ['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the committed review SHA.')
  return head
}

function resolveBaseSha(base, run = commandOutput) {
  if (/^[0-9a-f]{40}$/u.test(base)) return base
  const resolved = run('git', [
    'rev-parse',
    '--verify',
    `${base}^{commit}`,
  ]).trim()
  if (!/^[0-9a-f]{40}$/u.test(resolved))
    throw new Error('Could not resolve the committed review base SHA.')
  return resolved
}

function coordinatedBase({ base, head, run = commandOutput } = {}) {
  // An explicit base is owner intent. Do not inspect or consult pair history
  // when one was supplied.
  if (base) {
    const resolved = resolveBaseSha(base, run)
    run('git', ['merge-base', resolved, head])
    return {
      base: resolved,
      commitBase: resolved,
      previousHead: null,
      reused: false,
      noTarget: rangeIsEmpty(resolved, head, run),
    }
  }
  const branch = run('git', ['branch', '--show-current'])
  let codexState
  let claudeState
  if (branch) {
    const gitCommon = (file, args) => run(file, args)
    codexState = readRounds(roundsPath(branch, 'codex', gitCommon))
    claudeState = readRounds(roundsPath(branch, 'claude', gitCommon))
  }
  const resolved = resolvePairReviewBase({
    codexState,
    claudeState,
    profile: implementationReviewProfile,
    defaultBase,
    head,
    run,
  })
  const resolvedBase = resolveBaseSha(resolved.base, run)
  run('git', ['merge-base', resolvedBase, head])
  return {
    ...resolved,
    base: resolvedBase,
    noTarget: rangeIsEmpty(resolvedBase, head, run),
  }
}

/**
 * The branch's completed pairs under the current profile, oldest first: the
 * rounds both reviewer files recorded. The cap counts these and the
 * round-cap consultation builds on the last of them, so a branch at the cap
 * always has a last pair.
 */
function branchCompletedPairs({ run = commandOutput } = {}) {
  const branch = run('git', ['branch', '--show-current'])
  if (!branch) return []
  return completedPairs({
    codexState: readRounds(roundsPath(branch, 'codex', run)),
    claudeState: readRounds(roundsPath(branch, 'claude', run)),
    profile: implementationReviewProfile,
  })
}

function completedPairRounds({ run = commandOutput } = {}) {
  return branchCompletedPairs({ run }).length
}

/** HEAD of the branch's most recently completed pair, if any. */
function lastCompletedPairHead({ run = commandOutput } = {}) {
  return branchCompletedPairs({ run }).at(-1)?.head
}

function localInstructionsPresent(run = commandOutput) {
  return existsSync(
    join(run('git', ['rev-parse', '--show-toplevel']), localInstructionsFile),
  )
}

function roundCapResult(rounds) {
  return JSON.stringify(
    {
      verdict: 'ROUND_CAP',
      target_unreviewed: true,
      rounds,
      note: `The implementation review-round cap of ${implementationRoundCap} is spent (${rounds} completed pairs on this branch). Write the remaining blockers and their dispositions to a file and rerun with --dispositions-file <path>: the gate then consults ${roundCapConsultation.claude.model} at ${roundCapConsultation.claude.effort} effort on this HEAD and records its decision for Ready. Return to the owner when that consultation, or the orchestrator, finds that the issue or its premise should be reconsidered; otherwise record the remaining findings as deferred for Ready and continue. Do not treat the cap as a passed gate.`,
    },
    null,
    2,
  )
}

/** Blocker count of a delivered review result, or undefined when the result
 * is not the reviewers' JSON. An unknown severity counts as a blocker. Only
 * marked workaround findings are retained separately as bounded local evidence. */
function blockerCount(output) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed?.findings)) return undefined
  return parsed.findings.filter(
    (finding) =>
      finding?.severity !== 'follow_up' &&
      finding?.severity !== 'non_actionable',
  ).length
}

function workaroundEvidence(output) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed?.findings)) return undefined
  try {
    parsed.findings.forEach(assertWorkaroundFinding)
  } catch {
    return undefined
  }
  const findings = parsed.findings.filter(
    (finding) => finding.workaround === true,
  )
  return {
    workaroundBlockers: findings.length,
    workaroundFindings: findings.map(
      ({
        id,
        file,
        line,
        summary,
        severity,
        workaround,
        root_cause,
        removing_change,
      }) => ({
        id,
        file,
        line,
        summary,
        severity,
        workaround,
        root_cause,
        removing_change,
      }),
    ),
  }
}

function consultationPrompt({ head, pairHead, mergeBase, evidencePath }) {
  return [
    'Round-cap consultation for the implementation review gate. Read only: do not edit files, run commands, or write to remote services.',
    `The branch has spent its ${implementationRoundCap} implementation review pairs. The target is HEAD ${head}, reviewed against merge base ${mergeBase} (git diff ${mergeBase}...${head}). The last completed pair read HEAD ${pairHead}; no pair has read the change ${pairHead}..${head}.`,
    `Read ${evidencePath} first. It holds the branch's immutable objective scope, the remaining blockers and their dispositions (under Dispositions), the changed files and diff of the unreviewed change ${pairHead}..${head}, and the changed files and full diff of the fixed range. Read checkout files the blockers concern for further context, and judge each disposition against the objective scope and the diff.`,
    'Decide PROCEED when no remaining blocker breaks what the issue sets out to do and the unreviewed change introduces no new blocker, so the remaining findings can be recorded as deferred for Ready. Decide RETURN TO OWNER when a remaining blocker is unresolved, when the unreviewed change introduces one, or when the issue or its premise should be reconsidered.',
    'Explain the decision briefly, then end with exactly one final line: DECISION: PROCEED or DECISION: RETURN TO OWNER.',
  ].join('\n\n')
}

function consultationDecision(text) {
  const last = String(text ?? '')
    .trimEnd()
    .split('\n')
    .at(-1)
    ?.replace(/[`*]/gu, '')
    .trim()
  const match = /^DECISION: (PROCEED|RETURN TO OWNER)$/u.exec(last ?? '')
  if (!match)
    throw new Error(
      'The round-cap consultation did not end with DECISION: PROCEED or DECISION: RETURN TO OWNER; nothing was recorded.',
    )
  return match[1]
}

/** Runs the round-cap consultation with the configured Claude profile and
 * returns its text. The provider runs as an asynchronous child process group
 * that is stopped on SIGINT/SIGTERM, an aborted `signal`, or the timeout. */
async function runRoundCapConsultation(
  prompt,
  { evidenceDirectory, signal, provider = runProvider } = {},
) {
  const { model, effort } = roundCapConsultation.claude
  const result = await provider(
    'claude',
    [
      '--safe-mode',
      '--model',
      model,
      '--effort',
      effort,
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--add-dir',
      evidenceDirectory,
      '--permission-mode',
      'dontAsk',
      '--append-system-prompt',
      'Consultation only. Do not edit, execute commands, browse, or write to remote services.',
      '-p',
      prompt,
      '--output-format',
      'json',
    ],
    { signal, timeoutMs: consultationTimeoutMs },
  )
  let envelope
  try {
    envelope = JSON.parse(result.stdout ?? '')
  } catch {
    envelope = undefined
  }
  if (
    result.code !== 0 ||
    envelope?.is_error !== false ||
    envelope?.subtype !== 'success' ||
    typeof envelope?.result !== 'string' ||
    !envelope.result.trim() ||
    !Array.isArray(envelope?.permission_denials) ||
    envelope.permission_denials.length > 0
  )
    throw new Error('The round-cap consultation failed; nothing was recorded.')
  return envelope.result.trim()
}

function recordConsultationDecision({
  branch,
  head,
  pairHead,
  decision,
  run,
  kind,
  pairId,
}) {
  writeConsultation(roundsPath(branch, 'consultation', run), {
    head,
    pairHead,
    decision,
    profile: roundCapConsultation,
    kind,
    pairId,
  })
}

function appendTail(capture, chunk, limit = maxCapturedBytes) {
  const combined = Buffer.concat([capture.buffer, Buffer.from(chunk)])
  if (combined.byteLength <= limit)
    return { buffer: combined, truncated: capture.truncated }
  let start = combined.byteLength - limit
  while (start < combined.byteLength && (combined[start] & 0xc0) === 0x80)
    start += 1
  return {
    buffer: combined.subarray(start),
    truncated: true,
  }
}

function formatCapture(capture) {
  const value = capture.buffer.toString('utf8').trim()
  return capture.truncated ? `[earlier output omitted]\n${value}` : value
}

async function runReviewer(name, args = [], capability, options = {}) {
  if (!['codex', 'claude'].includes(name))
    throw new Error(`Unknown reviewer: ${name}`)
  const launch =
    name === 'codex'
      ? (options.launchCodex ?? launchCodexReview)
      : (options.launchClaude ?? launchClaudeReview)
  const parse = name === 'codex' ? parseCodexArgs : parseClaudeArgs
  const result = await launch(parse(args), capability, options)
  const captured = {
    name,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
  if (result.code !== 0)
    throw new Error(
      `${name} review failed (exit ${result.code}).\n${captured.stderr || captured.stdout}`,
    )
  if (!captured.stdout)
    throw new Error(`${name} review returned no final result.`)
  return captured
}

function recordCompletedRounds(head, optionsOrRun = {}, maybeRun) {
  const options =
    typeof optionsOrRun === 'function' ? { run: optionsOrRun } : optionsOrRun
  const run = options.run ?? maybeRun ?? commandOutput
  const branch = run('git', ['branch', '--show-current'])
  if (!branch) return
  const pairId = randomUUID()
  for (const reviewer of ['codex', 'claude']) {
    const path = roundsPath(branch, reviewer, run)
    writeRounds(
      path,
      recordRound(readRounds(path), {
        head,
        reviewer,
        base: options.base,
        commitBase: options.commitBase,
        profile: options.profile ?? implementationReviewProfile,
        blockers: options.blockers?.[reviewer],
        pairId,
        ...options.workarounds?.[reviewer],
      }),
    )
  }
}

async function waitForBoth(reviews) {
  const settled = await Promise.allSettled(reviews)
  const failures = settled.filter(({ status }) => status === 'rejected')
  if (failures.length)
    throw new Error(
      failures
        .map(({ reason }) => reason?.message ?? String(reason))
        .join('\n\n'),
    )
  return settled.map(({ value }) => value)
}

function withoutReminder(output) {
  const suffix = `\n${reviewReminder}`
  if (output === reviewReminder) return ''
  return output.endsWith(suffix) ? output.slice(0, -suffix.length) : output
}

function quoteCommitMessages(commitMessages) {
  return commitMessages
    .replace(
      new RegExp(
        [...CONTEXT_DELIMITERS]
          .sort((left, right) => right.length - left.length)
          .map((marker) => RegExp.escape(marker))
          .join('|'),
        'gu',
      ),
      (marker) => `[escaped: ${marker.replace(/^--- | ---$/gu, '')}]`,
    )
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join('\n')
}

function createContextSnapshot(context, directory) {
  const path = join(directory, `implementation-context-${randomUUID()}.txt`)
  writeFileSync(path, context, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o400)
  return path
}

async function main({
  argv = process.argv.slice(2),
  run = commandOutput,
  review = runReviewer,
  readCleanHead = () => cleanHead(run),
  inspectTestChanges = ({ base, head }) =>
    collectTestChanges({ base, head, run }),
  recordRounds = recordCompletedRounds,
  countRounds = () => completedPairRounds({ run }),
  readLastPairHead = () => lastCompletedPairHead({ run }),
  consult = runRoundCapConsultation,
  isRefused = (branch, head) =>
    refusedHead(roundsPath(branch, 'consultation', run), head),
  recordConsultation = recordConsultationDecision,
  localInstructionsPresent: hasLocalInstructions = () =>
    localInstructionsPresent(run),
  acquireLock = acquireActivityLock,
  acquireScopeLock = acquireTaskScopeLock,
  getBranch = currentTaskBranch,
  admitCandidate = admitTaskCandidate,
  signal,
  log = (value) => writeText(process.stdout, value),
  timingLog = (value) => writeText(process.stderr, value),
  usageLog = timingLog,
} = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    await log(usage())
    return 0
  }
  let releaseActivity = async () => {}
  let releaseScope = async () => {}
  let operationError
  let snapshotDirectory
  try {
    releaseActivity = await acquireLock('the implementation gate')
    const head = readCleanHead()
    const branch = getBranch(run)
    releaseScope = await acquireScopeLock(branch, { run })
    // An owner's CLAUDE.local.md would stop the Claude side only after the
    // Codex side had run, and would reach the round-cap consultation's Claude
    // session too; refuse before any provider starts.
    if (hasLocalInstructions())
      throw new Error(
        `${localInstructionsFile} already exists at the repository root; move it aside before the implementation gate.`,
      )
    // Counted under the branch lock so two gates cannot both pass the cap.
    const rounds = countRounds()
    const assertNotRefused = () => {
      if (isRefused(branch, head))
        throw new Error(
          'FIX HERE: correct the cause in this repository and commit a different HEAD. This HEAD remains refused by Ready.',
        )
    }
    assertNotRefused()
    if (options.consultWorkarounds) {
      if (options.base !== undefined)
        throw new Error('--consult-workarounds refuses --base.')
      const codexState = readRounds(roundsPath(branch, 'codex', run))
      const claudeState = readRounds(roundsPath(branch, 'claude', run))
      const profile = implementationReviewProfile
      const pair = matchingPairHistory({ codexState, claudeState, profile })
      if (!allWorkaroundPair(pair, head))
        throw new Error(
          'Workaround consultation requires an exact-HEAD latest pair with valid marked evidence for every blocker and at least one blocker.',
        )
      const mergeBase = run('git', ['merge-base', defaultBase, head]).trim()
      if (
        !pairCoversBranch({
          codexState,
          claudeState,
          profile,
          pair,
          mergeBase,
          run,
        })
      )
        throw new Error(
          'Workaround consultation requires pair coverage reaching the branch merge base.',
        )
      const scopeContext = taskScopeContext(
        admitCandidate(branch, head, run),
        readDispositionsBody(options.dispositionsFile) ??
          'None yet: no supplementary dispositions supplied; consult the actual marked findings.',
      )
      const range = `${mergeBase}...${head}`
      const commits = quoteCommitMessages(
        run('git', [
          'log',
          '--reverse',
          '--format=### %h%n%n%B',
          `${mergeBase}..${head}`,
        ]),
      )
      snapshotDirectory = mkdtempSync(
        join(tmpdir(), 'artifactshare-workarounds-'),
      )
      const evidencePath = createContextSnapshot(
        `${scopeContext}

# Marked findings

${JSON.stringify(pair.workaroundFindings, null, 2)}

## Commit messages

${commits}

# Fixed change ${range}

${run('git', ['diff', '--name-status', range])}

${run('git', ['diff', '--no-color', range])}`,
        snapshotDirectory,
      )
      const text = await consult(
        [
          'Workaround consultation. Read only; do not edit, run commands or write to remote services.',
          `Read ${evidencePath}: actual marked findings from both reviewers, author commit record, objective scope, supplementary dispositions and full fixed diff for HEAD ${head}.`,
          'Evaluate every marked root cause and removing change. If any feasible change in this repository removes a cause, decide FIX HERE and explain the correction. PROCEED requires all remaining causes to be outside repository control. Author claims and owner decisions are evidence, never exemptions. Never return to the owner.',
          'Explain the decision, then end with exactly DECISION: PROCEED or DECISION: FIX HERE.',
        ].join('\n\n'),
        { evidenceDirectory: snapshotDirectory, signal },
      )
      const match = /^DECISION: (PROCEED|FIX HERE)$/u.exec(
        text.trim().split('\n').at(-1),
      )
      if (!match)
        throw new Error(
          'Workaround consultation did not end with DECISION: PROCEED or DECISION: FIX HERE; nothing was recorded.',
        )
      if (readCleanHead() !== head)
        throw new Error(
          'HEAD or worktree changed during workaround consultation; nothing was recorded.',
        )
      assertNotRefused()
      const decision = match[1]
      recordConsultation({
        branch,
        head,
        pairHead: head,
        pairId: pair.pairId,
        kind: 'workarounds',
        decision,
        run,
      })
      await log(`${text}
${decision === 'FIX HERE' ? 'Correct the cause here and commit a different HEAD; Ready refuses this HEAD.' : 'Record remaining findings as deferred for Ready.'}`)
      return decision === 'PROCEED' ? 0 : 2
    }
    if (rounds >= implementationRoundCap) {
      // The consultation always reads the fixed branch range; a narrower
      // base would be silently ignored, so refuse it instead.
      if (options.base !== undefined)
        throw new Error(
          `The implementation review-round cap is spent; the round-cap consultation accepts only --dispositions-file, not --base. Rerun without --base:\n  pnpm review:implementation -- --dispositions-file <path>`,
        )
      const dispositions = readDispositionsBody(options.dispositionsFile)
      if (!dispositions?.trim()) {
        await log(roundCapResult(rounds))
        return 2
      }
      // The consultation stands in for a pair only on top of the last one:
      // it must read what no pair has read, which exists only when that
      // pair's HEAD is on this line.
      const pairHead = readLastPairHead()
      if (!pairHead || !isAncestorOrSelf(pairHead, head, run))
        throw new Error(
          `The last completed implementation pair's HEAD ${pairHead ?? '(none)'} is not HEAD ${head} or one of its ancestors; the round-cap consultation cannot cover this HEAD and nothing was recorded. Return to the owner.`,
        )
      // The consultation judges the dispositions against the branch's
      // immutable objective scope and the fixed change, which it reads from
      // one immutable snapshot because it cannot run Git itself.
      const scopeContext = taskScopeContext(
        admitCandidate(branch, head, run),
        dispositions,
      )
      const mergeBase = run('git', ['merge-base', defaultBase, head]).trim()
      const range = `${mergeBase}...${head}`
      const unreviewed = `${pairHead}..${head}`
      const unreviewedSection =
        pairHead === head
          ? `# Unreviewed change ${unreviewed}\n\n(none: the last completed pair read this HEAD)`
          : `# Unreviewed change ${unreviewed}\n\n## Changed files\n\n${run('git', ['diff', '--name-status', unreviewed]) || '(none)'}\n\n## Diff\n\n${run('git', ['diff', '--no-color', unreviewed])}`
      snapshotDirectory = mkdtempSync(
        join(tmpdir(), `artifactshare-round-cap-${process.pid}-`),
      )
      const evidencePath = createContextSnapshot(
        `${scopeContext}\n\n${unreviewedSection}\n\n# Fixed change ${range}\n\n## Changed files\n\n${run('git', ['diff', '--name-status', range]) || '(none)'}\n\n## Diff\n\n${run('git', ['diff', '--no-color', range])}\n`,
        snapshotDirectory,
      )
      const text = await consult(
        consultationPrompt({ head, pairHead, mergeBase, evidencePath }),
        { evidenceDirectory: snapshotDirectory, signal },
      )
      const decision = consultationDecision(text)
      if (readCleanHead() !== head)
        throw new Error(
          'HEAD or worktree changed during the round-cap consultation; nothing was recorded.',
        )
      // Ready reads only the decision for this exact HEAD, on top of the
      // pair HEAD it covered.
      assertNotRefused()
      recordConsultation({ branch, head, pairHead, decision, run })
      await log(
        `## Round-cap consultation (${roundCapConsultation.claude.model}, ${roundCapConsultation.claude.effort})\n\n${text}\n\nRecorded DECISION: ${decision} for HEAD ${head}.${decision === 'PROCEED' ? ' Record the remaining findings as deferred for Ready.' : ' Return to the owner; Ready refuses this HEAD.'}`,
      )
      return decision === 'PROCEED' ? 0 : 2
    }
    const scopeState = admitCandidate(branch, head, run)
    const scopeContext = taskScopeContext(
      scopeState,
      readDispositionsBody(options.dispositionsFile),
    )
    const target = coordinatedBase({ base: options.base, head, run })
    if (target.noTarget)
      throw new Error(
        'No implementation review target exists for the resolved base and HEAD; the final gate is incomplete.',
      )
    const changes = inspectTestChanges({ base: target.base, head })
    if (changes.base !== target.base || changes.head !== head)
      throw new Error(
        'Test change evidence does not match the fixed review range.',
      )
    const commitBase =
      target.commitBase ?? run('git', ['merge-base', defaultBase, head]).trim()
    const commitMessages = run('git', [
      'log',
      '--reverse',
      '--format=### %h%n%n%B',
      `${commitBase}..${head}`,
    ])
    // Quote Git evidence so commit headings and lists are not context sections.
    const quotedCommitMessages = quoteCommitMessages(commitMessages)
    const context = `${scopeContext}\n\n${renderTestChanges(changes)}\n\n## Commit messages\n\n${quotedCommitMessages}`
    snapshotDirectory = mkdtempSync(
      join(tmpdir(), `artifactshare-implementation-review-${process.pid}-`),
    )
    const snapshotPath = createContextSnapshot(context, snapshotDirectory)
    const common = [
      '--phase',
      'implementation',
      '--base',
      target.base,
      '--expected-head',
      head,
      '--context-file',
      snapshotPath,
    ]
    const results = await waitForBoth([
      review(
        'codex',
        [
          ...common,
          '--model',
          finalReviews.codex.model,
          '--effort',
          finalReviews.codex.effort,
        ],
        releaseActivity,
        { signal, emitUsageEvent: usageLog },
      ),
      review(
        'claude',
        [
          ...common,
          '--model',
          finalReviews.claude.model,
          '--effort',
          finalReviews.claude.effort,
        ],
        releaseActivity,
        { signal, emitUsageEvent: usageLog },
      ),
    ])

    // Nothing is accepted or delivered until both reviewers finish and the
    // target and worktree still match the launch snapshot.
    if (readCleanHead() !== head)
      throw new Error(
        'HEAD or worktree changed during review; review the current commit again.',
      )
    const sections = results.map((result) => {
      const output = result?.stdout ? withoutReminder(result.stdout) : ''
      if (!output.trim())
        throw new Error(
          `${result?.name ?? 'Reviewer'} review returned no final result.`,
        )
      return `## ${result.name === 'codex' ? 'Codex' : 'Claude'}\n\n${output}`
    })
    await log(`${sections.join('\n\n')}\n\n${reviewReminder}`)
    for (const result of results) {
      if (result.stderr) await timingLog(result.stderr)
    }
    if (readCleanHead() !== head)
      throw new Error(
        'HEAD or worktree changed before recording final review history.',
      )
    await recordRounds(head, {
      base: target.base,
      commitBase,
      profile: implementationReviewProfile,
      workarounds: Object.fromEntries(
        results.map((result) => [
          result.name,
          workaroundEvidence(withoutReminder(result.stdout).trim()),
        ]),
      ),
      blockers: Object.fromEntries(
        results.map((result) => [
          result.name,
          blockerCount(withoutReminder(result.stdout).trim()),
        ]),
      ),
      run,
    })
    return 0
  } catch (error) {
    operationError = normalizeOperationError(error)
    throw operationError
  } finally {
    if (snapshotDirectory)
      rmSync(snapshotDirectory, { recursive: true, force: true })
    try {
      await releaseActivityLock(releaseScope, operationError)
    } finally {
      await releaseActivityLock(releaseActivity, operationError)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })

export {
  appendTail,
  blockerCount,
  cleanHead,
  completedPairRounds,
  consultationDecision,
  coordinatedBase,
  createContextSnapshot,
  defaultBase,
  formatCapture,
  implementationReviewProfile,
  implementationRoundCap,
  lastCompletedPairHead,
  main,
  parseArgs,
  recordCompletedRounds,
  resolveBaseSha,
  roundCapResult,
  runReviewer,
  runRoundCapConsultation,
  usage,
  waitForBoth,
  withoutReminder,
  writeText,
}

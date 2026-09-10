#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { finalReviews } from './agent-role-settings.mjs'
import {
  launchCodexReview,
  parseArgs as parseCodexArgs,
  reviewReminder,
} from './codex-review.mjs'
import {
  launchClaudeReview,
  parseArgs as parseClaudeArgs,
} from './claude-review.mjs'
import {
  readRounds,
  recordRound,
  rangeIsEmpty,
  resolvePairReviewBase,
  roundsPath,
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

const defaultBase = 'origin/main'
const implementationReviewProfile = Object.freeze({
  ...finalReviews,
  method: 'controlled-review',
})
const maxCapturedBytes = 8 * 1024

function usage() {
  return 'Usage: pnpm review:implementation -- [--base <ref>] [--dispositions-file <path>]'
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
  for (const reviewer of ['codex', 'claude']) {
    const path = roundsPath(branch, reviewer, run)
    writeRounds(
      path,
      recordRound(readRounds(path), {
        head,
        reviewer,
        base: options.base,
        profile: options.profile ?? implementationReviewProfile,
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
  recordRounds = recordCompletedRounds,
  acquireLock = acquireActivityLock,
  acquireScopeLock = acquireTaskScopeLock,
  getBranch = currentTaskBranch,
  admitCandidate = admitTaskCandidate,
  signal,
  log = (value) => writeText(process.stdout, value),
  timingLog = (value) => writeText(process.stderr, value),
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
    const scopeState = admitCandidate(branch, head, run)
    const context = taskScopeContext(
      scopeState,
      readDispositionsBody(options.dispositionsFile),
    )
    snapshotDirectory = mkdtempSync(
      join(tmpdir(), `artifactshare-implementation-review-${process.pid}-`),
    )
    const snapshotPath = createContextSnapshot(context, snapshotDirectory)
    const target = coordinatedBase({ base: options.base, head, run })
    if (target.noTarget)
      throw new Error(
        'No implementation review target exists for the resolved base and HEAD; the final gate is incomplete.',
      )
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
        { signal },
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
        { signal },
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
      profile: implementationReviewProfile,
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
  cleanHead,
  coordinatedBase,
  createContextSnapshot,
  defaultBase,
  formatCapture,
  implementationReviewProfile,
  main,
  parseArgs,
  recordCompletedRounds,
  resolveBaseSha,
  runReviewer,
  usage,
  waitForBoth,
  withoutReminder,
  writeText,
}

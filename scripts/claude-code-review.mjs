// The Claude side of the implementation gate runs Claude Code's own
// `/code-review` at a fixed level instead of the controlled finder/verifier
// pair. `/code-review` has no input for task context, and the read-only tool
// limit leaves it without Git, so the launcher hands both over the way Claude
// Code reads them: the change context goes into a temporary, Git-ignored
// `CLAUDE.local.md` at the repository root, and the fixed base/head trees and
// diff sit outside the reviewed tree in a directory added with `--add-dir`.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evidenceContext,
  prepareReviewEvidence,
  reviewTimeoutMs,
} from './controlled-review-runner.mjs'

// `/code-review` hands the review to a subagent, so Agent is the one tool
// beyond read access. Everything else is removed from the session or
// denied, and user settings, hooks, plugins, and MCP servers stay unloaded.
const codeReviewTools = Object.freeze(['Read', 'Grep', 'Glob', 'Agent'])
const deniedTools = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
])
const severities = Object.freeze(['blocker', 'follow_up', 'non_actionable'])
const localInstructionsFile = 'CLAUDE.local.md'
const cleanupSignals = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'])

const codeReviewContract = [
  '# Code review contract for this run',
  '',
  'This file is written by the implementation review gate for one `/code-review` run and removed afterwards.',
  'Review only the fixed change named below. Do not edit files, run commands, or start another review.',
  'A blocker is a finding that prevents what the issue sets out to do: it breaks a current acceptance criterion, correctness, or safety for a reachable input. Preferences, reuse, simplification, efficiency, and future generalization are never blockers.',
  'Report every finding as one entry of a single JSON array in a ```json code block, and nothing else in code blocks. Each entry has: "file", "line" (number), "severity" ("blocker", "follow_up", or "non_actionable"), "summary", "failure_scenario", and for a blocker "broken_acceptance_criterion". An empty array means no finding.',
  'End the reply with exactly one line: `REVIEW_STATUS: COMPLETE`, or `REVIEW_STATUS: INCOMPLETE: <reason>` when the evidence or context could not support a full review. An incomplete review is never a pass.',
].join('\n')

function codeReviewLocalInstructions({ context, evidence }) {
  return [
    codeReviewContract,
    '',
    evidenceContext(evidence),
    'Read the diff file for the exact change; do not infer the change from searches.',
    '',
    context.trim(),
    '',
  ].join('\n')
}

function codeReviewInvocation({
  model,
  level,
  base,
  head,
  sessionId,
  evidenceRoot,
}) {
  return [
    '-p',
    `/code-review ${level} ${base}...${head}`,
    '--model',
    model,
    '--effort',
    level,
    '--session-id',
    sessionId,
    '--output-format',
    'json',
    '--tools',
    codeReviewTools.join(','),
    '--allowedTools',
    codeReviewTools.join(','),
    '--disallowedTools',
    deniedTools.join(','),
    '--permission-mode',
    'dontAsk',
    // Project and local sources: local carries CLAUDE.local.md; user
    // settings, hooks, and plugins stay unloaded.
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--add-dir',
    evidenceRoot,
  ]
}

// A finding may quote a code fence, so a block ends at the first closing
// fence after which the text parses as JSON, starting from the last opener.
function lastJsonBlock(text) {
  const source = String(text ?? '')
  const openers = [...source.matchAll(/```json[ \t]*\n/gu)]
  if (!openers.length)
    throw new Error('Code review returned no JSON findings block.')
  let lastError
  for (const opener of openers.reverse()) {
    const start = opener.index + opener[0].length
    for (const close of source.slice(start).matchAll(/```/gu)) {
      try {
        return JSON.parse(source.slice(start, start + close.index))
      } catch (error) {
        lastError = error
      }
    }
  }
  throw new Error(
    `Code review findings are not valid JSON: ${lastError?.message ?? 'no closing fence'}`,
  )
}

function reviewStatus(text) {
  const last = String(text ?? '')
    .trimEnd()
    .split('\n')
    .at(-1)
    ?.replace(/`/gu, '')
    .trim()
  const match = /^REVIEW_STATUS: (COMPLETE|INCOMPLETE\b.*)$/u.exec(last ?? '')
  if (!match) throw new Error('Code review did not report REVIEW_STATUS.')
  if (match[1] !== 'COMPLETE')
    throw new Error(`Code review is incomplete: ${match[1]}`)
}

// Findings keep the reviewer's words; only the shape the gate relies on is
// checked, and an unknown severity is kept as a blocker so it is not lost.
function parseCodeReviewFindings(text) {
  reviewStatus(text)
  const parsed = lastJsonBlock(text)
  if (!Array.isArray(parsed))
    throw new Error('Code review findings must be a JSON array.')
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`Code review finding ${index + 1} is not an object.`)
    for (const field of ['file', 'summary'])
      if (typeof entry[field] !== 'string' || !entry[field].trim())
        throw new Error(`Code review finding ${index + 1} has no ${field}.`)
    const severity = severities.includes(entry.severity)
      ? entry.severity
      : 'blocker'
    return { id: `code-review-${index + 1}`, ...entry, severity }
  })
}

function codeReviewOutput({ findings, callId, level }) {
  const blockers = findings.filter(({ severity }) => severity === 'blocker')
  return JSON.stringify(
    {
      verdict: blockers.length ? 'FINDINGS' : 'GO',
      findings,
      review_details: {
        method: 'code-review',
        level,
        execution: { code_review_call_id: callId },
        adoption: 'Caller decides; no finding is adopted by this review.',
      },
    },
    null,
    2,
  )
}

async function runCodeReview({
  context,
  repository,
  base,
  head,
  invoke,
  now = Date.now,
  timeoutMs = reviewTimeoutMs,
  createCallId = randomUUID,
  prepareEvidence = prepareReviewEvidence,
  signals = process,
} = {}) {
  if (!context?.trim()) throw new Error('Code review context is empty.')
  const localPath = join(repository, localInstructionsFile)
  // An existing file is the owner's own; never overwrite or delete it.
  if (existsSync(localPath))
    throw new Error(
      `${localInstructionsFile} already exists at the repository root; move it aside before the implementation gate.`,
    )
  const deadline = now() + timeoutMs
  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-code-review-'))
  let written = false
  // An interrupted gate must not leave its instructions for later sessions.
  // The handler runs once and re-raises the signal when nothing else
  // handles it, so the default exit still happens.
  const handlers = new Map(
    cleanupSignals.map((name) => [
      name,
      () => {
        if (written) rmSync(localPath, { force: true })
        if (signals.listenerCount(name) === 0) signals.kill(signals.pid, name)
      },
    ]),
  )
  for (const [name, handler] of handlers) signals.once(name, handler)
  try {
    const evidence = prepareEvidence({ directory, repository, base, head })
    writeFileSync(
      localPath,
      codeReviewLocalInstructions({ context, evidence }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )
    written = true
    chmodSync(localPath, 0o400)
    const callId = createCallId()
    const text = await invoke({
      role: 'code-review',
      callId,
      evidenceRoot: join(directory, 'evidence'),
      timeoutMs: Math.max(1, deadline - now()),
    })
    return { findings: parseCodeReviewFindings(text), callId }
  } finally {
    for (const [name, handler] of handlers) signals.off(name, handler)
    if (written) rmSync(localPath, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
}

export {
  cleanupSignals,
  codeReviewContract,
  codeReviewInvocation,
  codeReviewLocalInstructions,
  codeReviewOutput,
  codeReviewTools,
  deniedTools,
  localInstructionsFile,
  parseCodeReviewFindings,
  reviewStatus,
  runCodeReview,
}

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const angles = Object.freeze([
  'line-scan',
  'removed-behavior',
  'cross-file',
  'reuse',
  'simplification',
  'efficiency',
  'altitude',
  'conventions',
])
const reviewTimeoutMs = 1_800_000
const skillScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.agents',
  'skills',
  'controlled-review',
  'scripts',
  'render_prompt.py',
)

function controlledReviewConditions({
  repository,
  model,
  effort,
  phase,
  base,
  head,
}) {
  return [
    '# Resolved execution conditions',
    '',
    `repository: ${repository}`,
    `phase: ${phase}`,
    `base: ${base ?? 'not applicable'}`,
    `head: ${head}`,
    'source access: fixed read-only base/head trees and diff named in the evidence section below',
    `model: ${model}`,
    `effort: ${effort}`,
    `angles: ${angles.join(', ')}`,
    'grouping: one finder covers all eight lenses because they inspect the same fixed target and surrounding code',
    'sessions: at most two fresh ordinary sessions (one finder, then one verifier when candidates exist); one concurrent session within this provider',
    'candidate limit: implementation 6; specification 5; prior-finding matches are reported separately',
    'retries: none',
    'total wall deadline: 30 minutes for finder and verifier combined',
    'allowed validation: read the supplied snapshot and diff files only; do not run Git, tests, or target code',
  ].join('\n')
}

function gitBuffer(repository, args, options = {}) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  })
}

function trackedEntries(repository, revision) {
  const output = gitBuffer(repository, [
    'ls-tree',
    '-rlz',
    '--full-tree',
    revision,
  ])
  const content = output.at(-1) === 0 ? output.subarray(0, -1) : output
  if (content.length === 0) return []
  return content
    .toString('utf8')
    .split('\0')
    .map((entry) => {
      const separator = entry.indexOf('\t')
      const [mode, type, oid] = entry.slice(0, separator).trim().split(/\s+/u)
      const path = entry.slice(separator + 1)
      if (
        separator < 0 ||
        type !== 'blob' ||
        !['100644', '100755'].includes(mode)
      )
        throw new Error(
          `Review snapshots support only regular tracked files: ${path || entry}`,
        )
      if (
        !path ||
        isAbsolute(path) ||
        path.split('/').some((part) => part === '..' || part === '')
      )
        throw new Error(`Unsafe tracked path in review snapshot: ${path}`)
      return { mode, oid, path }
    })
}

function readBlobs(repository, entries) {
  const oids = [...new Set(entries.map(({ oid }) => oid))]
  if (oids.length === 0) return new Map()
  const output = gitBuffer(repository, ['cat-file', '--batch'], {
    input: Buffer.from(`${oids.join('\n')}\n`),
  })
  const blobs = new Map()
  let offset = 0
  for (const requested of oids) {
    const lineEnd = output.indexOf(0x0a, offset)
    if (lineEnd < 0)
      throw new Error('Git blob batch returned a partial header.')
    const [oid, type, rawSize] = output
      .subarray(offset, lineEnd)
      .toString('utf8')
      .split(' ')
    const size = Number(rawSize)
    if (oid !== requested || type !== 'blob' || !Number.isSafeInteger(size))
      throw new Error(
        `Git blob batch returned an invalid entry for ${requested}.`,
      )
    const start = lineEnd + 1
    const end = start + size
    if (end >= output.length || output[end] !== 0x0a)
      throw new Error(`Git blob batch returned partial data for ${requested}.`)
    blobs.set(oid, output.subarray(start, end))
    offset = end + 1
  }
  if (offset !== output.length)
    throw new Error('Git blob batch returned unexpected trailing data.')
  return blobs
}

function writeTreeSnapshot(repository, revision, root) {
  const entries = trackedEntries(repository, revision)
  const blobs = readBlobs(repository, entries)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const fixedRoot = resolve(root)
  for (const entry of entries) {
    const path = resolve(root, entry.path)
    if (!path.startsWith(`${fixedRoot}${sep}`))
      throw new Error(`Unsafe tracked path in review snapshot: ${entry.path}`)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, blobs.get(entry.oid), { mode: 0o600 })
    chmodSync(path, entry.mode === '100755' ? 0o500 : 0o400)
  }
}

function prepareReviewEvidence({ directory, repository, base, head }) {
  const evidenceRoot = join(directory, 'evidence')
  const baseRoot = join(evidenceRoot, 'base')
  const headRoot = join(evidenceRoot, 'head')
  const diffPath = join(evidenceRoot, 'diff.patch')
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 })
  writeTreeSnapshot(repository, base, baseRoot)
  writeTreeSnapshot(repository, head, headRoot)
  writeFileSync(
    diffPath,
    gitBuffer(repository, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      base,
      head,
      '--',
    ]),
    { mode: 0o400 },
  )
  return { baseRoot, headRoot, diffPath }
}

function evidenceContext({ baseRoot, headRoot, diffPath }) {
  return [
    '# Fixed review evidence',
    '',
    `base tree: ${baseRoot}`,
    `head tree: ${headRoot}`,
    `base-to-head diff: ${diffPath}`,
    'These read-only snapshots contain the complete tracked trees at the fixed revisions. Read repository rules from the head tree. No Git command is required.',
  ].join('\n')
}

function parseJson(value, label) {
  try {
    return JSON.parse(
      value
        .trim()
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, ''),
    )
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${error.message}`)
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be a JSON object.`)
  return value
}

function validateFinder(raw, candidateLimit) {
  const result = assertObject(parseJson(raw, 'Finder'), 'Finder result')
  if (result.status !== 'COMPLETE')
    throw new Error(
      `Finder did not complete.${result.reason ? ` ${result.reason}` : ''}`,
    )
  if (!Array.isArray(result.candidates))
    throw new Error('Finder result must contain a candidates array.')
  if (!Array.isArray(result.existing_matches))
    throw new Error('Finder result must contain an existing_matches array.')
  if (result.candidates.length > candidateLimit)
    throw new Error(`Finder exceeded the ${candidateLimit}-candidate limit.`)
  const ids = result.candidates.map((candidate, index) => {
    assertObject(candidate, `Finder candidate ${index + 1}`)
    if (typeof candidate.id !== 'string' || !candidate.id.trim())
      throw new Error(`Finder candidate ${index + 1} needs a nonempty id.`)
    return candidate.id
  })
  if (new Set(ids).size !== ids.length)
    throw new Error('Finder candidate ids must be unique.')
  return result
}

function validateVerifier(
  raw,
  candidateIds,
  candidateLimit,
  existingMatches = [],
) {
  const result = assertObject(parseJson(raw, 'Verifier'), 'Verifier result')
  if (result.status !== 'COMPLETE')
    throw new Error(
      `Verifier did not complete.${result.reason ? ` ${result.reason}` : ''}`,
    )
  if (!Array.isArray(result.candidate_results))
    throw new Error('Verifier result must contain a candidate_results array.')
  const verifiedIds = result.candidate_results.map((item, index) => {
    assertObject(item, `Verifier result ${index + 1}`)
    if (!['CONFIRMED', 'PLAUSIBLE', 'REFUTED'].includes(item.technical_verdict))
      throw new Error(`Verifier result ${index + 1} has an invalid verdict.`)
    if (typeof item.candidate_id !== 'string' || !item.candidate_id)
      throw new Error(`Verifier result ${index + 1} needs a candidate_id.`)
    for (const field of [
      'evidence',
      'scope_applicability',
      'prior_disposition',
      'unknowns',
    ]) {
      if (typeof item[field] !== 'string' || !item[field].trim())
        throw new Error(
          `Verifier result ${index + 1} needs a nonempty ${field}.`,
        )
    }
    return item.candidate_id
  })
  if (
    verifiedIds.length !== candidateIds.length ||
    new Set(verifiedIds).size !== verifiedIds.length ||
    candidateIds.some((id) => !verifiedIds.includes(id))
  )
    throw new Error('Verifier must return exactly one result per candidate.')
  if (!Array.isArray(result.findings))
    throw new Error('Verifier result must contain a findings array.')
  if (
    !Array.isArray(result.existing_matches) ||
    !isDeepStrictEqual(result.existing_matches, existingMatches)
  )
    throw new Error('Verifier must preserve finder existing_matches exactly.')
  if (result.findings.length > candidateLimit)
    throw new Error(`Verifier exceeded the ${candidateLimit}-finding limit.`)
  const findingIds = result.findings.map((finding, index) => {
    assertObject(finding, `Verifier finding ${index + 1}`)
    if (!['blocker', 'follow_up', 'non_actionable'].includes(finding.severity))
      throw new Error(`Verifier finding ${index + 1} has invalid severity.`)
    if (typeof finding.id !== 'string' || !candidateIds.includes(finding.id))
      throw new Error(
        `Verifier finding ${index + 1} must reference a finder candidate id.`,
      )
    if (
      result.candidate_results.find(
        ({ candidate_id }) => candidate_id === finding.id,
      )?.technical_verdict === 'REFUTED'
    )
      throw new Error(
        `Verifier finding ${index + 1} references a refuted candidate.`,
      )
    return finding.id
  })
  if (new Set(findingIds).size !== findingIds.length)
    throw new Error('Verifier finding ids must be unique.')
  const hasBlocker = result.findings.some(
    ({ severity }) => severity === 'blocker',
  )
  if (
    !['GO', 'FINDINGS'].includes(result.verdict) ||
    result.verdict !== (hasBlocker ? 'FINDINGS' : 'GO')
  )
    throw new Error('Verifier verdict is inconsistent with its findings.')
  return result
}

function finderContract(candidateLimit) {
  return [
    '# Machine-readable result contract',
    'This contract replaces any earlier request in the supplied review material about the final response format.',
    'Return only one JSON object: {"status":"COMPLETE","candidates":[...],"existing_matches":[...]}.',
    `Inspect all eight assigned angles. Return at most ${candidateLimit} new candidates; fewer is correct when evidence does not support more. existing_matches are separate and must not be omitted to fit the candidate limit.`,
    'Each candidate needs a unique id and the fields requested above. Keep prior-finding matches out of candidates and put them in existing_matches.',
    'Use {"status":"INCOMPLETE","reason":"...","candidates":[],"existing_matches":[]} when any assigned angle or required target cannot be inspected.',
  ].join('\n\n')
}

function verifierContract(candidateLimit) {
  return [
    '# Machine-readable result contract',
    'This contract replaces any earlier request in the supplied review material about the final response format.',
    'Return only one JSON object with status, verdict, candidate_results, findings, and existing_matches.',
    'candidate_results must contain exactly one entry for every supplied candidate: {"candidate_id":"...","technical_verdict":"CONFIRMED|PLAUSIBLE|REFUTED","evidence":"...","scope_applicability":"...","prior_disposition":"...","unknowns":"..."}. Keep REFUTED results.',
    `findings contains only confirmed or plausible current-scope results and has at most ${candidateLimit} entries. Each finding id must equal its candidate_id and severity must be blocker, follow_up, or non_actionable. A blocker also needs broken_acceptance_criterion or new_evidence, plus minimal_fix.`,
    'verdict is FINDINGS exactly when findings contains a blocker; otherwise it is GO. This is evidence for the caller, not adoption or permission to edit.',
    'Copy the finder existing_matches array without changing it. Use status INCOMPLETE with a reason when exact verification cannot be completed.',
  ].join('\n\n')
}

function renderPrompt({
  contextPath,
  candidatePath,
  role,
  run = execFileSync,
}) {
  const args = [skillScript, '--context', contextPath, '--role', role]
  if (role === 'finder') for (const angle of angles) args.push('--angle', angle)
  else args.push('--candidate', candidatePath)
  return run('python3', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function runControlledReview({
  context,
  phase,
  invoke,
  now = Date.now,
  render = renderPrompt,
  timeoutMs = reviewTimeoutMs,
  createCallId = randomUUID,
  repository,
  base,
  head,
  prepareEvidence = prepareReviewEvidence,
} = {}) {
  if (!context?.trim()) throw new Error('Controlled review context is empty.')
  if (!['implementation', 'spec'].includes(phase))
    throw new Error('Controlled review phase is invalid.')
  const candidateLimit = phase === 'spec' ? 5 : 6
  const deadline = now() + timeoutMs
  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-review-'))
  try {
    const evidence = repository
      ? prepareEvidence({
          directory,
          repository,
          base: base ?? head,
          head,
        })
      : undefined
    const contextPath = join(directory, 'context.md')
    writeFileSync(
      contextPath,
      `${context}${evidence ? `\n\n${evidenceContext(evidence)}` : ''}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    chmodSync(contextPath, 0o600)
    const finderPrompt = `${render({ contextPath, role: 'finder' })}\n\n${finderContract(candidateLimit)}\n`
    const finderInvocationId = createCallId()
    const finderRaw = await invoke(finderPrompt, {
      role: 'finder',
      callId: finderInvocationId,
      timeoutMs: Math.max(1, deadline - now()),
    })
    const localFinder = validateFinder(finderRaw, candidateLimit)
    const finder = {
      ...localFinder,
      invocation_id: finderInvocationId,
      candidates: localFinder.candidates.map((candidate) => ({
        ...candidate,
        id: `${finderInvocationId}:${candidate.id}`,
        aliases: [[finderInvocationId, candidate.id]],
      })),
    }
    if (finder.candidates.length === 0)
      return {
        finder,
        verifier: {
          status: 'COMPLETE',
          verdict: 'GO',
          candidate_results: [],
          findings: [],
          existing_matches: finder.existing_matches,
        },
      }
    if (deadline <= now()) throw new Error('Controlled review timed out.')
    const candidatePath = join(directory, 'candidates.json')
    writeFileSync(candidatePath, `${JSON.stringify(finder, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(candidatePath, 0o600)
    const verifierPrompt = `${render({
      contextPath,
      candidatePath,
      role: 'verifier',
    })}\n\n${verifierContract(candidateLimit)}\n`
    const verifierInvocationId = createCallId()
    const verifierRaw = await invoke(verifierPrompt, {
      role: 'verifier',
      callId: verifierInvocationId,
      timeoutMs: Math.max(1, deadline - now()),
    })
    return {
      finder,
      verifier: {
        ...validateVerifier(
          verifierRaw,
          finder.candidates.map(({ id }) => id),
          candidateLimit,
          finder.existing_matches,
        ),
        invocation_id: verifierInvocationId,
      },
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function controlledReviewOutput({ finder, verifier }) {
  return JSON.stringify(
    {
      verdict: verifier.verdict,
      findings: verifier.findings,
      review_details: {
        finder_report: finder,
        candidate_results: verifier.candidate_results,
        existing_matches: verifier.existing_matches,
        execution: {
          finder_call_id: finder.invocation_id,
          verifier_call_id: verifier.invocation_id ?? null,
        },
        adoption: 'Caller decides; no finding is adopted by this review.',
      },
    },
    null,
    2,
  )
}

export {
  angles,
  controlledReviewConditions,
  controlledReviewOutput,
  evidenceContext,
  finderContract,
  parseJson,
  prepareReviewEvidence,
  renderPrompt,
  reviewTimeoutMs,
  runControlledReview,
  skillScript,
  validateFinder,
  validateVerifier,
  verifierContract,
  writeTreeSnapshot,
}

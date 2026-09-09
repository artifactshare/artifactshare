#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acquireActivityLock,
  normalizeOperationError,
} from './worktree-activity-lock.mjs'
import {
  acquireFileLock as acquireSpecLock,
  lockInvocation,
} from './os-file-lock.mjs'
import {
  launchCodexReview,
  parseArgs as parseCodexArgs,
} from './codex-review.mjs'
import {
  launchClaudeReview,
  parseArgs as parseClaudeArgs,
} from './claude-review.mjs'
import { specificationDrafting } from './agent-role-settings.mjs'
import {
  assertBaselineMetrics,
  assertDispositionBundle,
  assertReviewAllowed,
  cliPackage,
  createSpecReviewSnapshot,
  readSpecReviewInput,
  reviewStateMarker as marker,
  reviewStateMarkers,
} from './spec-review-input.mjs'

const recordMarker = '<!-- artifactshare-spec-review-record:v1 -->'
const localStateSchemaVersion = 1
const specReviewProfile = specificationDrafting

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--reset') {
      options.reset = true
      continue
    }
    const value = args[++index]
    if (
      !['--artifact-url', '--version-id', '--dispositions-file'].includes(
        name,
      ) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Usage: pnpm review:spec -- --artifact-url <url> --version-id <id> [--dispositions-file <path>]',
      )
    options[name.slice(2).replaceAll('-', '_')] = value
  }
  if (!options.artifact_url || !options.version_id)
    throw new Error('Spec review requires artifact URL and version id.')
  return options
}

function commandOutput(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function reviewInputFingerprint(input, versionId) {
  return createSpecReviewSnapshot(input, versionId).input_fingerprint
}

function assertSameProjectPlacement(expected, actual) {
  if (expected !== actual)
    throw new Error(
      'Specification placement changed during review; rerun the coordinator.',
    )
}

function compactFindings(findings = []) {
  const counts = new Map()
  return findings.map(({ id, reviewer, severity }) => {
    const owner = reviewer ?? /^(codex|claude):/u.exec(id)?.[1] ?? 'reviewer'
    const number = (counts.get(owner) ?? 0) + 1
    counts.set(owner, number)
    return { id: `${owner}:${number}`, reviewer: owner, severity }
  })
}

function findingIdsDigest(findings = []) {
  return createHash('sha256')
    .update(JSON.stringify(findings.map(({ id }) => id).sort()))
    .digest('hex')
}

function findCompletedVersion(state, versionId, inputFingerprint) {
  const latest = state?.latest
  return sameProfile(state?.profile, specReviewProfile) &&
    latest?.evidence_invalidated !== true &&
    latest?.version_id === versionId &&
    latest.input_fingerprint === inputFingerprint &&
    Array.isArray(latest.findings)
    ? latest
    : undefined
}

function sameProfile(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function stateForProfile(state, profile = specReviewProfile) {
  if (sameProfile(state?.profile, profile)) return state
  return {
    ...state,
    profile,
    // Previous evidence was produced under a different or unknown final
    // profile. Preserve the generation's bounded round count, baseline, and
    // latest finding obligations, but mark the latest evidence as invalid so
    // it cannot satisfy the new gate.
    latest: state?.latest
      ? { ...state.latest, evidence_invalidated: true }
      : null,
  }
}

function boundedLocalState(state) {
  const reviews = Array.isArray(state?.reviews) ? state.reviews : []
  const recordedRounds = reviews.reduce(
    (maximum, review) =>
      Number.isSafeInteger(review?.round)
        ? Math.max(maximum, review.round)
        : maximum,
    reviews.length,
  )
  const roundCount = Number.isSafeInteger(state?.round_count)
    ? Math.max(state.round_count, recordedRounds)
    : recordedRounds
  if (state?.round_count === roundCount && reviews.length <= 3) return state
  return {
    ...state,
    round_count: roundCount,
    reviews: reviews.slice(-3),
  }
}

function stateFromComments(
  comments,
  trustedEmail,
  { allowDivergence = false } = {},
) {
  const candidates = []
  let hasForeignState = false
  for (const thread of comments) {
    for (const message of thread.messages ?? []) {
      if (typeof message.body !== 'string') continue
      const matchedMarker = reviewStateMarkers.find((value) =>
        message.body.startsWith(value),
      )
      if (!matchedMarker) continue
      if (message.author_email !== trustedEmail) {
        hasForeignState = true
        continue
      }
      const value = JSON.parse(message.body.slice(matchedMarker.length).trim())
      const legacy = matchedMarker !== marker
      candidates.push({
        generation: value.generation ?? 0,
        revision: value.revision ?? 0,
        ...(legacy ? { state: value } : { pointer: value }),
      })
    }
  }
  if (!candidates.length) {
    if (hasForeignState)
      throw new Error(
        'Artifact Share review state belongs to another identity; use the original profile.',
      )
    return undefined
  }
  candidates.sort(
    (left, right) =>
      right.generation - left.generation || right.revision - left.revision,
  )
  const current = candidates[0]
  const peers = candidates.filter(
    ({ generation, revision }) =>
      generation === current.generation && revision === current.revision,
  )
  if (
    !allowDivergence &&
    new Set(peers.map(({ state, pointer }) => JSON.stringify(state ?? pointer)))
      .size > 1
  )
    throw new Error('Artifact Share review state has divergent histories.')
  return current
}

function stateDigest(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

function stateFromRecord(pointer, run = commandOutput, expectedProjectId) {
  let content = ''
  let offset
  for (;;) {
    const args = [
      'exec',
      '--yes',
      `--package=${cliPackage}`,
      '--',
      'artifactshare',
      'artifacts',
      'get',
      pointer.record_url,
    ]
    if (offset !== undefined) args.push('--offset', String(offset))
    args.push('--json')
    const output = JSON.parse(run('npm', args))
    const data = output?.data
    if (
      output?.ok !== true ||
      data?.version_id !== pointer.record_version_id ||
      typeof data?.content !== 'string' ||
      typeof data?.truncated !== 'boolean' ||
      (expectedProjectId !== undefined &&
        (data.project_id ?? null) !== expectedProjectId)
    )
      throw new Error('Artifact Share review record is unavailable or stale.')
    content += data.content
    if (!data.truncated) {
      if (data.next_offset !== null)
        throw new Error('Artifact Share review record pagination is invalid.')
      break
    }
    if (
      !Number.isSafeInteger(data.next_offset) ||
      data.next_offset <= (offset ?? 0)
    )
      throw new Error('Artifact Share review record pagination is invalid.')
    offset = data.next_offset
  }
  if (!content.startsWith(recordMarker))
    throw new Error('Artifact Share review record is unavailable or stale.')
  const state = JSON.parse(content.slice(recordMarker.length).trim())
  if (
    stateDigest(state) !== pointer.state_sha256 ||
    (state.generation ?? 0) !== pointer.generation ||
    (state.revision ?? 0) !== pointer.revision
  )
    throw new Error('Artifact Share review record failed integrity checks.')
  return state
}

function localStateFromLegacy(state, fallbackMetrics) {
  const versions = Array.isArray(state?.versions) ? state.versions : []
  const latest = [...versions]
    .reverse()
    .find(({ findings }) => Array.isArray(findings))
  // Legacy records predate the executable model/effort profile. Keep only the
  // bounded round and finding metadata needed for lifetime accounting;
  // stateForProfile marks it as ineligible for the current evidence cache.
  const baselineMetrics = state?.baseline_metrics ?? fallbackMetrics
  assertBaselineMetrics(baselineMetrics)
  return {
    schema_version: localStateSchemaVersion,
    generation: state?.generation ?? 0,
    revision: state?.revision ?? 0,
    baseline_metrics: baselineMetrics,
    profile: null,
    round_count: versions.reduce(
      (maximum, { round }, index) =>
        Math.max(maximum, Number.isSafeInteger(round) ? round : index + 1),
      versions.length,
    ),
    reviews: versions
      .slice(-3)
      .map(({ version_id, input_fingerprint, round }, index) => ({
        version_id,
        input_fingerprint,
        round: round ?? Math.max(1, versions.length - 2) + index,
      })),
    latest: latest
      ? {
          version_id: latest.version_id,
          input_fingerprint: latest.input_fingerprint,
          round: latest.round ?? versions.indexOf(latest) + 1,
          findings: compactFindings(latest.findings),
          legacy_finding_ids_sha256: findingIdsDigest(latest.findings),
        }
      : null,
  }
}

function newLocalState(metrics, generation = 0, profile = specReviewProfile) {
  return {
    schema_version: localStateSchemaVersion,
    generation,
    revision: 0,
    baseline_metrics: metrics,
    profile,
    round_count: 0,
    reviews: [],
    latest: null,
  }
}

function canonicalArtifactIdentity(input) {
  const trimmed = input.trim()
  if (/^[A-Za-z0-9]+$/u.test(trimmed)) return trimmed
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Artifact URL does not contain a canonical artifact id.')
  }
  const sandboxMatch = url.hostname.match(/^([A-Za-z0-9]+)\.sandbox\./u)
  if (sandboxMatch?.[1]) return sandboxMatch[1]
  const shareMatch = url.pathname.match(/^\/a\/([A-Za-z0-9]+)(?:\.data)?\/?$/u)
  if (shareMatch?.[1]) return shareMatch[1]
  throw new Error('Artifact URL does not contain a canonical artifact id.')
}

function localStatePaths(artifactUrl, run = commandOutput) {
  const root = join(
    resolve(run('git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'spec-review',
  )
  const key = createHash('sha256')
    .update(canonicalArtifactIdentity(artifactUrl))
    .digest('hex')
  return {
    root,
    statePath: join(root, `${key}.json`),
    lockPath: join(root, `${key}.lock`),
  }
}

function assertLocalState(state) {
  if (
    state?.schema_version !== localStateSchemaVersion ||
    !Number.isInteger(state.generation) ||
    !Number.isInteger(state.revision) ||
    (state.round_count !== undefined &&
      (!Number.isSafeInteger(state.round_count) || state.round_count < 0)) ||
    !state.baseline_metrics ||
    (state.profile !== null &&
      state.profile !== undefined &&
      (typeof state.profile !== 'object' || Array.isArray(state.profile))) ||
    !Array.isArray(state.reviews) ||
    (state.latest !== null && !Array.isArray(state.latest?.findings))
  )
    throw new Error('Local spec review state is invalid.')
  try {
    assertBaselineMetrics(state.baseline_metrics)
  } catch {
    throw new Error(
      'Local spec review state is invalid: baseline_metrics require finite nonnegative values.',
    )
  }
  return state
}

function readLocalState(path, { allowInvalid = false } = {}) {
  try {
    return assertLocalState(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    if (
      allowInvalid &&
      (error instanceof SyntaxError ||
        error?.message?.startsWith('Local spec review state is invalid'))
    )
      return undefined
    throw error
  }
}

function writeLocalStateAtomic(path, state) {
  assertLocalState(state)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function hasLegacyState(comments) {
  return comments.some((thread) =>
    thread.messages?.some(
      ({ body }) =>
        typeof body === 'string' &&
        reviewStateMarkers.some((value) => body.startsWith(value)),
    ),
  )
}

function migrateLegacyState(
  input,
  run = commandOutput,
  { allowDivergence = false, reset = false, versionId } = {},
) {
  if (!hasLegacyState(input.allComments ?? [])) return undefined
  const identity = JSON.parse(
    run('npm', [
      'exec',
      '--yes',
      `--package=${cliPackage}`,
      '--',
      'artifactshare',
      'whoami',
      '--json',
    ]),
  )
  const trustedEmail = identity?.data?.user?.email
  if (typeof trustedEmail !== 'string' || !trustedEmail)
    throw new Error('Artifact Share identity email is unavailable.')
  const candidate = stateFromComments(input.allComments, trustedEmail, {
    allowDivergence,
  })
  if (!candidate) return undefined
  if (reset) return newLocalState(input.metrics, candidate.generation)
  const remote =
    candidate.state ?? stateFromRecord(candidate.pointer, run, input.projectId)
  const local = localStateFromLegacy(remote, input.metrics)
  if (versionId && local.latest?.version_id === versionId) {
    const legacyFingerprint = createHash('sha256')
      .update(JSON.stringify(input.comments))
      .digest('hex')
    if (local.latest.input_fingerprint !== legacyFingerprint) return local
    const fingerprint = reviewInputFingerprint(input, versionId)
    local.latest.input_fingerprint = fingerprint
    const review = local.reviews.findLast(
      ({ version_id, input_fingerprint }) =>
        version_id === versionId && input_fingerprint === legacyFingerprint,
    )
    if (review) review.input_fingerprint = fingerprint
  }
  return local
}

async function runReviewer(name, args, capability, options = {}) {
  if (!['codex', 'claude'].includes(name))
    throw new Error(`Unknown reviewer: ${name}`)
  const launch =
    name === 'codex'
      ? (options.launchCodex ?? launchCodexReview)
      : (options.launchClaude ?? launchClaudeReview)
  const parse = name === 'codex' ? parseCodexArgs : parseClaudeArgs
  const result = await launch(parse(args), capability, options)
  if (result.code !== 0)
    throw new Error(`${name} review failed.\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

function dispositionRequirements(priorFindings, baselineMetrics) {
  return JSON.stringify({
    baseline_metrics: baselineMetrics,
    prior_findings: priorFindings.map(({ id, reviewer, severity }) => ({
      id,
      reviewer,
      severity,
    })),
    dispositions: priorFindings.map(({ id }) => ({
      id,
      disposition: 'one of: fixed, follow_up, non_actionable, rewrite',
      repeated: false,
      contradiction: false,
    })),
  })
}

function validateDispositions(
  bundle,
  priorFindings,
  legacyFindingIdsDigest,
  baselineMetrics,
  metrics = baselineMetrics,
  reviewRound = 2,
) {
  const requirements = dispositionRequirements(priorFindings, baselineMetrics)
  if (bundle === undefined)
    throw new Error(
      `Correction review requires dispositions for both prior reviewer results. Required input: ${requirements}`,
    )
  try {
    assertDispositionBundle(bundle)
  } catch (error) {
    throw new Error(`${error.message} Required input: ${requirements}`)
  }
  const expected = priorFindings.map(({ id }) => id).sort()
  const actual = bundle.prior_findings.map(({ id }) => id).sort()
  const suppliedLegacyDigest = findingIdsDigest(bundle.prior_findings)
  const matchesLegacyIds =
    typeof legacyFindingIdsDigest === 'string' &&
    suppliedLegacyDigest === legacyFindingIdsDigest
  if (JSON.stringify(actual) !== JSON.stringify(expected) && !matchesLegacyIds)
    throw new Error(
      `Dispositions must include every prior Codex and Claude finding. Required input: ${requirements}`,
    )
  try {
    assertReviewAllowed({
      metrics,
      reviewRound,
      baselineMetrics,
      dispositions: bundle,
    })
  } catch (error) {
    if (error.message.startsWith('CIRCUIT_BREAKER:')) throw error
    throw new Error(`${error.message} Required input: ${requirements}`)
  }
  return bundle
}

async function waitForBoth(reviews) {
  const settled = await Promise.allSettled(reviews)
  const failures = settled.filter(({ status }) => status === 'rejected')
  if (failures.length)
    throw new Error(
      failures
        .map(({ reason }) => reason?.message ?? String(reason))
        .join('\n'),
    )
  return settled.map(({ value }) => value)
}

function assertUnchangedInput(initial, latest, versionId) {
  assertSameProjectPlacement(initial.projectId, latest.projectId)
  if (
    reviewInputFingerprint(initial, versionId) !==
    reviewInputFingerprint(latest, versionId)
  )
    throw new Error(
      'Specification or unresolved comments changed during review; rerun the coordinator.',
    )
}

async function main({
  argv = process.argv.slice(2),
  run = commandOutput,
  review = runReviewer,
  log = console.log,
  acquireActivity = acquireActivityLock,
  signal,
} = {}) {
  const options = parseArgs(argv)
  canonicalArtifactIdentity(options.artifact_url)
  let releaseActivity = async () => {}
  let releaseLock = async () => {}
  let operationError
  try {
    releaseActivity = await acquireActivity('spec review gate')
    const paths = localStatePaths(options.artifact_url, run)
    releaseLock = await acquireSpecLock(paths.lockPath)
    let snapshotDirectory
    try {
      const input = readSpecReviewInput({
        artifactUrl: options.artifact_url,
        versionId: options.version_id,
        run,
      })
      const inputFingerprint = reviewInputFingerprint(input, options.version_id)
      let state = readLocalState(paths.statePath, {
        allowInvalid: options.reset === true,
      })
      let migratedState = false
      if (!state) {
        const migrated = migrateLegacyState(input, run, {
          allowDivergence: options.reset === true,
          reset: options.reset === true,
          versionId: options.version_id,
        })
        migratedState = migrated !== undefined
        state = migrated ?? newLocalState(input.metrics)
      }
      const boundedState = boundedLocalState(state)
      const stateCompacted = boundedState !== state
      const profiledState = stateForProfile(boundedState)
      const profileChanged = profiledState !== boundedState
      state = profiledState
      if (options.reset) {
        const latestInput = readSpecReviewInput({
          artifactUrl: options.artifact_url,
          versionId: options.version_id,
          run,
        })
        assertUnchangedInput(input, latestInput, options.version_id)
        log('Local spec review state reset after owner-approved rewrite.')
        writeLocalStateAtomic(
          paths.statePath,
          newLocalState(input.metrics, state.generation + 1),
        )
        return 0
      }
      const existing = findCompletedVersion(
        state,
        options.version_id,
        inputFingerprint,
      )
      if (existing) {
        if (stateCompacted) writeLocalStateAtomic(paths.statePath, state)
        log(
          JSON.stringify(
            {
              scope_lock: input.scopeLock,
              baseline_metrics: state.baseline_metrics,
              ...existing,
              verdict:
                existing.verdict ??
                (existing.findings.some(
                  ({ severity }) => severity === 'blocker',
                )
                  ? 'FINDINGS'
                  : 'GO'),
            },
            null,
            2,
          ),
        )
        return 0
      }
      const round = state.round_count + 1
      // Three rounds is the review bound. The cap is an incomplete gate: it
      // cannot turn an unreviewed version or a real blocker into an automatic
      // deferral.
      if (round > 3) {
        log(
          JSON.stringify(
            {
              verdict: 'ROUND_CAP',
              target_unreviewed: true,
              rounds: state.round_count,
              scope_lock: input.scopeLock,
              baseline_metrics: state.baseline_metrics,
              unresolved_finding_ids: state.latest?.findings ?? [],
              evidence_invalidated: state.latest?.evidence_invalidated === true,
              note: `The review-round cap of 3 is spent (${state.round_count} completed rounds). Rewrite the specification from the original scope lock and acceptance criteria before reviewing another version; do not defer a blocker because of the cap.`,
            },
            null,
            2,
          ),
        )
        if (migratedState || stateCompacted || profileChanged)
          writeLocalStateAtomic(paths.statePath, state)
        return 2
      }
      const prior = state.latest?.findings ?? []
      const dispositionsSupplied = Object.hasOwn(options, 'dispositions_file')
      const dispositions = dispositionsSupplied
        ? JSON.parse(readFileSync(options.dispositions_file, 'utf8'))
        : undefined
      const validatedDispositions =
        round > 1 || dispositionsSupplied
          ? validateDispositions(
              dispositions,
              prior,
              state.latest?.legacy_finding_ids_sha256,
              state.baseline_metrics,
              input.metrics,
              round,
            )
          : undefined

      snapshotDirectory = join(
        tmpdir(),
        `artifactshare-spec-review-${process.pid}-${randomUUID()}`,
      )
      mkdirSync(snapshotDirectory, { mode: 0o700 })
      const snapshotPath = join(snapshotDirectory, 'snapshot.json')
      writeFileSync(
        snapshotPath,
        `${JSON.stringify(createSpecReviewSnapshot(input, options.version_id))}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      let dispositionsPath
      if (validatedDispositions) {
        dispositionsPath = join(snapshotDirectory, 'dispositions.json')
        writeFileSync(
          dispositionsPath,
          `${JSON.stringify(validatedDispositions)}\n`,
          {
            encoding: 'utf8',
            mode: 0o600,
          },
        )
      }
      const common = [
        '--phase',
        'spec',
        '--artifact-url',
        options.artifact_url,
        '--version-id',
        options.version_id,
        '--snapshot-file',
        snapshotPath,
        '--review-round',
        String(round),
        '--baseline-size',
        String(state.baseline_metrics.size),
        '--baseline-concepts',
        String(state.baseline_metrics.conceptCount),
      ]
      if (dispositionsPath) common.push('--dispositions-file', dispositionsPath)
      const [codexRaw, claudeRaw] = await waitForBoth([
        review(
          'codex',
          [
            ...common,
            '--model',
            specReviewProfile.codex.model,
            '--effort',
            specReviewProfile.codex.effort,
          ],
          releaseActivity,
          { signal },
        ),
        review(
          'claude',
          [
            ...common,
            '--model',
            specReviewProfile.claude.model,
            '--effort',
            specReviewProfile.claude.effort,
          ],
          releaseActivity,
          { signal },
        ),
      ])
      const results = {
        codex: JSON.parse(codexRaw),
        claude: JSON.parse(claudeRaw),
      }
      const findings = Object.entries(results).flatMap(([reviewer, result]) =>
        result.findings.map((finding, index) => ({
          ...finding,
          id: `${reviewer}:${index + 1}`,
          reviewer,
        })),
      )
      const latestInput = readSpecReviewInput({
        artifactUrl: options.artifact_url,
        versionId: options.version_id,
        run,
      })
      assertUnchangedInput(input, latestInput, options.version_id)

      const version = {
        version_id: options.version_id,
        input_fingerprint: inputFingerprint,
        round,
        verdict: findings.some(({ severity }) => severity === 'blocker')
          ? 'FINDINGS'
          : 'GO',
        findings,
      }
      const nextState = {
        ...state,
        revision: state.revision + 1,
        round_count: round,
        reviews: [
          ...state.reviews,
          {
            version_id: options.version_id,
            input_fingerprint: inputFingerprint,
            round,
          },
        ].slice(-3),
        latest: {
          ...version,
          findings: compactFindings(findings),
        },
      }
      writeLocalStateAtomic(paths.statePath, nextState)
      log(
        JSON.stringify(
          {
            scope_lock: input.scopeLock,
            baseline_metrics: state.baseline_metrics,
            ...version,
          },
          null,
          2,
        ),
      )
      return 0
    } finally {
      if (snapshotDirectory)
        rmSync(snapshotDirectory, { recursive: true, force: true })
    }
  } catch (error) {
    operationError = normalizeOperationError(error)
    throw operationError
  } finally {
    const releaseErrors = []
    for (const [label, release] of [
      ['spec lock', releaseLock],
      ['activity lock', releaseActivity],
    ]) {
      try {
        await release()
      } catch (error) {
        releaseErrors.push(
          `${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (releaseErrors.length) {
      const diagnostic = `Additionally, lock release failed: ${releaseErrors.join('; ')}`
      if (operationError) operationError.message += `\n${diagnostic}`
      // oxlint-disable-next-line no-unsafe-finally -- a release-only failure must fail an otherwise successful gate
      else throw new Error(diagnostic)
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
  acquireSpecLock,
  assertSameProjectPlacement,
  assertUnchangedInput,
  boundedLocalState,
  canonicalArtifactIdentity,
  compactFindings,
  findCompletedVersion,
  findingIdsDigest,
  localStateFromLegacy,
  localStatePaths,
  lockInvocation,
  main,
  marker,
  migrateLegacyState,
  newLocalState,
  parseArgs,
  readLocalState,
  recordMarker,
  reviewInputFingerprint,
  runReviewer,
  stateDigest,
  stateFromComments,
  stateFromRecord,
  validateDispositions,
  waitForBoth,
  writeLocalStateAtomic,
}

#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
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
  cliPackage,
  createSpecReviewSnapshot,
  readSpecReviewInput,
  reviewStateMarker as marker,
  reviewStateMarkers,
} from './spec-review-input.mjs'

const recordMarker = '<!-- artifactshare-spec-review-record:v1 -->'
const localStateSchemaVersion = 1

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
  return latest?.version_id === versionId &&
    latest.input_fingerprint === inputFingerprint &&
    Array.isArray(latest.findings)
    ? latest
    : undefined
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
  return {
    schema_version: localStateSchemaVersion,
    generation: state?.generation ?? 0,
    revision: state?.revision ?? 0,
    baseline_metrics: state?.baseline_metrics ?? fallbackMetrics,
    reviews: versions.map(
      ({ version_id, input_fingerprint, round }, index) => ({
        version_id,
        input_fingerprint,
        round: round ?? index + 1,
      }),
    ),
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

function newLocalState(metrics, generation = 0) {
  return {
    schema_version: localStateSchemaVersion,
    generation,
    revision: 0,
    baseline_metrics: metrics,
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
    !state.baseline_metrics ||
    !Array.isArray(state.reviews) ||
    (state.latest !== null && !Array.isArray(state.latest?.findings))
  )
    throw new Error('Local spec review state is invalid.')
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
        error?.message === 'Local spec review state is invalid.')
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

function lockInvocation(lockPath, platform = process.platform) {
  const holderSource = `
const coordinatorPid = Number(process.argv[1])
setInterval(() => {
  try {
    process.kill(coordinatorPid, 0)
  } catch {
    process.exit(0)
  }
}, 250)
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`
  const holder = [
    process.execPath,
    '-e',
    `process.stdout.write('locked\\n'); ${holderSource}`,
    String(process.pid),
  ]
  if (platform === 'darwin')
    return { file: 'lockf', args: ['-s', '-t', '0', '-k', lockPath, ...holder] }
  if (platform === 'linux')
    return { file: 'flock', args: ['-n', lockPath, ...holder] }
  throw new Error(
    'Spec review locking requires lockf on macOS or flock on Linux.',
  )
}

function acquireSpecLock(
  lockPath,
  { spawnProcess = spawn, platform = process.platform } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const invocation = lockInvocation(lockPath, platform)
  return new Promise((resolveLock, reject) => {
    const child = spawnProcess(invocation.file, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('Timed out while acquiring the local spec review lock.'))
    }, 5_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (settled || !stdout.includes('locked\n')) return
      settled = true
      clearTimeout(timeout)
      resolveLock(
        () =>
          new Promise((resolveRelease) => {
            if (child.exitCode !== null) {
              resolveRelease()
              return
            }
            child.once('close', resolveRelease)
            child.stdin.end()
          }),
      )
    })
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(
        new Error(
          stderr.trim() ||
            'A spec review coordinator already holds the local lock.',
        ),
      )
    })
  })
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

function runReviewer(name, args, { spawnProcess = spawn } = {}) {
  return new Promise((resolveReview, reject) => {
    const child = spawnProcess('pnpm', [`review:${name}`, '--', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolveReview(stdout.trim())
        : reject(new Error(`${name} review failed.\n${stderr || stdout}`)),
    )
  })
}

function validateDispositions(bundle, priorFindings, legacyFindingIdsDigest) {
  if (!bundle)
    throw new Error(
      'Correction review requires dispositions for both prior reviewer results.',
    )
  const expected = priorFindings.map(({ id }) => id).sort()
  const hasPriorFindings = Array.isArray(bundle.prior_findings)
  const actual = hasPriorFindings
    ? bundle.prior_findings.map(({ id }) => id).sort()
    : undefined
  const suppliedLegacyDigest = hasPriorFindings
    ? findingIdsDigest(bundle.prior_findings)
    : undefined
  const matchesLegacyIds =
    typeof legacyFindingIdsDigest === 'string' &&
    suppliedLegacyDigest === legacyFindingIdsDigest
  if (JSON.stringify(actual) !== JSON.stringify(expected) && !matchesLegacyIds)
    throw new Error(
      'Dispositions must include every prior Codex and Claude finding.',
    )
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
} = {}) {
  const options = parseArgs(argv)
  const paths = localStatePaths(options.artifact_url, run)
  const releaseLock = await acquireSpecLock(paths.lockPath)
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
      log(
        JSON.stringify(
          {
            scope_lock: input.scopeLock,
            baseline_metrics: state.baseline_metrics,
            ...existing,
          },
          null,
          2,
        ),
      )
      if (migratedState) writeLocalStateAtomic(paths.statePath, state)
      return 0
    }
    const round = state.reviews.length + 1
    // Three rounds is where review stops paying for itself. Stopping here used
    // to demand owner approval, which stalled the work on a person rather than
    // ending the gate: the remaining findings are carried as deferrals and the
    // change proceeds.
    if (round > 3) {
      log(
        JSON.stringify(
          {
            verdict: 'ROUND_CAP',
            rounds: state.reviews.length,
            scope_lock: input.scopeLock,
            baseline_metrics: state.baseline_metrics,
            unresolved_finding_ids: state.latest?.findings ?? [],
            note: 'Three review rounds are spent. Read the last round output for the text of the ids above, carry each remaining finding as a deferral at pr:ready, and do not open a fourth round.',
          },
          null,
          2,
        ),
      )
      writeLocalStateAtomic(paths.statePath, state)
      return 0
    }
    const prior = state.latest?.findings ?? []
    const dispositions = options.dispositions_file
      ? JSON.parse(readFileSync(options.dispositions_file, 'utf8'))
      : undefined
    if (round > 1)
      validateDispositions(
        dispositions,
        prior,
        state.latest?.legacy_finding_ids_sha256,
      )

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
    if (options.dispositions_file)
      common.push('--dispositions-file', options.dispositions_file)
    const [codexRaw, claudeRaw] = await waitForBoth([
      review('codex', common),
      review('claude', common),
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
      findings,
    }
    const nextState = {
      ...state,
      revision: state.revision + 1,
      reviews: [
        ...state.reviews,
        {
          version_id: options.version_id,
          input_fingerprint: inputFingerprint,
          round,
        },
      ],
      latest: { ...version, findings: compactFindings(findings) },
    }
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
    writeLocalStateAtomic(paths.statePath, nextState)
    return 0
  } finally {
    if (snapshotDirectory)
      rmSync(snapshotDirectory, { recursive: true, force: true })
    await releaseLock()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })

export {
  acquireSpecLock,
  assertSameProjectPlacement,
  assertUnchangedInput,
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

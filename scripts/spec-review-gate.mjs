#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  cliPackage,
  readSpecReviewInput,
  reviewStateMarker as marker,
  reviewStateMarkers,
} from './spec-review-input.mjs'

const recordMarker = '<!-- artifactshare-spec-review-record:v1 -->'

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

function reviewInputFingerprint(comments) {
  return createHash('sha256').update(JSON.stringify(comments)).digest('hex')
}

function assertSameProjectPlacement(expected, actual) {
  if (expected !== actual)
    throw new Error(
      'Specification placement changed during review; rerun the coordinator.',
    )
}

function findCompletedVersion(versions, versionId, inputFingerprint) {
  return versions.find(
    ({ version_id, input_fingerprint, findings }) =>
      version_id === versionId &&
      input_fingerprint === inputFingerprint &&
      Array.isArray(findings),
  )
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
      } else {
        const value = JSON.parse(
          message.body.slice(matchedMarker.length).trim(),
        )
        const legacy = matchedMarker !== marker
        candidates.push({
          threadId: thread.id,
          threadStatus: thread.status,
          messageId: message.message_id,
          generation: value.generation ?? 0,
          revision: value.revision ?? 0,
          ...(legacy ? { state: value } : { pointer: value }),
        })
      }
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

function deleteStateRecord(recordUrl, run = commandOutput) {
  const cleanup = JSON.parse(
    run('npm', [
      'exec',
      '--yes',
      `--package=${cliPackage}`,
      '--',
      'artifactshare',
      'delete',
      recordUrl,
      '--json',
    ]),
  )
  if (cleanup?.ok !== true || cleanup?.data?.deleted !== true)
    throw new Error('Artifact Share did not confirm record deletion.')
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

function hydrateTrackedState(tracked, run = commandOutput, expectedProjectId) {
  if (!tracked || tracked.state) return tracked
  return {
    ...tracked,
    state: stateFromRecord(tracked.pointer, run, expectedProjectId),
  }
}

function runReviewer(name, args, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
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
        ? resolve(stdout.trim())
        : reject(new Error(`${name} review failed.\n${stderr || stdout}`)),
    )
  })
}

function validateDispositions(bundle, priorFindings) {
  if (!bundle)
    throw new Error(
      'Correction review requires dispositions for both prior reviewer results.',
    )
  const expected = priorFindings.map(({ id }) => id).sort()
  const actual = bundle.prior_findings?.map(({ id }) => id).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected))
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

function persistStateRecord(
  state,
  { projectId = null, run = commandOutput } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'artifactshare-spec-review-'))
  const path = join(directory, 'spec-review-state.md')
  try {
    writeFileSync(path, `${recordMarker}\n${JSON.stringify(state)}\n`, 'utf8')
    const args = [
      'exec',
      '--yes',
      `--package=${cliPackage}`,
      '--',
      'artifactshare',
      'share',
      path,
    ]
    if (projectId) {
      args.push(
        '--project-id',
        projectId,
        '--visibility',
        'private',
        '--no-slack-notify',
      )
    } else {
      args.push('--home', '--visibility', 'private')
    }
    args.push('--json')
    const result = JSON.parse(run('npm', args))
    const recordUrl = result?.data?.artifact?.url
    const recordVersionId = result?.data?.version?.id
    if (
      result?.ok !== true ||
      typeof recordUrl !== 'string' ||
      typeof recordVersionId !== 'string'
    ) {
      if (typeof recordUrl === 'string') {
        try {
          deleteStateRecord(recordUrl, run)
        } catch (cleanupError) {
          throw new Error(
            `Could not persist Artifact Share review record. Cleanup also failed: ${cleanupError.message}`,
          )
        }
      }
      throw new Error('Could not persist Artifact Share review record.')
    }
    return {
      generation: state.generation ?? 0,
      revision: state.revision ?? 0,
      record_url: recordUrl,
      record_version_id: recordVersionId,
      state_sha256: stateDigest(state),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function pointerPostStatus({ artifactUrl, body, run = commandOutput }) {
  try {
    const output = JSON.parse(
      run('npm', [
        'exec',
        '--yes',
        `--package=${cliPackage}`,
        '--',
        'artifactshare',
        'artifacts',
        'get',
        artifactUrl,
        '--include',
        'comments',
        '--json',
      ]),
    )
    const comments = output?.data?.comments
    if (output?.ok !== true || !Array.isArray(comments)) return 'unknown'
    if (
      comments.some((thread) =>
        thread.messages?.some((message) => message.body === body),
      )
    )
      return 'posted'
    return output.data.comments_has_more === false ? 'absent' : 'unknown'
  } catch {
    return 'unknown'
  }
}

function persistState({
  artifactUrl,
  threadId,
  state,
  projectId,
  run = commandOutput,
}) {
  const pointer = persistStateRecord(state, { projectId, run })
  const body = `${marker}\n${JSON.stringify(pointer)}`
  const args = [
    'exec',
    '--yes',
    `--package=${cliPackage}`,
    '--',
    'artifactshare',
    'comments',
    'post',
    artifactUrl,
  ]
  if (threadId) args.push('--reply-to', threadId)
  args.push('--body', body, '--json')
  let result
  try {
    result = JSON.parse(run('npm', args))
  } catch (error) {
    const status = pointerPostStatus({ artifactUrl, body, run })
    if (status === 'posted') return pointer
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} The pointer result could not be reconciled; the review record was retained to avoid breaking a delayed or possibly committed pointer.`,
    )
  }
  if (result.ok !== true) {
    const message = 'Could not persist Artifact Share review pointer.'
    try {
      deleteStateRecord(pointer.record_url, run)
    } catch (cleanupError) {
      throw new Error(
        `${message} Cleanup of the unreferenced review record also failed: ${cleanupError.message}`,
      )
    }
    throw new Error(message)
  }
  return pointer
}

async function main({
  argv = process.argv.slice(2),
  run = commandOutput,
  review = runReviewer,
  log = console.log,
} = {}) {
  const options = parseArgs(argv)
  const input = readSpecReviewInput({
    artifactUrl: options.artifact_url,
    versionId: options.version_id,
    run,
  })
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
  const candidate = stateFromComments(
    input.allComments ?? input.comments,
    trustedEmail,
    { allowDivergence: options.reset === true },
  )
  const inputFingerprint = reviewInputFingerprint(input.comments)
  if (options.reset) {
    persistState({
      artifactUrl: options.artifact_url,
      threadId:
        candidate?.threadStatus === 'open' ? candidate.threadId : undefined,
      state: {
        generation: (candidate?.generation ?? 0) + 1,
        revision: 0,
        baseline_metrics: input.metrics,
        versions: [],
      },
      projectId: input.projectId,
      run,
    })
    const verifiedInput = readSpecReviewInput({
      artifactUrl: options.artifact_url,
      versionId: options.version_id,
      run,
    })
    assertSameProjectPlacement(input.projectId, verifiedInput.projectId)
    log('Artifact Share spec review state reset after owner-approved rewrite.')
    return 0
  }
  const tracked = hydrateTrackedState(candidate, run, input.projectId)
  const state = tracked?.state ?? {
    generation: 0,
    revision: 0,
    baseline_metrics: input.metrics,
    versions: [],
  }
  const existing = findCompletedVersion(
    state.versions,
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
    return 0
  }
  const round = state.versions.length + 1
  if (round > 3)
    throw new Error(
      'CIRCUIT_BREAKER: rewrite from the original scope lock; owner approval is required to reset state.',
    )
  const prior = state.versions.at(-1)?.findings ?? []
  const dispositions = options.dispositions_file
    ? JSON.parse(readFileSync(options.dispositions_file, 'utf8'))
    : undefined
  if (round > 1) validateDispositions(dispositions, prior)
  const common = [
    '--phase',
    'spec',
    '--artifact-url',
    options.artifact_url,
    '--version-id',
    options.version_id,
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
  const results = { codex: JSON.parse(codexRaw), claude: JSON.parse(claudeRaw) }
  const findings = Object.entries(results).flatMap(([reviewer, result]) =>
    result.findings.map((finding) => ({
      ...finding,
      id: `${reviewer}:${finding.id}`,
      reviewer,
    })),
  )
  for (const previous of state.versions) delete previous.findings
  const version = {
    version_id: options.version_id,
    input_fingerprint: inputFingerprint,
    round,
    findings,
  }
  state.versions.push(version)
  state.revision = (state.revision ?? 0) + 1
  const latestInput = readSpecReviewInput({
    artifactUrl: options.artifact_url,
    versionId: options.version_id,
    run,
  })
  const latest = hydrateTrackedState(
    stateFromComments(
      latestInput.allComments ?? latestInput.comments,
      trustedEmail,
    ),
    run,
    latestInput.projectId,
  )
  assertSameProjectPlacement(input.projectId, latestInput.projectId)
  if (reviewInputFingerprint(latestInput.comments) !== inputFingerprint)
    throw new Error(
      'Unresolved comments changed during review; rerun the coordinator.',
    )
  const concurrentlyCompleted = findCompletedVersion(
    latest?.state.versions ?? [],
    options.version_id,
    inputFingerprint,
  )
  if (concurrentlyCompleted) {
    log(
      JSON.stringify(
        {
          scope_lock: input.scopeLock,
          baseline_metrics: latest.state.baseline_metrics,
          ...concurrentlyCompleted,
        },
        null,
        2,
      ),
    )
    return 0
  }
  if ((tracked?.messageId ?? undefined) !== (latest?.messageId ?? undefined))
    throw new Error(
      'Spec review state changed concurrently; rerun the coordinator.',
    )
  persistState({
    artifactUrl: options.artifact_url,
    threadId: latest?.threadStatus === 'open' ? latest.threadId : undefined,
    state,
    projectId: input.projectId,
    run,
  })
  const verifiedInput = readSpecReviewInput({
    artifactUrl: options.artifact_url,
    versionId: options.version_id,
    run,
  })
  assertSameProjectPlacement(input.projectId, verifiedInput.projectId)
  const verified = hydrateTrackedState(
    stateFromComments(
      verifiedInput.allComments ?? verifiedInput.comments,
      trustedEmail,
    ),
    run,
    verifiedInput.projectId,
  )
  if (JSON.stringify(verified?.state) !== JSON.stringify(state))
    throw new Error('Spec review state did not persist without divergence.')
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })

export {
  assertSameProjectPlacement,
  deleteStateRecord,
  findCompletedVersion,
  hydrateTrackedState,
  main,
  marker,
  parseArgs,
  persistState,
  persistStateRecord,
  pointerPostStatus,
  recordMarker,
  reviewInputFingerprint,
  runReviewer,
  stateDigest,
  stateFromComments,
  stateFromRecord,
  validateDispositions,
  waitForBoth,
}

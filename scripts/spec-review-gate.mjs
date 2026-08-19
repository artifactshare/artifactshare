#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  cliPackage,
  readSpecReviewInput,
  reviewStateMarker as marker,
} from './spec-review-input.mjs'

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
      if (typeof message.body !== 'string' || !message.body.startsWith(marker))
        continue
      if (message.author_email !== trustedEmail) {
        hasForeignState = true
      } else {
        candidates.push({
          threadId: thread.id,
          threadStatus: thread.status,
          messageId: message.message_id,
          state: JSON.parse(message.body.slice(marker.length).trim()),
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
      (right.state.generation ?? 0) - (left.state.generation ?? 0) ||
      (right.state.revision ?? 0) - (left.state.revision ?? 0),
  )
  const current = candidates[0]
  const peers = candidates.filter(
    ({ state }) =>
      (state.generation ?? 0) === (current.state.generation ?? 0) &&
      (state.revision ?? 0) === (current.state.revision ?? 0),
  )
  if (
    !allowDivergence &&
    new Set(peers.map(({ state }) => JSON.stringify(state))).size > 1
  )
    throw new Error('Artifact Share review state has divergent histories.')
  return current
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

function persistState({ artifactUrl, threadId, state, run = commandOutput }) {
  const body = `${marker}\n${JSON.stringify(state)}`
  if (body.length > 4000)
    throw new Error(
      'Spec review state exceeds the Artifact Share comment limit.',
    )
  const command = 'post'
  const args = [
    'exec',
    '--yes',
    `--package=${cliPackage}`,
    '--',
    'artifactshare',
    'comments',
    command,
    artifactUrl,
  ]
  if (threadId) args.push('--reply-to', threadId)
  args.push('--body', body, '--json')
  const result = JSON.parse(run('npm', args))
  if (result.ok !== true)
    throw new Error('Could not persist Artifact Share review state.')
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
  const tracked = stateFromComments(
    input.allComments ?? input.comments,
    trustedEmail,
    { allowDivergence: options.reset === true },
  )
  const inputFingerprint = reviewInputFingerprint(input.comments)
  if (options.reset) {
    persistState({
      artifactUrl: options.artifact_url,
      threadId: tracked?.threadStatus === 'open' ? tracked.threadId : undefined,
      state: {
        generation: (tracked?.state.generation ?? 0) + 1,
        revision: 0,
        baseline_metrics: input.metrics,
        versions: [],
      },
      run,
    })
    log('Artifact Share spec review state reset after owner-approved rewrite.')
    return 0
  }
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
  const latest = stateFromComments(
    latestInput.allComments ?? latestInput.comments,
    trustedEmail,
  )
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
    run,
  })
  const verifiedInput = readSpecReviewInput({
    artifactUrl: options.artifact_url,
    versionId: options.version_id,
    run,
  })
  const verified = stateFromComments(
    verifiedInput.allComments ?? verifiedInput.comments,
    trustedEmail,
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
  findCompletedVersion,
  main,
  marker,
  parseArgs,
  persistState,
  reviewInputFingerprint,
  runReviewer,
  stateFromComments,
  validateDispositions,
  waitForBoth,
}

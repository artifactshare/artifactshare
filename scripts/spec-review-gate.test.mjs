import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { specificationDrafting } from './agent-role-settings.mjs'
import {
  acquireSpecLock,
  assertSameProjectPlacement,
  assertUnchangedInput,
  canonicalArtifactIdentity,
  compactFindings,
  findCompletedVersion,
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
  specReviewProfile,
  stateDigest,
  stateFromComments,
  stateFromRecord,
  validateDispositions,
  waitForBoth,
  writeLocalStateAtomic,
} from './spec-review-gate.mjs'
import {
  readSpecReviewInput,
  reviewStateMarkers,
  specMetrics,
} from './spec-review-input.mjs'

function specData(overrides = {}) {
  return {
    content: `## Scope lock

### Owner decisions

- Keep scope.

### Non-goals

- Expansion.

### Acceptance criteria

- The gate works.`,
    version_id: 'spec-v1',
    project_id: 'project-1',
    truncated: false,
    comments_has_more: false,
    comments: [
      {
        id: 'open-1',
        status: 'open',
        anchor: 'gate',
        messages: [
          {
            message_id: 'message-1',
            body: 'Check interruption safety.',
            created_at: '2026-08-26T00:00:00Z',
          },
        ],
      },
    ],
    ...overrides,
  }
}

function envelope(overrides = {}) {
  return JSON.stringify({ ok: true, data: specData(overrides) })
}

function workspaceRun(root, invocations, responses = [envelope(), envelope()]) {
  let reads = 0
  return (_file, args) => {
    invocations.push(args)
    if (args[0] === 'rev-parse') return root
    if (args.includes('get')) return responses[reads++] ?? responses.at(-1)
    throw new Error(`unexpected invocation: ${args.join(' ')}`)
  }
}

// The spec gate holds the worktree activity lock; tests never touch the real one.
const noActivityLock = () => Promise.resolve(() => Promise.resolve())

test('parses a spec gate and explicit owner reset', () => {
  assert.deepEqual(
    parseArgs([
      '--artifact-url',
      'https://example.test/a/x',
      '--version-id',
      'v1',
    ]),
    { artifact_url: 'https://example.test/a/x', version_id: 'v1' },
  )
  assert.equal(
    parseArgs(['--artifact-url', 'u', '--version-id', 'v', '--reset']).reset,
    true,
  )
  assert.throws(
    () => parseArgs(['--artifact-url', '--version-id', 'v1']),
    /Usage/u,
  )
})

test('rejects a malformed artifact URL before activity-lock acquisition', async () => {
  let acquired = false
  await assert.rejects(
    main({
      argv: [
        '--artifact-url',
        'https://example.test/not-an-artifact',
        '--version-id',
        'v1',
      ],
      acquireActivity: () => {
        acquired = true
        return Promise.resolve(() => Promise.resolve())
      },
    }),
    /canonical artifact id/u,
  )
  assert.equal(acquired, false)
})

test('rejects changed placement or immutable review input', () => {
  assert.doesNotThrow(() =>
    assertSameProjectPlacement('project-1', 'project-1'),
  )
  assert.throws(
    () => assertSameProjectPlacement('project-1', 'project-2'),
    /placement changed/u,
  )
  const initial = {
    content: 'one',
    comments: [],
    projectId: 'project-1',
    scopeLock: {},
    metrics: {},
  }
  assert.throws(
    () =>
      assertUnchangedInput(
        initial,
        { ...initial, comments: [{ id: 'new' }] },
        'v1',
      ),
    /changed during review/u,
  )
})

test('waits for both reviewers before reporting a failure', async () => {
  let finished = false
  const slow = Promise.resolve().then(() => {
    finished = true
    return 'done'
  })
  await assert.rejects(
    () => waitForBoth([Promise.reject(new Error('failed')), slow]),
    /failed/u,
  )
  assert.equal(finished, true)
})

test('stores local state under a hashed Git-private path', () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-state-path-'))
  try {
    const url =
      'https://private.example.test/a/Sensitive123?ignored=yes#fragment'
    const paths = localStatePaths(url, () => root)
    assert.equal(paths.root, join(root, 'artifactshare', 'spec-review'))
    assert.doesNotMatch(paths.statePath, /private|Sensitive123|ignored/u)
    writeLocalStateAtomic(
      paths.statePath,
      newLocalState({ size: 10, conceptCount: 1 }),
    )
    assert.deepEqual(readLocalState(paths.statePath).reviews, [])
    assert.equal(existsSync(`${paths.statePath}.tmp`), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses one canonical artifact identity across URL spellings and worktrees', () => {
  const common = mkdtempSync(join(tmpdir(), 'spec-common-dir-'))
  try {
    const urls = [
      'artifact123',
      'https://example.test/a/artifact123',
      'https://example.test/a/artifact123/?query=ignored#fragment',
      'https://artifact123.sandbox.example.test/anything',
    ]
    assert.deepEqual(
      urls.map((url) => canonicalArtifactIdentity(url)),
      Array(urls.length).fill('artifact123'),
    )
    const paths = urls.map((url) => localStatePaths(url, () => common))
    assert.equal(new Set(paths.map(({ statePath }) => statePath)).size, 1)
    assert.equal(new Set(paths.map(({ lockPath }) => lockPath)).size, 1)
    assert.throws(
      () => canonicalArtifactIdentity('https://example.test/not-an-artifact'),
      /canonical artifact id/u,
    )
  } finally {
    rmSync(common, { recursive: true, force: true })
  }
})

test('uses an OS lock that refuses concurrency and ignores ownerless files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-lock-'))
  const lock = join(root, 'same-spec.lock')
  try {
    writeFileSync(lock, '')
    const release = await acquireSpecLock(lock)
    await assert.rejects(() => acquireSpecLock(lock), /already holds/u)
    await release()
    const reacquired = await acquireSpecLock(lock)
    await reacquired()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('releases the OS lock after the coordinator is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-lock-parent-'))
  const lock = join(root, 'same-spec.lock')
  const moduleUrl = new URL('./spec-review-gate.mjs', import.meta.url).href
  const helper = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { acquireSpecLock } from ${JSON.stringify(moduleUrl)}
await acquireSpecLock(${JSON.stringify(lock)})
process.stdout.write('locked\\n')
setInterval(() => {}, 1_000)
`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  try {
    let output = ''
    await new Promise((resolve, reject) => {
      helper.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('locked\n')) resolve()
      })
      helper.once('error', reject)
      helper.once('close', (code) =>
        reject(new Error(`lock helper exited before acquisition: ${code}`)),
      )
    })
    helper.kill('SIGKILL')
    await once(helper, 'close')
    await new Promise((resolve) => setTimeout(resolve, 750))
    const release = await acquireSpecLock(lock)
    await release()
  } finally {
    if (helper.exitCode === null) helper.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('selects the platform OS lock utility', () => {
  assert.equal(lockInvocation('/tmp/spec.lock', 'darwin').file, 'lockf')
  assert.equal(lockInvocation('/tmp/spec.lock', 'linux').file, 'flock')
  assert.throws(
    () => lockInvocation('/tmp/spec.lock', 'win32'),
    /requires lockf on macOS or flock on Linux/u,
  )
})

test('migrates legacy inline state once and keeps only bounded finding fields', () => {
  const legacy = {
    generation: 2,
    revision: 3,
    baseline_metrics: { size: 100, conceptCount: 2 },
    versions: [
      {
        version_id: 'v1',
        input_fingerprint: 'fingerprint',
        round: 1,
        findings: [
          {
            id: 'codex:a',
            reviewer: 'codex',
            severity: 'blocker',
            summary: 'must not persist',
            token: 'must not persist',
          },
        ],
      },
    ],
  }
  const input = {
    allComments: [
      {
        messages: [
          {
            author_email: 'owner@example.test',
            body: `${reviewStateMarkers[1]}\n${JSON.stringify(legacy)}`,
          },
        ],
      },
    ],
    metrics: { size: 1, conceptCount: 0 },
    projectId: 'project-1',
  }
  const calls = []
  const migrated = migrateLegacyState(input, (_file, args) => {
    calls.push(args)
    return JSON.stringify({
      ok: true,
      data: { user: { email: 'owner@example.test' } },
    })
  })
  assert.deepEqual(migrated.latest.findings, [
    { id: 'codex:1', reviewer: 'codex', severity: 'blocker' },
  ])
  assert.doesNotMatch(JSON.stringify(migrated), /must not persist/u)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('whoami'))
})

test('hydrates a legacy record without deleting or changing it', () => {
  const state = { generation: 1, revision: 4, versions: [] }
  const pointer = {
    generation: 1,
    revision: 4,
    record_url: 'https://example.test/a/record',
    record_version_id: 'record-v4',
    state_sha256: stateDigest(state),
  }
  const invocations = []
  const read = stateFromRecord(
    pointer,
    (_file, args) => {
      invocations.push(args)
      return JSON.stringify({
        ok: true,
        data: {
          version_id: 'record-v4',
          project_id: 'project-1',
          content: `${recordMarker}\n${JSON.stringify(state)}`,
          truncated: false,
          next_offset: null,
        },
      })
    },
    'project-1',
  )
  assert.deepEqual(read, state)
  assert.ok(invocations.every((args) => !args.includes('delete')))
  assert.throws(
    () =>
      stateFromRecord(pointer, () =>
        JSON.stringify({
          ok: true,
          data: {
            version_id: 'record-v4',
            content: `${recordMarker}\n${JSON.stringify(state)}`,
            truncated: false,
            next_offset: 10,
          },
        }),
      ),
    /pagination is invalid/u,
  )
})

test('migrates a legacy fingerprint for display but cannot reuse unknown-profile evidence', () => {
  const input = {
    content: specData().content,
    comments: [{ id: 'open', messages: [{ body: 'same input' }] }],
    allComments: [],
    projectId: 'project-1',
    scopeLock: {
      owner_decisions: 'keep',
      non_goals: 'none',
      acceptance_criteria: 'works',
    },
    metrics: { size: 10, conceptCount: 1 },
  }
  const legacyFingerprint = createHash('sha256')
    .update(JSON.stringify(input.comments))
    .digest('hex')
  const legacy = {
    generation: 1,
    revision: 1,
    baseline_metrics: input.metrics,
    versions: [
      {
        version_id: 'spec-v1',
        input_fingerprint: legacyFingerprint,
        round: 1,
        findings: [],
      },
    ],
  }
  input.allComments = [
    {
      messages: [
        {
          author_email: 'owner@example.test',
          body: `${reviewStateMarkers[1]}\n${JSON.stringify(legacy)}`,
        },
      ],
    },
  ]
  const migrated = migrateLegacyState(
    input,
    () =>
      JSON.stringify({
        ok: true,
        data: { user: { email: 'owner@example.test' } },
      }),
    { versionId: 'spec-v1' },
  )
  const fingerprint = reviewInputFingerprint(input, 'spec-v1')
  assert.equal(migrated.latest.input_fingerprint, fingerprint)
  assert.equal(migrated.reviews[0].input_fingerprint, fingerprint)
  assert.equal(migrated.profile, null)
  assert.equal(
    findCompletedVersion(migrated, 'spec-v1', fingerprint),
    undefined,
  )
})

test('reruns migrated legacy evidence under the current profile, then caches that result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-legacy-cache-'))
  const url = 'https://example.test/a/spec'
  const projectedComments = [
    {
      id: 'open-1',
      anchor: 'gate',
      messages: [
        {
          message_id: 'message-1',
          body: 'Check interruption safety.',
          created_at: '2026-08-26T00:00:00Z',
        },
      ],
    },
  ]
  const legacyFingerprint = createHash('sha256')
    .update(JSON.stringify(projectedComments))
    .digest('hex')
  const legacy = {
    generation: 1,
    revision: 1,
    baseline_metrics: specMetrics(specData().content),
    versions: [
      {
        version_id: 'spec-v1',
        input_fingerprint: legacyFingerprint,
        round: 1,
        findings: [],
      },
    ],
  }
  const data = specData({
    comments: [
      ...specData().comments,
      {
        id: 'legacy-state',
        status: 'open',
        messages: [
          {
            author_email: 'owner@example.test',
            body: `${reviewStateMarkers[1]}\n${JSON.stringify(legacy)}`,
          },
        ],
      },
    ],
  })
  let identityReads = 0
  let reviewCalls = 0
  const dispositionsPath = join(root, 'dispositions.json')
  writeFileSync(
    dispositionsPath,
    JSON.stringify({
      baseline_metrics: specMetrics(data.content),
      prior_findings: [],
      dispositions: [],
    }),
  )
  const run = (_file, args) => {
    if (args[0] === 'rev-parse') return root
    if (args.includes('whoami')) {
      identityReads += 1
      return JSON.stringify({
        ok: true,
        data: { user: { email: 'owner@example.test' } },
      })
    }
    if (args.includes('get')) return JSON.stringify({ ok: true, data })
    throw new Error(`unexpected invocation: ${args.join(' ')}`)
  }
  try {
    for (let invocation = 0; invocation < 2; invocation += 1) {
      await main({
        acquireActivity: noActivityLock,
        argv: [
          '--artifact-url',
          url,
          '--version-id',
          'spec-v1',
          '--dispositions-file',
          dispositionsPath,
        ],
        run,
        review: () => {
          reviewCalls += 1
          return Promise.resolve(
            JSON.stringify({ verdict: 'GO', findings: [] }),
          )
        },
        log: () => {},
      })
    }
    assert.equal(identityReads, 1)
    assert.equal(reviewCalls, 2)
    const state = readLocalState(localStatePaths(url, () => root).statePath)
    assert.deepEqual(state.profile, specReviewProfile)
    assert.equal(state.reviews.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cache hit persists bounded normalization of old local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-cache-compaction-'))
  const url = 'https://example.test/a/spec'
  const invocations = []
  const run = workspaceRun(root, invocations)
  const input = readSpecReviewInput({
    artifactUrl: url,
    versionId: 'spec-v1',
    run,
  })
  const fingerprint = reviewInputFingerprint(input, 'spec-v1')
  const state = newLocalState(input.metrics)
  delete state.round_count
  state.reviews = Array.from({ length: 6 }, (_, index) => ({
    version_id: `spec-v${index + 1}`,
    input_fingerprint: `fingerprint-${index + 1}`,
    round: index + 1,
  }))
  state.latest = {
    version_id: 'spec-v1',
    input_fingerprint: fingerprint,
    round: 6,
    verdict: 'GO',
    findings: [{ id: 'codex:1', reviewer: 'codex', severity: 'follow_up' }],
  }
  const paths = localStatePaths(url, () => root)
  writeLocalStateAtomic(paths.statePath, state)
  let reviewCalls = 0
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
      run,
      review: () => {
        reviewCalls += 1
        return Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] }))
      },
      log: () => {
        const stored = readLocalState(paths.statePath)
        assert.equal(stored.round_count, 6)
        assert.equal(stored.reviews.length, 3)
      },
    })
    assert.equal(code, 0)
    assert.equal(reviewCalls, 0)
    const stored = readLocalState(paths.statePath)
    assert.equal(stored.round_count, 6)
    assert.deepEqual(
      stored.reviews.map(({ round }) => round),
      [4, 5, 6],
    )
    assert.deepEqual(stored.baseline_metrics, state.baseline_metrics)
    assert.deepEqual(stored.latest, state.latest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves legacy identity and divergence checks', () => {
  const comments = [
    {
      messages: [
        {
          author_email: 'owner@example.test',
          body: `${marker}\n${JSON.stringify({ generation: 1, revision: 0 })}`,
        },
        {
          author_email: 'owner@example.test',
          body: `${marker}\n${JSON.stringify({ generation: 1, revision: 0, fork: true })}`,
        },
      ],
    },
  ]
  assert.throws(
    () => stateFromComments(comments, 'owner@example.test'),
    /divergent/u,
  )
  assert.equal(
    stateFromComments(comments, 'owner@example.test', {
      allowDivergence: true,
    }).generation,
    1,
  )
})

test('runs both reviewers from one snapshot and only reads Artifact Share at start and end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-main-'))
  const invocations = []
  const snapshots = []
  const logs = []
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: [
        '--artifact-url',
        'https://example.test/a/spec',
        '--version-id',
        'spec-v1',
      ],
      run: workspaceRun(root, invocations),
      review: (name, args) => {
        const path = args[args.indexOf('--snapshot-file') + 1]
        assert.equal(statSync(path).mode & 0o777, 0o600)
        const snapshot = JSON.parse(readFileSync(path, 'utf8'))
        snapshots.push([name, snapshot, args])
        return Promise.resolve(
          JSON.stringify({
            verdict: 'GO',
            review_details: {
              candidate_results: [
                {
                  technical_verdict: 'REFUTED',
                  evidence: `${name} static counterexample`,
                },
              ],
            },
            findings: [
              {
                id: `${name}-note`,
                severity: 'follow_up',
                summary: 'session-only detail',
              },
            ],
          }),
        )
      },
      log: (value) => logs.push(value),
    })
    assert.equal(code, 0)
    const output = JSON.parse(logs[0])
    assert.equal(output.verdict, 'GO')
    assert.equal(output.findings.length, 2)
    assert.equal(output.findings[0].candidate_id, 'codex-note')
    assert.equal(output.findings[1].candidate_id, 'claude-note')
    assert.equal(
      output.review_details.codex.candidate_results[0].technical_verdict,
      'REFUTED',
    )
    assert.equal(
      output.review_details.claude.candidate_results[0].evidence,
      'claude static counterexample',
    )
    assert.equal(
      readLocalState(
        localStatePaths('https://example.test/a/spec', () => root).statePath,
      ).review_details,
      undefined,
    )
    assert.equal(snapshots.length, 2)
    assert.deepEqual(snapshots[0][1], snapshots[1][1])
    assert.deepEqual(
      snapshots.map(([, , args]) => [
        args[args.indexOf('--model') + 1],
        args[args.indexOf('--effort') + 1],
      ]),
      [
        [specificationDrafting.codex.model, specificationDrafting.codex.effort],
        [
          specificationDrafting.claude.model,
          specificationDrafting.claude.effort,
        ],
      ],
    )
    assert.equal(
      snapshots[0][1].input_fingerprint,
      reviewInputFingerprint(
        {
          content: specData().content,
          comments: [
            {
              id: 'open-1',
              anchor: 'gate',
              messages: [
                {
                  message_id: 'message-1',
                  body: 'Check interruption safety.',
                  created_at: '2026-08-26T00:00:00Z',
                },
              ],
            },
          ],
          projectId: 'project-1',
          scopeLock: snapshots[0][1].scope_lock,
          metrics: snapshots[0][1].metrics,
        },
        'spec-v1',
      ),
    )
    const artifactCalls = invocations.filter((args) =>
      args.includes('artifactshare'),
    )
    assert.equal(artifactCalls.length, 2)
    assert.ok(artifactCalls.every((args) => args.includes('get')))
    assert.ok(
      artifactCalls.every(
        (args) =>
          !args.includes('share') &&
          !args.includes('post') &&
          !args.includes('delete'),
      ),
    )
    const { statePath } = localStatePaths(
      'https://example.test/a/spec',
      () => root,
    )
    const stored = readLocalState(statePath)
    assert.equal(stored.reviews.length, 1)
    assert.doesNotMatch(JSON.stringify(stored), /session-only detail/u)
    assert.doesNotMatch(
      JSON.stringify(stored),
      /Scope lock|interruption safety/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('review failure preserves the last completed local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-failure-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const prior = newLocalState({ size: 10, conceptCount: 1 })
  writeLocalStateAtomic(paths.statePath, prior)
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
          run: workspaceRun(root, []),
          review: (name) =>
            name === 'codex'
              ? Promise.reject(new Error('review failed'))
              : Promise.resolve(
                  JSON.stringify({ verdict: 'GO', findings: [] }),
                ),
          log: () => {},
        }),
      /review failed/u,
    )
    assert.deepEqual(readLocalState(paths.statePath), prior)
    const release = await acquireSpecLock(paths.lockPath)
    await release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('initial review failure leaves no provisional local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-initial-failure-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
          run: workspaceRun(root, []),
          review: () => Promise.reject(new Error('review failed')),
          log: () => {},
        }),
      /review failed/u,
    )
    assert.equal(existsSync(paths.statePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('completed state is stored before successful output is attempted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-output-failure-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const prior = newLocalState({ size: 10, conceptCount: 1 })
  writeLocalStateAtomic(paths.statePath, prior)
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
          run: workspaceRun(root, []),
          review: () =>
            Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] })),
          log: () => {
            throw new Error('output failed')
          },
        }),
      /output failed/u,
    )
    const stored = readLocalState(paths.statePath)
    assert.equal(stored.round_count, 1)
    assert.equal(stored.latest.verdict, 'GO')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('input changes after review do not replace completed state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-change-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const prior = newLocalState({ size: 10, conceptCount: 1 })
  writeLocalStateAtomic(paths.statePath, prior)
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
          run: workspaceRun(root, [], [envelope(), envelope({ comments: [] })]),
          review: () =>
            Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] })),
          log: () => {},
        }),
      /changed during review/u,
    )
    assert.deepEqual(readLocalState(paths.statePath), prior)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('owner reset increments generation locally after readback only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-reset-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  writeLocalStateAtomic(
    paths.statePath,
    newLocalState({ size: 10, conceptCount: 1 }, 4),
  )
  const invocations = []
  try {
    await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v1', '--reset'],
      run: workspaceRun(root, invocations),
      review: () => {
        throw new Error('review must not run')
      },
      log: () => {},
    })
    assert.equal(readLocalState(paths.statePath).generation, 5)
    assert.equal(invocations.filter((args) => args.includes('get')).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('owner reset repairs an invalid local state after readback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-invalid-reset-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  writeLocalStateAtomic(
    paths.statePath,
    newLocalState({
      size: 1,
      conceptCount: 0,
    }),
  )
  writeFileSync(paths.statePath, '{invalid json\n')
  try {
    await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v1', '--reset'],
      run: workspaceRun(root, []),
      review: () => {
        throw new Error('review must not run')
      },
      log: () => {},
    })
    const state = readLocalState(paths.statePath)
    assert.equal(state.generation, 1)
    assert.deepEqual(state.reviews, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed owner reset leaves no provisional local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-reset-failure-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v1', '--reset'],
          run: workspaceRun(root, [], [envelope(), envelope({ comments: [] })]),
          review: () => {
            throw new Error('review must not run')
          },
          log: () => {},
        }),
      /changed during review/u,
    )
    assert.equal(existsSync(paths.statePath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('owner reset bypasses an unreadable legacy record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-legacy-reset-'))
  const url = 'https://example.test/a/spec'
  const pointer = {
    generation: 7,
    revision: 2,
    record_url: 'https://example.test/a/missing-record',
    record_version_id: 'missing-v2',
    state_sha256: 'unavailable',
  }
  const data = specData({
    comments: [
      {
        id: 'state',
        status: 'open',
        messages: [
          {
            author_email: 'owner@example.test',
            body: `${marker}\n${JSON.stringify(pointer)}`,
          },
        ],
      },
    ],
  })
  const calls = []
  try {
    await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v1', '--reset'],
      run: (_file, args) => {
        calls.push(args)
        if (args[0] === 'rev-parse') return root
        if (args.includes('whoami'))
          return JSON.stringify({
            ok: true,
            data: { user: { email: 'owner@example.test' } },
          })
        if (args.includes('get')) {
          const target = args[args.indexOf('get') + 1]
          if (target === pointer.record_url)
            throw new Error('legacy record must not be read')
          return JSON.stringify({ ok: true, data })
        }
        throw new Error(`unexpected invocation: ${args.join(' ')}`)
      },
      review: () => {
        throw new Error('review must not run')
      },
      log: () => {},
    })
    const paths = localStatePaths(url, () => root)
    assert.equal(readLocalState(paths.statePath).generation, 8)
    assert.ok(
      !calls.some(
        (args) =>
          args.includes('get') &&
          args[args.indexOf('get') + 1] === pointer.record_url,
      ),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the three-round circuit breaker and disposition coverage', () => {
  const baseline = { size: 1, conceptCount: 0 }
  const completeBundle = (findings) => ({
    baseline_metrics: baseline,
    prior_findings: findings,
    dispositions: findings.map(({ id }) => ({ id, disposition: 'fixed' })),
  })
  const state = newLocalState(baseline)
  state.latest = {
    version_id: 'v1',
    input_fingerprint: 'same',
    round: 1,
    findings: [{ id: 'codex:a' }, { id: 'claude:b' }],
  }
  assert.ok(findCompletedVersion(state, 'v1', 'same'))
  assert.throws(
    () => validateDispositions({}, [], undefined),
    /prior_findings must be an array/u,
  )
  assert.throws(
    () =>
      validateDispositions(
        undefined,
        [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
        undefined,
        { size: 10, conceptCount: 1 },
      ),
    (error) =>
      error.message.includes('"baseline_metrics":{"size":10') &&
      error.message.includes(
        '"prior_findings":[{"id":"codex:1","reviewer":"codex","severity":"blocker"}]',
      ) &&
      error.message.includes(
        '"disposition":"one of: fixed, follow_up, non_actionable, rewrite"',
      ) &&
      error.message.includes('"repeated":false') &&
      error.message.includes('"contradiction":false'),
  )
  assert.throws(
    () =>
      validateDispositions(
        { prior_findings: [{ id: 'codex:a' }] },
        state.latest.findings,
      ),
    /dispositions must be an array/u,
  )
  assert.doesNotThrow(() =>
    validateDispositions(
      completeBundle([{ id: 'codex:a' }, { id: 'claude:b' }]),
      state.latest.findings,
      undefined,
      baseline,
    ),
  )
  const legacyPrior = [{ id: 'codex:old-name' }, { id: 'claude:old-name' }]
  const legacyDigest = createHash('sha256')
    .update(JSON.stringify(legacyPrior.map(({ id }) => id).sort()))
    .digest('hex')
  assert.doesNotThrow(() =>
    validateDispositions(
      completeBundle(legacyPrior),
      [{ id: 'codex:1' }, { id: 'claude:1' }],
      legacyDigest,
      baseline,
    ),
  )
  assert.deepEqual(
    compactFindings([
      { id: 'a', reviewer: 'codex', severity: 'blocker', summary: 'drop' },
    ]),
    [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
  )
})

test('returns a nonpassing cap for a fourth unreviewed version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-round-cap-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const state = newLocalState({ size: 10, conceptCount: 1 })
  state.reviews = [1, 2, 3].map((round) => ({
    version_id: `old-v${round}`,
    input_fingerprint: `old-f${round}`,
    round,
  }))
  state.latest = {
    version_id: 'old-v3',
    input_fingerprint: 'old-f3',
    round: 3,
    findings: [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
  }
  writeLocalStateAtomic(paths.statePath, state)
  const logs = []
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v4'],
      run: workspaceRun(root, [], [envelope({ version_id: 'spec-v4' })]),
      review: () => {
        throw new Error('unreviewed target must not launch')
      },
      log: (value) => logs.push(value),
    })
    assert.equal(code, 2)
    assert.deepEqual(JSON.parse(logs[0]), {
      verdict: 'ROUND_CAP',
      target_unreviewed: true,
      rounds: 3,
      scope_lock: {
        owner_decisions: '- Keep scope.',
        non_goals: '- Expansion.',
        acceptance_criteria: '- The gate works.',
      },
      baseline_metrics: { size: 10, conceptCount: 1 },
      unresolved_finding_ids: [
        { id: 'codex:1', reviewer: 'codex', severity: 'blocker' },
      ],
      evidence_invalidated: false,
      note: 'The review-round cap of 3 is spent (3 completed rounds). Rewrite the specification from the original scope lock and acceptance criteria before reviewing another version; do not defer a blocker because of the cap.',
    })
    assert.deepEqual(readLocalState(paths.statePath), {
      ...state,
      round_count: 3,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a profile change preserves an exhausted generation and its findings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-profile-cap-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const state = newLocalState({ size: 10, conceptCount: 1 }, 2, {
    codex: { model: 'old', effort: 'high' },
  })
  state.reviews = [1, 2, 3].map((round) => ({
    version_id: `old-v${round}`,
    input_fingerprint: `old-f${round}`,
    round,
  }))
  state.latest = {
    version_id: 'old-v3',
    input_fingerprint: 'old-f3',
    round: 3,
    findings: [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
  }
  writeLocalStateAtomic(paths.statePath, state)
  let reviewCalls = 0
  const logs = []
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v4'],
      run: workspaceRun(root, [], [envelope({ version_id: 'spec-v4' })]),
      review: () => {
        reviewCalls += 1
        return Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] }))
      },
      log: (value) => logs.push(value),
    })
    assert.equal(code, 2)
    assert.equal(reviewCalls, 0)
    assert.equal(JSON.parse(logs[0]).rounds, 3)
    assert.equal(JSON.parse(logs[0]).evidence_invalidated, true)
    const stored = readLocalState(paths.statePath)
    assert.equal(stored.generation, 2)
    assert.deepEqual(stored.baseline_metrics, state.baseline_metrics)
    assert.equal(stored.reviews.length, 3)
    assert.deepEqual(stored.latest.findings, state.latest.findings)
    assert.equal(stored.latest.evidence_invalidated, true)
    assert.deepEqual(stored.profile, specReviewProfile)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a profile change still requires dispositions for prior findings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-profile-dispositions-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const state = newLocalState({ size: 10, conceptCount: 1 }, 0, {
    codex: { model: 'old', effort: 'high' },
  })
  state.reviews = [
    { version_id: 'old-v1', input_fingerprint: 'old-f1', round: 1 },
  ]
  state.latest = {
    version_id: 'old-v1',
    input_fingerprint: 'old-f1',
    round: 1,
    findings: [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
  }
  writeLocalStateAtomic(paths.statePath, state)
  let reviewCalls = 0
  try {
    await assert.rejects(
      () =>
        main({
          acquireActivity: noActivityLock,
          argv: ['--artifact-url', url, '--version-id', 'spec-v2'],
          run: workspaceRun(root, [], [envelope({ version_id: 'spec-v2' })]),
          review: () => {
            reviewCalls += 1
            return Promise.resolve(
              JSON.stringify({ verdict: 'GO', findings: [] }),
            )
          },
          log: () => {},
        }),
      /requires dispositions/u,
    )
    assert.equal(reviewCalls, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('correction dispositions are fully validated before reviewers launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-disposition-gate-'))
  const url = 'https://example.test/a/spec'
  const run = workspaceRun(root, [], [envelope({ version_id: 'spec-v2' })])
  const input = readSpecReviewInput({
    artifactUrl: url,
    versionId: 'spec-v2',
    run,
  })
  const prior = [
    { id: 'codex:1', reviewer: 'codex', severity: 'blocker' },
    { id: 'claude:1', reviewer: 'claude', severity: 'follow_up' },
  ]
  const state = newLocalState(input.metrics)
  state.round_count = 1
  state.reviews = [
    { version_id: 'spec-v1', input_fingerprint: 'old', round: 1 },
  ]
  state.latest = {
    version_id: 'spec-v1',
    input_fingerprint: 'old',
    round: 1,
    findings: prior,
  }
  const paths = localStatePaths(url, () => root)
  writeLocalStateAtomic(paths.statePath, state)
  const valid = {
    baseline_metrics: input.metrics,
    prior_findings: prior,
    dispositions: prior.map(({ id }) => ({ id, disposition: 'fixed' })),
  }
  const invalidCases = [
    [undefined, /requires dispositions/u],
    [{ ...valid, dispositions: undefined }, /dispositions must be an array/u],
    [{ ...valid, prior_findings: [null] }, /prior finding 1 is invalid/u],
    [
      {
        ...valid,
        dispositions: [
          { id: 'codex:1', disposition: 'fixed' },
          { id: 'wrong', disposition: 'fixed' },
        ],
      },
      /Every previous finding/u,
    ],
    [
      {
        ...valid,
        dispositions: prior.map(({ id }) => ({ id, disposition: 'later' })),
      },
      /invalid value/u,
    ],
    [
      {
        ...valid,
        dispositions: prior.map(({ id }) => ({
          id,
          disposition: 'fixed',
          contradiction: 'false',
        })),
      },
      /contradiction must be a boolean/u,
    ],
  ]
  let reviewCalls = 0
  try {
    for (const [
      index,
      [dispositions, expectedError],
    ] of invalidCases.entries()) {
      const dispositionPath = join(root, `invalid-${index}.json`)
      const argv = ['--artifact-url', url, '--version-id', 'spec-v2']
      if (dispositions !== undefined) {
        writeFileSync(dispositionPath, JSON.stringify(dispositions))
        argv.push('--dispositions-file', dispositionPath)
      }
      await assert.rejects(
        () =>
          main({
            acquireActivity: noActivityLock,
            argv,
            run,
            review: () => {
              reviewCalls += 1
              return Promise.resolve(
                JSON.stringify({ verdict: 'GO', findings: [] }),
              )
            },
            log: () => {},
          }),
        expectedError,
      )
    }
    assert.equal(reviewCalls, 0)

    const validPath = join(root, 'valid.json')
    writeFileSync(validPath, JSON.stringify(valid))
    const snapshotDispositionPaths = []
    const code = await main({
      acquireActivity: noActivityLock,
      argv: [
        '--artifact-url',
        url,
        '--version-id',
        'spec-v2',
        '--dispositions-file',
        validPath,
      ],
      run,
      review: (_name, args) => {
        reviewCalls += 1
        const snapshotPath = args[args.indexOf('--dispositions-file') + 1]
        snapshotDispositionPaths.push(snapshotPath)
        assert.notEqual(snapshotPath, validPath)
        assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), valid)
        assert.equal(statSync(snapshotPath).mode & 0o777, 0o600)
        return Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] }))
      },
      log: () => {},
    })
    assert.equal(code, 0)
    assert.equal(reviewCalls, 2)
    assert.equal(new Set(snapshotDispositionPaths).size, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a supplied first-round disposition bundle is validated and snapshotted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-first-dispositions-'))
  const url = 'https://example.test/a/spec'
  const metrics = specMetrics(specData().content)
  const bundle = {
    baseline_metrics: metrics,
    prior_findings: [],
    dispositions: [],
  }
  const sourcePath = join(root, 'dispositions.json')
  writeFileSync(sourcePath, JSON.stringify(bundle))
  const paths = []
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: [
        '--artifact-url',
        url,
        '--version-id',
        'spec-v1',
        '--dispositions-file',
        sourcePath,
      ],
      run: workspaceRun(root, []),
      review: (_name, args) => {
        const path = args[args.indexOf('--dispositions-file') + 1]
        paths.push(path)
        assert.notEqual(path, sourcePath)
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), bundle)
        return Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] }))
      },
      log: () => {},
    })
    assert.equal(code, 0)
    assert.equal(new Set(paths).size, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falsy first-round disposition JSON is rejected before reviewers launch', async () => {
  let reviewCalls = 0
  for (const [index, value] of [null, false, 0, ''].entries()) {
    const root = mkdtempSync(
      join(tmpdir(), `spec-falsy-dispositions-${index}-`),
    )
    const sourcePath = join(root, 'dispositions.json')
    writeFileSync(sourcePath, JSON.stringify(value))
    try {
      await assert.rejects(
        () =>
          main({
            acquireActivity: noActivityLock,
            argv: [
              '--artifact-url',
              `https://example.test/a/spec${index}`,
              '--version-id',
              'spec-v1',
              '--dispositions-file',
              sourcePath,
            ],
            run: workspaceRun(root, []),
            review: () => {
              reviewCalls += 1
              return Promise.resolve(
                JSON.stringify({ verdict: 'GO', findings: [] }),
              )
            },
            log: () => {},
          }),
        /Disposition input must be an object/u,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  assert.equal(reviewCalls, 0)
})

test('stale finding ids fail coverage before semantic circuit breakers', () => {
  const metrics = { size: 10, conceptCount: 1 }
  const expected = [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }]
  for (const flag of ['repeated', 'contradiction']) {
    const stale = [{ id: 'codex:stale' }]
    assert.throws(
      () =>
        validateDispositions(
          {
            baseline_metrics: metrics,
            prior_findings: stale,
            dispositions: [
              { id: 'codex:stale', disposition: 'fixed', [flag]: true },
            ],
          },
          expected,
          undefined,
          metrics,
        ),
      (error) => {
        assert.match(
          error.message,
          /Dispositions must include every prior Codex and Claude finding/u,
        )
        assert.doesNotMatch(error.message, /CIRCUIT_BREAKER/u)
        return true
      },
    )

    assert.throws(
      () =>
        validateDispositions(
          {
            baseline_metrics: metrics,
            prior_findings: expected,
            dispositions: [
              { id: 'codex:1', disposition: 'fixed', [flag]: true },
            ],
          },
          expected,
          undefined,
          metrics,
        ),
      /CIRCUIT_BREAKER/u,
    )
  }
})

test('coordinator rejects invalid correction controls before launching reviewers', async () => {
  const currentMetrics = specMetrics(specData().content)
  const cases = [
    {
      name: 'growth',
      baseline: {
        ...currentMetrics,
        size: Math.floor(currentMetrics.size / 2),
      },
      flags: {},
      error: /size grew by more than 60%/u,
    },
    {
      name: 'repeated',
      baseline: currentMetrics,
      flags: { repeated: true },
      error: /CIRCUIT_BREAKER: a finding repeated.*rewrite/u,
    },
    {
      name: 'contradiction',
      baseline: currentMetrics,
      flags: { contradiction: true },
      error: /CIRCUIT_BREAKER: contradictory findings.*rewrite/u,
    },
    {
      name: 'baseline-mismatch',
      baseline: currentMetrics,
      suppliedBaseline: { ...currentMetrics, size: currentMetrics.size + 1 },
      flags: {},
      error: /baseline metrics must match/u,
    },
  ]
  let reviewCalls = 0
  for (const [index, item] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), `spec-${item.name}-`))
    const url = `https://example.test/a/spec${index}`
    const paths = localStatePaths(url, () => root)
    const prior = [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }]
    const state = newLocalState(item.baseline)
    state.round_count = 1
    state.reviews = [
      { version_id: 'spec-v0', input_fingerprint: 'old', round: 1 },
    ]
    state.latest = {
      version_id: 'spec-v0',
      input_fingerprint: 'old',
      round: 1,
      findings: prior,
    }
    writeLocalStateAtomic(paths.statePath, state)
    const dispositionPath = join(root, 'dispositions.json')
    writeFileSync(
      dispositionPath,
      JSON.stringify({
        baseline_metrics: item.suppliedBaseline ?? item.baseline,
        prior_findings: prior,
        dispositions: [{ id: 'codex:1', disposition: 'fixed', ...item.flags }],
      }),
    )
    try {
      await assert.rejects(
        () =>
          main({
            acquireActivity: noActivityLock,
            argv: [
              '--artifact-url',
              url,
              '--version-id',
              'spec-v1',
              '--dispositions-file',
              dispositionPath,
            ],
            run: workspaceRun(root, []),
            review: () => {
              reviewCalls += 1
              return Promise.resolve(
                JSON.stringify({ verdict: 'GO', findings: [] }),
              )
            },
            log: () => {},
          }),
        (error) => {
          assert.match(error.message, item.error)
          if (error.message.startsWith('CIRCUIT_BREAKER:'))
            assert.doesNotMatch(error.message, /Required input/u)
          return true
        },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  assert.equal(reviewCalls, 0)
})

test('malformed persisted baseline and unsafe round count stop before review', async () => {
  const invalidStates = [
    {
      field: 'baseline',
      update: (state) => ({ ...state, baseline_metrics: {} }),
      error: /baseline_metrics require finite nonnegative values/u,
    },
    {
      field: 'round',
      update: (state) => ({
        ...state,
        round_count: Number.MAX_SAFE_INTEGER + 1,
      }),
      error: /Local spec review state is invalid/u,
    },
  ]
  let reviewCalls = 0
  for (const [index, item] of invalidStates.entries()) {
    const root = mkdtempSync(join(tmpdir(), `spec-invalid-${item.field}-`))
    const url = `https://example.test/a/invalid${index}`
    const paths = localStatePaths(url, () => root)
    const invalid = item.update(newLocalState(specMetrics(specData().content)))
    mkdirSync(dirname(paths.statePath), { recursive: true })
    writeFileSync(paths.statePath, JSON.stringify(invalid))
    try {
      await assert.rejects(
        () =>
          main({
            acquireActivity: noActivityLock,
            argv: ['--artifact-url', url, '--version-id', 'spec-v1'],
            run: workspaceRun(root, []),
            review: () => {
              reviewCalls += 1
              return Promise.resolve(
                JSON.stringify({ verdict: 'GO', findings: [] }),
              )
            },
            log: () => {},
          }),
        item.error,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  assert.equal(reviewCalls, 0)
})

test('legacy conversion bounds entries while preserving lifetime rounds and latest findings', async () => {
  assert.throws(
    () =>
      localStateFromLegacy(
        { baseline_metrics: {} },
        { size: 1, conceptCount: 0 },
      ),
    /finite nonnegative baseline/u,
  )
  const converted = localStateFromLegacy(
    {
      versions: [
        { version_id: 'v1', input_fingerprint: 'one', round: 1 },
        {
          version_id: 'v2',
          input_fingerprint: 'two',
          round: 2,
          findings: [{ id: 'x', severity: 'follow_up', summary: 'drop' }],
        },
        { version_id: 'v3', input_fingerprint: 'three', round: 3 },
        { version_id: 'v4', input_fingerprint: 'four', round: 4 },
        {
          version_id: 'v5',
          input_fingerprint: 'five',
          round: 5,
          findings: [{ id: 'latest', severity: 'blocker', summary: 'drop' }],
        },
      ],
    },
    { size: 1, conceptCount: 0 },
  )
  assert.equal(converted.round_count, 5)
  assert.deepEqual(
    converted.reviews.map(({ version_id }) => version_id),
    ['v3', 'v4', 'v5'],
  )
  assert.deepEqual(converted.latest.findings, [
    { id: 'reviewer:1', reviewer: 'reviewer', severity: 'blocker' },
  ])

  const root = mkdtempSync(join(tmpdir(), 'spec-legacy-round-cap-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  writeLocalStateAtomic(paths.statePath, converted)
  let reviewCalls = 0
  const logs = []
  try {
    const code = await main({
      acquireActivity: noActivityLock,
      argv: ['--artifact-url', url, '--version-id', 'spec-v6'],
      run: workspaceRun(root, [], [envelope({ version_id: 'spec-v6' })]),
      review: () => {
        reviewCalls += 1
        return Promise.resolve(JSON.stringify({ verdict: 'GO', findings: [] }))
      },
      log: (value) => logs.push(value),
    })
    assert.equal(code, 2)
    assert.equal(reviewCalls, 0)
    const cap = JSON.parse(logs[0])
    assert.equal(cap.rounds, 5)
    assert.match(cap.note, /\(5 completed rounds\)/u)
    const stored = readLocalState(paths.statePath)
    assert.equal(stored.round_count, 5)
    assert.equal(stored.reviews.length, 3)
    assert.deepEqual(stored.latest.findings, converted.latest.findings)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('native built-in evidence cannot satisfy the controlled-review method', () => {
  const state = newLocalState(
    { size: 10, conceptCount: 1 },
    0,
    specificationDrafting,
  )
  state.latest = { version_id: 'v1', input_fingerprint: 'same', findings: [] }
  assert.equal(findCompletedVersion(state, 'v1', 'same'), undefined)
  assert.equal(
    findCompletedVersion(
      { ...state, profile: specReviewProfile },
      'v1',
      'same',
    ),
    state.latest,
  )
})

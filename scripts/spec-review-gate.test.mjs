import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
  stateDigest,
  stateFromComments,
  stateFromRecord,
  validateDispositions,
  waitForBoth,
  writeLocalStateAtomic,
} from './spec-review-gate.mjs'
import { reviewStateMarkers } from './spec-review-input.mjs'

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

test('upgrades a matching legacy comment fingerprint for local reuse', () => {
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
  assert.ok(findCompletedVersion(migrated, 'spec-v1', fingerprint))
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
  try {
    const code = await main({
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
      log: () => {},
    })
    assert.equal(code, 0)
    assert.equal(snapshots.length, 2)
    assert.deepEqual(snapshots[0][1], snapshots[1][1])
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

test('output failure preserves the last completed local state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spec-output-failure-'))
  const url = 'https://example.test/a/spec'
  const paths = localStatePaths(url, () => root)
  const prior = newLocalState({ size: 10, conceptCount: 1 })
  writeLocalStateAtomic(paths.statePath, prior)
  try {
    await assert.rejects(
      () =>
        main({
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
    assert.deepEqual(readLocalState(paths.statePath), prior)
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
  const state = newLocalState({ size: 1, conceptCount: 0 })
  state.latest = {
    version_id: 'v1',
    input_fingerprint: 'same',
    round: 1,
    findings: [{ id: 'codex:a' }, { id: 'claude:b' }],
  }
  assert.ok(findCompletedVersion(state, 'v1', 'same'))
  assert.throws(() => validateDispositions({}, [], undefined), /every prior/u)
  assert.throws(
    () =>
      validateDispositions(
        { prior_findings: [{ id: 'codex:a' }] },
        state.latest.findings,
      ),
    /every prior/u,
  )
  assert.doesNotThrow(() =>
    validateDispositions(
      { prior_findings: [{ id: 'codex:a' }, { id: 'claude:b' }] },
      state.latest.findings,
    ),
  )
  const legacyPrior = [{ id: 'codex:old-name' }, { id: 'claude:old-name' }]
  const legacyDigest = createHash('sha256')
    .update(JSON.stringify(legacyPrior.map(({ id }) => id).sort()))
    .digest('hex')
  assert.doesNotThrow(() =>
    validateDispositions(
      { prior_findings: legacyPrior },
      [{ id: 'codex:1' }, { id: 'claude:1' }],
      legacyDigest,
    ),
  )
  assert.deepEqual(
    compactFindings([
      { id: 'a', reviewer: 'codex', severity: 'blocker', summary: 'drop' },
    ]),
    [{ id: 'codex:1', reviewer: 'codex', severity: 'blocker' }],
  )
})

test('legacy conversion preserves all round metadata but only latest findings', () => {
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
      ],
    },
    { size: 1, conceptCount: 0 },
  )
  assert.equal(converted.reviews.length, 2)
  assert.deepEqual(converted.latest.findings, [
    { id: 'reviewer:1', reviewer: 'reviewer', severity: 'follow_up' },
  ])
})

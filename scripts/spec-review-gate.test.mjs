import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assertSameProjectPlacement,
  findCompletedVersion,
  hydrateTrackedState,
  main,
  marker,
  parseArgs,
  persistState,
  persistStateRecord,
  recordMarker,
  reviewInputFingerprint,
  stateDigest,
  stateFromComments,
  stateFromRecord,
  validateDispositions,
  waitForBoth,
} from './spec-review-gate.mjs'
import { reviewStateMarkers } from './spec-review-input.mjs'

test('parses a spec gate and explicit owner reset', () => {
  assert.deepEqual(
    parseArgs([
      '--artifact-url',
      'https://example.test/a/x',
      '--version-id',
      'v1',
    ]),
    {
      artifact_url: 'https://example.test/a/x',
      version_id: 'v1',
    },
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

test('rejects a specification moved during review', () => {
  assert.doesNotThrow(() =>
    assertSameProjectPlacement('project-1', 'project-1'),
  )
  assert.throws(
    () => assertSameProjectPlacement('project-1', 'project-2'),
    /placement changed/u,
  )
  assert.throws(
    () => assertSameProjectPlacement('project-1', null),
    /placement changed/u,
  )
})

test('owner reset bypasses an unreadable current state record', async () => {
  const pointer = {
    generation: 4,
    revision: 2,
    record_url: 'https://example.test/a/missing-record',
    record_version_id: 'missing-v2',
    state_sha256: 'unavailable',
  }
  const invocations = []
  await assert.doesNotReject(() =>
    main({
      argv: [
        '--artifact-url',
        'https://example.test/a/spec',
        '--version-id',
        'spec-v1',
        '--reset',
      ],
      log: () => {},
      run: (_file, args) => {
        invocations.push(args)
        if (args.includes('whoami'))
          return JSON.stringify({
            ok: true,
            data: { user: { email: 'owner@example.test' } },
          })
        if (args.includes('share'))
          return JSON.stringify({
            ok: true,
            data: {
              artifact: { url: 'https://example.test/a/reset-record' },
              version: { id: 'reset-v1' },
            },
          })
        if (args.includes('post')) return JSON.stringify({ ok: true, data: {} })
        if (args.includes('get')) {
          const target = args[args.indexOf('get') + 1]
          if (target === pointer.record_url)
            throw new Error('current record is unreadable')
          return JSON.stringify({
            ok: true,
            data: {
              content: `## Scope lock\n\n### Owner decisions\n\n- Keep scope.\n\n### Non-goals\n\n- Expansion.\n\n### Acceptance criteria\n\n- Recovery works.`,
              version_id: 'spec-v1',
              project_id: 'project-1',
              truncated: false,
              comments_has_more: false,
              comments: [
                {
                  id: 'state-thread',
                  status: 'open',
                  messages: [
                    {
                      message_id: 'state-message',
                      author_email: 'owner@example.test',
                      body: `${marker}\n${JSON.stringify(pointer)}`,
                    },
                  ],
                },
              ],
            },
          })
        }
        throw new Error(`unexpected invocation: ${args.join(' ')}`)
      },
    }),
  )
  assert.ok(
    !invocations.some(
      (args) =>
        args.includes('get') &&
        args[args.indexOf('get') + 1] === pointer.record_url,
    ),
  )
})

test('owner reset rejects a specification moved while its pointer is persisted', async () => {
  let specReads = 0
  await assert.rejects(
    () =>
      main({
        argv: [
          '--artifact-url',
          'https://example.test/a/spec',
          '--version-id',
          'spec-v1',
          '--reset',
        ],
        log: () => {},
        run: (_file, args) => {
          if (args.includes('whoami'))
            return JSON.stringify({
              ok: true,
              data: { user: { email: 'owner@example.test' } },
            })
          if (args.includes('share'))
            return JSON.stringify({
              ok: true,
              data: {
                artifact: { url: 'https://example.test/a/reset-record' },
                version: { id: 'reset-v1' },
              },
            })
          if (args.includes('post'))
            return JSON.stringify({ ok: true, data: {} })
          if (args.includes('get')) {
            specReads += 1
            return JSON.stringify({
              ok: true,
              data: {
                content: `## Scope lock\n\n### Owner decisions\n\n- Keep scope.\n\n### Non-goals\n\n- Expansion.\n\n### Acceptance criteria\n\n- Recovery works.`,
                version_id: 'spec-v1',
                project_id: specReads === 1 ? 'project-1' : 'project-2',
                truncated: false,
                comments_has_more: false,
                comments: [],
              },
            })
          }
          throw new Error(`unexpected invocation: ${args.join(' ')}`)
        },
      }),
    /placement changed/u,
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

test('finds a durable state pointer in Artifact Share comments', () => {
  const pointer = {
    generation: 1,
    revision: 2,
    record_url: 'https://example.test/a/record',
    record_version_id: 'record-v2',
    state_sha256: 'abc',
  }
  const value = stateFromComments(
    [
      {
        id: 't1',
        status: 'open',
        messages: [
          {
            message_id: 'm1',
            author_email: 'owner@example.test',
            body: `${marker}\n${JSON.stringify(pointer)}`,
          },
        ],
      },
    ],
    'owner@example.test',
  )
  assert.deepEqual(value, {
    threadId: 't1',
    threadStatus: 'open',
    messageId: 'm1',
    generation: 1,
    revision: 2,
    pointer,
  })
})

test('skips malformed state messages without crashing', () => {
  assert.equal(
    stateFromComments(
      [{ id: 't1', messages: [{ body: { malformed: true } }] }],
      'owner@example.test',
    ),
    undefined,
  )
})

test('reads legacy inline state while migrating to record pointers', () => {
  const state = { generation: 1, revision: 0, versions: [] }
  const value = stateFromComments(
    [
      {
        id: 'legacy-thread',
        messages: [
          {
            message_id: 'legacy-message',
            author_email: 'owner@example.test',
            body: `${reviewStateMarkers[1]}\n${JSON.stringify(state)}`,
          },
        ],
      },
    ],
    'owner@example.test',
  )
  assert.deepEqual(value?.state, state)
})

test('prefers a newer reset generation and rejects same-revision divergence', () => {
  const comments = [
    {
      id: 't1',
      messages: [
        {
          message_id: 'old',
          author_email: 'owner@example.test',
          body: `${marker}\n${JSON.stringify({ generation: 0, revision: 3, versions: [{ version_id: 'v3' }] })}`,
        },
        {
          message_id: 'reset',
          author_email: 'owner@example.test',
          body: `${marker}\n${JSON.stringify({ generation: 1, revision: 0, versions: [] })}`,
        },
      ],
    },
  ]
  assert.equal(
    stateFromComments(comments, 'owner@example.test').messageId,
    'reset',
  )
  comments[0].messages.push({
    message_id: 'fork',
    author_email: 'owner@example.test',
    body: `${marker}\n${JSON.stringify({ generation: 1, revision: 0, versions: [{ version_id: 'fork' }] })}`,
  })
  assert.throws(
    () => stateFromComments(comments, 'owner@example.test'),
    /divergent/u,
  )
  assert.equal(
    stateFromComments(comments, 'owner@example.test', {
      allowDivergence: true,
    }).pointer.generation,
    1,
  )
})

test('stores full state in a private Artifact and only its pointer in comments', () => {
  const state = {
    generation: 2,
    revision: 3,
    versions: [{ findings: [{ summary: 'x'.repeat(6000) }] }],
  }
  let recordContent
  let commentBody
  const pointer = persistState({
    artifactUrl: 'https://example.test/a/spec',
    threadId: 'thread-1',
    state,
    run: (_file, args) => {
      if (args.includes('share')) {
        const path = args[args.indexOf('share') + 1]
        recordContent = readFileSync(path, 'utf8')
        assert.ok(args.includes('--home'))
        assert.deepEqual(
          args.slice(
            args.indexOf('--visibility'),
            args.indexOf('--visibility') + 2,
          ),
          ['--visibility', 'private'],
        )
        return JSON.stringify({
          ok: true,
          data: {
            artifact: { url: 'https://example.test/a/record' },
            version: { id: 'record-v1' },
          },
        })
      }
      commentBody = args[args.indexOf('--body') + 1]
      assert.ok(args.includes('thread-1'))
      return JSON.stringify({ ok: true, data: {} })
    },
  })
  assert.ok(recordContent.length > 4000)
  assert.ok(commentBody.length < 1000)
  assert.equal(pointer.state_sha256, stateDigest(state))
  assert.equal(pointer.record_version_id, 'record-v1')
})

test('stores project review state privately in the same project without notifying Slack', () => {
  const invocations = []
  persistState({
    artifactUrl: 'https://example.test/a/spec',
    projectId: 'project-1',
    state: { generation: 0, revision: 1, versions: [] },
    run: (_file, args) => {
      invocations.push(args)
      if (args.includes('share'))
        return JSON.stringify({
          ok: true,
          data: {
            artifact: { url: 'https://example.test/a/record' },
            version: { id: 'record-v1' },
          },
        })
      return JSON.stringify({ ok: true, data: {} })
    },
  })
  const shareArgs = invocations.find((args) => args.includes('share'))
  assert.ok(shareArgs.includes('--project-id'))
  assert.equal(shareArgs[shareArgs.indexOf('--project-id') + 1], 'project-1')
  assert.deepEqual(
    shareArgs.slice(
      shareArgs.indexOf('--visibility'),
      shareArgs.indexOf('--visibility') + 2,
    ),
    ['--visibility', 'private'],
  )
  assert.ok(shareArgs.includes('--no-slack-notify'))
  assert.ok(!shareArgs.includes('--home'))
})

test('deletes an unreferenced review record when pointer posting fails', () => {
  const invocations = []
  assert.throws(
    () =>
      persistState({
        artifactUrl: 'https://example.test/a/spec',
        state: { generation: 0, revision: 1, versions: [] },
        run: (_file, args) => {
          invocations.push(args)
          if (args.includes('share'))
            return JSON.stringify({
              ok: true,
              data: {
                artifact: { url: 'https://example.test/a/record' },
                version: { id: 'record-v1' },
              },
            })
          if (args.includes('delete'))
            return JSON.stringify({ ok: true, data: { deleted: true } })
          if (args.includes('get'))
            return JSON.stringify({
              ok: true,
              data: { comments: [], comments_has_more: false },
            })
          return JSON.stringify({ ok: false, error: { code: 'failed' } })
        },
      }),
    /Could not persist Artifact Share review pointer/u,
  )
  const deleteArgs = invocations.find((args) => args.includes('delete'))
  assert.equal(
    deleteArgs[deleteArgs.indexOf('delete') + 1],
    'https://example.test/a/record',
  )
})

test('keeps a record when a lost response hides a committed pointer', () => {
  const invocations = []
  let pointerBody
  const pointer = persistState({
    artifactUrl: 'https://example.test/a/spec',
    state: { generation: 0, revision: 1, versions: [] },
    run: (_file, args) => {
      invocations.push(args)
      if (args.includes('share'))
        return JSON.stringify({
          ok: true,
          data: {
            artifact: { url: 'https://example.test/a/record' },
            version: { id: 'record-v1' },
          },
        })
      if (args.includes('post')) {
        pointerBody = args[args.indexOf('--body') + 1]
        throw new Error('response lost')
      }
      if (args.includes('get'))
        return JSON.stringify({
          ok: true,
          data: {
            comments: [{ messages: [{ body: pointerBody }] }],
            comments_has_more: false,
          },
        })
      throw new Error('unexpected invocation')
    },
  })
  assert.equal(pointer.record_url, 'https://example.test/a/record')
  assert.ok(!invocations.some((args) => args.includes('delete')))
})

test('retains a possibly referenced record when pointer reconciliation is incomplete', () => {
  const invocations = []
  assert.throws(
    () =>
      persistState({
        artifactUrl: 'https://example.test/a/spec',
        state: { generation: 0, revision: 1, versions: [] },
        run: (_file, args) => {
          invocations.push(args)
          if (args.includes('share'))
            return JSON.stringify({
              ok: true,
              data: {
                artifact: { url: 'https://example.test/a/record' },
                version: { id: 'record-v1' },
              },
            })
          throw new Error('network unavailable')
        },
      }),
    /record was retained/u,
  )
  assert.ok(!invocations.some((args) => args.includes('delete')))
})

test('retains a record when a timed-out pointer is not visible yet', () => {
  const invocations = []
  assert.throws(
    () =>
      persistState({
        artifactUrl: 'https://example.test/a/spec',
        state: { generation: 0, revision: 1, versions: [] },
        run: (_file, args) => {
          invocations.push(args)
          if (args.includes('share'))
            return JSON.stringify({
              ok: true,
              data: {
                artifact: { url: 'https://example.test/a/record' },
                version: { id: 'record-v1' },
              },
            })
          if (args.includes('post')) throw new Error('response timed out')
          if (args.includes('get'))
            return JSON.stringify({
              ok: true,
              data: { comments: [], comments_has_more: false },
            })
          throw new Error('unexpected invocation')
        },
      }),
    /record was retained/u,
  )
  assert.ok(!invocations.some((args) => args.includes('delete')))
})

test('cleans up a created record when its success response lacks a version', () => {
  const invocations = []
  assert.throws(
    () =>
      persistStateRecord(
        { generation: 0, revision: 1, versions: [] },
        {
          run: (_file, args) => {
            invocations.push(args)
            if (args.includes('delete'))
              return JSON.stringify({ ok: true, data: { deleted: true } })
            return JSON.stringify({
              ok: true,
              data: { artifact: { url: 'https://example.test/a/record' } },
            })
          },
        },
      ),
    /Could not persist Artifact Share review record/u,
  )
  assert.ok(invocations.some((args) => args.includes('delete')))
})

test('hydrates and verifies exact state from its Artifact pointer', () => {
  const state = { generation: 1, revision: 4, versions: [] }
  const pointer = {
    generation: 1,
    revision: 4,
    record_url: 'https://example.test/a/record',
    record_version_id: 'record-v4',
    state_sha256: stateDigest(state),
  }
  const run = () =>
    JSON.stringify({
      ok: true,
      data: {
        version_id: 'record-v4',
        project_id: 'project-1',
        content: `${recordMarker}\n${JSON.stringify(state)}`,
        truncated: false,
        next_offset: null,
      },
    })
  assert.deepEqual(stateFromRecord(pointer, run), state)
  assert.deepEqual(
    hydrateTrackedState({ pointer, messageId: 'm4' }, run, 'project-1')?.state,
    state,
  )
  assert.throws(
    () => stateFromRecord(pointer, run, 'project-2'),
    /unavailable or stale/u,
  )
  assert.throws(
    () => stateFromRecord({ ...pointer, state_sha256: 'wrong' }, run),
    /integrity/u,
  )
})

test('reads every page of a large review state record', () => {
  const state = {
    generation: 3,
    revision: 7,
    versions: [{ findings: [{ summary: 'x'.repeat(210_000) }] }],
  }
  const content = `${recordMarker}\n${JSON.stringify(state)}`
  const pointer = {
    generation: 3,
    revision: 7,
    record_url: 'https://example.test/a/record',
    record_version_id: 'record-v7',
    state_sha256: stateDigest(state),
  }
  let calls = 0
  const run = (_file, args) => {
    calls += 1
    const offsetIndex = args.indexOf('--offset')
    if (calls === 1) assert.equal(offsetIndex, -1)
    else assert.equal(args[offsetIndex + 1], '200000')
    return JSON.stringify({
      ok: true,
      data: {
        version_id: 'record-v7',
        content:
          calls === 1 ? content.slice(0, 200_000) : content.slice(200_000),
        truncated: calls === 1,
        next_offset: calls === 1 ? 200_000 : null,
      },
    })
  }
  assert.deepEqual(stateFromRecord(pointer, run), state)
  assert.equal(calls, 2)
})

test('ignores state comments from another identity', () => {
  const comments = [
    {
      id: 't1',
      messages: [
        {
          message_id: 'forged',
          author_email: 'other@example.test',
          body: `${marker}\n{"generation":9,"revision":9,"versions":[]}`,
        },
      ],
    },
  ]
  assert.throws(
    () => stateFromComments(comments, 'owner@example.test'),
    /another identity/u,
  )
})

test('ignores a foreign state when trusted state exists', () => {
  const comments = [
    {
      id: 't1',
      messages: [
        {
          message_id: 'trusted',
          author_email: 'owner@example.test',
          body: `${marker}\n{"generation":0,"revision":1,"versions":[]}`,
        },
        {
          message_id: 'forged',
          author_email: 'other@example.test',
          body: `${marker}\n{"generation":9,"revision":9,"versions":[]}`,
        },
      ],
    },
  ]
  assert.equal(
    stateFromComments(comments, 'owner@example.test').messageId,
    'trusted',
  )
})

test('requires dispositions for every prior reviewer finding', () => {
  const prior = [{ id: 'codex:a' }, { id: 'claude:b' }]
  assert.throws(
    () => validateDispositions({ prior_findings: [{ id: 'codex:a' }] }, prior),
    /every prior/u,
  )
  assert.doesNotThrow(() =>
    validateDispositions({ prior_findings: prior }, prior),
  )
  assert.doesNotThrow(() => validateDispositions({ prior_findings: [] }, []))
})

test('changes the review input fingerprint with unresolved comments', () => {
  const original = [{ id: 't1', messages: [{ body: 'first' }] }]
  const changed = [{ id: 't1', messages: [{ body: 'second' }] }]
  assert.notEqual(
    reviewInputFingerprint(original),
    reviewInputFingerprint(changed),
  )
})

test('does not treat a stripped historical result as a cacheable result', () => {
  const versions = [
    { version_id: 'v1', input_fingerprint: 'same', round: 1 },
    {
      version_id: 'v2',
      input_fingerprint: 'new',
      round: 2,
      findings: [],
    },
  ]
  assert.equal(findCompletedVersion(versions, 'v1', 'same'), undefined)
})

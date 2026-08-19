import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findCompletedVersion,
  marker,
  parseArgs,
  reviewInputFingerprint,
  stateFromComments,
  validateDispositions,
  waitForBoth,
} from './spec-review-gate.mjs'

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

test('finds durable state in Artifact Share comments', () => {
  const value = stateFromComments(
    [
      {
        id: 't1',
        status: 'open',
        messages: [
          {
            message_id: 'm1',
            author_email: 'owner@example.test',
            body: `${marker}\n{"versions":[]}`,
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
    state: { versions: [] },
  })
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
    }).state.generation,
    1,
  )
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

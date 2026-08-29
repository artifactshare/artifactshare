import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  codexNotificationRegistration,
  codexQueueMessage,
  createCodexQueueAdapter,
  type CodexQueueInvocation,
} from './codex-notification.js'

const THREAD = '123e4567-e89b-42d3-a456-426614174000'

test('registers a matching Codex thread from trusted local environment', () => {
  assert.deepEqual(
    codexNotificationRegistration(
      { CODEX_THREAD_ID: THREAD, CODEX_SESSION_ID: THREAD },
      () => new Date('2026-08-29T00:00:00.000Z'),
    ),
    {
      provider: 'codex',
      transport: 'codex_queue',
      capability: 'push',
      target: THREAD,
      registered_at: '2026-08-29T00:00:00.000Z',
    },
  )
})

test('does not claim push capability for invalid or conflicting identifiers', () => {
  assert.equal(codexNotificationRegistration({}), null)
  for (const environment of [
    { CODEX_THREAD_ID: 'not-a-uuid' },
    {
      CODEX_THREAD_ID: THREAD,
      CODEX_SESSION_ID: '223e4567-e89b-42d3-a456-426614174000',
    },
  ]) {
    const registration = codexNotificationRegistration(environment)
    assert.equal(registration?.provider, 'codex')
    assert.equal(registration?.capability, 'manual')
    assert.equal(registration?.target, null)
  }
})

test('queues only a fixed batch-ready message to the registered thread', async () => {
  const invocations: CodexQueueInvocation[] = []
  const adapter = createCodexQueueAdapter(THREAD, async (invocation) => {
    invocations.push(invocation)
  })
  const result = await adapter.dispatch({
    event: 'preview.batch_ready',
    preview_session_id: '0123456789abcdef',
    batch_id: 'batch-1',
  })
  assert.deepEqual(result, { status: 'accepted' })
  assert.deepEqual(invocations, [
    {
      command: 'codex',
      args: [
        'queue',
        '--thread',
        THREAD,
        '--message',
        codexQueueMessage({
          event: 'preview.batch_ready',
          preview_session_id: '0123456789abcdef',
          batch_id: 'batch-1',
        }),
      ],
    },
  ])
  assert.equal(JSON.stringify(invocations).includes('comment'), false)
})

test('maps queue rejection and a missing executable to safe failures', async () => {
  const rejected = createCodexQueueAdapter(THREAD, async () => {
    throw Object.assign(new Error('no rollout found'), { code: 1 })
  })
  assert.deepEqual(
    await rejected.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    { status: 'failed', code: 'rejected', retryable: false },
  )

  const missing = createCodexQueueAdapter(THREAD, async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  assert.deepEqual(
    await missing.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    { status: 'failed', code: 'target_unavailable', retryable: false },
  )
})

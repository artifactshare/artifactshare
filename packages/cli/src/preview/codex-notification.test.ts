import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  codexNotificationRegistration,
  codexQueueInvocation,
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

test('prefers the Codex thread id and falls back to the session id', () => {
  assert.equal(codexNotificationRegistration({}), null)
  assert.equal(
    codexNotificationRegistration({
      CODEX_THREAD_ID: THREAD,
      CODEX_SESSION_ID: '223e4567-e89b-42d3-a456-426614174000',
    })?.target,
    THREAD,
  )
  assert.equal(
    codexNotificationRegistration({
      CODEX_THREAD_ID: 'not-a-uuid',
      CODEX_SESSION_ID: THREAD,
    })?.target,
    THREAD,
  )
  const invalid = codexNotificationRegistration({
    CODEX_THREAD_ID: 'not-a-uuid',
  })
  assert.equal(invalid?.capability, 'manual')
  assert.equal(invalid?.target, null)
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

test('uses the Windows command interpreter only for validated fixed input', () => {
  const event = {
    event: 'preview.batch_ready' as const,
    preview_session_id: '0123456789abcdef',
    batch_id: '123e4567-e89b-42d3-a456-426614174000',
  }
  assert.deepEqual(
    codexQueueInvocation(THREAD, event, 'win32', 'C:\\Windows\\cmd.exe'),
    {
      command: 'C:\\Windows\\cmd.exe',
      windowsVerbatimArguments: true,
      args: [
        '/d',
        '/s',
        '/c',
        `codex queue --thread ${THREAD} --message "${codexQueueMessage(event)}"`,
      ],
    },
  )
  assert.equal(
    codexQueueInvocation(THREAD, { ...event, batch_id: 'x & whoami' }, 'win32'),
    null,
  )
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

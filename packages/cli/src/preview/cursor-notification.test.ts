import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  createCursorAcpAdapter,
  cursorNotificationRegistration,
} from './cursor-notification.js'

const target = JSON.stringify({
  schema_version: 1,
  endpoint: 'http://127.0.0.1:43172/preview-batch',
  token: 'a'.repeat(64),
  pid: process.pid,
  session_id: 'cursor-acp-session',
  cwd: '/workspace',
})

test('registers managed ACP, explicit foreground wait, and ordinary Cursor as distinct capabilities', () => {
  const now = () => new Date('2026-08-29T00:00:00.000Z')
  assert.deepEqual(
    cursorNotificationRegistration(
      { ARTIFACTSHARE_CURSOR_ACP_TARGET: target },
      now,
    ),
    {
      provider: 'cursor',
      transport: 'acp_managed',
      capability: 'push',
      target,
      registered_at: '2026-08-29T00:00:00.000Z',
    },
  )
  assert.deepEqual(
    cursorNotificationRegistration(
      { CURSOR_AGENT: '1', ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT: '1' },
      now,
    ),
    {
      provider: 'cursor',
      transport: 'foreground_wait',
      capability: 'wait',
      target: null,
      registered_at: '2026-08-29T00:00:00.000Z',
    },
  )
  assert.equal(
    cursorNotificationRegistration({ CURSOR_AGENT: '1' }, now)?.capability,
    'manual',
  )
  assert.equal(cursorNotificationRegistration({}, now), null)
})

test('rejects malformed managed targets instead of claiming push', () => {
  const registration = cursorNotificationRegistration({
    ARTIFACTSHARE_CURSOR_ACP_TARGET: JSON.stringify({
      ...JSON.parse(target),
      endpoint: 'https://example.test/preview-batch',
    }),
  })
  assert.equal(registration?.capability, 'manual')
  assert.equal(registration?.target, null)
})

test('ACP adapter sends only the fixed batch-ready event', async () => {
  let sent: unknown
  const adapter = createCursorAcpAdapter(target, async (_input, init) => {
    sent = JSON.parse(String(init?.body))
    return new Response(null, { status: 202 })
  })
  assert.deepEqual(
    await adapter.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    { status: 'accepted' },
  )
  assert.deepEqual(sent, {
    event: 'preview.batch_ready',
    preview_session_id: '0123456789abcdef',
    batch_id: 'batch-1',
  })
  assert.equal(JSON.stringify(sent).includes('comment'), false)
})

test('ACP adapter retains a busy or unavailable batch as retryable', async () => {
  const busy = createCursorAcpAdapter(
    target,
    async () => new Response(null, { status: 409 }),
  )
  assert.deepEqual(
    await busy.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    {
      status: 'failed',
      code: 'rejected',
      retryable: true,
    },
  )
  const missing = createCursorAcpAdapter(target, async () => {
    throw new Error('bridge stopped')
  })
  assert.deepEqual(
    await missing.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    {
      status: 'failed',
      code: 'target_unavailable',
      retryable: true,
    },
  )
})

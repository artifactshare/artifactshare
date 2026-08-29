import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import {
  claudeNotificationRegistration,
  createClaudeChannelAdapter,
  writeClaudeChannelRecord,
} from './claude-notification.js'

const SESSION = 'claude-session-1671'
const temporaryDirectories: string[] = []

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'artifactshare-claude-'))
  temporaryDirectories.push(root)
  return {
    ARTIFACTSHARE_CONFIG_HOME: root,
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...extra,
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('registers Claude background wait by default and manual when disabled', () => {
  assert.deepEqual(
    claudeNotificationRegistration(
      environment(),
      () => new Date('2026-08-29T00:00:00.000Z'),
    ),
    {
      provider: 'claude_code',
      transport: 'background_wait',
      capability: 'wait',
      target: null,
      registered_at: '2026-08-29T00:00:00.000Z',
    },
  )
  assert.equal(
    claudeNotificationRegistration(
      environment({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
    )?.capability,
    'manual',
  )
  assert.equal(
    claudeNotificationRegistration(
      environment({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'TRUE' }),
    )?.capability,
    'manual',
  )
  assert.equal(claudeNotificationRegistration({}), null)
})

test('registers Channel push only after a live acknowledged record exists', () => {
  const env = environment()
  writeClaudeChannelRecord(
    {
      schema_version: 1,
      claude_session_id: SESSION,
      endpoint: 'http://127.0.0.1:43210/preview-batch',
      token: 'a'.repeat(64),
      pid: process.pid,
      acknowledged_at: '2026-08-29T00:00:00.000Z',
    },
    env,
  )
  const registration = claudeNotificationRegistration(env)
  assert.equal(registration?.provider, 'claude_code')
  assert.equal(registration?.transport, 'channel')
  assert.equal(registration?.capability, 'push')
  assert.notEqual(registration?.target, null)
})

test('Channel adapter sends only fixed identifiers and requires matching acknowledgement', async () => {
  const env = environment()
  const target = JSON.stringify({
    schema_version: 1,
    claude_session_id: SESSION,
    endpoint: 'http://127.0.0.1:43210/preview-batch',
    token: 'b'.repeat(64),
    pid: process.pid,
    acknowledged_at: '2026-08-29T00:00:00.000Z',
  })
  let sent: Record<string, unknown> | null = null
  const adapter = createClaudeChannelAdapter(
    target,
    env,
    async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          acknowledged: true,
          challenge: sent.challenge,
        }),
        { status: 200 },
      )
    },
  )
  assert.deepEqual(
    await adapter.dispatch({
      event: 'preview.batch_ready',
      preview_session_id: '0123456789abcdef',
      batch_id: 'batch-1',
    }),
    { status: 'accepted' },
  )
  assert.deepEqual(Object.keys(sent ?? {}).sort(), [
    'batch_id',
    'challenge',
    'event',
    'preview_session_id',
  ])
  assert.equal(JSON.stringify(sent).includes('comment'), false)
})

test('Channel acknowledgement failure falls back to background wait', async () => {
  const env = environment()
  const target = JSON.stringify({
    schema_version: 1,
    claude_session_id: SESSION,
    endpoint: 'http://127.0.0.1:43210/preview-batch',
    token: 'c'.repeat(64),
    pid: process.pid,
    acknowledged_at: '2026-08-29T00:00:00.000Z',
  })
  const adapter = createClaudeChannelAdapter(
    target,
    env,
    async () =>
      new Response(JSON.stringify({ acknowledged: false }), { status: 504 }),
  )
  const result = await adapter.dispatch({
    event: 'preview.batch_ready',
    preview_session_id: '0123456789abcdef',
    batch_id: 'batch-1',
  })
  assert.equal(result.status, 'failed')
  assert.equal(
    result.status === 'failed' && result.fallback?.transport,
    'background_wait',
  )
  assert.equal(
    result.status === 'failed' && result.fallback?.capability,
    'wait',
  )
})

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { claudeNotificationRegistration } from './claude-notification.js'

test('registers Claude background wait by default and manual when disabled', () => {
  assert.deepEqual(
    claudeNotificationRegistration(
      { CLAUDE_CODE_SESSION_ID: 'claude-session' },
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
    claudeNotificationRegistration({
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    })?.capability,
    'manual',
  )
  assert.equal(
    claudeNotificationRegistration({
      CLAUDE_CODE_SESSION_ID: 'claude-session',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: 'TRUE',
    })?.capability,
    'manual',
  )
  assert.equal(
    claudeNotificationRegistration({ CLAUDE_CODE_SESSION_ID: 'invalid id' })
      ?.capability,
    'manual',
  )
  assert.equal(claudeNotificationRegistration({}), null)
})

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  createPreviewNotificationCoordinator,
  type PreviewAgentAdapter,
  type PreviewBatchReadyEvent,
} from './notification.js'
import { createPreviewStore } from './store.js'

function fixture(options?: {
  sessionId?: string
  adapter?: PreviewAgentAdapter
  timeoutMs?: number
}) {
  const store = createPreviewStore(
    join(mkdtempSync(join(tmpdir(), 'preview-notification-')), 'store.json'),
  )
  store.createDraft({ kind: 'artifact' }, 'secret comment')
  const submitted = store.submitDrafts()
  if (!submitted.ok || !submitted.batch) throw new Error('submission failed')
  const batch = submitted.batch
  const registration = {
    provider: 'fixture',
    transport: 'fixture_push',
    capability: 'push' as const,
    target: 'private-target',
    registered_at: '2026-08-29T00:00:00.000Z',
  }
  const coordinator = createPreviewNotificationCoordinator({
    sessionId: options?.sessionId ?? 'session-a',
    registration,
    store,
    ...(options?.adapter ? { adapter: options.adapter } : {}),
    ...(options?.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  })
  return { store, batch, coordinator }
}

test('accepted push exposes only the fixed batch-ready envelope', async () => {
  const events: PreviewBatchReadyEvent[] = []
  const { batch, coordinator } = fixture({
    adapter: {
      async dispatch(event) {
        events.push(event)
        return { status: 'accepted' }
      },
    },
  })
  await coordinator.notifyBatch(batch.id)
  assert.deepEqual(events, [
    {
      event: 'preview.batch_ready',
      preview_session_id: 'session-a',
      batch_id: batch.id,
    },
  ])
  assert.equal(JSON.stringify(events).includes('secret comment'), false)
  assert.deepEqual(coordinator.projection(), {
    provider: 'fixture',
    transport: 'fixture_push',
    capability: 'push',
    state: 'queued',
  })
})

test('failed and timed-out pushes normalize to fixed failure codes', async () => {
  const rejected = fixture({
    adapter: {
      async dispatch() {
        return { status: 'failed', code: 'rejected', retryable: false }
      },
    },
  })
  await rejected.coordinator.notifyBatch(rejected.batch.id)
  assert.equal(rejected.coordinator.projection().state, 'failed')
  assert.equal(rejected.coordinator.projection().failure_code, 'rejected')

  const timedOut = fixture({
    adapter: { dispatch: () => new Promise(() => undefined) },
    timeoutMs: 5,
  })
  await timedOut.coordinator.notifyBatch(timedOut.batch.id)
  assert.equal(timedOut.coordinator.projection().failure_code, 'timeout')
})

test('duplicate dispatches share one call and retain its completed result', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = fixture({
    adapter: {
      async dispatch() {
        calls += 1
        await gate
        return { status: 'accepted' }
      },
    },
  })
  const batchId = current.batch.id
  const first = current.coordinator.notifyBatch(batchId)
  const second = current.coordinator.notifyBatch(batchId)
  release?.()
  await Promise.all([first, second])
  await current.coordinator.notifyBatch(batchId)
  assert.equal(calls, 1)
})

test('session identity is never shared across coordinator instances', async () => {
  const sessions: string[] = []
  const adapter: PreviewAgentAdapter = {
    async dispatch(event) {
      sessions.push(event.preview_session_id)
      return { status: 'accepted' }
    },
  }
  const first = fixture({ sessionId: 'one', adapter })
  const second = fixture({ sessionId: 'two', adapter })
  await Promise.all([
    first.coordinator.notifyBatch(first.batch.id),
    second.coordinator.notifyBatch(second.batch.id),
  ])
  assert.deepEqual(sessions.sort(), ['one', 'two'])
})

test('a late adapter result cannot regress a batch already being processed', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const current = fixture({
    adapter: {
      async dispatch() {
        await gate
        return { status: 'failed', code: 'rejected', retryable: false }
      },
    },
  })
  const pending = current.coordinator.notifyBatch(current.batch.id)
  assert.equal(current.store.deliver().length, 1)
  release?.()
  await pending
  assert.equal(current.coordinator.projection().state, 'processing')
  assert.equal(current.coordinator.projection().failure_code, undefined)
})

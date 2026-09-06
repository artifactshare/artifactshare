import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureRetries, shouldRetryCapture } from './screen-capture.mjs'

test('reads the retry budget from the environment', () => {
  assert.equal(captureRetries({}), 2)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '0' }), 0)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '3' }), 3)
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '-1' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: 'many' }))
})

test('retries only readiness timeouts within the budget', () => {
  const timeout = { kind: 'readiness_timeout' }
  assert.equal(shouldRetryCapture(timeout, 0, 2), true)
  assert.equal(shouldRetryCapture(timeout, 1, 2), true)
  assert.equal(shouldRetryCapture(timeout, 2, 2), false)
  assert.equal(shouldRetryCapture(timeout, 0, 0), false)
  assert.equal(shouldRetryCapture({ kind: 'navigation' }, 0, 2), false)
  // A readiness timeout after an interaction is the interaction's fault.
  assert.equal(shouldRetryCapture(timeout, 0, 2, false), false)
})

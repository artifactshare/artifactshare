import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureRetries, shouldRetryCapture } from './screen-capture.mjs'
import {
  screenCaptureOutputDirectory,
  screenCaptureOutputRoot,
} from './screen-capture-output.mjs'

test('keeps default screen captures in the worktree Git directory', () => {
  const calls = []
  const root = screenCaptureOutputRoot((file, args) => {
    calls.push([file, args])
    return '/outside/repository.git/worktrees/example\n'
  })
  assert.equal(
    root,
    '/outside/repository.git/worktrees/example/artifactshare/screen-captures',
  )
  assert.deepEqual(calls, [['git', ['rev-parse', '--absolute-git-dir']]])
})

test('preserves an explicitly injected screen capture output root', () => {
  assert.equal(
    screenCaptureOutputDirectory('before', '/tmp/explicit-captures'),
    join('/tmp/explicit-captures', 'before'),
  )
})

test('reads the retry budget from the environment', () => {
  assert.equal(captureRetries({}), 2)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '0' }), 0)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '3' }), 3)
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '-1' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: 'many' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '1e3' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '11' }))
})

test('retries only readiness timeouts within the budget', () => {
  const timeout = { kind: 'readiness_timeout' }
  assert.equal(shouldRetryCapture(timeout, 0, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 1, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 2, 2, true), false)
  assert.equal(shouldRetryCapture(timeout, 0, 0, true), false)
  assert.equal(shouldRetryCapture({ kind: 'navigation' }, 0, 2, true), false)
  // A readiness timeout after an interaction is the interaction's fault.
  assert.equal(shouldRetryCapture(timeout, 0, 2, false), false)
})

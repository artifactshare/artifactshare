import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clickSettleMilliseconds,
  consumeFailedRequests,
  isExpectedMissingTargetFailure,
  parseWalkthroughArgs,
  shouldWaitForViewerReady,
} from './task-walkthrough-capture.mjs'
import { championLoopTaskIds } from './task-walkthroughs.mjs'

test('selects the champion loop in its canonical order', () => {
  assert.deepEqual(
    parseWalkthroughArgs(['--champion-loop', '--label', 'audit']),
    {
      selected: championLoopTaskIds,
      label: 'audit',
    },
  )
})

test('rejects ambiguous, missing, and unknown selections', () => {
  assert.throws(() => parseWalkthroughArgs([]), /Usage:/)
  assert.throws(
    () =>
      parseWalkthroughArgs([
        '--champion-loop',
        '--task',
        championLoopTaskIds[0],
      ]),
    /Usage:/,
  )
  assert.throws(
    () => parseWalkthroughArgs(['--task', 'missing']),
    /Unknown walkthrough task/,
  )
})

test('captures pending navigation and clicks before their ready delay', () => {
  assert.equal(shouldWaitForViewerReady('/a/example', 'networkidle'), true)
  assert.equal(
    shouldWaitForViewerReady('/a/example', 'domcontentloaded'),
    false,
  )
  assert.equal(clickSettleMilliseconds({ captureDuringNavigation: true }), 0)
  assert.equal(clickSettleMilliseconds({}), 500)
})

test('accepts only the intended missing-target CLI failure', () => {
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdateMissing', {
      ok: false,
      error: { code: 'target_not_found' },
    }),
    true,
  )
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdateMissing', {
      ok: false,
      error: { code: 'service_unavailable' },
    }),
    false,
  )
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdate', {
      ok: false,
      error: { code: 'target_not_found' },
    }),
    false,
  )
})

test('attributes failed requests to only the next captured phase', () => {
  const failedRequests = [{ url: 'https://example.test/failed' }]
  assert.deepEqual(consumeFailedRequests(failedRequests), [
    { url: 'https://example.test/failed' },
  ])
  assert.deepEqual(failedRequests, [])
  assert.deepEqual(consumeFailedRequests(failedRequests), [])
})

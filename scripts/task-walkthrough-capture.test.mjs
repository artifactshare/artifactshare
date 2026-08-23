import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clickSettleMilliseconds,
  combineWalkthroughAndCleanupErrors,
  isExpectedMissingTargetFailure,
  parseCliJsonOutput,
  parseWalkthroughArgs,
  redactEvidenceText,
  redactEvidenceUrl,
  requestOriginPhase,
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

test('parses CLI JSON after a Node TLS warning', () => {
  assert.deepEqual(
    parseCliJsonOutput(
      '(node:123) Warning: Setting NODE_TLS_REJECT_UNAUTHORIZED to 0\n' +
        '{"ok":false,"error":{"code":"target_not_found"}}\n',
      '',
    ),
    { ok: false, error: { code: 'target_not_found' } },
  )
})

test('keeps late request failures with their originating phase', () => {
  const request = {}
  const requestPhases = new WeakMap([[request, 'pending']])
  assert.equal(requestOriginPhase(requestPhases, request, 'success'), 'pending')
  assert.equal(requestOriginPhase(requestPhases, {}, 'success'), 'success')
})

test('redacts signed sandbox tokens from retained evidence URLs', () => {
  assert.equal(
    redactEvidenceUrl('https://artifact.sandbox.localhost/file.html?t=secret'),
    'https://artifact.sandbox.localhost/file.html?t=%5Bredacted%5D',
  )
  assert.equal(redactEvidenceUrl('not a URL'), 'not a URL')
  assert.equal(
    redactEvidenceText(
      'Loading https://artifact.sandbox.localhost/file.html?t=secret&mode=html',
    ),
    'Loading https://artifact.sandbox.localhost/file.html?t=[redacted]&mode=html',
  )
})

test('preserves the walkthrough failure when cleanup also fails', () => {
  const walkthroughError = new Error('navigation failed')
  const cleanupError = new Error('delete failed')
  const combined = combineWalkthroughAndCleanupErrors(
    walkthroughError,
    cleanupError,
  )
  assert.equal(combined.cause, walkthroughError)
  assert.deepEqual(combined.errors, [walkthroughError, cleanupError])
  assert.match(combined.message, /navigation failed.*delete failed/)
})

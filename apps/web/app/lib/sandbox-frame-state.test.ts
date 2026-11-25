import { describe, expect, test } from 'vitest'
import {
  classifySandboxProbeResponse,
  shouldAcceptNavigationResult,
  shouldReportBlock,
  shouldAttemptAutomaticRecovery,
  shouldStartLivenessCheck,
  shouldStartLivenessProbe,
} from './sandbox-frame-state'

// The blocked and paused copy is checked as catalog data in
// `app/i18n/catalog-parity.test.ts`; these are the state rules behind it.
describe('sandbox frame transitions', () => {
  test('liveness timer probes only when its generation is still current', () => {
    expect(shouldStartLivenessProbe(2, 2)).toBe(true)
    expect(shouldStartLivenessProbe(2, 3)).toBe(false)
  })
  test('stale navigation result is ignored', () => {
    expect(shouldAcceptNavigationResult(1, 2)).toBe(false)
  })
  test('reports once per navigation', () => {
    expect(shouldReportBlock(null, 3)).toBe(true)
    expect(shouldReportBlock(3, 3)).toBe(false)
  })
  test('requires the exposed marker header and exact body for reachability', () => {
    const marker = 'artifactshare-sandbox-probe-v1'
    expect(classifySandboxProbeResponse(200, marker, marker, marker)).toBe(
      'reachable',
    )
    expect(classifySandboxProbeResponse(200, null, marker, marker)).toBe(
      'network-error',
    )
    expect(classifySandboxProbeResponse(200, marker, 'other', marker)).toBe(
      'network-error',
    )
    expect(classifySandboxProbeResponse(403, null, '', marker)).toBe(
      'forbidden',
    )
  })
  test('checks visible resumes and persisted pageshow only', () => {
    expect(shouldStartLivenessCheck('visibilitychange', 'hidden')).toBe(false)
    expect(shouldStartLivenessCheck('visibilitychange', 'visible')).toBe(true)
    expect(shouldStartLivenessCheck('pageshow', 'hidden', true)).toBe(false)
    expect(shouldStartLivenessCheck('pageshow', 'visible', false)).toBe(false)
    expect(shouldStartLivenessCheck('pageshow', 'visible', true)).toBe(true)
  })
  test('bounds automatic recovery attempts', () => {
    expect(shouldAttemptAutomaticRecovery(0, 1)).toBe(true)
    expect(shouldAttemptAutomaticRecovery(1, 1)).toBe(false)
  })
})

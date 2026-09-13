import { describe, expect, test } from 'vitest'
import {
  ANALYTICS_CUSTOM_DIMENSIONS,
  ANALYTICS_DATA_RETENTION,
  ANALYTICS_EVENTS,
  ANALYTICS_KEY_EVENTS,
  ANALYTICS_PARAMS,
  GA4_DEFAULT_KEY_EVENTS,
  NON_DIMENSION_PARAMS,
  type AnalyticsEventPayload,
} from './events'

function payloadTypeChecks(): void {
  const valid = {
    name: 'first_artifact_posted',
    params: { channel: 'web', engagement_time_msec: 1 },
  } satisfies AnalyticsEventPayload
  const missing = {
    name: 'first_artifact_posted',
    // @ts-expect-error — server events require engagement time.
    params: { channel: 'web' },
  } satisfies AnalyticsEventPayload
  const wrong = {
    name: 'first_artifact_posted',
    // @ts-expect-error — server event value kinds are closed.
    params: { channel: 'web', engagement_time_msec: '1' },
  } satisfies AnalyticsEventPayload
  // @ts-expect-error — event names and payloads remain correlated.
  const mismatched: AnalyticsEventPayload = {
    name: 'page_view',
    params: valid.params,
  }
}

test('preserves public analytics compatibility exports and dimension coverage', () => {
  expect(NON_DIMENSION_PARAMS).toEqual([])
  expect(
    ANALYTICS_CUSTOM_DIMENSIONS.map(
      ({ parameterName }) => parameterName,
    ).sort(),
  ).toEqual(Object.values(ANALYTICS_PARAMS).sort())
  expect(ANALYTICS_KEY_EVENTS).toContain(ANALYTICS_EVENTS.firstArtifactPosted)
  expect(GA4_DEFAULT_KEY_EVENTS).toContain('purchase')
  expect(ANALYTICS_DATA_RETENTION.eventDataRetention).toBe('FOURTEEN_MONTHS')
})

describe('analytics definitions', () => {
  test('defines the analytics events', () => {
    expect(Object.values(ANALYTICS_EVENTS)).toEqual([
      'page_view',
      'artifact_view',
      'copy_link_succeeded',
      'copy_link_failed',
      'sign_up_start',
      'auth_completed',
      'artifact_returned_after_auth',
      'sign_up',
      'workspace_created',
      'first_artifact_posted',
    ])
  })
  test('defines every parameter as one custom dimension', () =>
    expect(
      ANALYTICS_CUSTOM_DIMENSIONS.map(({ parameterName }) => parameterName),
    ).toEqual(Object.values(ANALYTICS_PARAMS)))
  test('marks sign_up as a key event', () =>
    expect(ANALYTICS_KEY_EVENTS).toContain('sign_up'))
})

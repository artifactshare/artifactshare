import { describe, expect, test } from 'vitest'
import {
  ANALYTICS_CUSTOM_DIMENSIONS,
  ANALYTICS_EVENTS,
  ANALYTICS_KEY_EVENTS,
  ANALYTICS_PARAMS,
} from './events'
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

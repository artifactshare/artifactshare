import { describe, expect, test } from 'vitest'
import {
  ANALYTICS_CUSTOM_DIMENSIONS,
  ANALYTICS_EVENTS,
  ANALYTICS_KEY_EVENTS,
  ANALYTICS_PARAMS,
} from './events'
describe('analytics definitions', () => {
  test('defines unique funnel events', () => {
    expect(Object.values(ANALYTICS_EVENTS)).toEqual([
      'artifact_view',
      'sign_up_start',
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

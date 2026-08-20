// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest'
import {
  captureAuthAttempt,
  clearAuthAttempt,
  markAuthCompleted,
  readAuthAttempt,
} from './auth-attempt.client'

describe('auth attempt analytics cookie', () => {
  beforeEach(() => clearAuthAttempt())

  test('does not create state before analytics consent', () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: false,
    })
    expect(readAuthAttempt()).toBeNull()
  })

  test('preserves only the shared artifact target and completion state', () => {
    captureAuthAttempt({
      method: 'microsoft',
      callbackURL: '/a/example?from=sign-in',
      shouldLoadAnalytics: true,
    })
    expect(readAuthAttempt()).toEqual({
      method: 'microsoft',
      artifactId: 'example',
      authCompletedSent: false,
      nonce: expect.any(String),
    })
    markAuthCompleted('existing')
    expect(readAuthAttempt()).toEqual({
      method: 'microsoft',
      artifactId: 'example',
      authCompletedSent: true,
      accountState: 'existing',
      nonce: expect.any(String),
    })
  })

  test('does not retain non-artifact callback paths', () => {
    captureAuthAttempt({
      method: 'email',
      callbackURL: '/settings',
      shouldLoadAnalytics: true,
    })
    expect(readAuthAttempt()).toEqual({
      method: 'email',
      authCompletedSent: false,
      nonce: expect.any(String),
    })
  })

  test('does not consume an attempt from another browser tab', () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    sessionStorage.clear()
    expect(readAuthAttempt()).toBeNull()
  })
})

// @vitest-environment happy-dom
import { beforeEach, describe, expect, test } from 'vitest'
import {
  captureAuthAttempt,
  clearAllAuthAttempts,
  clearAuthAttempt,
  markAuthCompleted,
  readAuthAttempt,
} from './auth-attempt.client'

describe('auth attempt analytics cookie', () => {
  beforeEach(() => clearAllAuthAttempts())

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

  test('recovers a sole attempt after mobile tab storage is discarded', () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    sessionStorage.clear()
    expect(readAuthAttempt('example')).toEqual(
      expect.objectContaining({ method: 'google', artifactId: 'example' }),
    )
  })

  test('does not recover another tab attempt on an unrelated page', () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    sessionStorage.clear()
    expect(readAuthAttempt()).toBeNull()
    expect(readAuthAttempt('different')).toBeNull()
  })

  test('replaces the same tab attempt when authentication is retried', () => {
    captureAuthAttempt({
      method: 'email',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    const firstNonce = readAuthAttempt()!.nonce
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    sessionStorage.setItem('__as_auth_attempt_nonce', firstNonce)
    expect(readAuthAttempt()).toBeNull()
  })

  test('keeps concurrent browser-tab attempts independent', () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/first',
      shouldLoadAnalytics: true,
    })
    const first = readAuthAttempt()
    expect(first).not.toBeNull()
    sessionStorage.clear()
    captureAuthAttempt({
      method: 'microsoft',
      callbackURL: '/a/second',
      shouldLoadAnalytics: true,
    })
    expect(readAuthAttempt()).toEqual(
      expect.objectContaining({ method: 'microsoft', artifactId: 'second' }),
    )
    sessionStorage.setItem('__as_auth_attempt_nonce', first!.nonce)
    expect(readAuthAttempt()).toEqual(
      expect.objectContaining({ method: 'google', artifactId: 'first' }),
    )
  })
})

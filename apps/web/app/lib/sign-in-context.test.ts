import { describe, expect, test } from 'vitest'
import {
  buildSignInErrorCallback,
  signInIntent,
  signInMethod,
} from './sign-in-context'

describe('sign-in context', () => {
  test('recognizes only the supported intent and explicit email method', () => {
    expect(signInIntent(new URLSearchParams('intent=upload'))).toBe('upload')
    expect(signInIntent(new URLSearchParams('intent=unknown'))).toBeNull()
    expect(signInMethod(new URLSearchParams('method=email'), null)).toBe(
      'email',
    )
    expect(signInMethod(new URLSearchParams('method=unknown'), null)).toBe(
      'provider',
    )
  })

  test('opens email for an account-not-linked provider error', () => {
    expect(signInMethod(new URLSearchParams(), 'ACCOUNT_NOT_LINKED')).toBe(
      'email',
    )
  })

  test('preserves upload intent and a safe internal destination', () => {
    expect(
      buildSignInErrorCallback(
        new URLSearchParams('intent=upload&next=%2F%3Fupload%3D1'),
      ),
    ).toBe('/sign-in?intent=upload&next=%2F%3Fupload%3D1')
  })

  test('drops unknown intent and unsafe destinations', () => {
    expect(
      buildSignInErrorCallback(
        new URLSearchParams('intent=other&next=https%3A%2F%2Fevil.example'),
      ),
    ).toBe('/sign-in')
  })
})

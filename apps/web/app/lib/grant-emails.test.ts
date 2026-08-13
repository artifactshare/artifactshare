import { describe, expect, test } from 'vitest'
import { isExternalAuthorEmail, isExternalEmail } from './grant-emails'

describe('isExternalAuthorEmail', () => {
  test('hd あり・同ドメイン → false', () => {
    expect(isExternalAuthorEmail('alice@example.com', 'example.com')).toBe(
      false,
    )
  })

  test('hd あり・別ドメイン → true', () => {
    expect(isExternalAuthorEmail('bob@other.com', 'example.com')).toBe(true)
  })

  test('hd なし・selfEmail なし → false', () => {
    expect(isExternalAuthorEmail('alice@example.com', null)).toBe(false)
    expect(isExternalAuthorEmail('alice@example.com', undefined)).toBe(false)
    expect(isExternalAuthorEmail('alice@example.com', '')).toBe(false)
  })

  test('hd なし・email == selfEmail (大文字小文字/前後空白) → false', () => {
    expect(
      isExternalAuthorEmail('alice@example.com', null, 'alice@example.com'),
    ).toBe(false)
    expect(
      isExternalAuthorEmail('Alice@Example.com', null, 'alice@example.com'),
    ).toBe(false)
    expect(
      isExternalAuthorEmail(' alice@example.com ', null, 'alice@example.com'),
    ).toBe(false)
  })

  test('hd なし・email != selfEmail → true', () => {
    expect(
      isExternalAuthorEmail('bob@example.com', null, 'alice@example.com'),
    ).toBe(true)
  })
})

describe('isExternalEmail', () => {
  test('hd なしで常に false (既存挙動)', () => {
    expect(isExternalEmail('bob@other.com', null)).toBe(false)
    expect(isExternalEmail('bob@other.com', undefined)).toBe(false)
    expect(isExternalEmail('bob@other.com', '')).toBe(false)
  })
})

describe('reserved bot email domain exclusions', () => {
  test('isExternalEmail never marks a bot address external', () => {
    expect(
      isExternalEmail('bot-x@bots.artifactshare.invalid', 'example.com'),
    ).toBe(false)
    expect(isExternalEmail('someone@else.com', 'example.com')).toBe(true)
  })

  test('isExternalAuthorEmail excludes bot addresses with and without hd', () => {
    // With hd.
    expect(
      isExternalAuthorEmail(
        'bot-x@bots.artifactshare.invalid',
        'example.com',
        'me@example.com',
      ),
    ).toBe(false)
    // Without hd, the fallback (owner != project creator ⇒ external) must not
    // fire for bot-owned artifacts.
    expect(
      isExternalAuthorEmail(
        'bot-x@bots.artifactshare.invalid',
        null,
        'me@example.com',
      ),
    ).toBe(false)
    expect(
      isExternalAuthorEmail('other@example.com', null, 'me@example.com'),
    ).toBe(true)
  })
})

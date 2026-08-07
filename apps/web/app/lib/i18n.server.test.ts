import { describe, expect, test } from 'vitest'
import {
  getLocale,
  isSupportedLocale,
  localeCookieHeader,
  normalizeLocaleTag,
} from './i18n.server'

const req = (init: { headers?: Record<string, string> } = {}) =>
  new Request('https://example.com/', { headers: init.headers })

describe('isSupportedLocale', () => {
  test('accepts supported locales', () => {
    expect(isSupportedLocale('en')).toBe(true)
    expect(isSupportedLocale('ja')).toBe(true)
  })

  test('rejects non-strings and unsupported', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('en-US')).toBe(false) // requires normalization first
    expect(isSupportedLocale(null)).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
    expect(isSupportedLocale(42)).toBe(false)
  })
})

describe('normalizeLocaleTag', () => {
  test('returns supported tag as-is', () => {
    expect(normalizeLocaleTag('ja')).toBe('ja')
    expect(normalizeLocaleTag('en')).toBe('en')
  })

  test('strips region subtag', () => {
    expect(normalizeLocaleTag('en-US')).toBe('en')
    expect(normalizeLocaleTag('ja-JP')).toBe('ja')
  })

  test('lowercases', () => {
    expect(normalizeLocaleTag('EN')).toBe('en')
    expect(normalizeLocaleTag('Ja-jp')).toBe('ja')
  })

  test('returns null for unsupported / empty / nullish', () => {
    expect(normalizeLocaleTag('pt-BR')).toBeNull()
    expect(normalizeLocaleTag('de')).toBeNull()
    expect(normalizeLocaleTag('')).toBeNull()
    expect(normalizeLocaleTag(null)).toBeNull()
    expect(normalizeLocaleTag(undefined)).toBeNull()
  })
})

describe('getLocale priority', () => {
  test('user.locale wins over cookie', () => {
    const r = req({
      headers: {
        cookie: '__as_locale=en',
        'accept-language': 'en-US',
      },
    })
    expect(getLocale(r, 'ja')).toBe('ja')
  })

  test('user.locale wins over Accept-Language when no cookie', () => {
    const r = req({ headers: { 'accept-language': 'en' } })
    expect(getLocale(r, 'ja')).toBe('ja')
  })

  test('cookie wins over Accept-Language', () => {
    const r = req({
      headers: {
        cookie: '__as_locale=en',
        'accept-language': 'ja',
      },
    })
    expect(getLocale(r)).toBe('en')
  })

  test('cookie is used when user.locale is unsupported', () => {
    const r = req({
      headers: {
        cookie: '__as_locale=ja',
        'accept-language': 'en',
      },
    })
    expect(getLocale(r, 'pt-BR')).toBe('ja')
  })

  test('Accept-Language used when cookie absent', () => {
    expect(getLocale(req({ headers: { 'accept-language': 'ja' } }))).toBe('ja')
  })

  test('Accept-Language respects q-value ordering', () => {
    expect(
      getLocale(req({ headers: { 'accept-language': 'en;q=0.5, ja;q=0.9' } })),
    ).toBe('ja')
    expect(
      getLocale(req({ headers: { 'accept-language': 'ja;q=0.3, en' } })),
    ).toBe('en') // implicit q=1 wins
  })

  test('Accept-Language strips region', () => {
    expect(getLocale(req({ headers: { 'accept-language': 'ja-JP' } }))).toBe(
      'ja',
    )
  })

  test('falls back to en when nothing matches', () => {
    expect(getLocale(req())).toBe('en')
    expect(
      getLocale(req({ headers: { 'accept-language': 'fr, de, pt-BR' } })),
    ).toBe('en')
  })

  test('skips unsupported tags and keeps scanning', () => {
    expect(
      getLocale(
        req({ headers: { 'accept-language': 'fr, de;q=0.9, ja;q=0.8' } }),
      ),
    ).toBe('ja')
  })

  test('ignores malformed cookie', () => {
    expect(
      getLocale(req({ headers: { cookie: '__as_locale=xx; other=yes' } })),
    ).toBe('en')
  })

  test('userLocale falls through when unsupported', () => {
    const r = req({ headers: { 'accept-language': 'ja' } })
    expect(getLocale(r, 'pt-BR')).toBe('ja')
    expect(getLocale(r, null)).toBe('ja')
  })
})

describe('localeCookieHeader', () => {
  test('builds host-only 1-year cookie', () => {
    const header = localeCookieHeader('ja')
    expect(header).toContain('__as_locale=ja')
    expect(header).toContain('Path=/')
    expect(header).toContain('Max-Age=31536000')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure')
  })
})

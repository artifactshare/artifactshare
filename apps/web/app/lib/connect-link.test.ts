import { describe, expect, test } from 'vitest'
import { withLang } from './connect-link'

describe('withLang', () => {
  test('uses the canonical Japanese root path', () => {
    expect(withLang('/', 'ja')).toBe('/ja')
  })

  test('preserves other paths and hashes', () => {
    expect(withLang('/about', 'ja', 'team')).toBe('/ja/about#team')
    expect(withLang('/', 'en', 'top')).toBe('/#top')
  })
})

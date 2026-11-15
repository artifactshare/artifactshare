import { expect, test } from 'vitest'
import {
  normalizeSearchText,
  packTokens,
  snippet,
  TOKEN_BYTES,
  COLUMN_BYTES,
} from './normalize'

const bytes = (s: string) => new TextEncoder().encode(s).length

test('normalizes fullwidth/case/kana and removes only long katakana terminal vowel marks', () => {
  expect(normalizeSearchText('ＡＢＣ ｻｰﾊﾞｰ サーバー')).toBe(
    normalizeSearchText('abc サーバ サーバ'),
  )
  expect(normalizeSearchText('カー')).toBe('カー')
  expect(normalizeSearchText('あー')).toContain('ー')
})

test.each([TOKEN_BYTES - 1, TOKEN_BYTES, TOKEN_BYTES + 1, 40_000])(
  'retains all bytes of a %i byte word for both indexing and queries',
  (size) => {
    const source = 'a'.repeat(size)
    const normalized = normalizeSearchText(source)
    expect(
      normalized.split(' ').every((piece) => bytes(piece) <= TOKEN_BYTES),
    ).toBe(true)
    expect(normalized.replaceAll(' ', '')).toBe(source)
    expect(packTokens(normalized).join(' ')).toBe(normalizeSearchText(source))
  },
)

test('bounds expanded and multibyte tokens and packs whole tokens without losing tails', () => {
  const source = 'Ａ'.repeat(50_000) + 'tail ' + 'カ'.repeat(100_000) + '最後'
  const normalized = normalizeSearchText(source)
  expect(
    normalized.split(' ').every((piece) => bytes(piece) <= TOKEN_BYTES),
  ).toBe(true)
  const chunks = packTokens(normalized)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every((chunk) => bytes(chunk) <= COLUMN_BYTES)).toBe(true)
  expect(chunks.join(' ')).toBe(normalized)
  expect(normalized).toContain('最後')
})

test('keeps exactly 200000 Unicode code points for snippets', () => {
  expect(snippet('😀'.repeat(200_001))).toBe('😀'.repeat(200_000))
  expect(snippet('short')).toBe('short')
})

test.each([TOKEN_BYTES - 1, TOKEN_BYTES, TOKEN_BYTES + 1])(
  'bounds a multibyte word of %i bytes without splitting code points',
  (size) => {
    const source = 'é'.repeat(Math.floor(size / 2)) + (size % 2 ? 'a' : '')
    const tokens = normalizeSearchText(source).split(' ')
    expect(tokens.every((token) => bytes(token) <= TOKEN_BYTES)).toBe(true)
    expect(tokens.join('')).toBe(source)
  },
)
test('sizes tokens after NFKC expansion', () => {
  const source = '㌀'.repeat(6000)
  const tokens = normalizeSearchText(source).split(' ')
  expect(tokens.every((token) => bytes(token) <= TOKEN_BYTES)).toBe(true)
  expect(tokens.join('')).toBe(source.normalize('NFKC'))
})

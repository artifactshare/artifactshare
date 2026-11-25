import { expect } from 'vitest'

const KANA = /\p{Script=Hiragana}|\p{Script=Katakana}/u

/**
 * A locale-aware public route must serve its own document, not the English one.
 * Checking the script rather than the copy keeps the check alive when either
 * document is reworded.
 */
export function expectLocalePair(en: string, ja: string) {
  expect(en).not.toBe('')
  expect(ja).not.toBe(en)
  expect(ja).toMatch(KANA)
  expect(en).not.toMatch(KANA)
}

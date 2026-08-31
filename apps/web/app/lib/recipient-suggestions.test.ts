import { describe, expect, test } from 'vitest'
import { isRecipientSuggestionQuery } from './recipient-suggestions'

describe('isRecipientSuggestionQuery', () => {
  test.each(['山', 'や', 'ヤ', 'ﾔ'])(
    'accepts one CJK or kana character: %s',
    (query) => {
      expect(isRecipientSuggestionQuery(query)).toBe(true)
    },
  )

  test.each(['a', '1', '@', '😀'])(
    'rejects one non-CJK character: %s',
    (query) => {
      expect(isRecipientSuggestionQuery(query)).toBe(false)
    },
  )

  test.each(['ab', 'a山', '😀😀'])('accepts two code points: %s', (query) => {
    expect(isRecipientSuggestionQuery(query)).toBe(true)
  })

  test('ignores surrounding whitespace', () => {
    expect(isRecipientSuggestionQuery(' 山 ')).toBe(true)
    expect(isRecipientSuggestionQuery(' a ')).toBe(false)
  })
})

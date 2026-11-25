import { describe, expect, test } from 'vitest'
import { getShareWithAiPath } from './share-with-ai-link'

describe('getShareWithAiPath', () => {
  test('returns the English canonical path for en', () => {
    expect(getShareWithAiPath('en')).toBe('/share-with-ai')
  })

  test('returns the Japanese canonical path for ja', () => {
    expect(getShareWithAiPath('ja')).toBe('/ja/share-with-ai')
  })
})

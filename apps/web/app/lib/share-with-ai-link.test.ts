import { describe, expect, test } from 'vitest'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import {
  SHARE_WITH_AI_EN_PATH,
  SHARE_WITH_AI_JA_PATH,
  getShareWithAiPath,
} from './share-with-ai-link'

describe('getShareWithAiPath', () => {
  test('returns the English canonical path by default', () => {
    expect(getShareWithAiPath(DEFAULT_LOCALE)).toBe(SHARE_WITH_AI_EN_PATH)
  })

  test('returns the Japanese canonical path for ja', () => {
    expect(getShareWithAiPath('ja')).toBe(SHARE_WITH_AI_JA_PATH)
  })
})

import { describe, expect, test } from 'vitest'
import en from './en.json'
import ja from './ja.json'

// `messages.ts` casts ja to the en key set, so a missing ja key is not a
// compile error. Pin en/ja parity and One/Other pair existence for the new
// vw.viewerList* keys here.
const PREFIX = 'vw.viewerList'
const PLURAL_STEMS = ['vw.viewerListCount', 'vw.viewerListPanelTitle']

describe('viewer list i18n keys', () => {
  const enKeys = Object.keys(en).filter((key) => key.startsWith(PREFIX))
  const jaKeys = Object.keys(ja).filter((key) => key.startsWith(PREFIX))

  test('at least the expected key group exists', () => {
    expect(enKeys.length).toBeGreaterThan(0)
  })

  test('en and ja have the same vw.viewerList* keys', () => {
    expect(jaKeys.sort()).toEqual(enKeys.sort())
  })

  test('every vw.viewerList* value is non-empty in both locales', () => {
    for (const key of enKeys) {
      expect((en as Record<string, string>)[key]).toBeTruthy()
      expect((ja as Record<string, string>)[key]).toBeTruthy()
    }
  })

  test.each(PLURAL_STEMS)('%s has One/Other pairs in both locales', (stem) => {
    for (const catalog of [en, ja] as Record<string, string>[]) {
      expect(catalog[`${stem}One`]).toBeTruthy()
      expect(catalog[`${stem}Other`]).toBeTruthy()
      // Other must carry the {n} placeholder per the tPlural injection spec.
      expect(catalog[`${stem}Other`]).toContain('{n}')
    }
  })
})

import { describe, expect, test } from 'vitest'
import { MESSAGES, type Locale } from '~/i18n/messages'
import { createHomeCard } from './home-og-card'

describe.each(['en', 'ja'] as const)(
  'createHomeCard (%s)',
  (locale: Locale) => {
    test('uses the localized hero copy and canonical locale URL', () => {
      const card = createHomeCard(locale)
      expect(card.title).toContain(MESSAGES[locale]['lp.hero.titleDim'])
      expect(card.title).toContain(MESSAGES[locale]['lp.hero.titleMain'])
      expect(card.subhead).toBe(MESSAGES[locale]['lp.title'])
      expect(card.url).toBe(
        locale === 'ja' ? 'artifactshare.com/ja' : 'artifactshare.com',
      )
    })

    test('uses one stable product kind across locales', () => {
      expect(createHomeCard(locale).kind).toBe('SHARE · COMMENT · UPDATE')
    })
  },
)

import { describe, expect, test } from 'vitest'
import { MESSAGES, type Locale } from '~/i18n/messages'
import { createHomeCard } from './home-og-card'

describe.each(['en', 'ja'] as const)(
  'createHomeCard (%s)',
  (locale: Locale) => {
    test('takes its hero copy from the locale dictionary', () => {
      const card = createHomeCard(locale)
      expect(card.title).toContain(MESSAGES[locale]['lp.hero.titleDim'])
      expect(card.title).toContain(MESSAGES[locale]['lp.hero.titleMain'])
      expect(card.subhead).toBe(MESSAGES[locale]['lp.title'])
    })
  },
)

test('points each locale at its own canonical URL and tagline', () => {
  const en = createHomeCard('en')
  const ja = createHomeCard('ja')
  expect(ja.url).toBe(`${en.url}/ja`)
  expect(ja.footer).not.toBe(en.footer)
  expect(ja.footer.length).toBeGreaterThan(0)
  expect(en.footer.length).toBeGreaterThan(0)
  expect(ja.kind).toBe(en.kind)
})

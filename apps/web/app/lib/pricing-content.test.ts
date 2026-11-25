import { describe, expect, test } from 'vitest'
import { PLAN_DISPLAY, type BillingPlan } from './billing-prices'
import {
  PRICING_COPY,
  comparisonValuesForCurrency,
  formatStorageOveragePrice,
  pricingMarkdown,
  yearlyEquivalent,
} from './pricing-content'

const LOCALES = ['en', 'ja'] as const
const PLANS = ['free', 'plus', 'team'] as const satisfies readonly BillingPlan[]

describe('prices shown to the reader', () => {
  test('converts a yearly price to its monthly equivalent', () => {
    expect(yearlyEquivalent('jpy', 'plus')).toBe('¥667')
    expect(yearlyEquivalent('usd', 'team')).toBe('$24.17')
  })

  test('keeps cent precision in the storage overage rate', () => {
    expect(formatStorageOveragePrice('usd')).toBe('$0.10')
    expect(formatStorageOveragePrice('jpy')).toMatch(/^¥\d+$/)
    expect(JSON.stringify(PRICING_COPY)).not.toMatch(/\$0\.1(?!0)/)
  })
})

describe('plan comparison', () => {
  test('hands back the values for the asked-for currency', () => {
    expect(comparisonValuesForCurrency(['—', 'yes'], 'jpy')).toEqual([
      '—',
      'yes',
    ])
    expect(
      comparisonValuesForCurrency({ jpy: ['¥16'], usd: ['$0.10'] }, 'usd'),
    ).toEqual(['$0.10'])
  })

  test.each(LOCALES)(
    'never shows one currency in the other currency column (%s)',
    (locale) => {
      for (const row of PRICING_COPY[locale].comparison) {
        const jpy = comparisonValuesForCurrency(row.values, 'jpy').join(' ')
        const usd = comparisonValuesForCurrency(row.values, 'usd').join(' ')
        if (jpy === usd) continue
        expect(jpy).toContain('¥')
        expect(jpy).not.toContain('$')
        expect(usd).toContain('$')
        expect(usd).not.toContain('¥')
      }
    },
  )
})

describe('copy stays aligned with the plan metadata', () => {
  test.each(LOCALES)('%s names the storage of every plan', (locale) => {
    const copy = PRICING_COPY[locale]
    for (const plan of PLANS)
      expect(copy.plans[plan].features[0]).toContain(PLAN_DISPLAY[plan].storage)
    expect(copy.comparison[0]?.values).toEqual(
      PLANS.map((plan) => PLAN_DISPLAY[plan].storage),
    )
  })

  test('both locales offer the same plans, features and questions', () => {
    const shape = (locale: (typeof LOCALES)[number]) => ({
      plans: Object.keys(PRICING_COPY[locale].plans).sort(),
      featureCounts: PLANS.map(
        (plan) => PRICING_COPY[locale].plans[plan].features.length,
      ),
      comparisonRows: PRICING_COPY[locale].comparison.length,
      faqs: PRICING_COPY[locale].faqs.length,
    })
    expect(shape('ja')).toEqual(shape('en'))
    expect(shape('en').faqs).toBeGreaterThan(0)
  })

  test('the agent-facing markdown carries the same numbers', () => {
    const markdown = pricingMarkdown()
    for (const plan of PLANS)
      expect(markdown).toContain(PLAN_DISPLAY[plan].storage)
    for (const currency of ['jpy', 'usd'] as const)
      expect(markdown).toContain(formatStorageOveragePrice(currency))
    expect(markdown).toContain('https://artifactshare.com/pricing')
  })
})

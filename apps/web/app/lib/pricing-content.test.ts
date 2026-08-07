import { describe, expect, test } from 'vitest'
import { BILLING_PRICES, PLAN_DISPLAY } from './billing-prices'
import {
  PRICING_COPY,
  comparisonValuesForCurrency,
  pricingMarkdown,
  yearlyEquivalent,
} from './pricing-content'

describe('pricing content', () => {
  test('keeps both locales fully localized and backed by SSOT metadata', () => {
    for (const locale of ['en', 'ja'] as const) {
      const copy = PRICING_COPY[locale]
      expect(copy.plans.free.features[0]).toContain(PLAN_DISPLAY.free.storage)
      expect(copy.plans.plus.features[0]).toContain(PLAN_DISPLAY.plus.storage)
      expect(copy.plans.team.features[0]).toContain(PLAN_DISPLAY.team.storage)
      expect(copy.comparison[0]?.values).toEqual([
        PLAN_DISPLAY.free.storage,
        PLAN_DISPLAY.plus.storage,
        PLAN_DISPLAY.team.storage,
      ])
      expect(copy.faqs).toHaveLength(7)
    }
    expect(PRICING_COPY.ja.faqs[0].question).toBe(
      '表示価格に税は含まれていますか？',
    )
    expect(PRICING_COPY.ja.plans.free.features.join('')).not.toMatch(/storage/i)
  })

  test('formats monthly and yearly values from billing prices', () => {
    expect(BILLING_PRICES.plus.jpy).toEqual({ month: 800, year: 8000 })
    expect(yearlyEquivalent('jpy', 'plus')).toBe('¥667')
    expect(yearlyEquivalent('usd', 'team')).toBe('$24.17')
  })

  test('keeps agent markdown aligned with the price SSOT', () => {
    const markdown = pricingMarkdown()
    expect(markdown).toContain('100 MB storage')
    expect(markdown).toContain('New uploads stop at the storage limit')
    expect(markdown).toContain('Active Plus and Team subscriptions')
    expect(markdown).toContain('¥16 per GB-month')
    expect(markdown).toContain('$0.10 per GB-month')
    expect(markdown).not.toContain('$0.1 /')
  })

  test('formats storage overage consistently across public pricing copy', () => {
    for (const locale of ['en', 'ja'] as const) {
      const content = JSON.stringify(PRICING_COPY[locale])
      expect(content).toContain('$0.10')
      expect(content).not.toContain('$0.1 /')
    }
  })

  test('resolves localized comparison overage values for each currency', () => {
    const expected = {
      ja: {
        jpy: ['—', '¥16 / GB・月', '¥16 / GB・月'],
        usd: ['—', '$0.10 / GB・月', '$0.10 / GB・月'],
      },
      en: {
        jpy: ['—', '¥16 / GB-month', '¥16 / GB-month'],
        usd: ['—', '$0.10 / GB-month', '$0.10 / GB-month'],
      },
    } as const

    for (const locale of ['ja', 'en'] as const) {
      const row = PRICING_COPY[locale].comparison.find(
        ({ label }) =>
          label === (locale === 'ja' ? '容量超過料金' : 'Storage overage rate'),
      )
      expect(row).toBeDefined()
      expect(comparisonValuesForCurrency(row!.values, 'jpy')).toEqual(
        expected[locale].jpy,
      )
      expect(comparisonValuesForCurrency(row!.values, 'usd')).toEqual(
        expected[locale].usd,
      )
    }
  })

  test('states unbounded active overage for Plus and Team', () => {
    expect(PRICING_COPY.en.plans.plus.note).toContain('beyond 10 GB')
    expect(PRICING_COPY.en.plans.plus.note).toContain('without a hard cap')
    expect(PRICING_COPY.en.plans.team.note).toContain('beyond 100 GB')
    expect(PRICING_COPY.en.plans.team.note).toContain('without a hard cap')
    expect(PRICING_COPY.ja.plans.plus.note).toContain('10 GBを超えた保存容量')
    expect(PRICING_COPY.ja.plans.team.note).toContain('100 GBを超えた保存容量')
    expect(PRICING_COPY.ja.plans.plus.note).toContain('上限なく')
    expect(PRICING_COPY.ja.plans.team.note).toContain('上限なく')
    expect(JSON.stringify(PRICING_COPY.ja)).not.toContain('非稼働')
    expect(JSON.stringify(PRICING_COPY.en)).not.toContain('inactive paid')
  })

  test('explains currency choice without exposing location detection', () => {
    expect(JSON.stringify(PRICING_COPY.ja)).not.toContain('地域を判定')
    expect(JSON.stringify(PRICING_COPY.en)).not.toContain('location cannot')
    expect(PRICING_COPY.ja.faqs[5].answer).toContain('固定価格')
    expect(PRICING_COPY.en.faqs[5].answer).toContain('fixed price')
  })

  test('keeps the pricing hero focused on the product outcome', () => {
    expect(PRICING_COPY.ja.body).not.toMatch(/CLI|MCP/)
    expect(PRICING_COPY.en.body).not.toMatch(/CLI|MCP/i)
    expect(PRICING_COPY.ja.body).toContain('人数による追加料金はありません。')
    expect(PRICING_COPY.en.body).toContain('No per-person fees.')
  })

  test('includes CLI and MCP publishing without per-person fees on every plan', () => {
    for (const plan of ['free', 'plus', 'team'] as const) {
      expect(PRICING_COPY.ja.plans[plan].features).toContain(
        'CLI・MCPサーバーからAIで直接投稿',
      )
      expect(PRICING_COPY.ja.plans[plan].features).toContain(
        '投稿者・閲覧者・コメント参加者の人数による追加料金なし',
      )
      expect(PRICING_COPY.en.plans[plan].features).toContain(
        'Post directly from AI tools via CLI or MCP server',
      )
      expect(PRICING_COPY.en.plans[plan].features).toContain(
        'No additional fees based on the number of publishers, viewers, or commenters',
      )
    }
  })

  test('keeps link sharing plan differences in both public pricing locales', () => {
    expect(PRICING_COPY.ja.comparison).toContainEqual({
      label: '認証なしのリンク共有',
      values: ['—', '期限設定付き', '期限設定・組織管理付き'],
    })
    expect(PRICING_COPY.en.comparison).toContainEqual({
      label: 'Links that open without sign-in',
      values: [
        '—',
        'With expiration settings',
        'With expiration settings and workspace controls',
      ],
    })
    expect(PRICING_COPY.ja.plans.free.note).toContain(
      'リンク共有と社外メンバーからの投稿はPlusプランとTeamプランで利用できます。',
    )
    expect(PRICING_COPY.en.plans.free.note).toContain(
      'Link sharing and uploads from external members are available on Plus and Team.',
    )
  })
})

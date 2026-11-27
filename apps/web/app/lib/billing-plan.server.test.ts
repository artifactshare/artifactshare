import { describe, expect, test } from 'vitest'
import { BILLING_PRICES } from './billing-prices'
import {
  allowsStorageOverage,
  projectLimitForPlan,
  storageQuotaForPlan,
} from './billing-plan.server'

describe('billing-plan', () => {
  test('billing prices keep the published prices', () => {
    expect(BILLING_PRICES.plus.jpy).toEqual({ month: 800, year: 8000 })
    expect(BILLING_PRICES.team.usd).toEqual({ month: 29, year: 290 })
  })
  test('allows storage overage for active plus and team subscriptions', () => {
    expect(allowsStorageOverage('free', 'active')).toBe(false)
    expect(allowsStorageOverage('plus', 'active')).toBe(true)
    expect(allowsStorageOverage('team', 'none')).toBe(false)
    expect(allowsStorageOverage('team', 'canceled')).toBe(false)
    expect(allowsStorageOverage('team', 'active')).toBe(true)
    expect(allowsStorageOverage('team', 'trialing')).toBe(true)
    expect(allowsStorageOverage('team', 'past_due')).toBe(true)
  })

  test('project limits match plan tiers', () => {
    expect(projectLimitForPlan('free')).toBe(5)
    expect(projectLimitForPlan('plus')).toBe(20)
    expect(projectLimitForPlan('team')).toBeNull()
  })

  test('storage quotas match plan tiers', () => {
    expect(storageQuotaForPlan('free')).toBe(100 * 1024 ** 2)
    expect(storageQuotaForPlan('plus')).toBe(10 * 1024 ** 3)
    expect(storageQuotaForPlan('team')).toBe(100 * 1024 ** 3)
    expect(storageQuotaForPlan(null)).toBe(100 * 1024 ** 2)
  })
})

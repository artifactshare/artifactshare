import { describe, expect, test } from 'vitest'
import { BILLING_PRICES, PLAN_STORAGE_QUOTA_BYTES } from './billing-prices'
import {
  allowsStorageOverage,
  isPaidPlan,
  normalizePlan,
  PLAN_PROJECT_LIMITS,
  projectLimitForPlan,
  storageQuotaForPlan,
} from './billing-plan.server'

describe('billing-plan', () => {
  test('billing prices keep the published plan limits and prices', () => {
    expect(PLAN_STORAGE_QUOTA_BYTES).toEqual({
      free: 104857600,
      plus: 10737418240,
      team: 107374182400,
    })
    expect(BILLING_PRICES.plus.jpy).toEqual({ month: 800, year: 8000 })
    expect(BILLING_PRICES.team.usd).toEqual({ month: 29, year: 290 })
  })
  test('normalizePlan falls back unknown values to free', () => {
    expect(normalizePlan('enterprise')).toBe('free')
    expect(normalizePlan(null)).toBe('free')
    expect(normalizePlan(undefined)).toBe('free')
  })

  test('isPaidPlan is true for plus and team only', () => {
    expect(isPaidPlan('free')).toBe(false)
    expect(isPaidPlan('plus')).toBe(true)
    expect(isPaidPlan('team')).toBe(true)
    expect(isPaidPlan('unknown')).toBe(false)
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
    expect(projectLimitForPlan('free')).toBe(PLAN_PROJECT_LIMITS.free)
    expect(projectLimitForPlan('plus')).toBe(PLAN_PROJECT_LIMITS.plus)
    expect(projectLimitForPlan('team')).toBeNull()
  })

  test('storage quotas match plan tiers', () => {
    expect(storageQuotaForPlan('free')).toBe(PLAN_STORAGE_QUOTA_BYTES.free)
    expect(storageQuotaForPlan('plus')).toBe(PLAN_STORAGE_QUOTA_BYTES.plus)
    expect(storageQuotaForPlan('team')).toBe(PLAN_STORAGE_QUOTA_BYTES.team)
    expect(storageQuotaForPlan(null)).toBe(PLAN_STORAGE_QUOTA_BYTES.free)
  })
})

import { sql } from 'kysely'
import { describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { planInTierSql } from './plan-tier-sql.server'
import {
  isPaidPlan,
  isPlanInTier,
  normalizePlan,
  planTier,
  plansInTier,
} from './plan-tier'

describe('plan-tier', () => {
  test('normalizePlan falls back unknown values to free', () => {
    expect(normalizePlan('plus')).toBe('plus')
    expect(normalizePlan('team')).toBe('team')
    expect(normalizePlan('enterprise')).toBe('free')
    expect(normalizePlan('toString')).toBe('free')
    expect(normalizePlan(null)).toBe('free')
    expect(normalizePlan(undefined)).toBe('free')
  })

  test('each plan belongs to one tier, and unknown plans are free', () => {
    expect(planTier('free')).toBe('free')
    expect(planTier('plus')).toBe('individual')
    expect(planTier('team')).toBe('team')
    expect(planTier('unknown')).toBe('free')
    expect(planTier(null)).toBe('free')
  })

  test('isPaidPlan is true for plus and team only', () => {
    expect(isPaidPlan('free')).toBe(false)
    expect(isPaidPlan('plus')).toBe(true)
    expect(isPaidPlan('team')).toBe(true)
    expect(isPaidPlan('unknown')).toBe(false)
  })

  test('isPlanInTier matches the plan table', () => {
    expect(isPlanInTier('team', 'team')).toBe(true)
    expect(isPlanInTier('plus', 'team')).toBe(false)
    expect(isPlanInTier('plus', 'individual')).toBe(true)
    expect(isPlanInTier('free', 'free')).toBe(true)
  })

  test('plansInTier lists the plans of the given tiers', () => {
    expect(plansInTier(['team'])).toEqual(['team'])
    expect(plansInTier(['individual', 'team'])).toEqual(['plus', 'team'])
    expect(plansInTier(['free'])).toEqual(['free'])
  })

  test('planInTierSql matches the plan-name predicates it replaces', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    try {
      const { rows } = await sql<{
        plan: string
        team_tier: number
        team_name: number
        paid_tier: number
        paid_names: number
      }>`
        SELECT
          w.plan,
          ${planInTierSql('w.plan', ['team'])} AS team_tier,
          w.plan = 'team' AS team_name,
          ${planInTierSql('w.plan', ['individual', 'team'])} AS paid_tier,
          w.plan IN ('plus', 'team') AS paid_names
        FROM (
          SELECT 'free' AS plan
          UNION ALL SELECT 'plus'
          UNION ALL SELECT 'team'
          UNION ALL SELECT 'enterprise'
        ) w
      `.execute(db)

      expect(rows).toHaveLength(4)
      for (const row of rows) {
        expect(row.team_tier, row.plan).toBe(row.team_name)
        expect(row.paid_tier, row.plan).toBe(row.paid_names)
      }
      expect(
        rows.filter((row) => row.team_tier === 1).map((r) => r.plan),
      ).toEqual(['team'])
    } finally {
      sqlite.close()
    }
  })
})

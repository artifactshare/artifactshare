import { sql, type RawBuilder } from 'kysely'
import { plansInTier, type PlanTier } from './plan-tier'

export function planInTierSql(
  column: string,
  tiers: readonly [PlanTier, ...PlanTier[]],
): RawBuilder<boolean> {
  const plans = plansInTier(tiers).map((plan) => sql.lit(plan))
  return sql<boolean>`${sql.ref(column)} IN (${sql.join(plans)})`
}

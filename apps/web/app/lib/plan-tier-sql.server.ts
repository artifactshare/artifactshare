import { sql, type RawBuilder } from 'kysely'
import { plansInTier, type PlanTier } from './plan-tier'

/**
 * SQL predicate: the plan column holds a plan in one of `tiers`. The plan
 * names are inlined as literals, so the predicate adds no bind parameters.
 */
export function planInTierSql(
  column: string,
  tiers: readonly [PlanTier, ...PlanTier[]],
): RawBuilder<boolean> {
  const plans = plansInTier(tiers).map((plan) => sql.lit(plan))
  return sql<boolean>`${sql.ref(column)} IN (${sql.join(plans)})`
}

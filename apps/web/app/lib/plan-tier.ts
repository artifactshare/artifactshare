import type { BillingPlan } from './billing-prices'

/**
 * What a plan grants outside billing. Code that gates a feature decides by
 * tier, never by plan name, so a new plan joins a tier here instead of
 * silently missing a comparison somewhere else.
 *
 * - `free`: no paid features.
 * - `individual`: paid features the workspace owner manages alone.
 * - `team`: paid features plus workspace administration and workspace-wide
 *   project access.
 */
export type PlanTier = 'free' | 'individual' | 'team'

export const PLAN_TIERS = {
  free: 'free',
  plus: 'individual',
  team: 'team',
} as const satisfies Record<BillingPlan, PlanTier>

export const PAID_TIERS = ['individual', 'team'] as const satisfies readonly [
  PlanTier,
  ...PlanTier[],
]

function isBillingPlan(plan: string): plan is BillingPlan {
  return Object.hasOwn(PLAN_TIERS, plan)
}

export function normalizePlan(plan: string | null | undefined): BillingPlan {
  return plan != null && isBillingPlan(plan) ? plan : 'free'
}

export function planTier(plan: string | null | undefined): PlanTier {
  return PLAN_TIERS[normalizePlan(plan)]
}

/** The plans in tier `T`, derived from `PLAN_TIERS`. */
export type PlanInTier<T extends PlanTier> = {
  [P in BillingPlan]: (typeof PLAN_TIERS)[P] extends T ? P : never
}[BillingPlan]

/** Narrows a known plan by tier, for code that still renders per plan. */
export function isPlanInTier<T extends PlanTier>(
  plan: BillingPlan,
  tier: T,
): plan is PlanInTier<T> {
  return PLAN_TIERS[plan] === tier
}

export function isPaidPlan(plan: string | null | undefined): boolean {
  return (PAID_TIERS as readonly PlanTier[]).includes(planTier(plan))
}

export function plansInTier(
  tiers: readonly [PlanTier, ...PlanTier[]],
): BillingPlan[] {
  const wanted = new Set<PlanTier>(tiers)
  return (Object.keys(PLAN_TIERS) as BillingPlan[]).filter((plan) =>
    wanted.has(PLAN_TIERS[plan]),
  )
}

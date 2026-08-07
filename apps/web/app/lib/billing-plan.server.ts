import {
  PLAN_PROJECT_LIMITS,
  PLAN_STORAGE_QUOTA_BYTES,
  type BillingPlan,
} from './billing-prices'

export { PLAN_PROJECT_LIMITS, PLAN_STORAGE_QUOTA_BYTES }
export type { BillingPlan }

export const ACTIVE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
] as const

export function normalizePlan(plan: string | null | undefined): BillingPlan {
  if (plan === 'plus' || plan === 'team') return plan
  return 'free'
}

export function isPaidPlan(plan: string | null | undefined): boolean {
  const normalized = normalizePlan(plan)
  return normalized === 'plus' || normalized === 'team'
}

export function isActiveSubscriptionStatus(status: string): boolean {
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(
    status as (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number],
  )
}

export function allowsStorageOverage(
  plan: string | null | undefined,
  subscriptionStatus: string,
): boolean {
  return (
    isActiveSubscriptionStatus(subscriptionStatus) &&
    (normalizePlan(plan) === 'team' || normalizePlan(plan) === 'plus')
  )
}

export function projectLimitForPlan(
  plan: string | null | undefined,
): number | null {
  return PLAN_PROJECT_LIMITS[normalizePlan(plan)]
}

export function storageQuotaForPlan(plan: string | null | undefined): number {
  return PLAN_STORAGE_QUOTA_BYTES[normalizePlan(plan)]
}

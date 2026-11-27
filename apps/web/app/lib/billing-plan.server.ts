import {
  PLAN_PROJECT_LIMITS,
  PLAN_STORAGE_QUOTA_BYTES,
  type BillingPlan,
} from './billing-prices'
import { isPaidPlan, normalizePlan } from './plan-tier'

export { PLAN_PROJECT_LIMITS, PLAN_STORAGE_QUOTA_BYTES }
export type { BillingPlan }

export const ACTIVE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
] as const

export function isActiveSubscriptionStatus(status: string): boolean {
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(
    status as (typeof ACTIVE_SUBSCRIPTION_STATUSES)[number],
  )
}

export function allowsStorageOverage(
  plan: string | null | undefined,
  subscriptionStatus: string,
): boolean {
  return isActiveSubscriptionStatus(subscriptionStatus) && isPaidPlan(plan)
}

export function projectLimitForPlan(
  plan: string | null | undefined,
): number | null {
  return PLAN_PROJECT_LIMITS[normalizePlan(plan)]
}

export function storageQuotaForPlan(plan: string | null | undefined): number {
  return PLAN_STORAGE_QUOTA_BYTES[normalizePlan(plan)]
}

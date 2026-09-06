import { normalizePlan } from './billing-plan.server'

export const DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS = 14
export const DEFAULT_LINK_LOW_TRUST_LINK_PUBLISH_COUNT = 5

export type LinkTrustThresholds = {
  accountAgeDays: number
  linkPublishCount: number
}

export function linkTrustThresholdsFromEnv(env: {
  LINK_LOW_TRUST_ACCOUNT_AGE_DAYS?: string
  LINK_LOW_TRUST_LINK_PUBLISH_COUNT?: string
}): LinkTrustThresholds {
  return {
    accountAgeDays: nonNegativeIntegerOrDefault(
      env.LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
      DEFAULT_LINK_LOW_TRUST_ACCOUNT_AGE_DAYS,
    ),
    linkPublishCount: nonNegativeIntegerOrDefault(
      env.LINK_LOW_TRUST_LINK_PUBLISH_COUNT,
      DEFAULT_LINK_LOW_TRUST_LINK_PUBLISH_COUNT,
    ),
  }
}

export function isLowTrustLinkWorkspace(args: {
  plan: string | null | undefined
  ownerCreatedAt: string
  now: string
  linkPublishCount: number
  thresholds: LinkTrustThresholds
}): boolean {
  if (normalizePlan(args.plan) !== 'free') return false

  const ownerCreatedAt = Date.parse(args.ownerCreatedAt)
  const now = Date.parse(args.now)
  if (!Number.isFinite(ownerCreatedAt) || !Number.isFinite(now)) return true

  const accountAgeMs = now - ownerCreatedAt
  const minimumAgeMs = args.thresholds.accountAgeDays * 24 * 60 * 60 * 1000
  return (
    accountAgeMs < minimumAgeMs ||
    args.linkPublishCount < args.thresholds.linkPublishCount
  )
}

function nonNegativeIntegerOrDefault(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

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

export const DEFAULT_LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT = 20
/** The rolling window the daily publish limit is counted over. */
export const LINK_PUBLISH_RATE_WINDOW_MS = 24 * 60 * 60 * 1000

export type LinkPublishRateLimit = {
  /** Shared with the low-trust policy: a Free workspace younger than this is "new". */
  accountAgeDays: number
  /** New link publications allowed per rolling 24 hours; 0 disables the limit. */
  dailyLimit: number
}

export function linkPublishRateLimitFromEnv(env: {
  LINK_LOW_TRUST_ACCOUNT_AGE_DAYS?: string
  LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT?: string
}): LinkPublishRateLimit {
  return {
    accountAgeDays: linkTrustThresholdsFromEnv(env).accountAgeDays,
    dailyLimit: nonNegativeIntegerOrDefault(
      env.LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT,
      DEFAULT_LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT,
    ),
  }
}

/**
 * Whether the publish limit applies to this workspace at all: a Free
 * workspace younger than the account age threshold, with the limit enabled.
 * Plus and Team are never limited; an unparsable date counts as new.
 */
export function isLinkPublishLimitedWorkspace(args: {
  plan: string | null | undefined
  workspaceCreatedAt: string
  now: string
  limit: LinkPublishRateLimit
}): boolean {
  if (args.limit.dailyLimit === 0) return false
  if (normalizePlan(args.plan) !== 'free') return false
  const createdAt = Date.parse(args.workspaceCreatedAt)
  const now = Date.parse(args.now)
  return (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(now) ||
    now - createdAt < args.limit.accountAgeDays * 24 * 60 * 60 * 1000
  )
}

/** Whether a limited workspace has used up its daily link publications. */
export function isLinkPublishRateLimited(args: {
  plan: string | null | undefined
  workspaceCreatedAt: string
  now: string
  publishedInWindow: number
  limit: LinkPublishRateLimit
}): boolean {
  return (
    isLinkPublishLimitedWorkspace(args) &&
    args.publishedInWindow >= args.limit.dailyLimit
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

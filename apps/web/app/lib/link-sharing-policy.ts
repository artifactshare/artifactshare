import { normalizePlan, type BillingPlan } from './billing-plan.server'

export const LINK_EXPIRY_MIN_DAYS = 1
export const LINK_EXPIRY_MAX_DAYS = 365

export type WorkspaceLinkPolicy = {
  plan: BillingPlan
  linkSharingEnabled: boolean
  externalPostingEnabled: boolean
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
}

export type LinkExpiryPolicyInput = {
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
}

export type LinkExpiryPolicyValidation =
  | { kind: 'ok' }
  | { kind: 'invalid'; field: 'default' | 'max' | 'relationship' }

export const LINK_SHARING_PLAN_DEFAULTS = {
  free: {
    linkSharingEnabled: false,
    externalPostingEnabled: false,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  },
  plus: {
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  },
  team: {
    linkSharingEnabled: false,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 30,
    linkExpiryMaxDays: 90,
  },
} as const satisfies Record<BillingPlan, Omit<WorkspaceLinkPolicy, 'plan'>>

export function linkSharingPolicyDefaults(
  plan: string | null | undefined,
): WorkspaceLinkPolicy {
  const normalized = normalizePlan(plan)
  return { plan: normalized, ...LINK_SHARING_PLAN_DEFAULTS[normalized] }
}

export function normalizeWorkspaceLinkPolicy(row: {
  plan: string | null | undefined
  link_sharing_enabled: number | null | undefined
  external_posting_enabled: number | null | undefined
  link_expiry_default_days: number | null | undefined
  link_expiry_max_days: number | null | undefined
}): WorkspaceLinkPolicy {
  const plan = normalizePlan(row.plan)
  return {
    plan,
    linkSharingEnabled: plan !== 'free' && row.link_sharing_enabled === 1,
    externalPostingEnabled:
      plan !== 'free' && row.external_posting_enabled === 1,
    linkExpiryDefaultDays: row.link_expiry_default_days ?? null,
    linkExpiryMaxDays: row.link_expiry_max_days ?? null,
  }
}

export function validateLinkExpiryPolicy(
  input: LinkExpiryPolicyInput,
): LinkExpiryPolicyValidation {
  if (!validDays(input.linkExpiryDefaultDays)) {
    return { kind: 'invalid', field: 'default' }
  }
  if (!validDays(input.linkExpiryMaxDays)) {
    return { kind: 'invalid', field: 'max' }
  }
  if (
    input.linkExpiryDefaultDays === null &&
    input.linkExpiryMaxDays !== null
  ) {
    return { kind: 'invalid', field: 'relationship' }
  }
  if (
    input.linkExpiryDefaultDays !== null &&
    input.linkExpiryMaxDays !== null &&
    input.linkExpiryDefaultDays > input.linkExpiryMaxDays
  ) {
    return { kind: 'invalid', field: 'relationship' }
  }
  return { kind: 'ok' }
}

function validDays(value: number | null): boolean {
  return (
    value === null ||
    (Number.isInteger(value) &&
      value >= LINK_EXPIRY_MIN_DAYS &&
      value <= LINK_EXPIRY_MAX_DAYS)
  )
}

export function canUseLinkSharing(policy: WorkspaceLinkPolicy): boolean {
  if (policy.plan === 'free') return false
  return policy.linkSharingEnabled
}

export function canUseExternalPosting(policy: WorkspaceLinkPolicy): boolean {
  if (policy.plan === 'free') return false
  return policy.externalPostingEnabled
}

export function isValidUtcIso(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/,
  )
  if (!match) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6])
  )
}

export type LinkExpiryResolution =
  | { kind: 'ok'; linkExpiresAt: string | null }
  | { kind: 'invalid'; reason: 'format' | 'past' | 'max' | 'unlimited' }

export function resolveLinkExpiry(
  policy: WorkspaceLinkPolicy,
  requested: string | null | undefined,
  now: string,
): LinkExpiryResolution {
  const validation = validateLinkExpiryPolicy(policy)
  if (validation.kind !== 'ok') return { kind: 'invalid', reason: 'max' }
  if (!isValidUtcIso(now)) return { kind: 'invalid', reason: 'format' }

  if (requested === undefined) {
    if (policy.linkExpiryDefaultDays === null) {
      return policy.linkExpiryMaxDays === null
        ? { kind: 'ok', linkExpiresAt: null }
        : { kind: 'invalid', reason: 'unlimited' }
    }
    return {
      kind: 'ok',
      linkExpiresAt: addUtcDays(now, policy.linkExpiryDefaultDays),
    }
  }

  if (requested === null) {
    return policy.linkExpiryMaxDays === null
      ? { kind: 'ok', linkExpiresAt: null }
      : { kind: 'invalid', reason: 'unlimited' }
  }
  if (!isValidUtcIso(requested)) return { kind: 'invalid', reason: 'format' }
  const requestedTime = Date.parse(requested)
  const nowTime = Date.parse(now)
  if (requestedTime <= nowTime) return { kind: 'invalid', reason: 'past' }
  if (
    policy.linkExpiryMaxDays !== null &&
    requestedTime > Date.parse(addUtcDays(now, policy.linkExpiryMaxDays))
  ) {
    return { kind: 'invalid', reason: 'max' }
  }
  return { kind: 'ok', linkExpiresAt: new Date(requested).toISOString() }
}

function addUtcDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

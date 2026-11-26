import {
  BILLING_PRICES,
  PLAN_STORAGE_QUOTA_BYTES,
  STORAGE_OVERAGE_PRICES,
  type BillingPlan,
} from '~/lib/billing-prices'
import { isViteDev } from '~/lib/is-vite-dev'
import type { WorkspaceMemberRole } from '~/lib/team-management'
import type { BillingLoaderData } from '~/routes/_protected/settings/+components/billing-page'
import type { SettingsLoaderData } from '~/routes/_protected/settings/_layout'

/**
 * Billing states the local stack cannot reach on its own: they need a Stripe
 * contract or a workspace close to its storage limit. Each state holds what
 * the Settings shell and billing loaders would return for it.
 */
interface BillingState {
  description: string
  shell: SettingsLoaderData
  billing: BillingLoaderData
}

const GB = 1024 ** 3
const PERIOD_START = '2029-12-01T00:00:00.000Z'
const RENEWS_AT = '2030-01-01T00:00:00.000Z'

function shell(
  plan: BillingPlan,
  storageUsedBytes: number,
  role: WorkspaceMemberRole = 'owner',
): SettingsLoaderData {
  return {
    kind: plan === 'team' ? 'team' : 'upgrade',
    workspace: {
      id: 'fixture-workspace',
      name: 'Fixture Workspace',
      hd: null,
      plan,
      storageUsedBytes,
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES[plan],
    },
    currentUserIsAdmin: role !== 'member',
    currentUserRole: role,
    user: {
      id: 'fixture-user',
      email: 'user@example.test',
      name: 'Fixture User',
      image: null,
      initial: 'F',
    },
  }
}

/** A monthly JPY contract renewing this month, with this projected overage. */
function subscription(plan: 'plus' | 'team', overageGb: number) {
  const amount = BILLING_PRICES[plan].jpy.month
  const overageAmount = overageGb * STORAGE_OVERAGE_PRICES.jpy
  return {
    stripeSubscriptionStatus: 'active',
    hasSubscription: true,
    contract: {
      plan,
      interval: 'monthly',
      currency: 'jpy',
      amount,
      renewsAt: RENEWS_AT,
      cancelAtPeriodEnd: false,
    },
    monthlyEstimate: {
      currency: 'jpy',
      planAmount: amount,
      overageAmount,
      totalAmount: amount + overageAmount,
      planCharge: 'upcoming',
      cancelAtPeriodEnd: false,
      planDate: RENEWS_AT,
      overageGb,
      overageEnabled: true,
    },
    showOverageProjection: true,
    includedBytes: PLAN_STORAGE_QUOTA_BYTES[plan],
    overageProjection: {
      gb: overageGb,
      currency: 'jpy',
      amount: overageAmount,
    },
  } satisfies Partial<BillingLoaderData>
}

const FREE: BillingLoaderData = {
  canManage: true,
  stripeSubscriptionStatus: 'none',
  hasSubscription: false,
  billingConfigured: true,
  defaultCurrency: 'jpy',
  initialPlan: 'team',
  initialInterval: 'monthly',
  activeProjectCount: 2,
  projectLimit: 5,
  entryContext: 'default',
  externalPostingEnabled: false,
  contract: null,
  monthlyEstimate: null,
  showOverageProjection: false,
  includedBytes: PLAN_STORAGE_QUOTA_BYTES.free,
  overageProjection: null,
  contributorCount: null,
}

const TEAM_SUBSCRIPTION = subscription('team', 0)

const TEAM: BillingLoaderData = {
  ...FREE,
  ...TEAM_SUBSCRIPTION,
  activeProjectCount: 12,
  projectLimit: null,
  externalPostingEnabled: true,
  contributorCount: 6,
}

export const BILLING_STATES = {
  free: {
    description: 'Free plan with room to spare',
    shell: shell('free', 12 * 1024 ** 2),
    billing: FREE,
  },
  'free-near-limit': {
    description: 'Free plan at 92% of its storage',
    shell: shell('free', Math.round(PLAN_STORAGE_QUOTA_BYTES.free * 0.92)),
    billing: FREE,
  },
  'free-unconfigured': {
    description: 'Free plan on a stack without Stripe values',
    shell: shell('free', 12 * 1024 ** 2),
    billing: { ...FREE, billingConfigured: false },
  },
  'team-subscribed': {
    description: 'Team monthly contract in good standing',
    shell: shell('team', 18 * GB),
    billing: TEAM,
  },
  'team-past-due': {
    description: 'Team contract whose last payment failed',
    shell: shell('team', 18 * GB),
    billing: {
      ...TEAM,
      stripeSubscriptionStatus: 'past_due',
      monthlyEstimate: {
        ...TEAM_SUBSCRIPTION.monthlyEstimate,
        planCharge: 'unpaid',
        planDate: PERIOD_START,
      },
    },
  },
  'team-cancel-scheduled': {
    description: 'Team contract set to end at the period end',
    shell: shell('team', 18 * GB),
    billing: {
      ...TEAM,
      contract: { ...TEAM_SUBSCRIPTION.contract, cancelAtPeriodEnd: true },
      // A contract that ends at renewal is not charged for the next period.
      monthlyEstimate: {
        ...TEAM_SUBSCRIPTION.monthlyEstimate,
        planAmount: 0,
        totalAmount: 0,
        planCharge: 'none',
        cancelAtPeriodEnd: true,
      },
    },
  },
  'team-overage': {
    description: 'Team workspace 12 GB past its included storage',
    shell: shell('team', PLAN_STORAGE_QUOTA_BYTES.team + 12 * GB),
    billing: { ...TEAM, ...subscription('team', 12) },
  },
  'team-member': {
    description: 'Team workspace seen by a member who cannot manage billing',
    shell: shell('team', 18 * GB, 'member'),
    // Only owners load the contract, and the estimate needs it.
    billing: {
      ...TEAM,
      canManage: false,
      contract: null,
      monthlyEstimate: null,
    },
  },
  'plus-overage': {
    description: 'Plus workspace 2 GB past its included storage',
    shell: shell('plus', PLAN_STORAGE_QUOTA_BYTES.plus + 2 * GB),
    billing: {
      ...TEAM,
      ...subscription('plus', 2),
      activeProjectCount: 8,
      projectLimit: 20,
      entryContext: 'plusOverage',
      contributorCount: null,
    },
  },
} satisfies Record<string, BillingState>

export type BillingStateId = keyof typeof BILLING_STATES

export const BILLING_STATE_IDS = Object.keys(BILLING_STATES) as BillingStateId[]

export function isBillingStateId(value: unknown): value is BillingStateId {
  return typeof value === 'string' && Object.hasOwn(BILLING_STATES, value)
}

/** The state a dev route names; a 404 outside Vite dev or for any other. */
export function requireBillingState(state: string | undefined): BillingState {
  if (!isViteDev() || !isBillingStateId(state))
    throw new Response(null, { status: 404 })
  return BILLING_STATES[state]
}

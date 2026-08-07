import type { Compilable, Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type Stripe from 'stripe'
import {
  isActiveSubscriptionStatus,
  PLAN_STORAGE_QUOTA_BYTES,
  type BillingPlan,
} from '~/lib/billing-plan.server'
import { LINK_SHARING_PLAN_DEFAULTS } from '~/lib/link-sharing-policy'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'
import {
  allFixedPriceIds,
  hasActiveSubscription,
  planForPriceId,
  resolveStripePrices,
  type BillingEnv,
  type StripePrices,
  type WorkspaceBillingRow,
} from './billing.server'

export type SyncWorkspaceSubscriptionOptions = {
  stripeEventId?: string
}

export type SyncWorkspaceSubscriptionResult =
  | { kind: 'ok' }
  | { kind: 'ignored' }
  | { kind: 'workspace-not-found' }
  | { kind: 'unknown-price' }

type WorkspaceSubscriptionRow = Pick<
  WorkspaceBillingRow,
  'id' | 'plan' | 'stripe_customer_id' | 'stripe_subscription_id'
> & {
  link_sharing_enabled: number
  external_posting_enabled: number
  link_expiry_default_days: number | null
  link_expiry_max_days: number | null
}

export function deriveContractPlanFromSubscription(
  subscription: Stripe.Subscription,
  prices: StripePrices,
): 'plus' | 'team' | null {
  const fixedPriceIds = allFixedPriceIds(prices)
  const contractPlans = new Set<'plus' | 'team'>()

  for (const item of subscription.items.data) {
    const priceId = typeof item.price === 'string' ? item.price : item.price.id
    if (!fixedPriceIds.has(priceId)) continue
    const plan = planForPriceId(priceId, prices)
    if (plan === 'plus' || plan === 'team') {
      contractPlans.add(plan)
    }
  }

  if (contractPlans.size !== 1) return null
  return [...contractPlans][0]
}

export function derivePlanFromSubscription(
  subscription: Stripe.Subscription,
  prices: StripePrices,
): BillingPlan | null {
  const contractPlan = deriveContractPlanFromSubscription(subscription, prices)
  if (contractPlan === null) return null

  if (isActiveSubscriptionStatus(subscription.status)) {
    return contractPlan
  }
  return 'free'
}

function subscriptionCustomerId(
  subscription: Stripe.Subscription,
): string | null {
  const customer = subscription.customer
  if (typeof customer === 'string') return customer
  return customer?.id ?? null
}

async function resolveWorkspaceForSubscription(
  db: Kysely<DB>,
  subscription: Stripe.Subscription,
): Promise<WorkspaceSubscriptionRow | null> {
  const metadataWorkspaceId = subscription.metadata?.workspace_id?.trim()
  if (metadataWorkspaceId) {
    const row = await db
      .selectFrom('workspaces')
      .select([
        'id',
        'plan',
        'stripe_customer_id',
        'stripe_subscription_id',
        'link_sharing_enabled',
        'external_posting_enabled',
        'link_expiry_default_days',
        'link_expiry_max_days',
      ])
      .where('id', '=', metadataWorkspaceId)
      .executeTakeFirst()
    if (row) return row
  }

  const customerId = subscriptionCustomerId(subscription)
  if (!customerId) return null

  return (
    (await db
      .selectFrom('workspaces')
      .select([
        'id',
        'plan',
        'stripe_customer_id',
        'stripe_subscription_id',
        'link_sharing_enabled',
        'external_posting_enabled',
        'link_expiry_default_days',
        'link_expiry_max_days',
      ])
      .where('stripe_customer_id', '=', customerId)
      .executeTakeFirst()) ?? null
  )
}

export async function syncWorkspaceSubscription(
  db: Kysely<DB>,
  stripe: Stripe,
  env: BillingEnv,
  subscriptionId: string,
  options?: SyncWorkspaceSubscriptionOptions,
): Promise<SyncWorkspaceSubscriptionResult> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  })

  const workspace = await resolveWorkspaceForSubscription(db, subscription)
  if (!workspace) {
    console.error('billing_sync_workspace_not_found', {
      subscriptionId: subscription.id,
      customerId: subscriptionCustomerId(subscription),
      metadataWorkspaceId: subscription.metadata?.workspace_id ?? null,
    })
    return { kind: 'workspace-not-found' }
  }

  if (
    workspace.stripe_subscription_id !== null &&
    workspace.stripe_subscription_id !== subscription.id &&
    !hasActiveSubscription(subscription.status)
  ) {
    return { kind: 'ignored' }
  }

  const prices = resolveStripePrices(env)
  const contractPlan = deriveContractPlanFromSubscription(subscription, prices)
  if (contractPlan === null) {
    console.error('billing_sync_unknown_price', {
      subscriptionId: subscription.id,
      workspaceId: workspace.id,
    })
    return { kind: 'unknown-price' }
  }

  const plan = derivePlanFromSubscription(subscription, prices)
  if (plan === null) {
    console.error('billing_sync_unknown_price', {
      subscriptionId: subscription.id,
      workspaceId: workspace.id,
    })
    return { kind: 'unknown-price' }
  }

  const workspaceUpdates: Record<string, unknown> = {
    stripe_subscription_id: subscription.id,
    stripe_subscription_status: subscription.status,
    plan,
    storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[plan],
  }

  // Apply product defaults on the first paid contract. Later paid-plan changes
  // preserve explicit access controls and expiry settings.
  if (
    workspace.plan === 'free' &&
    workspace.stripe_subscription_id === null &&
    workspace.plan !== plan
  ) {
    if (plan === 'plus' || plan === 'team') {
      const defaults = LINK_SHARING_PLAN_DEFAULTS[plan]
      Object.assign(workspaceUpdates, {
        link_sharing_enabled: defaults.linkSharingEnabled ? 1 : 0,
        external_posting_enabled: defaults.externalPostingEnabled ? 1 : 0,
        link_expiry_default_days: defaults.linkExpiryDefaultDays,
        link_expiry_max_days: defaults.linkExpiryMaxDays,
      })
    }
  }

  if (!options?.stripeEventId) {
    await db
      .updateTable('workspaces')
      .set(workspaceUpdates)
      .where('id', '=', workspace.id)
      .execute()
    return { kind: 'ok' }
  }

  const now = nowIso()
  const batch: Compilable<unknown>[] = [
    db
      .updateTable('workspaces')
      .set(workspaceUpdates)
      .where('id', '=', workspace.id),
  ]
  if (workspace.plan !== plan) {
    const planChangeDetail = JSON.stringify({
      stripe_event_id: options.stripeEventId,
      from: workspace.plan,
      to: plan,
    })
    batch.push(
      db
        .insertInto('audit_events')
        .columns([
          'id',
          'workspace_id',
          'actor_user_id',
          'action',
          'subject_type',
          'subject_id',
          'detail',
          'created_at',
        ])
        .expression((eb) =>
          eb
            .selectFrom('billing_webhook_events')
            .where('stripe_event_id', '=', options.stripeEventId!)
            .where('processed_at', 'is', null)
            .select([
              eb.val(nanoid(16)).as('id'),
              eb.val(workspace.id).as('workspace_id'),
              eb.val(null).as('actor_user_id'),
              eb.val('plan.change').as('action'),
              eb.val('workspace').as('subject_type'),
              eb.val(workspace.id).as('subject_id'),
              eb.val(planChangeDetail).as('detail'),
              eb.val(now).as('created_at'),
            ]),
        ),
    )
  }
  batch.push(
    db
      .updateTable('billing_webhook_events')
      .set({ processed_at: now, error: null })
      .where('stripe_event_id', '=', options.stripeEventId)
      .where('processed_at', 'is', null),
  )
  await runD1Batch(...batch)

  return { kind: 'ok' }
}

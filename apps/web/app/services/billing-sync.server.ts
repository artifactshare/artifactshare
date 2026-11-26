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

export type BillingSubscription = Pick<
  Stripe.Subscription,
  'id' | 'status' | 'metadata' | 'customer'
> & {
  items: {
    data: Array<
      Pick<Stripe.SubscriptionItem, 'id'> & {
        price: Pick<Stripe.SubscriptionItem['price'], 'id'>
      }
    >
  }
}
export type BillingStripeClient = {
  subscriptions: {
    retrieve: (
      ...args: Parameters<Stripe['subscriptions']['retrieve']>
    ) => Promise<BillingSubscription>
  }
}

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
}

export function deriveContractPlanFromSubscription(
  subscription: BillingSubscription,
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
  subscription: BillingSubscription,
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
  subscription: BillingSubscription,
): string | null {
  const customer = subscription.customer
  if (typeof customer === 'string') return customer
  return customer?.id ?? null
}

async function resolveWorkspaceForSubscription(
  db: Kysely<DB>,
  subscription: BillingSubscription,
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
      ])
      .where('stripe_customer_id', '=', customerId)
      .executeTakeFirst()) ?? null
  )
}

export async function syncWorkspaceSubscription(
  db: Kysely<DB>,
  stripe: BillingStripeClient,
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

  // Apply the access-control defaults on the first paid contract. Link expiry
  // settings belong to the workspace and are never rewritten by a plan change;
  // later paid-plan changes preserve the access controls too.
  if (
    workspace.plan === 'free' &&
    workspace.stripe_subscription_id === null &&
    workspace.plan !== plan
  ) {
    if (plan === 'plus' || plan === 'team') {
      const defaults = LINK_SHARING_PLAN_DEFAULTS[plan]
      Object.assign(workspaceUpdates, {
        // Team defaults to link sharing off for new workspaces; an upgrade
        // must not cut links the workspace already shares.
        link_sharing_enabled:
          plan === 'team'
            ? workspace.link_sharing_enabled
            : defaults.linkSharingEnabled
              ? 1
              : 0,
        external_posting_enabled: defaults.externalPostingEnabled ? 1 : 0,
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
  await runD1Batch(db, ...batch)

  return { kind: 'ok' }
}

type ReturnedCheckoutSession = Pick<
  Stripe.Checkout.Session,
  'client_reference_id' | 'mode' | 'status' | 'customer' | 'subscription'
>

export type CheckoutReturnStripeClient = BillingStripeClient & {
  checkout: {
    sessions: { retrieve: (id: string) => Promise<ReturnedCheckoutSession> }
  }
}

const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/u

function stripeObjectId(value: string | { id: string } | null): string | null {
  if (typeof value === 'string') return value
  return value?.id ?? null
}

/**
 * Brings the plan up to date when the owner returns from Stripe Checkout,
 * before the page reads it, so the billing page shows the plan just bought
 * without waiting for the webhook. The session must be a completed
 * subscription Checkout that this workspace started for its own Stripe
 * customer; anything else is left to the webhook, as before. The subscription
 * goes through the same sync the webhook uses.
 */
export async function syncReturnedCheckout(
  db: Kysely<DB>,
  stripe: CheckoutReturnStripeClient,
  env: BillingEnv,
  workspaceId: string,
  checkoutSessionId: string,
): Promise<SyncWorkspaceSubscriptionResult | { kind: 'not-this-checkout' }> {
  if (!CHECKOUT_SESSION_ID.test(checkoutSessionId))
    return { kind: 'not-this-checkout' }
  const [session, workspace] = await Promise.all([
    stripe.checkout.sessions.retrieve(checkoutSessionId),
    db
      .selectFrom('workspaces')
      .select('stripe_customer_id')
      .where('id', '=', workspaceId)
      .executeTakeFirst(),
  ])
  const subscriptionId = stripeObjectId(session.subscription)
  if (
    session.mode !== 'subscription' ||
    session.status !== 'complete' ||
    session.client_reference_id !== workspaceId ||
    !workspace?.stripe_customer_id ||
    stripeObjectId(session.customer) !== workspace.stripe_customer_id ||
    !subscriptionId
  )
    return { kind: 'not-this-checkout' }
  return syncWorkspaceSubscription(db, stripe, env, subscriptionId)
}

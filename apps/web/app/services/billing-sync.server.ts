import type { Compilable, ExpressionBuilder, Kysely } from 'kysely'
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
  | { kind: 'conflict' }

type WorkspaceSubscriptionRow = Pick<
  WorkspaceBillingRow,
  | 'id'
  | 'plan'
  | 'stripe_customer_id'
  | 'stripe_subscription_id'
  | 'stripe_subscription_status'
> & {
  link_sharing_enabled: number
  stripe_sync_token: string | null
}

const NEVER_PAID_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'incomplete',
  'incomplete_expired',
] satisfies Stripe.Subscription.Status[])

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
        'stripe_subscription_status',
        'link_sharing_enabled',
        'stripe_sync_token',
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
        'stripe_subscription_status',
        'link_sharing_enabled',
        'stripe_sync_token',
      ])
      .where('stripe_customer_id', '=', customerId)
      .executeTakeFirst()) ?? null
  )
}

// Syncs that collide retry with fresh reads. Past this many, the webhook answers
// 500 and Stripe delivers the event again later.
const MAX_SYNC_ATTEMPTS = 3

export async function syncWorkspaceSubscription(
  db: Kysely<DB>,
  stripe: BillingStripeClient,
  env: BillingEnv,
  subscriptionId: string,
  options?: SyncWorkspaceSubscriptionOptions,
): Promise<SyncWorkspaceSubscriptionResult> {
  const routing = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price'],
  })
  const target = await resolveWorkspaceForSubscription(db, routing)
  if (!target) {
    console.error('billing_sync_workspace_not_found', {
      subscriptionId: routing.id,
      customerId: subscriptionCustomerId(routing),
      metadataWorkspaceId: routing.metadata?.workspace_id ?? null,
    })
    return { kind: 'workspace-not-found' }
  }

  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt++) {
    // Read the row, then Stripe, then write only if no other sync committed
    // in between (stripe_sync_token is unchanged). A sync that read Stripe
    // before a change then cannot overwrite one that read it after.
    const workspace = await readWorkspaceSubscriptionRow(db, target.id)
    if (!workspace) return { kind: 'workspace-not-found' }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    })
    const attempted = await writeWorkspaceSubscription(
      db,
      env,
      workspace,
      subscription,
      options,
    )
    if (attempted !== 'conflict') return attempted
  }
  console.error('billing_sync_conflict', {
    subscriptionId,
    workspaceId: target.id,
  })
  return { kind: 'conflict' }
}

async function readWorkspaceSubscriptionRow(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<WorkspaceSubscriptionRow | undefined> {
  return await db
    .selectFrom('workspaces')
    .select([
      'id',
      'plan',
      'stripe_customer_id',
      'stripe_subscription_id',
      'stripe_subscription_status',
      'link_sharing_enabled',
      'stripe_sync_token',
    ])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
}

async function writeWorkspaceSubscription(
  db: Kysely<DB>,
  env: BillingEnv,
  workspace: WorkspaceSubscriptionRow,
  subscription: BillingSubscription,
  options: SyncWorkspaceSubscriptionOptions | undefined,
): Promise<SyncWorkspaceSubscriptionResult | 'conflict'> {
  const syncToken = nanoid()
  const unchangedSince = (query: ExpressionBuilder<DB, 'workspaces'>) =>
    query('stripe_sync_token', 'is', workspace.stripe_sync_token)

  if (
    workspace.stripe_subscription_id !== null &&
    workspace.stripe_subscription_id !== subscription.id &&
    !hasActiveSubscription(subscription.status)
  ) {
    // An ignored event still takes the token, so a sync that read Stripe
    // before it cannot commit afterwards.
    const committed = await commitSync(db, workspace, syncToken, [
      db
        .updateTable('workspaces')
        .set({ stripe_sync_token: syncToken })
        .where('id', '=', workspace.id)
        .where(unchangedSince),
      ...processedMark(db, workspace.id, syncToken, options),
    ])
    return committed ? { kind: 'ignored' } : 'conflict'
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
    stripe_sync_token: syncToken,
  }

  const hadPaidContract =
    workspace.stripe_subscription_id !== null &&
    !NEVER_PAID_SUBSCRIPTION_STATUSES.has(workspace.stripe_subscription_status)
  if (
    workspace.plan === 'free' &&
    !hadPaidContract &&
    workspace.plan !== plan
  ) {
    if (plan === 'plus' || plan === 'team') {
      const defaults = LINK_SHARING_PLAN_DEFAULTS[plan]
      Object.assign(workspaceUpdates, {
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

  const now = nowIso()
  const batch: Compilable<unknown>[] = []
  if (workspace.plan !== plan) {
    const planChangeDetail = JSON.stringify({
      stripe_event_id: options?.stripeEventId,
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
            .selectFrom('workspaces')
            .where('id', '=', workspace.id)
            .where('plan', '=', workspace.plan)
            .where(unchangedSince)
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
      .updateTable('workspaces')
      .set(workspaceUpdates)
      .where('id', '=', workspace.id)
      .where(unchangedSince),
    ...processedMark(db, workspace.id, syncToken, options),
  )
  return (await commitSync(db, workspace, syncToken, batch))
    ? { kind: 'ok' }
    : 'conflict'
}

function processedMark(
  db: Kysely<DB>,
  workspaceId: string,
  syncToken: string,
  options: SyncWorkspaceSubscriptionOptions | undefined,
): Compilable<unknown>[] {
  if (!options?.stripeEventId) return []
  return [
    db
      .updateTable('billing_webhook_events')
      .set({ processed_at: nowIso(), error: null })
      .where('stripe_event_id', '=', options.stripeEventId)
      .where('processed_at', 'is', null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('workspaces')
            .select('id')
            .where('id', '=', workspaceId)
            .where('stripe_sync_token', '=', syncToken),
        ),
      ),
  ]
}

async function commitSync(
  db: Kysely<DB>,
  workspace: WorkspaceSubscriptionRow,
  syncToken: string,
  batch: Compilable<unknown>[],
): Promise<boolean> {
  await runD1Batch(db, ...batch)
  const after = await db
    .selectFrom('workspaces')
    .select('stripe_sync_token')
    .where('id', '=', workspace.id)
    .executeTakeFirst()
  // A mismatch means another sync committed first, or replaced this one's
  // token right after it. Either way the caller retries from a fresh read,
  // which is safe because a retry writes what Stripe says now.
  return after?.stripe_sync_token === syncToken
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

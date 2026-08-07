import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import Stripe from 'stripe'
import { nowIso } from '~/lib/datetime'
import { isSqliteConstraintError } from '~/lib/d1-errors.server'
import { createStripeClient, type BillingEnv } from '~/services/billing.server'
import { syncWorkspaceSubscription } from '~/services/billing-sync.server'
import { createDb } from '~/services/db.server'
import type { DB } from '~/types/db'
import type { Route } from './+types/api.stripe.webhook'

const SUBSCRIPTION_SYNC_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
])

export const loader = () => new Response('Not found', { status: 404 })

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'missing-stripe-secrets' }, { status: 500 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return new Response('Missing signature', { status: 400 })
  }

  const body = await request.text()
  const stripe = createStripeClient(env as BillingEnv)

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    )
  } catch {
    return new Response('Invalid signature', { status: 400 })
  }

  console.info('stripe_webhook_received', {
    eventId: event.id,
    eventType: event.type,
  })

  const db = createDb()
  try {
    const receipt = await recordWebhookEvent(db, event.id, event.type)
    if (receipt === 'already-processed') {
      return new Response(null, { status: 200 })
    }

    if (!SUBSCRIPTION_SYNC_EVENT_TYPES.has(event.type)) {
      await markWebhookProcessed(db, event.id)
      return new Response(null, { status: 200 })
    }

    const subscriptionId = extractSubscriptionId(event)
    if (!subscriptionId) {
      console.info('stripe_webhook_no_subscription', {
        eventId: event.id,
        eventType: event.type,
      })
      await markWebhookProcessed(db, event.id)
      return new Response(null, { status: 200 })
    }

    try {
      const result = await syncWorkspaceSubscription(
        db,
        stripe,
        env as BillingEnv,
        subscriptionId,
        { stripeEventId: event.id },
      )

      if (
        result.kind === 'workspace-not-found' ||
        result.kind === 'unknown-price'
      ) {
        await markWebhookError(db, event.id, result.kind)
        return new Response(null, { status: 500 })
      }

      if (result.kind === 'ignored') {
        await markWebhookProcessed(db, event.id)
      }

      return new Response(null, { status: 200 })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'billing_sync_failed'
      console.error('stripe_webhook_sync_failed', {
        eventId: event.id,
        eventType: event.type,
        error,
      })
      await markWebhookError(db, event.id, message)
      return new Response(null, { status: 500 })
    }
  } finally {
    await db.destroy()
  }
}

type WebhookReceipt = 'new' | 'already-processed' | 'retry'

function hasBillingWebhookEventPrimaryKeyConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const messages = [err.message]
  if (err.cause instanceof Error) messages.push(err.cause.message)
  return messages.some((message) =>
    /(?:UNIQUE|PRIMARY KEY) constraint failed: billing_webhook_events\.stripe_event_id/i.test(
      message,
    ),
  )
}

async function recordWebhookEvent(
  db: Kysely<DB>,
  stripeEventId: string,
  eventType: string,
): Promise<WebhookReceipt> {
  const receivedAt = nowIso()
  try {
    await db
      .insertInto('billing_webhook_events')
      .values({
        stripe_event_id: stripeEventId,
        event_type: eventType,
        received_at: receivedAt,
        processed_at: null,
        error: null,
      })
      .execute()
    return 'new'
  } catch (err) {
    if (
      !hasBillingWebhookEventPrimaryKeyConflict(err) &&
      !isSqliteConstraintError(err)
    ) {
      throw err
    }

    const existing = await db
      .selectFrom('billing_webhook_events')
      .select(['processed_at'])
      .where('stripe_event_id', '=', stripeEventId)
      .executeTakeFirst()

    if (!existing) throw err
    if (existing.processed_at !== null) return 'already-processed'
    return 'retry'
  }
}

async function markWebhookProcessed(
  db: Kysely<DB>,
  stripeEventId: string,
): Promise<void> {
  await db
    .updateTable('billing_webhook_events')
    .set({ processed_at: nowIso(), error: null })
    .where('stripe_event_id', '=', stripeEventId)
    .execute()
}

async function markWebhookError(
  db: Kysely<DB>,
  stripeEventId: string,
  error: string,
): Promise<void> {
  await db
    .updateTable('billing_webhook_events')
    .set({ error })
    .where('stripe_event_id', '=', stripeEventId)
    .execute()
}

export function extractSubscriptionId(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const subscription = session.subscription
      if (typeof subscription === 'string') return subscription
      return subscription?.id ?? null
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      return (event.data.object as Stripe.Subscription).id
    }
    case 'invoice.payment_failed':
    case 'invoice.paid': {
      return invoiceSubscriptionId(event.data.object as Stripe.Invoice)
    }
    default:
      return null
  }
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentSubscription = invoice.parent?.subscription_details?.subscription
  if (typeof parentSubscription === 'string') return parentSubscription
  return parentSubscription?.id ?? null
}

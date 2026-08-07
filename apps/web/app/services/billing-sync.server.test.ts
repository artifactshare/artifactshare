import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-plan.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import {
  derivePlanFromSubscription,
  syncWorkspaceSubscription,
} from './billing-sync.server'
import { resolveStripePrices, type BillingEnv } from './billing.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
  },
}))

const legacyMeteredOveragePrice = 'price_team_overage'

const prices = resolveStripePrices({
  STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_monthly',
  STRIPE_PRICE_PLUS_YEARLY: 'price_plus_yearly',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_team_monthly',
  STRIPE_PRICE_TEAM_YEARLY: 'price_team_yearly',
  STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
  STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
})

const env: BillingEnv = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PLUS_MONTHLY: prices.plusMonthly,
  STRIPE_PRICE_PLUS_YEARLY: prices.plusYearly,
  STRIPE_PRICE_TEAM_MONTHLY: prices.teamMonthly,
  STRIPE_PRICE_TEAM_YEARLY: prices.teamYearly,
  STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
  STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
}

describe('billing sync service', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
  })

  afterEach(async () => {
    sqliteRef.current = null
    await db.destroy()
  })

  test('derivePlanFromSubscription maps active subscriptions to contract plan', () => {
    const subscription = makeSubscription({
      status: 'active',
      items: [{ priceId: prices.plusMonthly }],
    })

    expect(derivePlanFromSubscription(subscription, prices)).toBe('plus')
  })

  test('derivePlanFromSubscription returns free for canceled subscriptions', () => {
    const subscription = makeSubscription({
      status: 'canceled',
      items: [{ priceId: prices.teamMonthly }],
    })

    expect(derivePlanFromSubscription(subscription, prices)).toBe('free')
  })

  test('derivePlanFromSubscription ignores metered prices', () => {
    const subscription = makeSubscription({
      status: 'active',
      items: [
        { priceId: prices.teamMonthly },
        { priceId: legacyMeteredOveragePrice, metered: true },
      ],
    })

    expect(derivePlanFromSubscription(subscription, prices)).toBe('team')
  })

  test('derivePlanFromSubscription fails when no known fixed price exists', () => {
    const subscription = makeSubscription({
      status: 'active',
      items: [{ priceId: 'price_unknown' }],
    })

    expect(derivePlanFromSubscription(subscription, prices)).toBeNull()
  })

  test('syncWorkspaceSubscription applies an active plus contract', async () => {
    seedWorkspace(sqlite, { plan: 'free' })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_new',
        status: 'active',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.plusMonthly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_new')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'plus',
      stripe_subscription_id: 'sub_new',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    expect(
      sqlite
        .prepare(
          `SELECT link_sharing_enabled, external_posting_enabled,
                  link_expiry_default_days, link_expiry_max_days
           FROM workspaces WHERE id = 'ws1'`,
        )
        .get(),
    ).toEqual({
      link_sharing_enabled: 1,
      external_posting_enabled: 1,
      link_expiry_default_days: 30,
      link_expiry_max_days: 90,
    })
  })

  test('syncWorkspaceSubscription returns free after cancellation', async () => {
    seedWorkspace(sqlite, {
      plan: 'plus',
      stripeSubscriptionId: 'sub_old',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_old',
        status: 'canceled',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.plusMonthly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_old')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'free',
      stripe_subscription_id: 'sub_old',
      stripe_subscription_status: 'canceled',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
  })

  test('syncWorkspaceSubscription keeps plan on past_due', async () => {
    seedWorkspace(sqlite, {
      plan: 'team',
      stripeSubscriptionId: 'sub_team',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_team',
        status: 'past_due',
        metadata: { workspace_id: 'ws1' },
        items: [
          { priceId: prices.teamMonthly },
          { priceId: legacyMeteredOveragePrice, metered: true },
        ],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_team')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'team',
      stripe_subscription_id: 'sub_team',
      stripe_subscription_status: 'past_due',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
  })

  test('syncWorkspaceSubscription ignores stale old subscription events', async () => {
    seedWorkspace(sqlite, {
      plan: 'plus',
      stripeSubscriptionId: 'sub_new',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_old',
        status: 'canceled',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.plusMonthly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_old')

    expect(result).toEqual({ kind: 'ignored' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'plus',
      stripe_subscription_id: 'sub_new',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
  })

  test('syncWorkspaceSubscription replaces workspace subscription when a new active contract arrives', async () => {
    seedWorkspace(sqlite, {
      plan: 'plus',
      stripeSubscriptionId: 'sub_old',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_new',
        status: 'active',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.teamMonthly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_new')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'team',
      stripe_subscription_id: 'sub_new',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
  })

  test.each([
    ['plus', prices.teamMonthly, 'team'],
    ['team', prices.plusMonthly, 'plus'],
  ])(
    'preserves paid access policy when changing %s to %s',
    async (from, priceId, to) => {
      seedWorkspace(sqlite, { plan: from })
      sqlite.exec(`UPDATE workspaces SET
      link_sharing_enabled = 0,
      external_posting_enabled = 0,
      link_expiry_default_days = 7,
      link_expiry_max_days = 14
      WHERE id = 'ws1'`)
      const stripe = mockStripeRetrieve(
        makeSubscription({
          id: 'sub_change',
          status: 'active',
          metadata: { workspace_id: 'ws1' },
          items: [{ priceId }],
        }),
      )

      await expect(
        syncWorkspaceSubscription(db, stripe, env, 'sub_change'),
      ).resolves.toEqual({ kind: 'ok' })
      expect(
        sqlite
          .prepare(
            `SELECT plan, link_sharing_enabled, external_posting_enabled,
                  link_expiry_default_days, link_expiry_max_days
           FROM workspaces WHERE id = 'ws1'`,
          )
          .get(),
      ).toEqual({
        plan: to,
        link_sharing_enabled: 0,
        external_posting_enabled: 0,
        link_expiry_default_days: 7,
        link_expiry_max_days: 14,
      })
    },
  )

  test('preserves access policy when a canceled workspace resubscribes', async () => {
    seedWorkspace(sqlite, {
      plan: 'free',
      stripeSubscriptionId: 'sub_canceled',
      stripeSubscriptionStatus: 'canceled',
    })
    sqlite.exec(`UPDATE workspaces SET
      link_sharing_enabled = 0,
      external_posting_enabled = 0,
      link_expiry_default_days = 7,
      link_expiry_max_days = 14
      WHERE id = 'ws1'`)
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_resubscribed',
        status: 'active',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.plusMonthly }],
      }),
    )

    await expect(
      syncWorkspaceSubscription(db, stripe, env, 'sub_resubscribed'),
    ).resolves.toEqual({ kind: 'ok' })
    expect(
      sqlite
        .prepare(
          `SELECT plan, link_sharing_enabled, external_posting_enabled,
                  link_expiry_default_days, link_expiry_max_days
           FROM workspaces WHERE id = 'ws1'`,
        )
        .get(),
    ).toEqual({
      plan: 'plus',
      link_sharing_enabled: 0,
      external_posting_enabled: 0,
      link_expiry_default_days: 7,
      link_expiry_max_days: 14,
    })
  })

  test('syncWorkspaceSubscription leaves plan unchanged for unknown prices', async () => {
    seedWorkspace(sqlite, {
      plan: 'free',
      stripeSubscriptionId: 'sub_unknown',
      stripeSubscriptionStatus: 'active',
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_unknown',
        status: 'active',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: 'price_unknown' }],
      }),
    )

    const result = await syncWorkspaceSubscription(
      db,
      stripe,
      env,
      'sub_unknown',
    )

    expect(result).toEqual({ kind: 'unknown-price' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'free',
      stripe_subscription_id: 'sub_unknown',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
  })

  test('syncWorkspaceSubscription resolves workspace by stripe customer id', async () => {
    seedWorkspace(sqlite, {
      plan: 'free',
      stripeCustomerId: 'cus_1',
    })
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_1',
        status: 'active',
        customer: 'cus_1',
        items: [{ priceId: prices.plusYearly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_1')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite).plan).toBe('plus')
  })

  test('syncWorkspaceSubscription does not update subscription items for active team contract', async () => {
    seedWorkspace(sqlite, { plan: 'free' })
    const subscription = makeSubscription({
      id: 'sub_team',
      status: 'active',
      metadata: { workspace_id: 'ws1' },
      items: [{ priceId: prices.teamMonthly }],
    })
    const stripe = mockStripe(subscription)

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_team')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'team',
      stripe_subscription_id: 'sub_team',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
  })

  test('syncWorkspaceSubscription does not re-add metered items on webhook resync', async () => {
    seedWorkspace(sqlite, {
      plan: 'team',
      stripeSubscriptionId: 'sub_team',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
    const subscription = makeSubscription({
      id: 'sub_team',
      status: 'active',
      metadata: { workspace_id: 'ws1' },
      items: [
        { priceId: prices.teamMonthly },
        { priceId: legacyMeteredOveragePrice, metered: true },
      ],
    })
    const stripe = mockStripe(subscription)

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_team')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'team',
      stripe_subscription_id: 'sub_team',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
    })
  })

  test('syncWorkspaceSubscription does not remove metered items for active plus contract', async () => {
    seedWorkspace(sqlite, {
      plan: 'plus',
      stripeSubscriptionId: 'sub_plus',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    const subscription = makeSubscription({
      id: 'sub_plus',
      status: 'active',
      metadata: { workspace_id: 'ws1' },
      items: [
        { priceId: prices.plusMonthly },
        { priceId: legacyMeteredOveragePrice, metered: true },
      ],
    })
    subscription.items.data[1].id = 'si_metered'
    const stripe = mockStripe(subscription)

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_plus')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'plus',
      stripe_subscription_id: 'sub_plus',
      stripe_subscription_status: 'active',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
  })

  test('syncWorkspaceSubscription skips subscription updates for canceled plus contract with metered item', async () => {
    seedWorkspace(sqlite, {
      plan: 'plus',
      stripeSubscriptionId: 'sub_plus',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.plus,
    })
    const subscription = makeSubscription({
      id: 'sub_plus',
      status: 'canceled',
      metadata: { workspace_id: 'ws1' },
      items: [
        { priceId: prices.plusMonthly },
        { priceId: legacyMeteredOveragePrice, metered: true },
      ],
    })
    subscription.items.data[1].id = 'si_metered'
    const stripe = mockStripe(subscription)

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_plus')

    expect(result).toEqual({ kind: 'ok' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
    expect(readWorkspace(sqlite)).toEqual({
      plan: 'free',
      stripe_subscription_id: 'sub_plus',
      stripe_subscription_status: 'canceled',
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
  })

  test('syncWorkspaceSubscription writes plan.change audit once with webhook idempotency', async () => {
    seedWorkspace(sqlite, { plan: 'free' })
    sqlite.exec(`
      INSERT INTO billing_webhook_events (
        stripe_event_id, event_type, received_at, processed_at, error
      ) VALUES (
        'evt_plan', 'customer.subscription.updated', '2026-07-01T00:00:00.000Z',
        NULL, NULL
      );
    `)
    const stripe = mockStripeRetrieve(
      makeSubscription({
        id: 'sub_new',
        status: 'active',
        metadata: { workspace_id: 'ws1' },
        items: [{ priceId: prices.plusMonthly }],
      }),
    )

    const result = await syncWorkspaceSubscription(db, stripe, env, 'sub_new', {
      stripeEventId: 'evt_plan',
    })

    expect(result).toEqual({ kind: 'ok' })
    const audits = sqlite
      .prepare(
        `SELECT action, subject_type, subject_id, actor_user_id, detail
         FROM audit_events`,
      )
      .all() as Array<{
      action: string
      subject_type: string
      subject_id: string
      actor_user_id: string | null
      detail: string
    }>
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'plan.change',
      subject_type: 'workspace',
      subject_id: 'ws1',
      actor_user_id: null,
    })
    expect(JSON.parse(audits[0]!.detail)).toEqual({
      stripe_event_id: 'evt_plan',
      from: 'free',
      to: 'plus',
    })
    expect(
      (
        sqlite
          .prepare(
            `SELECT processed_at FROM billing_webhook_events
             WHERE stripe_event_id = 'evt_plan'`,
          )
          .get() as { processed_at: string | null }
      ).processed_at,
    ).not.toBeNull()

    const retry = await syncWorkspaceSubscription(db, stripe, env, 'sub_new', {
      stripeEventId: 'evt_plan',
    })
    expect(retry).toEqual({ kind: 'ok' })
    expect(
      (
        sqlite.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as {
          count: number
        }
      ).count,
    ).toBe(1)
  })
})

function makeSubscription(args: {
  id?: string
  status: Stripe.Subscription.Status
  metadata?: Record<string, string>
  customer?: string
  items: Array<{ priceId: string; metered?: boolean }>
}): Stripe.Subscription {
  return {
    id: args.id ?? 'sub_test',
    status: args.status,
    metadata: args.metadata ?? {},
    customer: args.customer ?? 'cus_test',
    items: {
      data: args.items.map((item, index) => ({
        id: `si_${index}`,
        price: item.metered
          ? { id: item.priceId, recurring: { usage_type: 'metered' } }
          : { id: item.priceId },
      })),
    },
  } as Stripe.Subscription
}

function mockStripeRetrieve(subscription: Stripe.Subscription): Stripe {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(subscription),
      update: vi.fn().mockResolvedValue(subscription),
    },
  } as unknown as Stripe
}

function mockStripe(subscription: Stripe.Subscription): Stripe {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue(subscription),
      update: vi.fn().mockResolvedValue(subscription),
    },
  } as unknown as Stripe
}

function seedWorkspace(
  sqlite: DatabaseSync,
  options: {
    plan?: string
    stripeCustomerId?: string | null
    stripeSubscriptionId?: string | null
    stripeSubscriptionStatus?: string
    storageQuotaBytes?: number
  } = {},
): void {
  const plan = options.plan ?? 'free'
  const stripeCustomerId = options.stripeCustomerId ?? null
  const stripeSubscriptionId = options.stripeSubscriptionId ?? null
  const stripeSubscriptionStatus = options.stripeSubscriptionStatus ?? 'none'
  const storageQuotaBytes =
    options.storageQuotaBytes ?? PLAN_STORAGE_QUOTA_BYTES.free

  sqlite.exec(`
    INSERT INTO workspaces (
      id, name, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at,
      stripe_customer_id, stripe_subscription_id, stripe_subscription_status, created_at
    ) VALUES (
      'ws1', 'Workspace', '${plan}', ${storageQuotaBytes}, 0, '2026-07-01T00:00:00.000Z',
      ${stripeCustomerId ? `'${stripeCustomerId}'` : 'NULL'},
      ${stripeSubscriptionId ? `'${stripeSubscriptionId}'` : 'NULL'},
      '${stripeSubscriptionStatus}', '2026-07-01T00:00:00.000Z'
    );
  `)
}

function readWorkspace(sqlite: DatabaseSync): {
  plan: string
  stripe_subscription_id: string | null
  stripe_subscription_status: string
  storage_quota_bytes: number
} {
  return sqlite
    .prepare(
      `SELECT plan, stripe_subscription_id, stripe_subscription_status, storage_quota_bytes
       FROM workspaces WHERE id = 'ws1'`,
    )
    .get() as {
    plan: string
    stripe_subscription_id: string | null
    stripe_subscription_status: string
    storage_quota_bytes: number
  }
}

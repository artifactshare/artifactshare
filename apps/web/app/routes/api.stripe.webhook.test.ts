import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const constructEventAsyncMock = vi.hoisted(() => vi.fn())
const createStripeClientMock = vi.hoisted(() => vi.fn())
const syncWorkspaceSubscriptionMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const actualSyncWorkspaceSubscriptionRef = vi.hoisted(() => ({
  current: null as
    | typeof import('~/services/billing-sync.server').syncWorkspaceSubscription
    | null,
}))
const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_monthly',
    STRIPE_PRICE_PLUS_YEARLY: 'price_plus_yearly',
    STRIPE_PRICE_TEAM_MONTHLY: 'price_team_monthly',
    STRIPE_PRICE_TEAM_YEARLY: 'price_team_yearly',
    STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
    STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({ sql, params }),
      }),
      batch: async (stmts: Array<{ sql: string; params: unknown[] }>) => {
        const sqlite = sqliteRef.current
        if (!sqlite) throw new Error('sqlite not bound in test')
        sqlite.exec('BEGIN')
        try {
          for (const stmt of stmts) {
            sqlite.prepare(stmt.sql).run(...(stmt.params as never[]))
          }
          sqlite.exec('COMMIT')
        } catch (err) {
          sqlite.exec('ROLLBACK')
          throw err
        }
      },
    },
  },
}))

vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))

vi.mock('~/services/billing.server', async () => {
  const actual = await vi.importActual<
    typeof import('~/services/billing.server')
  >('~/services/billing.server')
  return {
    ...actual,
    createStripeClient: createStripeClientMock,
  }
})

vi.mock('~/services/billing-sync.server', async () => {
  const actual = await vi.importActual<
    typeof import('~/services/billing-sync.server')
  >('~/services/billing-sync.server')
  actualSyncWorkspaceSubscriptionRef.current = actual.syncWorkspaceSubscription
  return {
    ...actual,
    syncWorkspaceSubscription: syncWorkspaceSubscriptionMock,
  }
})

import { action, extractSubscriptionId } from './api.stripe.webhook'
import { resolveStripePrices, type BillingEnv } from '~/services/billing.server'

describe('/api/stripe/webhook', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>
  let destroyMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    destroyMock = vi.spyOn(db, 'destroy').mockResolvedValue(undefined)
    createDbMock.mockReturnValue(db)
    createStripeClientMock.mockReturnValue({
      webhooks: { constructEventAsync: constructEventAsyncMock },
    })
    constructEventAsyncMock.mockReset()
    syncWorkspaceSubscriptionMock.mockReset()
    syncWorkspaceSubscriptionMock.mockImplementation(
      async (
        dbArg,
        _stripe,
        _env,
        _subId,
        options?: { stripeEventId?: string },
      ) => {
        if (options?.stripeEventId) {
          await dbArg
            .updateTable('billing_webhook_events')
            .set({ processed_at: '2026-07-01T02:00:00.000Z', error: null })
            .where('stripe_event_id', '=', options.stripeEventId)
            .execute()
        }
        return { kind: 'ok' as const }
      },
    )
  })

  afterEach(async () => {
    sqliteRef.current = null
    destroyMock.mockRestore()
    await db.destroy()
  })

  test('rejects requests without a stripe signature', async () => {
    const response = await action({
      request: new Request('https://artifactshare.test/api/stripe/webhook', {
        method: 'POST',
        body: '{}',
      }),
    } as never)

    expect(response.status).toBe(400)
    expect(constructEventAsyncMock).not.toHaveBeenCalled()
  })

  test('rejects invalid signatures', async () => {
    constructEventAsyncMock.mockRejectedValue(new Error('invalid signature'))

    const response = await postWebhook('{}')

    expect(response.status).toBe(400)
    expect(syncWorkspaceSubscriptionMock).not.toHaveBeenCalled()
  })

  test('processes a subscription event and marks it processed', async () => {
    mockVerifiedEvent({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      object: { id: 'sub_1' },
    })

    const response = await postWebhook('{"id":"evt_1"}')

    expect(response.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        webhooks: expect.objectContaining({
          constructEventAsync: constructEventAsyncMock,
        }),
      }),
      expect.objectContaining({
        STRIPE_SECRET_KEY: 'sk_test',
      }),
      'sub_1',
      { stripeEventId: 'evt_1' },
    )
    expect(readWebhookEvent(sqlite, 'evt_1')).toMatchObject({
      event_type: 'customer.subscription.updated',
      processed_at: expect.any(String),
      error: null,
    })
  })

  test('skips already processed events', async () => {
    sqlite.exec(`
      INSERT INTO billing_webhook_events (
        stripe_event_id, event_type, received_at, processed_at, error
      ) VALUES (
        'evt_done', 'customer.subscription.updated', '2026-07-01T00:00:00.000Z',
        '2026-07-01T01:00:00.000Z', NULL
      );
    `)
    mockVerifiedEvent({
      id: 'evt_done',
      type: 'customer.subscription.updated',
      object: { id: 'sub_1' },
    })

    const response = await postWebhook('{"id":"evt_done"}')

    expect(response.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).not.toHaveBeenCalled()
  })

  test('retries events that were received but not processed', async () => {
    sqlite.exec(`
      INSERT INTO billing_webhook_events (
        stripe_event_id, event_type, received_at, processed_at, error
      ) VALUES (
        'evt_retry', 'invoice.paid', '2026-07-01T00:00:00.000Z', NULL, 'sync_failed'
      );
    `)
    mockVerifiedEvent({
      id: 'evt_retry',
      type: 'invoice.paid',
      object: {
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_retry' },
        },
      },
    })

    const response = await postWebhook('{"id":"evt_retry"}')

    expect(response.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.anything(),
      'sub_retry',
      { stripeEventId: 'evt_retry' },
    )
    expect(readWebhookEvent(sqlite, 'evt_retry')).toMatchObject({
      processed_at: expect.any(String),
      error: null,
    })
  })

  test('marks unsupported events processed without syncing', async () => {
    mockVerifiedEvent({
      id: 'evt_other',
      type: 'customer.created',
    })

    const response = await postWebhook('{"id":"evt_other"}')

    expect(response.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).not.toHaveBeenCalled()
    expect(readWebhookEvent(sqlite, 'evt_other')).toMatchObject({
      processed_at: expect.any(String),
      error: null,
    })
  })

  test('marks ignored sync results processed so Stripe stops retrying', async () => {
    mockVerifiedEvent({
      id: 'evt_ignored',
      type: 'customer.subscription.updated',
      object: { id: 'sub_ignored' },
    })
    syncWorkspaceSubscriptionMock.mockResolvedValue({ kind: 'ignored' })

    const response = await postWebhook('{"id":"evt_ignored"}')

    expect(response.status).toBe(200)
    expect(readWebhookEvent(sqlite, 'evt_ignored')).toMatchObject({
      processed_at: expect.any(String),
      error: null,
    })
  })

  test('returns 500 when sync fails so Stripe can retry', async () => {
    mockVerifiedEvent({
      id: 'evt_fail',
      type: 'customer.subscription.updated',
      object: { id: 'sub_fail' },
    })
    syncWorkspaceSubscriptionMock.mockResolvedValue({ kind: 'unknown-price' })

    const response = await postWebhook('{"id":"evt_fail"}')

    expect(response.status).toBe(500)
    expect(readWebhookEvent(sqlite, 'evt_fail')).toMatchObject({
      processed_at: null,
      error: 'unknown-price',
    })
  })

  test('extractSubscriptionId reads checkout and invoice payloads', () => {
    expect(
      extractSubscriptionId({
        type: 'checkout.session.completed',
        data: { object: { subscription: 'sub_checkout' } },
      } as Stripe.Event),
    ).toBe('sub_checkout')
    expect(
      extractSubscriptionId({
        type: 'invoice.paid',
        data: {
          object: {
            parent: {
              type: 'subscription_details',
              subscription_details: { subscription: 'sub_invoice' },
            },
          },
        },
      } as unknown as Stripe.Event),
    ).toBe('sub_invoice')
    expect(
      extractSubscriptionId({
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_direct' } },
      } as Stripe.Event),
    ).toBe('sub_direct')
    expect(
      extractSubscriptionId({
        type: 'invoice.paid',
        data: { object: { parent: null } },
      } as unknown as Stripe.Event),
    ).toBeNull()
  })

  test('marks subscription-less invoice events processed without syncing', async () => {
    mockVerifiedEvent({
      id: 'evt_no_sub',
      type: 'invoice.paid',
      object: { parent: null },
    })

    const response = await postWebhook('{"id":"evt_no_sub"}')

    expect(response.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).not.toHaveBeenCalled()
    expect(readWebhookEvent(sqlite, 'evt_no_sub')).toMatchObject({
      processed_at: expect.any(String),
      error: null,
    })
  })

  test('records plan.change once through real sync and ignores Stripe retries', async () => {
    const billingEnv: BillingEnv = {
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_monthly',
      STRIPE_PRICE_PLUS_YEARLY: 'price_plus_yearly',
      STRIPE_PRICE_TEAM_MONTHLY: 'price_team_monthly',
      STRIPE_PRICE_TEAM_YEARLY: 'price_team_yearly',
      STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
      STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
    }
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
        storage_updated_at
      ) VALUES (
        'ws1', 'example.com', 'Example', '2026-07-01T00:00:00.000Z', 'free',
        104857600, 0, '2026-07-01T00:00:00.000Z'
      );
    `)
    const prices = resolveStripePrices(billingEnv)
    const subscription = {
      id: 'sub_plan',
      status: 'active',
      metadata: { workspace_id: 'ws1' },
      customer: 'cus_test',
      items: {
        data: [{ id: 'si_1', price: { id: prices.plusMonthly } }],
      },
    } as unknown as Stripe.Subscription
    syncWorkspaceSubscriptionMock.mockImplementation(
      async (dbArg, stripe, envArg, subId, options) =>
        actualSyncWorkspaceSubscriptionRef.current!(
          dbArg,
          {
            subscriptions: {
              retrieve: vi.fn().mockResolvedValue(subscription),
              update: vi.fn(),
            },
          } as never,
          envArg,
          subId,
          options,
        ),
    )
    mockVerifiedEvent({
      id: 'evt_plan_once',
      type: 'customer.subscription.updated',
      object: { id: 'sub_plan' },
    })

    const first = await postWebhook('{"id":"evt_plan_once"}')
    expect(first.status).toBe(200)
    expect(readPlanChangeAuditCount(sqlite)).toBe(1)

    const second = await postWebhook('{"id":"evt_plan_once"}')
    expect(second.status).toBe(200)
    expect(syncWorkspaceSubscriptionMock).toHaveBeenCalledTimes(1)
    expect(readPlanChangeAuditCount(sqlite)).toBe(1)
  })
})

async function postWebhook(body: string): Promise<Response> {
  return action({
    request: new Request('https://artifactshare.test/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body,
    }),
  } as never)
}

function mockVerifiedEvent(args: {
  id: string
  type: string
  object?: Record<string, unknown>
}): void {
  constructEventAsyncMock.mockResolvedValue({
    id: args.id,
    type: args.type,
    data: { object: args.object ?? {} },
  })
}

function readWebhookEvent(
  sqlite: DatabaseSync,
  stripeEventId: string,
): {
  event_type: string
  processed_at: string | null
  error: string | null
} {
  return sqlite
    .prepare(
      `SELECT event_type, processed_at, error
       FROM billing_webhook_events
       WHERE stripe_event_id = ?`,
    )
    .get(stripeEventId) as {
    event_type: string
    processed_at: string | null
    error: string | null
  }
}

function readPlanChangeAuditCount(sqlite: DatabaseSync): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'plan.change'`,
      )
      .get() as { count: number }
  ).count
}

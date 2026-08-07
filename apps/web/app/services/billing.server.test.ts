import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import type Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  allFixedPriceIds,
  changePlan,
  loadSubscriptionContract,
  previewPlanChange,
  createCheckoutSession,
  createPortalSession,
  ensureStripeCustomer,
  fixedPriceIdForPlan,
  isBillingConfigured,
  planForPriceId,
  parseCheckoutCurrency,
  resolveCheckoutCurrency,
  resolveMonthlyEstimate,
  resolveStripePrices,
  type BillingEnv,
} from './billing.server'

const prices = {
  plusMonthly: 'price_plus_monthly',
  plusYearly: 'price_plus_yearly',
  teamMonthly: 'price_team_monthly',
  teamYearly: 'price_team_yearly',
} satisfies ReturnType<typeof resolveStripePrices>

const legacyMeteredOveragePrice = 'price_team_overage'

function fixedPrice(id: string) {
  return { id }
}

function meteredPrice(id: string) {
  return { id, recurring: { usage_type: 'metered' as const } }
}

const env: BillingEnv = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PLUS_MONTHLY: prices.plusMonthly,
  STRIPE_PRICE_PLUS_YEARLY: prices.plusYearly,
  STRIPE_PRICE_TEAM_MONTHLY: prices.teamMonthly,
  STRIPE_PRICE_TEAM_YEARLY: prices.teamYearly,
  STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
  STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
}

describe('billing service', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
  })

  afterEach(async () => {
    await db.destroy()
  })

  describe('resolveMonthlyEstimate', () => {
    const projection = {
      projectedOverageGb: 2,
      projectedOverageUsd: 0.2,
      projectedOverageJpy: 32,
    }
    const contract = (overrides: Record<string, unknown> = {}) => ({
      plan: 'plus' as const,
      interval: 'monthly' as const,
      currency: 'usd' as const,
      amount: 10,
      renewsAt: '2026-03-15T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      ...overrides,
    })
    const now = new Date('2026-03-10T00:00:00.000Z')

    test('distinguishes upcoming and billed monthly charges', () => {
      expect(resolveMonthlyEstimate(contract(), projection, now)).toMatchObject(
        {
          planCharge: 'upcoming',
          totalAmount: 10.2,
        },
      )
      expect(
        resolveMonthlyEstimate(
          contract({ renewsAt: '2026-04-15T00:00:00.000Z' }),
          projection,
          now,
        ),
      ).toMatchObject({ planCharge: 'billed', totalAmount: 10.2 })
    })

    test('handles yearly renewal and non-renewal months', () => {
      expect(
        resolveMonthlyEstimate(
          contract({
            interval: 'yearly',
            renewsAt: '2026-04-15T00:00:00.000Z',
          }),
          projection,
          now,
        ),
      ).toMatchObject({ planCharge: 'none', totalAmount: 0.2 })
      expect(
        resolveMonthlyEstimate(
          contract({
            interval: 'yearly',
            renewsAt: '2026-03-15T00:00:00.000Z',
          }),
          projection,
          now,
        ),
      ).toMatchObject({ planCharge: 'upcoming', totalAmount: 10.2 })
    })

    test('clamps monthly start dates and supports disabled overage', () => {
      const result = resolveMonthlyEstimate(
        contract({ renewsAt: '2026-03-31T00:00:00.000Z' }),
        projection,
        new Date('2026-02-10T00:00:00.000Z'),
      )
      expect(result).toMatchObject({
        planCharge: 'billed',
        planDate: '2026-02-28T00:00:00.000Z',
      })
      expect(
        resolveMonthlyEstimate(
          contract({ renewsAt: '2026-03-01T00:00:00.000Z' }),
          projection,
          new Date('2026-02-10T00:00:00.000Z'),
          false,
        ),
      ).toMatchObject({
        overageAmount: 0,
        overageEnabled: false,
        totalAmount: 10,
      })
    })

    test('returns null for incomplete inputs and converts currencies', () => {
      expect(
        resolveMonthlyEstimate(
          contract({ currency: 'jpy', amount: 1000 }),
          projection,
          now,
        ),
      ).toMatchObject({ totalAmount: 1032 })
      expect(
        resolveMonthlyEstimate(
          contract({ currency: 'usd', amount: 10.12 }),
          { ...projection, projectedOverageUsd: 0.205 },
          now,
        ),
      ).toMatchObject({ totalAmount: 10.33 })
      expect(resolveMonthlyEstimate(null, projection, now)).toBeNull()
      expect(
        resolveMonthlyEstimate(contract({ amount: null }), projection, now),
      ).toBeNull()
      expect(
        resolveMonthlyEstimate(contract({ renewsAt: null }), projection, now),
      ).toBeNull()
      expect(resolveMonthlyEstimate(contract(), null, now)).toBeNull()
      // 2 進浮動小数点で表現できない和も cent へ丸める。
      expect(
        resolveMonthlyEstimate(
          contract({ currency: 'usd', amount: 9.99 }),
          { ...projection, projectedOverageUsd: 0.3 },
          now,
        ),
      ).toMatchObject({ totalAmount: 10.29 })
    })

    test('does not count the renewal for cancel-at-period-end contracts', () => {
      expect(
        resolveMonthlyEstimate(
          contract({ cancelAtPeriodEnd: true }),
          projection,
          now,
        ),
      ).toMatchObject({
        planCharge: 'none',
        cancelAtPeriodEnd: true,
        totalAmount: 0.2,
      })
      // 開始日が当月内の請求済みはキャンセル予約でも計上する。
      expect(
        resolveMonthlyEstimate(
          contract({
            cancelAtPeriodEnd: true,
            renewsAt: '2026-04-05T00:00:00.000Z',
          }),
          projection,
          now,
        ),
      ).toMatchObject({ planCharge: 'billed', totalAmount: 10.2 })
    })

    test('clamps yearly leap-day starts and keeps the time of day', () => {
      expect(
        resolveMonthlyEstimate(
          contract({
            interval: 'yearly',
            renewsAt: '2028-02-29T10:30:00.000Z',
          }),
          projection,
          new Date('2027-02-10T00:00:00.000Z'),
        ),
      ).toMatchObject({
        planCharge: 'billed',
        planDate: '2027-02-28T10:30:00.000Z',
      })
      expect(
        resolveMonthlyEstimate(
          contract({ renewsAt: '2026-03-31T15:45:00.000Z' }),
          projection,
          new Date('2026-02-10T00:00:00.000Z'),
        ),
      ).toMatchObject({ planDate: '2026-02-28T15:45:00.000Z' })
    })
  })

  test('resolveCheckoutCurrency maps JP to jpy and others to usd', () => {
    expect(resolveCheckoutCurrency('JP')).toBe('jpy')
    expect(resolveCheckoutCurrency('US')).toBe('usd')
    expect(resolveCheckoutCurrency(undefined)).toBe('usd')
  })

  test('parseCheckoutCurrency accepts jpy and usd only', () => {
    expect(parseCheckoutCurrency('jpy')).toBe('jpy')
    expect(parseCheckoutCurrency('usd')).toBe('usd')
    expect(parseCheckoutCurrency('eur')).toBeNull()
    expect(parseCheckoutCurrency('')).toBeNull()
    expect(parseCheckoutCurrency(null)).toBeNull()
  })

  test('resolveStripePrices reads env vars', () => {
    expect(resolveStripePrices(env)).toEqual(prices)
  })

  test('planForPriceId maps fixed prices only', () => {
    expect(planForPriceId(prices.plusMonthly, prices)).toBe('plus')
    expect(planForPriceId(prices.plusYearly, prices)).toBe('plus')
    expect(planForPriceId(prices.teamMonthly, prices)).toBe('team')
    expect(planForPriceId(prices.teamYearly, prices)).toBe('team')
    expect(planForPriceId(legacyMeteredOveragePrice, prices)).toBeNull()
    expect(planForPriceId('price_unknown', prices)).toBeNull()
  })

  test('fixedPriceIdForPlan resolves checkout prices', () => {
    expect(fixedPriceIdForPlan('plus', 'monthly', prices)).toBe(
      prices.plusMonthly,
    )
    expect(fixedPriceIdForPlan('team', 'yearly', prices)).toBe(
      prices.teamYearly,
    )
  })

  test('allFixedPriceIds includes only fixed prices', () => {
    expect(allFixedPriceIds(prices)).toEqual(
      new Set([
        prices.plusMonthly,
        prices.plusYearly,
        prices.teamMonthly,
        prices.teamYearly,
      ]),
    )
    expect(allFixedPriceIds(prices).has(legacyMeteredOveragePrice)).toBe(false)
  })

  test('ensureStripeCustomer reuses an existing customer id', async () => {
    seedWorkspace(sqlite, 'free', 'cus_existing')

    const stripe = {
      customers: { create: vi.fn() },
    } as unknown as Stripe

    const customerId = await ensureStripeCustomer(
      db,
      stripe,
      {
        id: 'ws1',
        stripe_customer_id: 'cus_existing',
      },
      'ja',
    )

    expect(customerId).toBe('cus_existing')
    expect(stripe.customers.create).not.toHaveBeenCalled()
  })

  test('ensureStripeCustomer creates and persists a new customer', async () => {
    seedWorkspace(sqlite, 'free', null)
    const stripe = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
      },
    } as unknown as Stripe

    const customerId = await ensureStripeCustomer(
      db,
      stripe,
      {
        id: 'ws1',
        stripe_customer_id: null,
      },
      'ja',
    )

    expect(customerId).toBe('cus_new')
    expect(stripe.customers.create).toHaveBeenCalledWith({
      metadata: { workspace_id: 'ws1' },
      preferred_locales: ['ja'],
    })
    expect(readCustomerId(sqlite)).toBe('cus_new')
  })

  test('ensureStripeCustomer sets preferred_locales to en', async () => {
    seedWorkspace(sqlite, 'free', null)
    const stripe = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
      },
    } as unknown as Stripe

    await ensureStripeCustomer(
      db,
      stripe,
      {
        id: 'ws1',
        stripe_customer_id: null,
      },
      'en',
    )

    expect(stripe.customers.create).toHaveBeenCalledWith({
      metadata: { workspace_id: 'ws1' },
      preferred_locales: ['en'],
    })
  })

  test('createPortalSession pins the dedicated portal configuration', async () => {
    const stripe = {
      billingPortal: {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: 'https://portal.test' }),
        },
      },
    } as unknown as Stripe

    const result = await createPortalSession(
      stripe,
      env,
      'cus_1',
      'https://artifactshare.test',
    )

    expect(result).toEqual({ kind: 'ok', url: 'https://portal.test' })
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_1',
      configuration: env.STRIPE_PORTAL_CONFIGURATION,
      return_url: 'https://artifactshare.test/settings/billing',
    })
  })

  test('createCheckoutSession rejects paid workspaces', async () => {
    seedWorkspace(sqlite, 'plus', 'cus_plus')

    const stripe = {
      checkout: { sessions: { create: vi.fn() } },
      customers: { create: vi.fn() },
    } as unknown as Stripe

    const result = await createCheckoutSession(
      db,
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'plus',
        stripe_customer_id: 'cus_plus',
        stripe_subscription_id: 'sub_plus',
        stripe_subscription_status: 'active',
      },
      'team',
      'monthly',
      'https://artifactshare.test',
      'usd',
      'en',
    )

    expect(result).toEqual({ kind: 'already-subscribed' })
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  test('createCheckoutSession builds plus checkout with one line item', async () => {
    seedWorkspace(sqlite, 'free', null)
    const stripe = {
      customers: {
        create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
      },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: 'https://checkout.test' }),
        },
      },
    } as unknown as Stripe

    const result = await createCheckoutSession(
      db,
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'free',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_subscription_status: 'none',
      },
      'plus',
      'yearly',
      'https://artifactshare.test',
      'jpy',
      'ja',
    )

    expect(result).toEqual({ kind: 'ok', url: 'https://checkout.test' })
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: 'subscription',
      currency: 'jpy',
      locale: 'ja',
      customer: 'cus_new',
      client_reference_id: 'ws1',
      subscription_data: { metadata: { workspace_id: 'ws1' } },
      line_items: [{ price: prices.plusYearly, quantity: 1 }],
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
      billing_address_collection: 'required',
      success_url:
        'https://artifactshare.test/settings/billing?status=checkout-success',
      cancel_url:
        'https://artifactshare.test/settings/billing?status=checkout-cancelled',
    })
  })

  test('createCheckoutSession builds team checkout with one line item only', async () => {
    seedWorkspace(sqlite, 'free', 'cus_free')
    const stripe = {
      customers: { create: vi.fn() },
      checkout: {
        sessions: {
          create: vi.fn().mockResolvedValue({ url: 'https://checkout.test' }),
        },
      },
    } as unknown as Stripe

    await createCheckoutSession(
      db,
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'free',
        stripe_customer_id: 'cus_free',
        stripe_subscription_id: null,
        stripe_subscription_status: 'none',
      },
      'team',
      'monthly',
      'https://artifactshare.test',
      'usd',
      'en',
    )

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'usd',
        locale: 'en',
        line_items: [{ price: prices.teamMonthly, quantity: 1 }],
        automatic_tax: { enabled: true },
      }),
    )
  })

  test('changePlan updates fixed price for team upgrade', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [{ id: 'si_fixed', price: fixedPrice(prices.plusMonthly) }],
          },
        }),
        update: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      },
    } as unknown as Stripe

    const result = await changePlan(
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'plus',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        stripe_subscription_status: 'active',
      },
      'team',
      'yearly',
    )

    expect(result).toEqual({
      kind: 'ok',
      url: '/settings/billing?status=plan-change-requested',
    })
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_fixed', price: prices.teamYearly }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    })
  })

  test('changePlan updates fixed price only when downgrading to plus', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [
              { id: 'si_fixed', price: fixedPrice(prices.teamMonthly) },
              {
                id: 'si_metered',
                price: meteredPrice(legacyMeteredOveragePrice),
              },
            ],
          },
        }),
        update: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      },
    } as unknown as Stripe

    await changePlan(
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'team',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        stripe_subscription_status: 'active',
      },
      'plus',
      'monthly',
    )

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_fixed', price: prices.plusMonthly }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    })
  })

  test('changePlan rejects the current plan and interval combination', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [{ id: 'si_fixed', price: fixedPrice(prices.teamMonthly) }],
          },
        }),
        update: vi.fn(),
      },
    } as unknown as Stripe

    const result = await changePlan(
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'team',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        stripe_subscription_status: 'active',
      },
      'team',
      'monthly',
    )

    expect(result).toEqual({ kind: 'invalid' })
    expect(stripe.subscriptions.update).not.toHaveBeenCalled()
  })

  test('loadSubscriptionContract maps the fixed item to plan, interval, and price', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          currency: 'jpy',
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: 'si_fixed',
                current_period_end: 1789516800,
                price: {
                  id: prices.teamYearly,
                  currency: 'usd',
                  unit_amount: 29000,
                  currency_options: { jpy: { unit_amount: 45000 } },
                },
              },
            ],
          },
        }),
      },
    } as unknown as Stripe

    const contract = await loadSubscriptionContract(stripe, env, 'sub_1')

    expect(contract).toEqual({
      plan: 'team',
      interval: 'yearly',
      currency: 'jpy',
      amount: 45000,
      renewsAt: new Date(1789516800 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    })
  })

  test('loadSubscriptionContract converts usd cents and returns null on failure', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'sub_1',
            currency: 'usd',
            cancel_at_period_end: true,
            items: {
              data: [
                {
                  id: 'si_fixed',
                  current_period_end: null,
                  price: {
                    id: prices.plusMonthly,
                    currency: 'usd',
                    unit_amount: 500,
                  },
                },
              ],
            },
          })
          .mockRejectedValueOnce(new Error('stripe down')),
      },
    } as unknown as Stripe

    await expect(
      loadSubscriptionContract(stripe, env, 'sub_1'),
    ).resolves.toEqual({
      plan: 'plus',
      interval: 'monthly',
      currency: 'usd',
      amount: 5,
      renewsAt: null,
      cancelAtPeriodEnd: true,
    })
    await expect(
      loadSubscriptionContract(stripe, env, 'sub_1'),
    ).resolves.toBeNull()
  })

  test('previewPlanChange sums only the proration lines created by this change', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1789000000 * 1000))
    const prorationDate = 1789000000
    const createPreview = vi.fn().mockResolvedValue({
      currency: 'jpy',
      total: 94272,
      next_payment_attempt: 1789516800,
      period_end: 1789516000,
      lines: {
        has_more: false,
        data: [
          {
            amount: -4272,
            period: { start: prorationDate },
            parent: { subscription_item_details: { proration: true } },
          },
          {
            amount: 45000,
            period: { start: prorationDate },
            parent: { invoice_item_details: { proration: true } },
          },
          {
            amount: -999,
            period: { start: prorationDate - 86400 },
            parent: { subscription_item_details: { proration: true } },
          },
          {
            amount: 45000,
            period: { start: prorationDate },
            parent: { subscription_item_details: { proration: false } },
          },
          { amount: 8544, period: { start: prorationDate }, parent: null },
        ],
      },
    })
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [{ id: 'si_fixed', price: fixedPrice(prices.plusMonthly) }],
          },
        }),
      },
      invoices: { createPreview },
    } as unknown as Stripe

    const result = await previewPlanChange(
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'plus',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        stripe_subscription_status: 'active',
      },
      'team',
      'monthly',
    )

    expect(result).toEqual({
      kind: 'ok',
      currency: 'jpy',
      prorationAmount: 40728,
      nextInvoiceAt: new Date(1789516800 * 1000).toISOString(),
    })
    expect(createPreview).toHaveBeenCalledWith({
      subscription: 'sub_1',
      subscription_details: {
        items: [{ id: 'si_fixed', price: prices.teamMonthly }],
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
      },
    })
    vi.useRealTimers()
  })

  test('previewPlanChange omits the amount when preview lines are paginated', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [{ id: 'si_fixed', price: fixedPrice(prices.plusMonthly) }],
          },
        }),
      },
      invoices: {
        createPreview: vi.fn().mockResolvedValue({
          currency: 'jpy',
          next_payment_attempt: null,
          period_end: 1789516000,
          lines: { has_more: true, data: [] },
        }),
      },
    } as unknown as Stripe

    const result = await previewPlanChange(
      stripe,
      env,
      {
        id: 'ws1',
        plan: 'plus',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        stripe_subscription_status: 'active',
      },
      'team',
      'monthly',
    )

    expect(result).toEqual({
      kind: 'ok',
      currency: 'jpy',
      prorationAmount: null,
      nextInvoiceAt: new Date(1789516000 * 1000).toISOString(),
    })
  })

  test('previewPlanChange rejects the current combination and inactive subscriptions', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn().mockResolvedValue({
          id: 'sub_1',
          items: {
            data: [{ id: 'si_fixed', price: fixedPrice(prices.plusMonthly) }],
          },
        }),
      },
      invoices: { createPreview: vi.fn() },
    } as unknown as Stripe
    const workspace = {
      id: 'ws1',
      plan: 'plus',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      stripe_subscription_status: 'active',
    }

    await expect(
      previewPlanChange(stripe, env, workspace, 'plus', 'monthly'),
    ).resolves.toEqual({ kind: 'invalid' })
    await expect(
      previewPlanChange(
        stripe,
        env,
        { ...workspace, stripe_subscription_status: 'canceled' },
        'team',
        'monthly',
      ),
    ).resolves.toEqual({ kind: 'no-subscription' })
  })
})

function seedWorkspace(
  sqlite: DatabaseSync,
  plan: string,
  stripeCustomerId: string | null,
): void {
  sqlite.exec(`
    INSERT INTO workspaces (
      id, name, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at,
      stripe_customer_id, stripe_subscription_status, created_at
    ) VALUES (
      'ws1', 'Workspace', '${plan}', 104857600, 0, '2026-07-01T00:00:00.000Z',
      ${stripeCustomerId ? `'${stripeCustomerId}'` : 'NULL'},
      'none', '2026-07-01T00:00:00.000Z'
    );
  `)
}

function readCustomerId(sqlite: DatabaseSync): string | null {
  const row = sqlite
    .prepare('SELECT stripe_customer_id FROM workspaces WHERE id = ?')
    .get('ws1') as { stripe_customer_id: string | null } | undefined
  return row?.stripe_customer_id ?? null
}

describe('isBillingConfigured', () => {
  test('returns true when the secret and all price ids are set', () => {
    expect(isBillingConfigured(env)).toBe(true)
  })

  test('returns false when the secret key is missing', () => {
    expect(isBillingConfigured({ ...env, STRIPE_SECRET_KEY: undefined })).toBe(
      false,
    )
  })

  test('returns false when any price id is empty', () => {
    expect(isBillingConfigured({ ...env, STRIPE_PRICE_PLUS_MONTHLY: '' })).toBe(
      false,
    )
    expect(
      isBillingConfigured({ ...env, STRIPE_PRODUCT_STORAGE_OVERAGE: '' }),
    ).toBe(false)
  })

  test('returns false when the portal configuration is empty or missing', () => {
    expect(
      isBillingConfigured({ ...env, STRIPE_PORTAL_CONFIGURATION: '' }),
    ).toBe(false)
    expect(
      isBillingConfigured({
        ...env,
        STRIPE_PORTAL_CONFIGURATION: undefined as unknown as string,
      }),
    ).toBe(false)
  })
})

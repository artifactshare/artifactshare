import type { Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  changePlan,
  createCheckoutSession,
  createPortalSession,
  createStripeClient,
  loadSubscriptionContract,
  previewPlanChange,
  type BillingEnv,
} from './billing.server'
import { createMonthlyOverageCharges } from './billing-usage.server'

const env: BillingEnv = {
  STRIPE_SECRET_KEY: ['sk', 'test', 'transport'].join('_'),
  STRIPE_PRICE_PLUS_MONTHLY: 'price_public_local_plus_monthly',
  STRIPE_PRICE_PLUS_YEARLY: 'price_public_local_plus_yearly',
  STRIPE_PRICE_TEAM_MONTHLY: 'price_public_local_team_monthly',
  STRIPE_PRICE_TEAM_YEARLY: 'price_public_local_team_yearly',
  STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_public_local_overage',
  STRIPE_PORTAL_CONFIGURATION: 'bpc_public_local',
}
const workspace = {
  id: 'ws1',
  plan: 'free',
  stripe_customer_id: null,
  stripe_subscription_id: 'sub_local',
  stripe_subscription_status: 'active',
}
const subscription = {
  id: 'sub_local',
  status: 'active',
  currency: 'usd',
  cancel_at_period_end: false,
  items: {
    data: [
      {
        id: 'si_local',
        current_period_end: 1800000000,
        price: {
          id: env.STRIPE_PRICE_PLUS_MONTHLY,
          currency: 'jpy',
          unit_amount: 1000,
          currency_options: { usd: { unit_amount: 900 } },
        },
      },
    ],
  },
}
let db: Kysely<DB>
let requests: Request[]
let replies: Array<{ path: string; body: unknown }>
beforeEach(async () => {
  db = createMigratedInMemoryDb().db
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws1',
      name: 'Transport',
      created_at: '2026-07-01T00:00:00.000Z',
    })
    .execute()
  requests = []
  replies = []
  // Replace fetch itself: even an unexpected SDK retry cannot reach the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const reply = replies.shift()
      if (
        !reply ||
        new URL(request.url).origin !== 'https://api.stripe.com' ||
        new URL(request.url).pathname !== reply.path
      ) {
        throw new Error(`Unexpected Stripe transport request: ${request.url}`)
      }
      return Response.json(reply.body)
    }),
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await db.destroy()
})

test('Stripe-Version is Endive on the application fetch client', async () => {
  replies.push({ path: '/v1/subscriptions/sub_local', body: subscription })
  expect(
    await loadSubscriptionContract(createStripeClient(env), env, 'sub_local'),
  ).toEqual({
    plan: 'plus',
    interval: 'monthly',
    currency: 'usd',
    amount: 9,
    renewsAt: new Date(1800000000 * 1000).toISOString(),
    cancelAtPeriodEnd: false,
  })
  expect(requests).toHaveLength(1)
  expect(
    requests[0]!.headers.get('Stripe-Version'),
    'Stripe-Version is Endive',
  ).toBe('2026-10-28.endive')
  expect(new URL(requests[0]!.url).searchParams.get('expand[0]')).toBe(
    'items.data.price.currency_options',
  )
})

test('customer and fixed-price checkout serialize billing fields and consume returned IDs and URL', async () => {
  replies.push(
    { path: '/v1/customers', body: { id: 'cus_local' } },
    {
      path: '/v1/checkout/sessions',
      body: { id: 'cs_local', url: 'https://checkout.example.test/local' },
    },
  )
  expect(
    await createCheckoutSession(
      db,
      createStripeClient(env),
      env,
      workspace,
      'plus',
      'monthly',
      'https://app.example.test',
      'usd',
      'en',
    ),
  ).toEqual({ kind: 'ok', url: 'https://checkout.example.test/local' })
  expect(requests).toHaveLength(2)
  expect(
    Object.fromEntries(new URLSearchParams(await requests[0]!.text())),
  ).toEqual({
    'metadata[workspace_id]': 'ws1',
    'preferred_locales[0]': 'en',
  })
  expect(
    Object.fromEntries(new URLSearchParams(await requests[1]!.text())),
  ).toEqual({
    mode: 'subscription',
    currency: 'usd',
    locale: 'en',
    customer: 'cus_local',
    client_reference_id: 'ws1',
    'subscription_data[metadata][workspace_id]': 'ws1',
    'line_items[0][price]': env.STRIPE_PRICE_PLUS_MONTHLY,
    'line_items[0][quantity]': '1',
    'automatic_tax[enabled]': 'true',
    'customer_update[address]': 'auto',
    billing_address_collection: 'required',
    success_url:
      'https://app.example.test/settings/billing?status=checkout-success',
    cancel_url:
      'https://app.example.test/settings/billing?status=checkout-cancelled',
  })
  expect(
    await db
      .selectFrom('workspaces')
      .select('stripe_customer_id')
      .executeTakeFirstOrThrow(),
  ).toEqual({ stripe_customer_id: 'cus_local' })
})

test('portal uses its dedicated configuration and consumes the session URL', async () => {
  replies.push({
    path: '/v1/billing_portal/sessions',
    body: { url: 'https://portal.example.test/local' },
  })
  expect(
    await createPortalSession(
      createStripeClient(env),
      env,
      'cus_local',
      'https://app.example.test',
    ),
  ).toEqual({ kind: 'ok', url: 'https://portal.example.test/local' })
  expect(requests).toHaveLength(1)
  expect(
    Object.fromEntries(new URLSearchParams(await requests[0]!.text())),
  ).toEqual({
    customer: 'cus_local',
    configuration: env.STRIPE_PORTAL_CONFIGURATION,
    return_url: 'https://app.example.test/settings/billing',
  })
})

test.each([
  { currency: 'usd', hasMore: false, amount: 3 },
  { currency: 'usd', hasMore: true, amount: null },
  { currency: 'eur', hasMore: false, amount: null },
])(
  'preview decodes proration parents ($currency, incomplete=$hasMore)',
  async ({ currency, hasMore, amount }) => {
    const epoch = 1800000000
    vi.spyOn(Date, 'now').mockReturnValue(epoch * 1000)
    replies.push(
      { path: '/v1/subscriptions/sub_local', body: subscription },
      {
        path: '/v1/invoices/create_preview',
        body: {
          currency,
          period_end: epoch + 100,
          lines: {
            has_more: hasMore,
            data: [
              {
                amount: 500,
                period: { start: epoch },
                parent: { subscription_item_details: { proration: true } },
              },
              {
                amount: -200,
                period: { start: epoch },
                parent: { invoice_item_details: { proration: true } },
              },
              {
                amount: 900,
                period: { start: epoch },
                parent: { subscription_item_details: { proration: false } },
              },
              {
                amount: 800,
                period: { start: epoch - 1 },
                parent: { subscription_item_details: { proration: true } },
              },
            ],
          },
        },
      },
    )
    expect(
      await previewPlanChange(
        createStripeClient(env),
        env,
        workspace,
        'team',
        'monthly',
      ),
    ).toEqual({
      kind: 'ok',
      currency: currency === 'usd' ? 'usd' : null,
      prorationAmount: amount,
      nextInvoiceAt: new Date((epoch + 100) * 1000).toISOString(),
    })
    expect(requests).toHaveLength(2)
    expect(
      Object.fromEntries(new URLSearchParams(await requests[1]!.text())),
    ).toEqual({
      subscription: 'sub_local',
      'subscription_details[items][0][id]': 'si_local',
      'subscription_details[items][0][price]': env.STRIPE_PRICE_TEAM_MONTHLY,
      'subscription_details[proration_behavior]': 'always_invoice',
      'subscription_details[proration_date]': String(epoch),
    })
  },
)

test('plan change serializes immediate proration and conditional payment', async () => {
  replies.push(
    { path: '/v1/subscriptions/sub_local', body: subscription },
    { path: '/v1/subscriptions/sub_local', body: subscription },
  )
  expect(
    await changePlan(
      createStripeClient(env),
      env,
      workspace,
      'team',
      'monthly',
    ),
  ).toEqual({
    kind: 'ok',
    url: '/settings/billing?status=plan-change-requested',
  })
  expect(requests).toHaveLength(2)
  expect(
    Object.fromEntries(new URLSearchParams(await requests[1]!.text())),
  ).toEqual({
    'items[0][id]': 'si_local',
    'items[0][price]': env.STRIPE_PRICE_TEAM_MONTHLY,
    proration_behavior: 'always_invoice',
    payment_behavior: 'pending_if_incomplete',
  })
})

test.each(['active', 'canceled'])(
  'overage serializes units and idempotency for %s subscription',
  async (status) => {
    await db
      .updateTable('workspaces')
      .set({
        stripe_customer_id: 'cus_local',
        stripe_subscription_id: 'sub_local',
        stripe_subscription_status: status,
      })
      .execute()
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws1',
        date: '2026-06-15',
        used_bytes: 0,
        included_bytes: 0,
        billable_overage_gb: 2,
      })
      .execute()
    replies.push(
      {
        path: '/v1/subscriptions/sub_local',
        body: { ...subscription, status },
      },
      { path: '/v1/invoiceitems', body: { id: 'ii_local' } },
    )
    if (status === 'canceled')
      replies.push({ path: '/v1/invoices', body: { id: 'in_local' } })
    const result = await createMonthlyOverageCharges(
      db,
      createStripeClient(env),
      env.STRIPE_PRODUCT_STORAGE_OVERAGE,
      new Date('2026-07-01T17:00:00Z'),
    )
    expect(result.invoice_items_created).toBe(1)
    expect(result.standalone_invoices_created).toBe(status === 'active' ? 0 : 1)
    expect(requests).toHaveLength(status === 'active' ? 2 : 3)
    expect(requests[1]!.headers.get('Idempotency-Key')).toBe(
      'overage-item-ws1-2026-06',
    )
    expect(
      Object.fromEntries(new URLSearchParams(await requests[1]!.text())),
    ).toEqual({
      customer: 'cus_local',
      ...(status === 'active' ? { subscription: 'sub_local' } : {}),
      'price_data[currency]': 'usd',
      'price_data[product]': env.STRIPE_PRODUCT_STORAGE_OVERAGE,
      'price_data[unit_amount]': '10',
      'price_data[tax_behavior]': 'exclusive',
      quantity: '2',
      description: 'Storage overage for 2026-06',
      'metadata[workspace_id]': 'ws1',
      'metadata[month]': '2026-06',
    })
    if (status === 'canceled') {
      expect(requests[2]!.headers.get('Idempotency-Key')).toBe(
        'overage-invoice-ws1-2026-06',
      )
      expect(
        Object.fromEntries(new URLSearchParams(await requests[2]!.text())),
      ).toEqual({
        customer: 'cus_local',
        pending_invoice_items_behavior: 'include',
        auto_advance: 'true',
        'automatic_tax[enabled]': 'true',
      })
    }
    expect(
      await db
        .selectFrom('billing_overage_charges')
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'completed',
      overage_gb_month: 2,
      stripe_invoice_item_id: 'ii_local',
      stripe_invoice_id: status === 'active' ? null : 'in_local',
    })
  },
)

test('SDK connection failure preserves the service external-failed result', async () => {
  vi.mocked(fetch).mockRejectedValue(
    new TypeError('local connection interrupted'),
  )
  const stripe = createStripeClient(env)
  expect(
    await createPortalSession(
      stripe,
      env,
      'cus_local',
      'https://app.example.test',
    ),
  ).toEqual({ kind: 'external-failed' })
})

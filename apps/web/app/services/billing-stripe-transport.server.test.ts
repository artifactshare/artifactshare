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
let replies: Array<{
  method?: string
  path: string
  status?: number
  body: unknown
}>
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
        new URL(request.url).pathname !== reply.path ||
        (reply.method !== undefined && request.method !== reply.method)
      ) {
        throw new Error(`Unexpected Stripe transport request: ${request.url}`)
      }
      return Response.json(reply.body, { status: reply.status })
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
      'https://app.example.test/settings/billing?status=checkout-success&session_id={CHECKOUT_SESSION_ID}',
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

const returningCustomer = {
  id: 'ws1',
  plan: 'free',
  stripe_customer_id: 'cus_local',
  stripe_subscription_id: null,
  stripe_subscription_status: 'none',
}
const stripeList = (data: unknown[]) => ({
  object: 'list',
  data,
  has_more: false,
})
const requestLine = (request: Request) =>
  `${request.method} ${new URL(request.url).pathname}`

async function checkoutForReturningCustomer() {
  // createCheckoutSession reads the customer from the row under its lease.
  await db
    .updateTable('workspaces')
    .set({ stripe_customer_id: returningCustomer.stripe_customer_id })
    .where('id', '=', returningCustomer.id)
    .execute()
  return await createCheckoutSession(
    db,
    createStripeClient(env),
    env,
    returningCustomer,
    'team',
    'monthly',
    'https://app.example.test',
    'usd',
    'en',
  )
}

test.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete'])(
  'checkout for a customer whose subscription is %s opens the billing portal instead of a second subscription',
  async (status) => {
    replies.push(
      { method: 'GET', path: '/v1/checkout/sessions', body: stripeList([]) },
      {
        method: 'GET',
        path: '/v1/subscriptions',
        body: stripeList([{ ...subscription, id: 'sub_earlier', status }]),
      },
      {
        method: 'POST',
        path: '/v1/billing_portal/sessions',
        body: { url: 'https://portal.example.test/local' },
      },
    )
    const result = await checkoutForReturningCustomer()
    expect(
      requests.map(requestLine),
      'no second Checkout session is created',
    ).not.toContain('POST /v1/checkout/sessions')
    expect(result).toEqual({
      kind: 'ok',
      url: 'https://portal.example.test/local',
    })
    expect(
      new URL(requests[1]!.url).searchParams.get('customer'),
      'subscriptions are read for the workspace customer',
    ).toBe('cus_local')
    expect(
      Object.fromEntries(new URLSearchParams(await requests[2]!.text())),
    ).toEqual({
      customer: 'cus_local',
      configuration: env.STRIPE_PORTAL_CONFIGURATION,
      return_url: 'https://app.example.test/settings/billing',
    })
  },
)

test('a new checkout expires the Checkout sessions the customer still has open, so only one can be paid', async () => {
  replies.push(
    {
      method: 'GET',
      path: '/v1/checkout/sessions',
      body: stripeList([
        { id: 'cs_other_tab', object: 'checkout.session', status: 'open' },
      ]),
    },
    {
      method: 'POST',
      path: '/v1/checkout/sessions/cs_other_tab/expire',
      body: {
        id: 'cs_other_tab',
        object: 'checkout.session',
        status: 'expired',
      },
    },
    {
      method: 'GET',
      path: '/v1/subscriptions',
      body: stripeList([
        { ...subscription, id: 'sub_never_paid', status: 'incomplete_expired' },
      ]),
    },
    {
      method: 'POST',
      path: '/v1/checkout/sessions',
      body: { id: 'cs_local', url: 'https://checkout.example.test/local' },
    },
  )
  const result = await checkoutForReturningCustomer()
  expect(requests.map(requestLine)).toEqual([
    'GET /v1/checkout/sessions',
    'POST /v1/checkout/sessions/cs_other_tab/expire',
    'GET /v1/subscriptions',
    'POST /v1/checkout/sessions',
  ])
  expect(result).toEqual({
    kind: 'ok',
    url: 'https://checkout.example.test/local',
  })
  const openSessionQuery = new URL(requests[0]!.url).searchParams
  expect(openSessionQuery.get('customer')).toBe('cus_local')
  expect(openSessionQuery.get('status')).toBe('open')
  expect(new URLSearchParams(await requests[3]!.text()).get('customer')).toBe(
    'cus_local',
  )
})

test('checkout opens no new session when an open one can no longer be expired', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  replies.push(
    {
      method: 'GET',
      path: '/v1/checkout/sessions',
      body: stripeList([
        { id: 'cs_other_tab', object: 'checkout.session', status: 'open' },
      ]),
    },
    {
      // The other tab finished paying between the list and the expire.
      method: 'POST',
      path: '/v1/checkout/sessions/cs_other_tab/expire',
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          message: 'This Checkout Session is no longer open.',
        },
      },
    },
    // Stripe would accept a new session, so only the service can refuse it.
    { method: 'GET', path: '/v1/subscriptions', body: stripeList([]) },
    {
      method: 'POST',
      path: '/v1/checkout/sessions',
      body: { id: 'cs_local', url: 'https://checkout.example.test/local' },
    },
  )
  const result = await checkoutForReturningCustomer()
  expect(requests.map(requestLine)).not.toContain('POST /v1/checkout/sessions')
  expect(result).toEqual({ kind: 'external-failed' })
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
    kind: 'accepted',
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
    for (let day = 1; day <= 30; day++) {
      await db
        .insertInto('workspace_storage_daily_usage')
        .values({
          workspace_id: 'ws1',
          date: `2026-06-${String(day).padStart(2, '0')}`,
          used_bytes: 0,
          included_bytes: 0,
          billable_overage_gb: 2,
        })
        .execute()
    }
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

test('a stale overage retry reads every invoice item page and charges nothing already invoiced', async () => {
  await db
    .updateTable('workspaces')
    .set({
      stripe_customer_id: 'cus_local',
      stripe_subscription_id: 'sub_local',
      stripe_subscription_status: 'canceled',
    })
    .execute()
  for (let day = 1; day <= 30; day++) {
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws1',
        date: `2026-06-${String(day).padStart(2, '0')}`,
        used_bytes: 0,
        included_bytes: 0,
        billable_overage_gb: 2,
      })
      .execute()
  }
  await db
    .insertInto('billing_overage_charges')
    .values({
      workspace_id: 'ws1',
      month: '2026-06',
      overage_gb_month: 0,
      status: 'pending',
      created_at: '2026-07-01T17:00:00.000Z',
    })
    .execute()
  replies.push(
    {
      path: '/v1/subscriptions/sub_local',
      body: { ...subscription, status: 'canceled' },
    },
    {
      path: '/v1/invoiceitems',
      body: {
        object: 'list',
        url: '/v1/invoiceitems',
        has_more: true,
        data: [{ id: 'ii_other', invoice: 'in_other', metadata: {} }],
      },
    },
    {
      path: '/v1/invoiceitems',
      body: {
        object: 'list',
        url: '/v1/invoiceitems',
        has_more: false,
        data: [
          {
            id: 'ii_local',
            invoice: 'in_local',
            metadata: { workspace_id: 'ws1', month: '2026-06' },
          },
        ],
      },
    },
  )

  const result = await createMonthlyOverageCharges(
    db,
    createStripeClient(env),
    env.STRIPE_PRODUCT_STORAGE_OVERAGE,
    new Date('2026-07-02T18:00:00Z'),
  )

  expect(result.invoice_items_created).toBe(0)
  expect(requests.map((request) => request.method)).toEqual([
    'GET',
    'GET',
    'GET',
  ])
  expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({
    customer: 'cus_local',
    limit: '100',
  })
  expect(new URL(requests[2]!.url).searchParams.get('starting_after')).toBe(
    'ii_other',
  )
  expect(
    await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow(),
  ).toMatchObject({
    status: 'completed',
    stripe_invoice_item_id: 'ii_local',
    stripe_invoice_id: 'in_local',
  })
})

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

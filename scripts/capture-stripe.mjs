// The local capture's fake Stripe: a loopback HTTP server that answers the
// two read requests the billing page and its plan-change preview make, for
// the subscriptions the billing capture states seed, and refuses everything
// else. It is not a Stripe emulator: nothing is stored, and no request can
// create, change or charge anything.
//
// `scripts/local-capture.mjs` starts it, writes `captureStripeVars(origin)`
// over the copied Stripe variables so the app can only reach this server, and
// stops it on every exit path.
import { createServer } from 'node:http'
import { BILLING_PRICES } from '../apps/web/app/lib/billing-prices.ts'

/** Clearly synthetic: no Stripe account issues a key with this name. */
export const CAPTURE_STRIPE_SECRET_KEY = ['sk', 'test', 'capture'].join('_')

export const CAPTURE_STRIPE_PRICES = {
  plusMonthly: 'price_capture_plus_monthly',
  plusYearly: 'price_capture_plus_yearly',
  teamMonthly: 'price_capture_team_monthly',
  teamYearly: 'price_capture_team_yearly',
}

/** Every Stripe variable the capture writes over the copied ones. */
export function captureStripeVars(origin) {
  return {
    STRIPE_SECRET_KEY: CAPTURE_STRIPE_SECRET_KEY,
    STRIPE_PRICE_PLUS_MONTHLY: CAPTURE_STRIPE_PRICES.plusMonthly,
    STRIPE_PRICE_PLUS_YEARLY: CAPTURE_STRIPE_PRICES.plusYearly,
    STRIPE_PRICE_TEAM_MONTHLY: CAPTURE_STRIPE_PRICES.teamMonthly,
    STRIPE_PRICE_TEAM_YEARLY: CAPTURE_STRIPE_PRICES.teamYearly,
    STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_capture_storage_overage',
    STRIPE_PORTAL_CONFIGURATION: 'bpc_capture',
    // Nothing in a capture verifies webhooks; a copied secret must not stay.
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_API_ORIGIN: origin,
  }
}

// The paid billing capture states. Their subscription ID is derived from the
// seeded workspace (`sub_capture_<workspace id>`, see
// `apps/web/app/services/dev-screen-state.server.ts`), so each persona and
// state has its own subscription and no capture overwrites another's.
const SUBSCRIPTION_ID =
  /^sub_capture_(dev-screen-(?:free|plus|team)-settings-billing-(subscribed|past-due|continuing-near-limit))$/u

/**
 * The current monthly period of every fixture subscription, in Unix seconds:
 * the UTC calendar month containing `now`. A fake instance fixes it when it
 * starts, so all its replies agree and the billing page shows a contract in
 * its current period, renewing at the start of next month.
 */
export function captureStripePeriod(now = new Date()) {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return {
    start: Date.UTC(year, month, 1) / 1000,
    end: Date.UTC(year, month + 1, 1) / 1000,
  }
}

const PRICE_PLANS = {
  [CAPTURE_STRIPE_PRICES.plusMonthly]: ['plus', 'month'],
  [CAPTURE_STRIPE_PRICES.plusYearly]: ['plus', 'year'],
  [CAPTURE_STRIPE_PRICES.teamMonthly]: ['team', 'month'],
  [CAPTURE_STRIPE_PRICES.teamYearly]: ['team', 'year'],
}

/** Production prices in Stripe's minor units (yen, US cents). */
function unitAmount(priceId, currency) {
  const [plan, interval] = PRICE_PLANS[priceId]
  const amount = BILLING_PRICES[plan][currency][interval]
  return currency === 'jpy' ? amount : Math.round(amount * 100)
}

function price(priceId) {
  return {
    object: 'price',
    id: priceId,
    currency: 'usd',
    unit_amount: unitAmount(priceId, 'usd'),
    recurring: { interval: PRICE_PLANS[priceId][1] },
    currency_options: {
      jpy: { unit_amount: unitAmount(priceId, 'jpy') },
      usd: { unit_amount: unitAmount(priceId, 'usd') },
    },
  }
}

function fixtureSubscription(id, period) {
  const match = SUBSCRIPTION_ID.exec(id)
  if (!match) return null
  const [, workspaceId, state] = match
  return {
    object: 'subscription',
    id,
    customer: `cus_capture_${workspaceId}`,
    status: state === 'past-due' ? 'past_due' : 'active',
    currency: 'usd',
    cancel_at_period_end: false,
    metadata: { workspace_id: workspaceId },
    items: {
      object: 'list',
      has_more: false,
      data: [
        {
          object: 'subscription_item',
          id: `si_capture_${workspaceId}`,
          current_period_start: period.start,
          current_period_end: period.end,
          price: price(CAPTURE_STRIPE_PRICES.teamMonthly),
        },
      ],
    },
  }
}

function stripeError(status, type, message) {
  return { status, body: { error: { type, message } } }
}

function invoicePreview(form, period) {
  const subscription = fixtureSubscription(
    form.get('subscription') ?? '',
    period,
  )
  const item = subscription?.items.data[0]
  const target = form.get('subscription_details[items][0][price]')
  const prorationDate = Number(form.get('subscription_details[proration_date]'))
  if (
    !item ||
    form.get('subscription_details[items][0][id]') !== item.id ||
    !Object.hasOwn(PRICE_PLANS, target) ||
    target === item.price.id ||
    !Number.isInteger(prorationDate) ||
    prorationDate <= 0
  )
    return stripeError(
      400,
      'invalid_request_error',
      'The capture fake previews only a change of a fixture subscription to another fixture price.',
    )
  // One proration line for the change itself, starting at the requested
  // proration time: the difference between the two fixed prices.
  return {
    status: 200,
    body: {
      object: 'invoice',
      currency: 'usd',
      subscription: subscription.id,
      next_payment_attempt: null,
      period_end: period.end,
      lines: {
        object: 'list',
        has_more: false,
        data: [
          {
            object: 'line_item',
            amount: unitAmount(target, 'usd') - item.price.unit_amount,
            currency: 'usd',
            period: { start: prorationDate, end: period.end },
            parent: {
              type: 'subscription_item_details',
              subscription_item_details: {
                proration: true,
                subscription: subscription.id,
                subscription_item: item.id,
              },
            },
          },
        ],
      },
    },
  }
}

/**
 * The reply to one request. Only `GET /v1/subscriptions/:id` for a fixture
 * subscription and `POST /v1/invoices/create_preview` for a change of one are
 * answered, and only for the synthetic secret key. `period` is the instance's
 * `captureStripePeriod`.
 */
export function captureStripeResponse(
  { method, path, authorization, body },
  period = captureStripePeriod(),
) {
  if (authorization !== `Bearer ${CAPTURE_STRIPE_SECRET_KEY}`)
    return stripeError(401, 'authentication_error', 'Invalid API key.')
  const { pathname } = new URL(path, 'http://capture.invalid')
  const subscriptionPath = /^\/v1\/subscriptions\/([^/]+)$/u.exec(pathname)
  if (method === 'GET' && subscriptionPath) {
    let id
    try {
      id = decodeURIComponent(subscriptionPath[1])
    } catch {
      return stripeError(
        400,
        'invalid_request_error',
        'Malformed subscription ID.',
      )
    }
    const subscription = fixtureSubscription(id, period)
    return subscription
      ? { status: 200, body: subscription }
      : stripeError(404, 'invalid_request_error', 'No such subscription.')
  }
  if (method === 'POST' && pathname === '/v1/invoices/create_preview')
    return invoicePreview(new URLSearchParams(body), period)
  return stripeError(
    404,
    'invalid_request_error',
    `The capture fake does not answer ${method} ${pathname}.`,
  )
}

const MAX_BODY_BYTES = 64 * 1024

/**
 * Starts the fake on a loopback port the kernel chooses (bound exclusively,
 * so no other listener can answer in its place). Resolves once it listens.
 */
export async function startCaptureStripe({
  host = '127.0.0.1',
  now = new Date(),
} = {}) {
  const period = captureStripePeriod(now)
  const server = createServer((request, response) => {
    let body = ''
    let size = 0
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size <= MAX_BODY_BYTES) body += chunk
    })
    request.on('end', () => {
      const reply =
        size > MAX_BODY_BYTES
          ? stripeError(413, 'invalid_request_error', 'Request too large.')
          : captureStripeResponse(
              {
                method: request.method,
                path: request.url ?? '/',
                authorization: request.headers.authorization,
                body,
              },
              period,
            )
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.body))
    })
  })
  await new Promise((done, fail) => {
    server.once('error', (error) =>
      fail(
        new Error(
          `The capture's fake Stripe could not listen on ${host} (${error?.code ?? error})`,
          { cause: error },
        ),
      ),
    )
    server.listen({ host, port: 0, exclusive: true }, () => done())
  })
  const { port } = server.address()
  return {
    origin: `http://${host}:${port}`,
    close: () =>
      new Promise((done, fail) => {
        server.closeAllConnections()
        server.close((error) => (error ? fail(error) : done()))
      }),
  }
}

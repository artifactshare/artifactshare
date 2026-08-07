import type { Kysely } from 'kysely'
import Stripe from 'stripe'
import type { Locale } from '~/i18n/messages'
import {
  isActiveSubscriptionStatus,
  isPaidPlan,
  type BillingPlan,
} from '~/lib/billing-plan.server'
import type { DB } from '~/types/db'
import { defaultBillingCurrency } from '~/lib/billing-prices'
import type { OverageProjection } from '~/services/billing-usage.server'

export type BillingInterval = 'monthly' | 'yearly'
export type CheckoutPlan = 'plus' | 'team'
export type CheckoutCurrency = 'jpy' | 'usd'

export function resolveCheckoutCurrency(country: unknown): CheckoutCurrency {
  return defaultBillingCurrency(country)
}

export function parseCheckoutCurrency(
  value: string | null | undefined,
): CheckoutCurrency | null {
  if (value === 'jpy' || value === 'usd') return value
  return null
}

export type StripePrices = {
  plusMonthly: string
  plusYearly: string
  teamMonthly: string
  teamYearly: string
}

export type BillingEnv = {
  STRIPE_SECRET_KEY?: string
  STRIPE_PRICE_PLUS_MONTHLY: string
  STRIPE_PRICE_PLUS_YEARLY: string
  STRIPE_PRICE_TEAM_MONTHLY: string
  STRIPE_PRICE_TEAM_YEARLY: string
  STRIPE_PRODUCT_STORAGE_OVERAGE: string
  STRIPE_PORTAL_CONFIGURATION: string
}

export type BillingMutationResult =
  | { kind: 'ok'; url: string }
  | { kind: 'forbidden' }
  | { kind: 'invalid' }
  | { kind: 'already-subscribed' }
  | { kind: 'no-subscription' }
  | { kind: 'external-failed' }

export type WorkspaceBillingRow = {
  id: string
  plan: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_subscription_status: string
}

export function createStripeClient(env: BillingEnv): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY')
  }
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  })
}

export function resolveStripePrices(env: BillingEnv): StripePrices {
  return {
    plusMonthly: env.STRIPE_PRICE_PLUS_MONTHLY,
    plusYearly: env.STRIPE_PRICE_PLUS_YEARLY,
    teamMonthly: env.STRIPE_PRICE_TEAM_MONTHLY,
    teamYearly: env.STRIPE_PRICE_TEAM_YEARLY,
  }
}

export function isBillingConfigured(env: BillingEnv): boolean {
  const prices = resolveStripePrices(env)
  // env に key 自体が無い環境 (undefined) も fail-closed にするため falsy 判定。
  return Boolean(
    env.STRIPE_SECRET_KEY &&
    prices.plusMonthly &&
    prices.plusYearly &&
    prices.teamMonthly &&
    prices.teamYearly &&
    env.STRIPE_PRODUCT_STORAGE_OVERAGE &&
    env.STRIPE_PORTAL_CONFIGURATION,
  )
}

export function planForPriceId(
  priceId: string,
  prices: StripePrices,
): BillingPlan | null {
  if (priceId === prices.plusMonthly || priceId === prices.plusYearly) {
    return 'plus'
  }
  if (priceId === prices.teamMonthly || priceId === prices.teamYearly) {
    return 'team'
  }
  return null
}

export function fixedPriceIdForPlan(
  plan: CheckoutPlan,
  interval: BillingInterval,
  prices: StripePrices,
): string {
  if (plan === 'plus') {
    return interval === 'monthly' ? prices.plusMonthly : prices.plusYearly
  }
  return interval === 'monthly' ? prices.teamMonthly : prices.teamYearly
}

export function allFixedPriceIds(prices: StripePrices): Set<string> {
  return new Set([
    prices.plusMonthly,
    prices.plusYearly,
    prices.teamMonthly,
    prices.teamYearly,
  ])
}

export function hasActiveSubscription(status: string): boolean {
  return isActiveSubscriptionStatus(status)
}

export async function ensureStripeCustomer(
  db: Kysely<DB>,
  stripe: Stripe,
  workspace: Pick<WorkspaceBillingRow, 'id' | 'stripe_customer_id'>,
  locale: Locale,
): Promise<string> {
  if (workspace.stripe_customer_id) return workspace.stripe_customer_id

  const customer = await stripe.customers.create({
    metadata: { workspace_id: workspace.id },
    preferred_locales: [locale],
  })

  const update = await db
    .updateTable('workspaces')
    .set({ stripe_customer_id: customer.id })
    .where('id', '=', workspace.id)
    .where('stripe_customer_id', 'is', null)
    .executeTakeFirst()

  if (Number(update.numUpdatedRows ?? 0n) === 0) {
    const row = await db
      .selectFrom('workspaces')
      .select('stripe_customer_id')
      .where('id', '=', workspace.id)
      .executeTakeFirstOrThrow()

    if (row.stripe_customer_id) {
      console.error('billing_customer_create_race', {
        workspace_id: workspace.id,
        orphan_customer_id: customer.id,
        winner_customer_id: row.stripe_customer_id,
      })
      return row.stripe_customer_id
    }
  }

  return customer.id
}

export async function createCheckoutSession(
  db: Kysely<DB>,
  stripe: Stripe,
  env: BillingEnv,
  workspace: WorkspaceBillingRow,
  plan: CheckoutPlan,
  interval: BillingInterval,
  origin: string,
  currency: CheckoutCurrency,
  locale: Locale,
): Promise<BillingMutationResult> {
  if (isPaidPlan(workspace.plan)) {
    return { kind: 'already-subscribed' }
  }

  const prices = resolveStripePrices(env)
  const fixedPriceId = fixedPriceIdForPlan(plan, interval, prices)
  if (!fixedPriceId) return { kind: 'invalid' }

  try {
    const customerId = await ensureStripeCustomer(db, stripe, workspace, locale)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      currency,
      locale,
      customer: customerId,
      client_reference_id: workspace.id,
      subscription_data: {
        metadata: { workspace_id: workspace.id },
      },
      line_items: [{ price: fixedPriceId, quantity: 1 }],
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
      billing_address_collection: 'required',
      success_url: `${origin}/settings/billing?status=checkout-success`,
      cancel_url: `${origin}/settings/billing?status=checkout-cancelled`,
    })

    if (!session.url) return { kind: 'external-failed' }
    return { kind: 'ok', url: session.url }
  } catch (error) {
    console.error('billing_checkout_session_create_failed', error)
    return { kind: 'external-failed' }
  }
}

export async function createPortalSession(
  stripe: Stripe,
  env: BillingEnv,
  customerId: string,
  origin: string,
): Promise<BillingMutationResult> {
  try {
    // 未指定だとアカウントのデフォルト設定 (他事業と共有、TechTalk ブランド)
    // に落ちるため、Artifact Share 専用 configuration を常に明示する。
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: env.STRIPE_PORTAL_CONFIGURATION,
      return_url: `${origin}/settings/billing`,
    })
    if (!session.url) return { kind: 'external-failed' }
    return { kind: 'ok', url: session.url }
  } catch (error) {
    console.error('billing_portal_session_create_failed', error)
    return { kind: 'external-failed' }
  }
}

export type SubscriptionContract = {
  plan: CheckoutPlan
  interval: BillingInterval
  currency: CheckoutCurrency | null
  /** Fixed price in display units (JPY yen / USD dollars), tax excluded. */
  amount: number | null
  renewsAt: string | null
  cancelAtPeriodEnd: boolean
}

export type MonthlyEstimate = {
  currency: CheckoutCurrency
  planAmount: number
  overageAmount: number
  totalAmount: number
  planCharge: 'billed' | 'upcoming' | 'none'
  cancelAtPeriodEnd: boolean
  planDate: string
  overageGb: number
  overageEnabled: boolean
}

// 対象月の末日へ clamp する (3/31 の 1 か月前 = 2 月末日、2/29 の 1 年前 = 2/28)。
// 時刻成分は保持する (0 時 UTC に落とすと負オフセットの TZ 表示で前日になる)。
function subtractContractInterval(date: Date, interval: BillingInterval): Date {
  const year =
    interval === 'yearly' || date.getUTCMonth() === 0
      ? date.getUTCFullYear() - 1
      : date.getUTCFullYear()
  const month =
    interval === 'yearly' ? date.getUTCMonth() : (date.getUTCMonth() + 11) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  )
}

export function resolveMonthlyEstimate(
  contract: SubscriptionContract | null,
  projection: OverageProjection | null,
  now: Date,
  allowsOverage = true,
): MonthlyEstimate | null {
  if (
    !contract?.currency ||
    contract.amount === null ||
    !contract.renewsAt ||
    !projection
  )
    return null
  const renewsAt = new Date(contract.renewsAt)
  if (Number.isNaN(renewsAt.getTime())) return null
  const month = now.toISOString().slice(0, 7)
  const start = subtractContractInterval(renewsAt, contract.interval)
  const startInMonth = start.toISOString().slice(0, 7) === month
  const renewsInMonth = renewsAt.toISOString().slice(0, 7) === month
  // cancel_at_period_end の契約は期間末に更新されないため、更新請求を計上しない。
  const planCharge = startInMonth
    ? 'billed'
    : renewsInMonth && !contract.cancelAtPeriodEnd
      ? 'upcoming'
      : 'none'
  const planIncluded = planCharge !== 'none'
  const roundAmount = (value: number) =>
    contract.currency === 'jpy'
      ? Math.round(value)
      : Math.round(value * 100) / 100
  const overageAmount = allowsOverage
    ? roundAmount(
        contract.currency === 'jpy'
          ? projection.projectedOverageJpy
          : projection.projectedOverageUsd,
      )
    : 0
  return {
    currency: contract.currency,
    planAmount: planIncluded ? contract.amount : 0,
    overageAmount,
    totalAmount: roundAmount(
      (planIncluded ? contract.amount : 0) + overageAmount,
    ),
    planCharge,
    cancelAtPeriodEnd: contract.cancelAtPeriodEnd,
    planDate: (startInMonth ? start : renewsAt).toISOString(),
    overageGb: projection.projectedOverageGb,
    overageEnabled: allowsOverage,
  }
}

function displayAmount(currency: CheckoutCurrency, unitAmount: number): number {
  return currency === 'jpy' ? unitAmount : unitAmount / 100
}

function intervalForPriceId(
  priceId: string,
  prices: StripePrices,
): BillingInterval | null {
  if (priceId === prices.plusMonthly || priceId === prices.teamMonthly) {
    return 'monthly'
  }
  if (priceId === prices.plusYearly || priceId === prices.teamYearly) {
    return 'yearly'
  }
  return null
}

export async function loadSubscriptionContract(
  stripe: Stripe,
  env: BillingEnv,
  subscriptionId: string,
): Promise<SubscriptionContract | null> {
  const prices = resolveStripePrices(env)
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price.currency_options'],
    })
    const fixedPriceIds = allFixedPriceIds(prices)
    const fixedItem = subscription.items.data.find((item) =>
      fixedPriceIds.has(item.price.id),
    )
    if (!fixedItem) return null

    const plan = planForPriceId(fixedItem.price.id, prices)
    const interval = intervalForPriceId(fixedItem.price.id, prices)
    if (!plan || plan === 'free' || !interval) return null

    const currency = parseCheckoutCurrency(subscription.currency)
    let amount: number | null = null
    if (currency) {
      if (fixedItem.price.currency === currency) {
        amount =
          fixedItem.price.unit_amount === null
            ? null
            : displayAmount(currency, fixedItem.price.unit_amount)
      } else {
        const option = fixedItem.price.currency_options?.[currency]
        amount =
          option?.unit_amount === null || option?.unit_amount === undefined
            ? null
            : displayAmount(currency, option.unit_amount)
      }
    }

    return {
      plan,
      interval,
      currency,
      amount,
      renewsAt: fixedItem.current_period_end
        ? new Date(fixedItem.current_period_end * 1000).toISOString()
        : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    }
  } catch (error) {
    console.error('billing_subscription_contract_load_failed', error)
    return null
  }
}

export type PlanChangePreview =
  | {
      kind: 'ok'
      currency: CheckoutCurrency | null
      /**
       * Sum of the proration lines this change creates (tax excluded), display
       * units. Negative = credit. Null when the currency is unknown.
       * 請求書全体でなく調整分だけを返す (更新料金が混ざると倍額に見える)。
       */
      prorationAmount: number | null
      /** ISO timestamp of the previewed next invoice, when Stripe reports it. */
      nextInvoiceAt: string | null
    }
  | { kind: 'no-subscription' }
  | { kind: 'invalid' }
  | { kind: 'external-failed' }

export async function previewPlanChange(
  stripe: Stripe,
  env: BillingEnv,
  workspace: WorkspaceBillingRow,
  plan: CheckoutPlan,
  interval: BillingInterval,
): Promise<PlanChangePreview> {
  if (
    !workspace.stripe_subscription_id ||
    !hasActiveSubscription(workspace.stripe_subscription_status)
  ) {
    return { kind: 'no-subscription' }
  }
  const prices = resolveStripePrices(env)
  const nextFixedPriceId = fixedPriceIdForPlan(plan, interval, prices)

  try {
    const subscription = await stripe.subscriptions.retrieve(
      workspace.stripe_subscription_id,
    )
    const fixedPriceIds = allFixedPriceIds(prices)
    const fixedItem = subscription.items.data.find((item) =>
      fixedPriceIds.has(item.price.id),
    )
    if (!fixedItem) return { kind: 'external-failed' }
    if (fixedItem.price.id === nextFixedPriceId) return { kind: 'invalid' }

    // proration_date で「この変更が生む調整行」を特定する (保留中の別変更の
    // proration 行を合計に混ぜない)。
    const prorationDate = Math.floor(Date.now() / 1000)
    const invoice = await stripe.invoices.createPreview({
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: fixedItem.id, price: nextFixedPriceId }],
        // 差額は先送りせず変更時に精算する (changePlan と揃える)。
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
      },
    })
    const currency = parseCheckoutCurrency(invoice.currency)
    const prorationTotal = invoice.lines.data
      .filter(
        (line) =>
          (line.parent?.subscription_item_details?.proration === true ||
            line.parent?.invoice_item_details?.proration === true) &&
          line.period?.start === prorationDate,
      )
      .reduce((sum, line) => sum + line.amount, 0)
    // 行がページングで欠けている場合は誤った合計を出さない。
    const linesComplete = invoice.lines.has_more !== true
    const nextInvoiceEpoch = invoice.next_payment_attempt ?? invoice.period_end
    return {
      kind: 'ok',
      currency,
      prorationAmount:
        currency && linesComplete
          ? displayAmount(currency, prorationTotal)
          : null,
      nextInvoiceAt: nextInvoiceEpoch
        ? new Date(nextInvoiceEpoch * 1000).toISOString()
        : null,
    }
  } catch (error) {
    console.error('billing_plan_change_preview_failed', error)
    return { kind: 'external-failed' }
  }
}

export async function changePlan(
  stripe: Stripe,
  env: BillingEnv,
  workspace: WorkspaceBillingRow,
  plan: CheckoutPlan,
  interval: BillingInterval,
): Promise<BillingMutationResult> {
  if (!workspace.stripe_subscription_id) {
    return { kind: 'no-subscription' }
  }
  if (!hasActiveSubscription(workspace.stripe_subscription_status)) {
    return { kind: 'no-subscription' }
  }

  const prices = resolveStripePrices(env)
  const nextFixedPriceId = fixedPriceIdForPlan(plan, interval, prices)
  if (!nextFixedPriceId) return { kind: 'invalid' }

  try {
    const subscription = await stripe.subscriptions.retrieve(
      workspace.stripe_subscription_id,
      { expand: ['items.data.price'] },
    )

    const fixedPriceIds = allFixedPriceIds(prices)
    const fixedItem = subscription.items.data.find((item) =>
      fixedPriceIds.has(item.price.id),
    )
    if (!fixedItem) return { kind: 'external-failed' }
    if (fixedItem.price.id === nextFixedPriceId) return { kind: 'invalid' }

    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: fixedItem.id, price: nextFixedPriceId }],
      // 差額を先送りせず変更時に精算する。控除は残高として以後の請求に充当される。
      proration_behavior: 'always_invoice',
      // 即時請求が決済できない場合は変更を適用しない (未払いのままアップグレードさせない)。
      payment_behavior: 'pending_if_incomplete',
    })

    return { kind: 'ok', url: '/settings/billing?status=plan-change-requested' }
  } catch (error) {
    console.error('billing_subscription_update_failed', error)
    return { kind: 'external-failed' }
  }
}

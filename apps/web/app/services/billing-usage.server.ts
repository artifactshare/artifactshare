import { type Kysely, sql } from 'kysely'
import type Stripe from 'stripe'
import {
  allowsStorageOverage,
  isActiveSubscriptionStatus,
  normalizePlan,
  PLAN_STORAGE_QUOTA_BYTES,
} from '~/lib/billing-plan.server'
import type { DB } from '~/types/db'
import { STORAGE_OVERAGE_PRICES } from '~/lib/billing-prices'

const BYTES_PER_GB = 1073741824
const OVERAGE_CLAIM_RETRY_MS = 60 * 60 * 1000

export interface DailyUsageSnapshotResult {
  duration_ms: number
  workspaces_snapshot: number
  workspaces_failed: number
}

export interface MonthlyOverageChargeResult {
  duration_ms: number
  month: string
  workspaces_eligible: number
  workspaces_skipped: number
  invoice_items_created: number
  standalone_invoices_created: number
  workspaces_failed: number
}

function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function utcMonthString(now: Date): string {
  return now.toISOString().slice(0, 7)
}

function previousUtcMonth(now: Date): string {
  const year = now.getUTCFullYear()
  // getUTCMonth() is 0-based, so the raw value is already the previous month's 1-based number.
  const month = now.getUTCMonth()
  if (month === 0) return `${year - 1}-12`
  return `${year}-${String(month).padStart(2, '0')}`
}

function overageUnitAmount(currency: string): number | null {
  if (currency === 'jpy') return STORAGE_OVERAGE_PRICES.jpy
  if (currency === 'usd') return Math.round(STORAGE_OVERAGE_PRICES.usd * 100)
  return null
}

function overageDescription(month: string): string {
  return `Storage overage for ${month}`
}

function overageWorkKey(workspaceId: string, month: string): string {
  return `${workspaceId}:${month}`
}

function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'resource_missing'
  )
}

function computeBillableOverageGb(
  plan: string,
  stripeSubscriptionStatus: string,
  usedBytes: number,
  includedBytes: number,
): number {
  if (!allowsStorageOverage(plan, stripeSubscriptionStatus)) return 0
  return Math.max(0, (usedBytes - includedBytes) / BYTES_PER_GB)
}

export async function snapshotDailyStorageUsage(
  db: Kysely<DB>,
  now: Date,
): Promise<DailyUsageSnapshotResult> {
  const start = Date.now()
  const date = utcDateString(now)
  const workspaces = await db
    .selectFrom('workspaces')
    .select(['id', 'plan', 'storage_used_bytes', 'stripe_subscription_status'])
    .execute()

  let workspacesFailed = 0

  for (const workspace of workspaces) {
    try {
      const includedBytes =
        PLAN_STORAGE_QUOTA_BYTES[normalizePlan(workspace.plan)]
      const billableOverageGb = computeBillableOverageGb(
        workspace.plan,
        workspace.stripe_subscription_status,
        workspace.storage_used_bytes,
        includedBytes,
      )

      await db
        .insertInto('workspace_storage_daily_usage')
        .values({
          workspace_id: workspace.id,
          date,
          used_bytes: workspace.storage_used_bytes,
          included_bytes: includedBytes,
          billable_overage_gb: billableOverageGb,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'date']).doUpdateSet({
            used_bytes: workspace.storage_used_bytes,
            included_bytes: includedBytes,
            billable_overage_gb: billableOverageGb,
          }),
        )
        .execute()
    } catch (err) {
      workspacesFailed++
      const e = err instanceof Error ? err : new Error(String(err))
      console.log(
        JSON.stringify({
          event: 'billing_daily_usage_snapshot_failed',
          workspace_id: workspace.id,
          date,
          err: e.message,
        }),
      )
    }
  }

  return {
    duration_ms: Date.now() - start,
    workspaces_snapshot: workspaces.length,
    workspaces_failed: workspacesFailed,
  }
}

async function averageBillableOverageGbForMonth(
  db: Kysely<DB>,
  workspaceId: string,
  month: string,
): Promise<number> {
  const result = await sql<{ avg: number | null }>`
    SELECT AVG(billable_overage_gb) AS avg
    FROM workspace_storage_daily_usage
    WHERE workspace_id = ${workspaceId}
      AND date LIKE ${`${month}%`}
  `.execute(db)
  return result.rows[0]?.avg ?? 0
}

async function monthlyOverageGbForMonth(
  db: Kysely<DB>,
  workspaceId: string,
  month: string,
): Promise<number> {
  const avgGb = await averageBillableOverageGbForMonth(db, workspaceId, month)
  return Math.round(avgGb)
}

type OverageClaimResult = { kind: 'claimed' } | { kind: 'skip' }

async function claimOverageCharge(
  db: Kysely<DB>,
  workspaceId: string,
  month: string,
  nowIso: string,
  completedWorkspaceIds: Set<string>,
): Promise<OverageClaimResult> {
  if (completedWorkspaceIds.has(workspaceId)) {
    return { kind: 'skip' }
  }

  const insertResult = await db
    .insertInto('billing_overage_charges')
    .values({
      workspace_id: workspaceId,
      month,
      overage_gb_month: 0,
      status: 'pending',
      created_at: nowIso,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'month']).doNothing())
    .executeTakeFirst()

  if (Number(insertResult.numInsertedOrUpdatedRows ?? 0n) > 0) {
    return { kind: 'claimed' }
  }

  return { kind: 'skip' }
}

async function resolveOverageTarget(
  stripe: Stripe,
  customerId: string,
  subscriptionId: string | null,
): Promise<{ activeSubscriptionId: string | null; currency: string | null }> {
  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      return {
        activeSubscriptionId: isActiveSubscriptionStatus(subscription.status)
          ? subscription.id
          : null,
        currency: subscription.currency,
      }
    } catch (err) {
      if (!isStripeResourceMissing(err)) throw err
    }
  }

  const customer = await stripe.customers.retrieve(customerId)
  if (typeof customer === 'string' || customer.deleted) {
    return { activeSubscriptionId: null, currency: null }
  }
  return { activeSubscriptionId: null, currency: customer.currency ?? null }
}

async function findExistingPendingInvoiceItem(
  stripe: Stripe,
  customerId: string,
  workspaceId: string,
  month: string,
): Promise<Stripe.InvoiceItem | null> {
  const list = await stripe.invoiceItems.list({
    customer: customerId,
    pending: true,
    limit: 100,
  })
  return (
    list.data.find(
      (item) =>
        item.metadata?.workspace_id === workspaceId &&
        item.metadata?.month === month,
    ) ?? null
  )
}

type OverageWorkItem = {
  workspaceId: string
  month: string
  stripeCustomerId: string
  stripeSubscriptionId: string | null
  isStaleRetry: boolean
}

type OverageProcessResult =
  | { kind: 'skipped' }
  | { kind: 'noop' }
  | {
      kind: 'completed'
      invoiceItem: boolean
      standaloneInvoice: boolean
    }
  | { kind: 'failed' }

async function processOverageWorkItem(
  db: Kysely<DB>,
  stripe: Stripe,
  overageProductId: string,
  work: OverageWorkItem,
  nowIso: string,
): Promise<OverageProcessResult> {
  const { workspaceId, month, stripeCustomerId, stripeSubscriptionId } = work

  try {
    const overageGb = await monthlyOverageGbForMonth(db, workspaceId, month)

    if (overageGb === 0) {
      await db
        .updateTable('billing_overage_charges')
        .set({
          overage_gb_month: 0,
          status: 'completed',
          processed_at: nowIso,
        })
        .where('workspace_id', '=', workspaceId)
        .where('month', '=', month)
        .execute()
      return {
        kind: 'completed',
        invoiceItem: false,
        standaloneInvoice: false,
      }
    }

    const { activeSubscriptionId, currency } = await resolveOverageTarget(
      stripe,
      stripeCustomerId,
      stripeSubscriptionId,
    )
    const unitAmount = currency ? overageUnitAmount(currency) : null

    if (!currency || unitAmount === null) {
      console.log(
        JSON.stringify({
          event: 'billing_overage_charge_failed',
          workspace_id: workspaceId,
          month,
          err: `unsupported currency: ${currency ?? 'unknown'}`,
        }),
      )
      await db
        .updateTable('billing_overage_charges')
        .set({
          status: 'failed',
          processed_at: nowIso,
        })
        .where('workspace_id', '=', workspaceId)
        .where('month', '=', month)
        .execute()
      return { kind: 'failed' }
    }

    const existingItem = work.isStaleRetry
      ? await findExistingPendingInvoiceItem(
          stripe,
          stripeCustomerId,
          workspaceId,
          month,
        )
      : null

    let invoiceItemId: string
    let invoiceItemCreated = false

    if (existingItem) {
      invoiceItemId = existingItem.id
    } else {
      const invoiceItem = await stripe.invoiceItems.create(
        {
          customer: stripeCustomerId,
          ...(activeSubscriptionId
            ? { subscription: activeSubscriptionId }
            : {}),
          price_data: {
            currency,
            product: overageProductId,
            unit_amount: unitAmount,
            tax_behavior: 'exclusive',
          },
          quantity: overageGb,
          description: overageDescription(month),
          metadata: {
            workspace_id: workspaceId,
            month,
          },
        },
        {
          idempotencyKey: `overage-item-${workspaceId}-${month}`,
        },
      )
      invoiceItemId = invoiceItem.id
      invoiceItemCreated = true
    }

    let invoiceId: string | null = null
    if (!activeSubscriptionId) {
      const invoice = await stripe.invoices.create(
        {
          customer: stripeCustomerId,
          pending_invoice_items_behavior: 'include',
          auto_advance: true,
          automatic_tax: { enabled: true },
        },
        {
          idempotencyKey: `overage-invoice-${workspaceId}-${month}`,
        },
      )
      invoiceId = invoice.id
    }

    await db
      .updateTable('billing_overage_charges')
      .set({
        overage_gb_month: overageGb,
        status: 'completed',
        stripe_invoice_item_id: invoiceItemId,
        stripe_invoice_id: invoiceId,
        processed_at: nowIso,
      })
      .where('workspace_id', '=', workspaceId)
      .where('month', '=', month)
      .execute()

    return {
      kind: 'completed',
      invoiceItem: invoiceItemCreated,
      standaloneInvoice: invoiceId !== null,
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.log(
      JSON.stringify({
        event: 'billing_overage_charge_failed',
        workspace_id: workspaceId,
        month,
        err: e.message,
      }),
    )
    return { kind: 'failed' }
  }
}

export async function createMonthlyOverageCharges(
  db: Kysely<DB>,
  stripe: Stripe,
  overageProductId: string,
  now: Date,
): Promise<MonthlyOverageChargeResult> {
  const start = Date.now()
  const month = previousUtcMonth(now)
  const nowIso = now.toISOString()
  const staleThresholdIso = new Date(
    now.getTime() - OVERAGE_CLAIM_RETRY_MS,
  ).toISOString()

  const completedForPreviousMonth = await db
    .selectFrom('billing_overage_charges')
    .select('workspace_id')
    .where('month', '=', month)
    .where('status', '=', 'completed')
    .execute()
  const completedWorkspaceIds = new Set(
    completedForPreviousMonth.map((row) => row.workspace_id),
  )

  const usageWorkspaceRows = await db
    .selectFrom('workspace_storage_daily_usage')
    .select('workspace_id')
    .where('date', 'like', `${month}%`)
    .groupBy('workspace_id')
    .execute()

  const usageWorkspaceIds = [
    ...new Set(usageWorkspaceRows.map((row) => row.workspace_id)),
  ]

  const usageWorkspaces =
    usageWorkspaceIds.length === 0
      ? []
      : await db
          .selectFrom('workspaces')
          .select(['id', 'stripe_customer_id', 'stripe_subscription_id'])
          .where('id', 'in', usageWorkspaceIds)
          .where('stripe_customer_id', 'is not', null)
          .execute()

  const stalePendingRows = await db
    .selectFrom('billing_overage_charges')
    .innerJoin(
      'workspaces',
      'workspaces.id',
      'billing_overage_charges.workspace_id',
    )
    .select([
      'billing_overage_charges.workspace_id',
      'billing_overage_charges.month',
      'workspaces.stripe_customer_id',
      'workspaces.stripe_subscription_id',
    ])
    .where('billing_overage_charges.status', '=', 'pending')
    .where('billing_overage_charges.created_at', '<=', staleThresholdIso)
    .where('workspaces.stripe_customer_id', 'is not', null)
    .execute()

  const worklist = new Map<string, OverageWorkItem>()
  let workspacesSkipped = 0

  const claimTargets = usageWorkspaces.filter(
    (workspace) => workspace.stripe_customer_id !== null,
  )
  const claims = await Promise.all(
    claimTargets.map((workspace) =>
      claimOverageCharge(
        db,
        workspace.id,
        month,
        nowIso,
        completedWorkspaceIds,
      ),
    ),
  )
  claimTargets.forEach((workspace, index) => {
    if (claims[index].kind === 'skip') {
      workspacesSkipped++
      return
    }
    worklist.set(overageWorkKey(workspace.id, month), {
      workspaceId: workspace.id,
      month,
      stripeCustomerId: workspace.stripe_customer_id as string,
      stripeSubscriptionId: workspace.stripe_subscription_id,
      isStaleRetry: false,
    })
  })

  for (const row of stalePendingRows) {
    const customerId = row.stripe_customer_id
    if (!customerId) continue

    const key = overageWorkKey(row.workspace_id, row.month)
    if (worklist.has(key)) continue

    worklist.set(key, {
      workspaceId: row.workspace_id,
      month: row.month,
      stripeCustomerId: customerId,
      stripeSubscriptionId: row.stripe_subscription_id,
      isStaleRetry: true,
    })
  }

  const settled = await Promise.allSettled(
    [...worklist.values()].map((work) =>
      processOverageWorkItem(db, stripe, overageProductId, work, nowIso),
    ),
  )

  let invoiceItemsCreated = 0
  let standaloneInvoicesCreated = 0
  let workspacesFailed = 0

  for (const result of settled) {
    if (result.status === 'rejected') {
      workspacesFailed++
      continue
    }
    const value = result.value
    if (value.kind === 'failed') workspacesFailed++
    else if (value.kind === 'completed' && value.invoiceItem) {
      invoiceItemsCreated++
      if (value.standaloneInvoice) standaloneInvoicesCreated++
    }
  }

  return {
    duration_ms: Date.now() - start,
    month,
    workspaces_eligible: worklist.size,
    workspaces_skipped: workspacesSkipped,
    invoice_items_created: invoiceItemsCreated,
    standalone_invoices_created: standaloneInvoicesCreated,
    workspaces_failed: workspacesFailed,
  }
}

export interface OverageProjection {
  projectedOverageGb: number
  projectedOverageUsd: number
  projectedOverageJpy: number
}

export async function loadCurrentMonthOverageProjection(
  db: Kysely<DB>,
  workspaceId: string,
  now: Date,
): Promise<OverageProjection> {
  const month = utcMonthString(now)
  const projectedOverageGb = await monthlyOverageGbForMonth(
    db,
    workspaceId,
    month,
  )
  return {
    projectedOverageGb,
    projectedOverageUsd: projectedOverageGb * STORAGE_OVERAGE_PRICES.usd,
    projectedOverageJpy: projectedOverageGb * STORAGE_OVERAGE_PRICES.jpy,
  }
}

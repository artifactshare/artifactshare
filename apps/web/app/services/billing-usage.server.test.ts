import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-plan.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  createMonthlyOverageCharges,
  loadCurrentMonthOverageProjection,
  snapshotDailyStorageUsage,
} from './billing-usage.server'

const BYTES_PER_GB = 1073741824
const NOW = new Date('2026-07-06T17:00:00.000Z')
const MONTH_START = new Date('2026-07-01T17:00:00.000Z')
const OVERAGE_PRODUCT_ID = 'prod_overage_test'

async function seedWorkspace(
  db: Kysely<DB>,
  args: {
    id?: string
    plan?: string
    storageUsedBytes?: number
    stripeCustomerId?: string | null
    stripeSubscriptionId?: string | null
    stripeSubscriptionStatus?: string
  } = {},
) {
  const id = args.id ?? 'ws1'
  const plan = args.plan ?? 'free'
  const quotaKey = plan === 'team' ? 'team' : plan === 'plus' ? 'plus' : 'free'
  await db
    .insertInto('workspaces')
    .values({
      id,
      hd: `${id}.example.com`,
      name: 'Workspace',
      created_at: '2026-07-01T00:00:00.000Z',
      plan,
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[quotaKey],
      storage_used_bytes: args.storageUsedBytes ?? 0,
      storage_updated_at: '2026-07-01T00:00:00.000Z',
      stripe_customer_id: args.stripeCustomerId ?? null,
      stripe_subscription_id: args.stripeSubscriptionId ?? null,
      stripe_subscription_status: args.stripeSubscriptionStatus ?? 'none',
    })
    .execute()
}

async function seedDailyUsage(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    date: string
    billableOverageGb: number
  },
) {
  await db
    .insertInto('workspace_storage_daily_usage')
    .values({
      workspace_id: args.workspaceId,
      date: args.date,
      used_bytes: 0,
      included_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
      billable_overage_gb: args.billableOverageGb,
    })
    .execute()
}

function makeStripeMock() {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        currency: 'jpy',
      }),
    },
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'cus_1',
        currency: 'jpy',
        deleted: false,
      }),
    },
    invoiceItems: {
      create: vi.fn().mockResolvedValue({ id: 'ii_1' }),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    invoices: {
      create: vi.fn().mockResolvedValue({ id: 'in_1' }),
    },
  }
}

describe('snapshotDailyStorageUsage', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('records billable overage for active team subscriptions only', async () => {
    const teamOverBytes = PLAN_STORAGE_QUOTA_BYTES.team + 2 * BYTES_PER_GB
    await seedWorkspace(db, {
      id: 'ws-team',
      plan: 'team',
      storageUsedBytes: teamOverBytes,
      stripeSubscriptionStatus: 'active',
    })
    await seedWorkspace(db, {
      id: 'ws-free',
      plan: 'free',
      storageUsedBytes: PLAN_STORAGE_QUOTA_BYTES.free + BYTES_PER_GB,
    })
    await seedWorkspace(db, {
      id: 'ws-canceled',
      plan: 'team',
      storageUsedBytes: teamOverBytes,
      stripeSubscriptionStatus: 'canceled',
    })

    await snapshotDailyStorageUsage(db, NOW)

    const rows = await db
      .selectFrom('workspace_storage_daily_usage')
      .selectAll()
      .orderBy('workspace_id')
      .execute()

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-canceled',
      date: '2026-07-06',
      billable_overage_gb: 0,
    })
    expect(rows[1]).toMatchObject({
      workspace_id: 'ws-free',
      billable_overage_gb: 0,
      included_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
    expect(rows[2]).toMatchObject({
      workspace_id: 'ws-team',
      billable_overage_gb: 2,
      included_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
      used_bytes: teamOverBytes,
    })
  })

  test('upserts the same UTC date into a single row', async () => {
    await seedWorkspace(db, {
      plan: 'team',
      storageUsedBytes: PLAN_STORAGE_QUOTA_BYTES.team,
      stripeSubscriptionStatus: 'active',
    })

    await snapshotDailyStorageUsage(db, NOW)
    await db
      .updateTable('workspaces')
      .set({
        storage_used_bytes: PLAN_STORAGE_QUOTA_BYTES.team + BYTES_PER_GB,
      })
      .where('id', '=', 'ws1')
      .execute()
    await snapshotDailyStorageUsage(db, NOW)

    const rows = await db
      .selectFrom('workspace_storage_daily_usage')
      .selectAll()
      .execute()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws1',
      date: '2026-07-06',
      billable_overage_gb: 1,
    })
  })

  test('isolates per-workspace snapshot failures', async () => {
    await seedWorkspace(db, { id: 'ws-ok', plan: 'free' })
    await seedWorkspace(db, { id: 'ws-fail', plan: 'free' })

    let insertIntoCallCount = 0
    const originalInsertInto = db.insertInto.bind(db)
    vi.spyOn(db, 'insertInto').mockImplementation((table) => {
      if (table === 'workspace_storage_daily_usage') {
        insertIntoCallCount += 1
        if (insertIntoCallCount === 2) {
          throw new Error('insert failed')
        }
      }
      return originalInsertInto(table)
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await snapshotDailyStorageUsage(db, NOW)

    expect(result.workspaces_snapshot).toBe(2)
    expect(result.workspaces_failed).toBe(1)

    const rows = await db
      .selectFrom('workspace_storage_daily_usage')
      .select('workspace_id')
      .orderBy('workspace_id')
      .execute()
    expect(rows).toHaveLength(1)
    expect(['ws-fail', 'ws-ok']).toContain(rows[0]?.workspace_id)

    const failureLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .find((event) => event.event === 'billing_daily_usage_snapshot_failed')
    expect(failureLog?.workspace_id).toBe(
      rows[0]?.workspace_id === 'ws-ok' ? 'ws-fail' : 'ws-ok',
    )
    logSpy.mockRestore()
    vi.restoreAllMocks()
  })
})

describe('createMonthlyOverageCharges', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('creates invoice item for active subscription with rounded GB-month average', async () => {
    await seedWorkspace(db, {
      id: 'ws1',
      plan: 'team',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripeSubscriptionStatus: 'active',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-06-10',
      billableOverageGb: 1,
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-06-20',
      billableOverageGb: 2,
    })

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.month).toBe('2026-06')
    expect(result.invoice_items_created).toBe(1)
    expect(result.standalone_invoices_created).toBe(0)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1')
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      {
        customer: 'cus_1',
        subscription: 'sub_1',
        price_data: {
          currency: 'jpy',
          product: OVERAGE_PRODUCT_ID,
          unit_amount: 16,
          tax_behavior: 'exclusive',
        },
        quantity: 2,
        description: 'Storage overage for 2026-06',
        metadata: {
          workspace_id: 'ws1',
          month: '2026-06',
        },
      },
      { idempotencyKey: 'overage-item-ws1-2026-06' },
    )
    expect(stripe.invoices.create).not.toHaveBeenCalled()

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      workspace_id: 'ws1',
      month: '2026-06',
      overage_gb_month: 2,
      status: 'completed',
      stripe_invoice_item_id: 'ii_1',
      stripe_invoice_id: null,
    })
  })

  test('skips workspaces already completed in billing_overage_charges', async () => {
    await seedWorkspace(db, {
      plan: 'team',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-06-01',
      billableOverageGb: 1,
    })
    await db
      .insertInto('billing_overage_charges')
      .values({
        workspace_id: 'ws1',
        month: '2026-06',
        overage_gb_month: 500,
        status: 'completed',
        created_at: '2026-06-01T00:00:00.000Z',
        processed_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.workspaces_skipped).toBe(1)
    expect(result.invoice_items_created).toBe(0)
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()
  })

  test('records zero-overage months without calling Stripe', async () => {
    await seedWorkspace(db, {
      plan: 'team',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-06-01',
      billableOverageGb: 0,
    })

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.invoice_items_created).toBe(0)
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()
    expect(stripe.invoices.create).not.toHaveBeenCalled()
    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      overage_gb_month: 0,
      status: 'completed',
      stripe_invoice_item_id: null,
    })
  })

  test('creates standalone invoice when subscription is inactive', async () => {
    await seedWorkspace(db, {
      id: 'ws-canceled',
      plan: 'free',
      stripeCustomerId: 'cus_canceled',
      stripeSubscriptionId: 'sub_canceled',
      stripeSubscriptionStatus: 'canceled',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-canceled',
      date: '2026-06-15',
      billableOverageGb: 2,
    })

    const stripe = makeStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_canceled',
      status: 'canceled',
      currency: 'usd',
    })
    stripe.customers.retrieve.mockResolvedValue({
      id: 'cus_canceled',
      currency: 'usd',
      deleted: false,
    })

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.invoice_items_created).toBe(1)
    expect(result.standalone_invoices_created).toBe(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_canceled')
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      {
        customer: 'cus_canceled',
        price_data: {
          currency: 'usd',
          product: OVERAGE_PRODUCT_ID,
          unit_amount: 10,
          tax_behavior: 'exclusive',
        },
        quantity: 2,
        description: 'Storage overage for 2026-06',
        metadata: {
          workspace_id: 'ws-canceled',
          month: '2026-06',
        },
      },
      { idempotencyKey: 'overage-item-ws-canceled-2026-06' },
    )
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      {
        customer: 'cus_canceled',
        pending_invoice_items_behavior: 'include',
        auto_advance: true,
        automatic_tax: { enabled: true },
      },
      { idempotencyKey: 'overage-invoice-ws-canceled-2026-06' },
    )

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      status: 'completed',
      stripe_invoice_item_id: 'ii_1',
      stripe_invoice_id: 'in_1',
    })
  })

  test('skips recent pending claims and retries stale pending claims', async () => {
    await seedWorkspace(db, {
      id: 'ws-recent',
      plan: 'team',
      stripeCustomerId: 'cus_recent',
      stripeSubscriptionId: 'sub_recent',
    })
    await seedWorkspace(db, {
      id: 'ws-stale',
      plan: 'team',
      stripeCustomerId: 'cus_stale',
      stripeSubscriptionId: 'sub_stale',
    })
    for (const [workspaceId, gb] of [
      ['ws-recent', 1],
      ['ws-stale', 1],
    ] as const) {
      await seedDailyUsage(db, {
        workspaceId,
        date: '2026-06-15',
        billableOverageGb: gb,
      })
    }

    await db
      .insertInto('billing_overage_charges')
      .values([
        {
          workspace_id: 'ws-recent',
          month: '2026-06',
          overage_gb_month: 0,
          status: 'pending',
          created_at: '2026-07-01T16:30:00.000Z',
        },
        {
          workspace_id: 'ws-stale',
          month: '2026-06',
          overage_gb_month: 0,
          status: 'pending',
          created_at: '2026-07-01T15:00:00.000Z',
        },
      ])
      .execute()

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.workspaces_skipped).toBe(2)
    expect(result.invoice_items_created).toBe(1)
    expect(stripe.invoiceItems.create).toHaveBeenCalledTimes(1)
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_stale' }),
      expect.any(Object),
    )

    const rows = await db
      .selectFrom('billing_overage_charges')
      .select(['workspace_id', 'status'])
      .orderBy('workspace_id')
      .execute()
    expect(rows).toEqual([
      { workspace_id: 'ws-recent', status: 'pending' },
      { workspace_id: 'ws-stale', status: 'completed' },
    ])
  })

  test('leaves pending row on Stripe failure for later retry', async () => {
    await seedWorkspace(db, {
      id: 'ws-fail',
      plan: 'team',
      stripeCustomerId: 'cus_fail',
      stripeSubscriptionId: 'sub_fail',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-fail',
      date: '2026-06-15',
      billableOverageGb: 1,
    })

    const stripe = makeStripeMock()
    stripe.invoiceItems.create.mockRejectedValue(new Error('stripe down'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const firstResult = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )
    expect(firstResult.workspaces_failed).toBe(1)

    const pendingRow = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(pendingRow.status).toBe('pending')

    await db
      .updateTable('billing_overage_charges')
      .set({ created_at: '2026-07-01T15:00:00.000Z' })
      .where('workspace_id', '=', 'ws-fail')
      .execute()

    stripe.invoiceItems.create.mockResolvedValue({ id: 'ii_retry' })
    const retryResult = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )
    expect(retryResult.invoice_items_created).toBe(1)

    const completedRow = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(completedRow).toMatchObject({
      status: 'completed',
      stripe_invoice_item_id: 'ii_retry',
    })

    const failureLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .find((event) => event.event === 'billing_overage_charge_failed')
    expect(failureLog).toMatchObject({
      workspace_id: 'ws-fail',
      month: '2026-06',
    })
    logSpy.mockRestore()
  })

  test('isolates per-workspace Stripe failures', async () => {
    await seedWorkspace(db, {
      id: 'ws-fail',
      plan: 'team',
      stripeCustomerId: 'cus_fail',
      stripeSubscriptionId: 'sub_fail',
    })
    await seedWorkspace(db, {
      id: 'ws-ok',
      plan: 'team',
      stripeCustomerId: 'cus_ok',
      stripeSubscriptionId: 'sub_ok',
    })
    for (const workspaceId of ['ws-fail', 'ws-ok']) {
      await seedDailyUsage(db, {
        workspaceId,
        date: '2026-06-15',
        billableOverageGb: 1,
      })
    }

    const stripe = makeStripeMock()
    stripe.invoiceItems.create.mockImplementation(
      async (params: { customer: string }) => {
        if (params.customer === 'cus_fail') {
          throw new Error('stripe down')
        }
        return { id: 'ii_ok' }
      },
    )

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.workspaces_failed).toBe(1)
    expect(result.invoice_items_created).toBe(1)

    const rows = await db
      .selectFrom('billing_overage_charges')
      .select(['workspace_id', 'status'])
      .orderBy('workspace_id')
      .execute()
    expect(rows).toEqual([
      { workspace_id: 'ws-fail', status: 'pending' },
      { workspace_id: 'ws-ok', status: 'completed' },
    ])
  })

  test('charges previous-month overage for downgraded workspaces', async () => {
    await seedWorkspace(db, {
      id: 'ws-downgraded',
      plan: 'free',
      stripeCustomerId: 'cus_downgraded',
      stripeSubscriptionId: 'sub_downgraded',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-downgraded',
      date: '2026-06-15',
      billableOverageGb: 2,
    })

    const stripe = makeStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_downgraded',
      status: 'canceled',
      currency: 'jpy',
    })

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      NOW,
    )

    expect(result.month).toBe('2026-06')
    expect(result.invoice_items_created).toBe(1)
    expect(result.standalone_invoices_created).toBe(1)
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.customers.retrieve).not.toHaveBeenCalled()
  })

  test('charges unsent previous-month overage when run mid-month', async () => {
    await seedWorkspace(db, {
      plan: 'team',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-06-20',
      billableOverageGb: 1.5,
    })

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      NOW,
    )

    expect(result.month).toBe('2026-06')
    expect(result.invoice_items_created).toBe(1)
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 2 }),
      expect.any(Object),
    )
  })

  test('retries stale pending rows from months older than the previous month', async () => {
    await seedWorkspace(db, {
      id: 'ws-old',
      plan: 'team',
      stripeCustomerId: 'cus_old',
      stripeSubscriptionId: 'sub_old',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-old',
      date: '2026-04-10',
      billableOverageGb: 2,
    })
    await db
      .insertInto('billing_overage_charges')
      .values({
        workspace_id: 'ws-old',
        month: '2026-04',
        overage_gb_month: 0,
        status: 'pending',
        created_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.month).toBe('2026-06')
    expect(result.invoice_items_created).toBe(1)
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_old',
        metadata: { workspace_id: 'ws-old', month: '2026-04' },
      }),
      expect.any(Object),
    )

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .where('month', '=', '2026-04')
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      status: 'completed',
      overage_gb_month: 2,
      stripe_invoice_item_id: 'ii_1',
    })
  })

  test('does not retry failed rows from unsupported currency', async () => {
    await seedWorkspace(db, {
      id: 'ws-failed',
      plan: 'team',
      stripeCustomerId: 'cus_failed',
      stripeSubscriptionId: 'sub_failed',
    })
    await db
      .insertInto('billing_overage_charges')
      .values({
        workspace_id: 'ws-failed',
        month: '2026-04',
        overage_gb_month: 0,
        status: 'failed',
        created_at: '2026-06-01T00:00:00.000Z',
        processed_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()
    await seedDailyUsage(db, {
      workspaceId: 'ws-failed',
      date: '2026-04-10',
      billableOverageGb: 2,
    })

    const stripe = makeStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_failed',
      status: 'active',
      currency: 'eur',
    })

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.invoice_items_created).toBe(0)
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .where('month', '=', '2026-04')
      .executeTakeFirstOrThrow()
    expect(charge.status).toBe('failed')
  })

  test('reuses existing pending invoice item on stale retry when metadata matches', async () => {
    await seedWorkspace(db, {
      id: 'ws-reuse',
      plan: 'team',
      stripeCustomerId: 'cus_reuse',
      stripeSubscriptionId: 'sub_reuse',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-reuse',
      date: '2026-04-10',
      billableOverageGb: 1,
    })
    await db
      .insertInto('billing_overage_charges')
      .values({
        workspace_id: 'ws-reuse',
        month: '2026-04',
        overage_gb_month: 0,
        status: 'pending',
        created_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()

    const stripe = makeStripeMock()
    stripe.invoiceItems.list.mockResolvedValue({
      data: [
        {
          id: 'ii_existing',
          metadata: { workspace_id: 'ws-reuse', month: '2026-04' },
        },
      ],
    })

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.invoice_items_created).toBe(0)
    expect(stripe.invoiceItems.list).toHaveBeenCalledWith({
      customer: 'cus_reuse',
      pending: true,
      limit: 100,
    })
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .where('month', '=', '2026-04')
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      status: 'completed',
      stripe_invoice_item_id: 'ii_existing',
    })
  })

  test('does not issue claim INSERT for completed workspaces in the target month', async () => {
    await seedWorkspace(db, {
      id: 'ws-done',
      plan: 'team',
      stripeCustomerId: 'cus_done',
      stripeSubscriptionId: 'sub_done',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-done',
      date: '2026-06-01',
      billableOverageGb: 1,
    })
    await db
      .insertInto('billing_overage_charges')
      .values({
        workspace_id: 'ws-done',
        month: '2026-06',
        overage_gb_month: 1,
        status: 'completed',
        created_at: '2026-06-01T00:00:00.000Z',
        processed_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()

    let billingOverageInsertCalls = 0
    const originalInsertInto = db.insertInto.bind(db)
    const insertSpy = vi.spyOn(db, 'insertInto').mockImplementation(((
      table: keyof DB,
    ) => {
      if (table === 'billing_overage_charges') {
        billingOverageInsertCalls += 1
      }
      return originalInsertInto(table)
    }) as typeof db.insertInto)

    const stripe = makeStripeMock()
    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.workspaces_skipped).toBe(1)
    expect(result.invoice_items_created).toBe(0)
    expect(billingOverageInsertCalls).toBe(0)
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()
    insertSpy.mockRestore()
  })

  test('marks unsupported currency as failed terminal state on first attempt', async () => {
    await seedWorkspace(db, {
      id: 'ws-eur',
      plan: 'team',
      stripeCustomerId: 'cus_eur',
      stripeSubscriptionId: 'sub_eur',
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws-eur',
      date: '2026-06-15',
      billableOverageGb: 1,
    })

    const stripe = makeStripeMock()
    stripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_eur',
      status: 'active',
      currency: 'eur',
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await createMonthlyOverageCharges(
      db,
      stripe as never,
      OVERAGE_PRODUCT_ID,
      MONTH_START,
    )

    expect(result.workspaces_failed).toBe(1)
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled()

    const charge = await db
      .selectFrom('billing_overage_charges')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(charge).toMatchObject({
      status: 'failed',
      processed_at: MONTH_START.toISOString(),
    })

    const failureLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .find((event) => event.event === 'billing_overage_charge_failed')
    expect(failureLog).toMatchObject({
      workspace_id: 'ws-eur',
      month: '2026-06',
    })
    logSpy.mockRestore()
  })
})

describe('loadCurrentMonthOverageProjection', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('rounds projected GB and cost to integer GB basis', async () => {
    await seedWorkspace(db, { id: 'ws1', plan: 'team' })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-07-10',
      billableOverageGb: 1,
    })
    await seedDailyUsage(db, {
      workspaceId: 'ws1',
      date: '2026-07-20',
      billableOverageGb: 2,
    })

    const projection = await loadCurrentMonthOverageProjection(db, 'ws1', NOW)

    expect(projection).toEqual({
      projectedOverageGb: 2,
      projectedOverageUsd: 0.2,
      projectedOverageJpy: 32,
    })
  })
})

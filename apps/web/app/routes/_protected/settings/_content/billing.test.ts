import { env } from 'cloudflare:workers'
import { Window } from 'happy-dom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
} from 'react-router'
import * as billing from '~/services/billing.server'
import * as billingUsage from '~/services/billing-usage.server'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BILLING_PRICES, PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbState = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus_monthly',
    STRIPE_PRICE_PLUS_YEARLY: 'price_plus_yearly',
    STRIPE_PRICE_TEAM_MONTHLY: 'price_team_monthly',
    STRIPE_PRICE_TEAM_YEARLY: 'price_team_yearly',
    STRIPE_PRODUCT_STORAGE_OVERAGE: 'prod_storage_overage',
    STRIPE_PORTAL_CONFIGURATION: 'bpc_test_config',
  },
}))

vi.mock('~/services/db.server', () => ({
  createDb: () => {
    if (!dbState.db) throw new Error('missing sqlite fixture')
    return dbState.db
  },
}))

const requireUserMock = vi.hoisted(() => vi.fn())
const createCheckoutSessionMock = vi.hoisted(() => vi.fn())
const loadSubscriptionContractMock = vi.hoisted(() =>
  vi.fn<typeof billing.loadSubscriptionContract>(() => Promise.resolve(null)),
)

vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))

vi.mock('~/services/billing.server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/services/billing.server')>()
  return {
    ...actual,
    createCheckoutSession: createCheckoutSessionMock,
    loadSubscriptionContract: loadSubscriptionContractMock,
  }
})

import BillingPage, {
  action,
  loader,
  shouldShowBillingContext,
} from './billing'
import { loadSettingsShell } from '../+lib/settings-request.server'

describe('/settings/billing loader', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
    createCheckoutSessionMock.mockReset()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    dbState.db = null
    await db.destroy()
  })

  test.each([true, false])(
    'a Team subscription loads its contract only when Stripe configured=%s',
    async (configured) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'))
      await seedAdmin(db, 'u-a', 'ws-a')
      await updateWorkspacePlan(db, 'ws-a', 'team', 'active', 'sub_1')
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
      loadSubscriptionContractMock.mockResolvedValue({
        plan: 'team',
        interval: 'monthly',
        currency: 'usd',
        amount: BILLING_PRICES.team.usd.month,
        renewsAt: '2026-08-01T00:00:00.000Z',
        cancelAtPeriodEnd: false,
      })
      const savedKey = env.STRIPE_SECRET_KEY
      if (!configured) env.STRIPE_SECRET_KEY = ''
      try {
        const result = await loader({
          context: new RouterContextProvider(),
          request: new Request('https://example.test/settings/billing'),
        } as never)
        expect(result.billingConfigured).toBe(configured)
        expect(result.contract !== null).toBe(configured)
      } finally {
        env.STRIPE_SECRET_KEY = savedKey
        loadSubscriptionContractMock.mockReset()
        loadSubscriptionContractMock.mockResolvedValue(null)
      }
    },
  )

  test.each([true, false])(
    'a Free workspace without a subscription loads no contract when Stripe configured=%s',
    async (configured) => {
      await seedAdmin(db, 'u-a', 'ws-a')
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
      const savedKey = env.STRIPE_SECRET_KEY
      if (!configured) env.STRIPE_SECRET_KEY = ''
      try {
        const result = await loader({
          context: new RouterContextProvider(),
          request: new Request('https://example.test/settings/billing'),
        } as never)
        expect(result).toMatchObject({
          billingConfigured: configured,
          hasSubscription: false,
          contract: null,
        })
        expect(loadSubscriptionContractMock).not.toHaveBeenCalled()
      } finally {
        env.STRIPE_SECRET_KEY = savedKey
      }
    },
  )

  test('a subscription that started this month reaches the page with its current-period charge', async () => {
    const actual = await vi.importActual<
      typeof import('~/services/billing.server')
    >('~/services/billing.server')
    loadSubscriptionContractMock.mockImplementation(
      actual.loadSubscriptionContract,
    )
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'))
    const periodStart = Date.UTC(2026, 6, 1) / 1000
    const periodEnd = Date.UTC(2026, 7, 1) / 1000
    // The real contract mapping reads this Stripe reply; fetch is replaced so
    // no request can reach the network.
    const stripeRequests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        stripeRequests.push(
          `${request.method} ${new URL(request.url).pathname}`,
        )
        return Response.json({
          object: 'subscription',
          id: 'sub_1',
          status: 'active',
          currency: 'usd',
          cancel_at_period_end: false,
          items: {
            object: 'list',
            has_more: false,
            data: [
              {
                object: 'subscription_item',
                id: 'si_1',
                current_period_start: periodStart,
                current_period_end: periodEnd,
                price: {
                  object: 'price',
                  id: env.STRIPE_PRICE_TEAM_MONTHLY,
                  currency: 'usd',
                  unit_amount: Math.round(BILLING_PRICES.team.usd.month * 100),
                  recurring: { interval: 'month' },
                  currency_options: {
                    usd: {
                      unit_amount: Math.round(
                        BILLING_PRICES.team.usd.month * 100,
                      ),
                    },
                  },
                },
              },
            ],
          },
        })
      }),
    )
    try {
      await seedAdmin(db, 'u-a', 'ws-a')
      await updateWorkspacePlan(db, 'ws-a', 'team', 'active', 'sub_1')
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
      const result = await loader({
        context: new RouterContextProvider(),
        request: new Request('https://example.test/settings/billing'),
      } as never)
      expect(stripeRequests).toEqual(['GET /v1/subscriptions/sub_1'])
      expect(result.contract).toEqual({
        plan: 'team',
        interval: 'monthly',
        currency: 'usd',
        amount: BILLING_PRICES.team.usd.month,
        renewsAt: new Date(periodEnd * 1000).toISOString(),
        cancelAtPeriodEnd: false,
      })
      // The period starts this month, so the estimate bills the plan.
      expect(result.monthlyEstimate).toMatchObject({
        currency: 'usd',
        planCharge: 'billed',
        planAmount: BILLING_PRICES.team.usd.month,
        planDate: new Date(periodStart * 1000).toISOString(),
        overageEnabled: true,
      })
    } finally {
      vi.unstubAllGlobals()
      loadSubscriptionContractMock.mockReset()
      loadSubscriptionContractMock.mockResolvedValue(null)
    }
  })

  test('a configured Free workspace without a subscription offers both checkouts', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    const context = new RouterContextProvider()

    const shell = await loadSettingsShell(context)
    const result = await loader({
      context,
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(shell.workspace).toMatchObject({
      plan: 'free',
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
    expect(result).toMatchObject({
      canManage: true,
      billingConfigured: true,
      hasSubscription: false,
      stripeSubscriptionStatus: 'none',
      contract: null,
      monthlyEstimate: null,
    })

    // The page those two results render: both checkout cards, enabled,
    // and nothing of a subscription.
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: createElement(Outlet, { context: shell }),
          children: [
            {
              index: true,
              element: createElement(BillingPage, { loaderData: result }),
            },
          ],
        },
      ],
      { initialEntries: ['/'] },
    )
    const doc = new Window().document
    doc.body.innerHTML = renderToStaticMarkup(
      createElement(RouterProvider, { router }),
    )
    expect(
      doc.querySelector(
        '[data-billing-unavailable], [data-billing-contract-details]',
      ),
    ).toBeNull()
    const submits = [
      ...doc.querySelectorAll('[data-plan] form button[type="submit"]'),
    ]
    expect(
      submits.map((submit) =>
        submit.closest('[data-plan]')!.getAttribute('data-plan'),
      ),
    ).toEqual(['plus', 'team'])
    for (const submit of submits)
      expect(submit.closest('[disabled]')).toBeNull()
  })

  test('admin loader returns manageable billing data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'))
    await seedAdmin(db, 'u-a', 'ws-a')
    await updateWorkspacePlan(db, 'ws-a', 'plus', 'active', 'sub_1')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    const contract = {
      plan: 'plus' as const,
      interval: 'monthly' as const,
      currency: 'usd' as const,
      amount: 5,
      renewsAt: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    }
    loadSubscriptionContractMock.mockResolvedValueOnce(contract)

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(loadSubscriptionContractMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'sub_1',
    )
    expect(result).toEqual({
      showOverageProjection: true,
      includedBytes: 10 * 1024 ** 3,
      contributorCount: null,
      overageProjection: { gb: 0, currency: 'usd', amount: 0 },
      contract,
      canManage: true,
      stripeSubscriptionStatus: 'active',
      hasSubscription: true,
      billingConfigured: true,
      defaultCurrency: 'usd',
      initialPlan: 'team',
      initialInterval: 'monthly',
      activeProjectCount: 0,
      projectLimit: 20,
      entryContext: 'default',
      externalPostingEnabled: true,
      monthlyEstimate: expect.objectContaining({ totalAmount: 5 }),
    })
  })

  test.each(['u-a', 'u-c'])(
    'projection failure preserves billing data for %s',
    async (userId) => {
      await seedAdmin(db, 'u-a', 'ws-a')
      await updateWorkspacePlan(db, 'ws-a', 'plus', 'active', 'sub_1')
      requireUserMock.mockReturnValue(sessionUser(userId, 'ws-a'))
      loadSubscriptionContractMock.mockResolvedValueOnce({
        plan: 'plus',
        interval: 'monthly',
        currency: 'usd',
        amount: 5,
        renewsAt: null,
        cancelAtPeriodEnd: false,
      })
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const projection = vi
        .spyOn(billingUsage, 'loadCurrentMonthOverageProjection')
        .mockRejectedValue(new Error('projection unavailable'))

      const result = await loader({
        context: new RouterContextProvider(),
        request: new Request('https://example.test/settings/billing'),
      } as never)

      // Usage and, for the owner, the monthly estimate share one projection.
      expect(projection).toHaveBeenCalledTimes(1)
      const operations = log.mock.calls.map(([diagnostic]) => diagnostic)
      expect(operations).toEqual([
        {
          operation: 'billing.projection',
          cause: 'Error',
          frames: expect.any(Array),
        },
      ])
      expect(result).toMatchObject({
        canManage: userId === 'u-a',
        showOverageProjection: true,
        overageProjection: null,
        monthlyEstimate: null,
      })
    },
  )

  test('loader returns jpy defaultCurrency for JP requests', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const request = new Request(
      'https://example.test/settings/billing',
    ) as Request<unknown, IncomingRequestCfProperties<unknown>>
    Object.defineProperty(request, 'cf', { value: { country: 'JP' } })

    const result = await loader({
      context: new RouterContextProvider(),
      request,
    } as never)

    expect(result.defaultCurrency).toBe('jpy')
  })

  test('free loader returns the free quotas and disabled external posting policy', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result).toMatchObject({
      projectLimit: 5,
      externalPostingEnabled: false,
    })
  })

  test('the shell billing shows preserves a zero-byte storage quota', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_quota_bytes: 0 })
      .where('id', '=', 'ws-a')
      .execute()
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const shell = await loadSettingsShell(new RouterContextProvider())

    expect(shell.workspace.storageQuotaBytes).toBe(0)
  })

  test('non-owner loader returns read-only billing data without owner contact', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await updateWorkspacePlan(db, 'ws-a', 'team', 'active', 'sub_1')
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result).toEqual({
      showOverageProjection: true,
      includedBytes: 100 * 1024 ** 3,
      contributorCount: 0,
      overageProjection: { gb: 0, currency: null, amount: null },
      contract: null,
      canManage: false,
      stripeSubscriptionStatus: 'active',
      hasSubscription: true,
      billingConfigured: true,
      defaultCurrency: 'usd',
      initialPlan: 'team',
      initialInterval: 'monthly',
      activeProjectCount: 0,
      projectLimit: null,
      entryContext: 'default',
      externalPostingEnabled: true,
      monthlyEstimate: null,
    })
  })

  test('counts only active project containers in the workspace', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    await seedContainer(db, 'active-project', 'project', null)
    await seedContainer(
      db,
      'archived-project',
      'project',
      '2026-06-02T00:00:00.000Z',
    )
    await seedContainer(db, 'inbox', 'inbox', null)

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.activeProjectCount).toBe(1)
  })

  test.each([
    ['?plan=plus&interval=yearly&currency=jpy', 'plus', 'yearly', 'jpy'],
    ['?plan=unknown&interval=unknown&currency=eur', 'team', 'monthly', 'usd'],
  ])(
    'parses valid query values and defaults unknown values for %s',
    async (search, plan, interval, currency) => {
      await seedAdmin(db, 'u-a', 'ws-a')
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
      const result = await loader({
        context: new RouterContextProvider(),
        request: new Request(`https://example.test/settings/billing${search}`),
      } as never)
      expect(result).toMatchObject({
        initialPlan: plan,
        initialInterval: interval,
        defaultCurrency: currency,
      })
    },
  )

  test.each([
    ['monthly-jpy', '?interval=monthly&currency=jpy'],
    ['monthly-usd', '?interval=monthly&currency=usd'],
    ['yearly-jpy', '?interval=yearly&currency=jpy'],
    ['yearly-usd', '?interval=yearly&currency=usd'],
  ])(
    'purchase %s loads its interval and currency from the query',
    async (id, query) => {
      await seedAdmin(db, 'u-a', 'ws-a')
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
      const result = await loader({
        context: new RouterContextProvider(),
        request: new Request(`https://example.test/settings/billing${query}`),
      } as never)
      const [interval, currency] = id.split('-')
      expect(result).toMatchObject({
        initialInterval: interval,
        defaultCurrency: currency,
      })
    },
  )

  test.each([
    ['?reason=project_limit', 'projectLimit'],
    ['?source=usage', 'usage'],
    ['?reason=unknown&source=unknown', 'default'],
  ])('maps entry context for %s', async (search, entryContext) => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request(`https://example.test/settings/billing${search}`),
    } as never)
    expect(result.entryContext).toBe(entryContext)
  })

  test('detects Plus storage overage without an explicit entry query', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await updateWorkspacePlan(db, 'ws-a', 'plus', 'active', 'sub_1')
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 10 * 1024 * 1024 * 1024 + 1 })
      .where('id', '=', 'ws-a')
      .execute()
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.entryContext).toBe('plusOverage')
  })

  test('prioritizes an explicit project-limit reason over Plus storage overage', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await updateWorkspacePlan(db, 'ws-a', 'plus', 'active', 'sub_1')
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 10 * 1024 * 1024 * 1024 + 1 })
      .where('id', '=', 'ws-a')
      .execute()
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request(
        'https://example.test/settings/billing?reason=project_limit',
      ),
    } as never)

    expect(result.entryContext).toBe('projectLimit')
  })

  test('admin loader is read-only and identifies the owner', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await db
      .updateTable('workspace_members')
      .set({ role: 'owner' })
      .where('workspace_id', '=', 'ws-a')
      .where('user_id', '=', 'u-a')
      .execute()
    await seedAdmin(db, 'u-c', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.canManage).toBe(false)
  })

  test('non-owner loader omits the contact when no workspace owner exists', async () => {
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: new RouterContextProvider(),
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.canManage).toBe(false)
  })
})

describe('billing context visibility', () => {
  test.each([
    [true, 'free', 'default', false, true],
    [true, 'free', 'default', true, false],
    [true, 'free', 'projectLimit', false, true],
    [true, 'plus', 'plusOverage', false, true],
    [true, 'plus', 'projectLimit', false, true],
    [true, 'plus', 'usage', false, true],
    [true, 'plus', 'default', false, false],
    [true, 'team', 'plusOverage', false, false],
    [false, 'free', 'default', false, false],
  ] as const)(
    'canManage=%s plan=%s context=%s awaitingCheckoutReflection=%s returns %s',
    (canManage, plan, entryContext, awaitingCheckoutReflection, expected) => {
      expect(
        shouldShowBillingContext({
          canManage,
          plan,
          entryContext,
          awaitingCheckoutReflection,
        }),
      ).toBe(expected)
    },
  )
})

describe('/settings/billing action', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
    createCheckoutSessionMock.mockReset()
  })

  afterEach(async () => {
    dbState.db = null
    await db.destroy()
  })

  test('non-admin checkout is rejected', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'checkout',
        plan: 'plus',
        interval: 'monthly',
      }),
      context: new RouterContextProvider(),
    } as never)

    expect(response).toMatchObject({
      data: { ok: false, intent: 'checkout', code: 'forbidden' },
      init: { status: 403 },
    })
  })

  test('admin checkout is rejected when an owner exists', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await db
      .updateTable('workspace_members')
      .set({ role: 'owner' })
      .where('workspace_id', '=', 'ws-a')
      .where('user_id', '=', 'u-a')
      .execute()
    await seedAdmin(db, 'u-c', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'checkout',
        plan: 'plus',
        interval: 'monthly',
      }),
      context: new RouterContextProvider(),
    } as never)

    expect(response).toMatchObject({
      data: { ok: false, intent: 'checkout', code: 'forbidden' },
      init: { status: 403 },
    })
  })

  test('checkout falls back to jpy for JP requests without currency', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    createCheckoutSessionMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://checkout.test',
    })

    const response = await action({
      request: postForm(
        {
          intent: 'checkout',
          plan: 'team',
          interval: 'monthly',
        },
        { country: 'JP' },
      ),
      context: new RouterContextProvider(),
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      'https://checkout.test',
    )
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ws-a' }),
      'team',
      'monthly',
      expect.any(String),
      'jpy',
      'en',
    )
  })

  test('checkout prefers form currency over cf country', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    createCheckoutSessionMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://checkout.test',
    })

    const response = await action({
      request: postForm(
        {
          intent: 'checkout',
          plan: 'plus',
          interval: 'monthly',
          currency: 'usd',
        },
        { country: 'JP' },
      ),
      context: new RouterContextProvider(),
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      'https://checkout.test',
    )
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ws-a' }),
      'plus',
      'monthly',
      expect.any(String),
      'usd',
      'en',
    )
  })

  test('checkout rejects invalid currency', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'checkout',
        plan: 'plus',
        interval: 'monthly',
        currency: 'eur',
      }),
      context: new RouterContextProvider(),
    } as never)

    expect(response).toMatchObject({
      data: { ok: false, intent: 'checkout', code: 'invalid' },
      init: { status: 400 },
    })
    expect(createCheckoutSessionMock).not.toHaveBeenCalled()
  })

  test('checkout passes usd for non-JP requests without currency', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    createCheckoutSessionMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://checkout.test',
    })

    const response = await action({
      request: postForm({
        intent: 'checkout',
        plan: 'plus',
        interval: 'yearly',
      }),
      context: new RouterContextProvider(),
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      'https://checkout.test',
    )
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ws-a' }),
      'plus',
      'yearly',
      expect.any(String),
      'usd',
      'en',
    )
  })

  test('checkout passes user locale en to createCheckoutSession', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a', 'en'))
    createCheckoutSessionMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://checkout.test',
    })

    await action({
      request: postForm({
        intent: 'checkout',
        plan: 'plus',
        interval: 'monthly',
      }),
      context: new RouterContextProvider(),
    } as never)

    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ws-a' }),
      'plus',
      'monthly',
      expect.any(String),
      'usd',
      'en',
    )
  })

  test('checkout passes cookie locale ja when user locale is null', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    createCheckoutSessionMock.mockResolvedValue({
      kind: 'ok',
      url: 'https://checkout.test',
    })

    await action({
      request: postForm(
        {
          intent: 'checkout',
          plan: 'plus',
          interval: 'monthly',
        },
        { cookie: '__as_locale=ja' },
      ),
      context: new RouterContextProvider(),
    } as never)

    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: 'ws-a' }),
      'plus',
      'monthly',
      expect.any(String),
      'usd',
      'ja',
    )
  })

  describe('with the real Stripe calls', () => {
    const stripeRequests: string[] = []

    function stubStripe(replies: Record<string, unknown>) {
      stripeRequests.length = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const line = `${request.method} ${new URL(request.url).pathname}`
          stripeRequests.push(line)
          return Response.json(replies[line] ?? {})
        }),
      )
    }

    beforeEach(async () => {
      const actual = await vi.importActual<
        typeof import('~/services/billing.server')
      >('~/services/billing.server')
      createCheckoutSessionMock.mockImplementation(actual.createCheckoutSession)
      await seedAdmin(db, 'u-a', 'ws-a')
      await db
        .updateTable('workspaces')
        .set({ stripe_customer_id: 'cus_1' })
        .where('id', '=', 'ws-a')
        .execute()
      requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    test('checkout for a customer who still has a billable subscription redirects to the billing portal', async () => {
      stubStripe({
        'GET /v1/checkout/sessions': { object: 'list', data: [] },
        'GET /v1/subscriptions': {
          object: 'list',
          data: [{ object: 'subscription', id: 'sub_1', status: 'past_due' }],
        },
        'POST /v1/billing_portal/sessions': {
          url: 'https://portal.test/session',
        },
      })

      const response = await action({
        request: postForm({
          intent: 'checkout',
          plan: 'plus',
          interval: 'monthly',
          currency: 'usd',
        }),
        context: new RouterContextProvider(),
      } as never)

      expect((response as Response).headers.get('Location')).toBe(
        'https://portal.test/session',
      )
      expect(stripeRequests).not.toContain('POST /v1/checkout/sessions')
    })

    test('the portal intent redirects to the billing portal', async () => {
      stubStripe({
        'POST /v1/billing_portal/sessions': {
          url: 'https://portal.test/session',
        },
      })

      const response = await action({
        request: postForm({ intent: 'portal' }),
        context: new RouterContextProvider(),
      } as never)

      expect((response as Response).headers.get('Location')).toBe(
        'https://portal.test/session',
      )
      expect(stripeRequests).toEqual(['POST /v1/billing_portal/sessions'])
    })
  })
})

async function seedBase(db: Kysely<DB>) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'ws-a',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        name: 'A',
        plan: 'free',
        stripe_subscription_status: 'none',
        created_at: now,
      },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      {
        id: 'u-a',
        email: 'a@example.com',
        email_verified: 1,
        name: 'User A',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws-a',
        locale: null,
      },
      {
        id: 'u-c',
        email: 'c@example.com',
        email_verified: 1,
        name: 'User C',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws-a',
        locale: null,
      },
    ])
    .execute()
  await db
    .insertInto('workspace_members')
    .values([
      {
        workspace_id: 'ws-a',
        user_id: 'u-a',
        role: 'member',
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      {
        workspace_id: 'ws-a',
        user_id: 'u-c',
        role: 'member',
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    ])
    .execute()
}

async function seedAdmin(db: Kysely<DB>, userId: string, workspaceId: string) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: userId === 'u-a' ? 'owner' : 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'user_id']).doUpdateSet({
        role: userId === 'u-a' ? 'owner' : 'admin',
        status: 'active',
        updated_at: now,
      }),
    )
    .execute()
}

async function seedContainer(
  db: Kysely<DB>,
  id: string,
  kind: 'inbox' | 'project',
  archivedAt: string | null,
) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('artifact_containers')
    .values({
      id,
      workspace_id: 'ws-a',
      kind,
      owner_user_id: kind === 'inbox' ? 'u-a' : null,
      created_by_id: 'u-a',
      name: id,
      description: null,
      archived_at: archivedAt,
      created_at: now,
      updated_at: now,
    })
    .execute()
}

async function updateWorkspacePlan(
  db: Kysely<DB>,
  workspaceId: string,
  plan: string,
  status: string,
  subscriptionId: string,
) {
  await db
    .updateTable('workspaces')
    .set({
      plan,
      storage_quota_bytes:
        plan === 'team'
          ? 100 * 1024 * 1024 * 1024
          : plan === 'plus'
            ? 10 * 1024 * 1024 * 1024
            : 100 * 1024 * 1024,
      stripe_subscription_status: status,
      stripe_subscription_id: subscriptionId,
      external_posting_enabled: plan === 'free' ? 0 : 1,
    })
    .where('id', '=', workspaceId)
    .execute()
}

function sessionUser(
  id: string,
  workspaceId: string,
  locale: string | null = null,
): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    workspaceId,
    hd: null,
    msTenantId: null,
    kind: 'human' as const,
    locale,
  }
}

function postForm(
  fields: Record<string, string>,
  options?: { country?: string; cookie?: string },
) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value)
  }
  const headers: Record<string, string> = {}
  if (options?.cookie) {
    headers.cookie = options.cookie
  }
  const request = new Request('https://example.test/settings/billing', {
    method: 'POST',
    body: form,
    headers,
  }) as Request<unknown, IncomingRequestCfProperties<unknown>>
  if (options?.country) {
    Object.defineProperty(request, 'cf', {
      value: { country: options.country },
    })
  }
  return request
}

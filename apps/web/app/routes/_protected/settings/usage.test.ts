import { describe, expect, test, vi } from 'vitest'

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

const workspaceRow = vi.hoisted(() => ({
  current: {
    id: 'ws1',
    plan: 'team',
    stripe_subscription_status: 'active',
    stripe_subscription_id: 'sub_1',
  } as Record<string, unknown>,
}))

vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'u1', workspaceId: 'ws1' }),
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirstOrThrow: () => Promise.resolve(workspaceRow.current),
        }),
      }),
    }),
  }),
}))

const projectionMock = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      projectedOverageGb: 3,
      projectedOverageUsd: 0.3,
      projectedOverageJpy: 48,
    }),
  ),
)
vi.mock('~/services/billing-usage.server', () => ({
  loadCurrentMonthOverageProjection: projectionMock,
}))

const contractMock = vi.hoisted(() => vi.fn())
const countContributorsMock = vi.hoisted(() => vi.fn(() => Promise.resolve(2)))
vi.mock('~/services/billing.server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/services/billing.server')>()
  return {
    ...actual,
    createStripeClient: () => ({}),
    loadSubscriptionContract: contractMock,
  }
})
vi.mock('~/services/team-management.server', () => ({
  countWorkspaceContributors: countContributorsMock,
}))

import { loader, shouldShowUsageWarning } from './usage'

describe('shouldShowUsageWarning', () => {
  test.each([
    [0.899, 1, false],
    [0.9, 1, true],
    [1, 1, true],
    [0, 0, false],
    [Number.NaN, 1, false],
    [1, Number.NaN, false],
    [Number.POSITIVE_INFINITY, 1, false],
    [1, Number.POSITIVE_INFINITY, false],
  ])('returns %s/%s => %s', (used, limit, expected) => {
    expect(shouldShowUsageWarning(used, limit)).toBe(expected)
  })
})

describe('/settings/usage loader', () => {
  test('shows the projected overage in the contract currency only', async () => {
    contractMock.mockResolvedValueOnce({
      plan: 'team',
      interval: 'monthly',
      currency: 'jpy',
      amount: 4500,
      renewsAt: null,
      cancelAtPeriodEnd: false,
    })

    const result = await loader({ context: {} } as never)

    expect(result.overageProjection).toEqual({
      gb: 3,
      currency: 'jpy',
      amount: 48,
    })
  })

  test('rounds usd amounts to cents', async () => {
    contractMock.mockResolvedValueOnce({
      plan: 'team',
      interval: 'monthly',
      currency: 'usd',
      amount: 29,
      renewsAt: null,
      cancelAtPeriodEnd: false,
    })

    const result = await loader({ context: {} } as never)

    expect(result.overageProjection).toEqual({
      gb: 3,
      currency: 'usd',
      amount: 0.3,
    })
  })

  test('omits the amount when the contract currency is unknown', async () => {
    contractMock.mockResolvedValueOnce(null)

    const result = await loader({ context: {} } as never)

    expect(result.overageProjection).toEqual({
      gb: 3,
      currency: null,
      amount: null,
    })
  })

  test('free plan skips projection and contributor count reflects team only', async () => {
    workspaceRow.current = {
      id: 'ws1',
      plan: 'free',
      stripe_subscription_status: 'none',
      stripe_subscription_id: null,
    }

    const result = await loader({ context: {} } as never)

    expect(result.showOverageProjection).toBe(false)
    expect(result.overageProjection).toBeNull()
    expect(result.contributorCount).toBeNull()
    workspaceRow.current = {
      id: 'ws1',
      plan: 'team',
      stripe_subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
    }
  })
})

import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
const externalPostingEnabledMock = vi.hoisted(() => vi.fn(() => true))
const loadSubscriptionContractMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(null)),
)

vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))

vi.mock('~/lib/project-external-posting.server', () => ({
  isExternalPostingEnabledForWorkspace: externalPostingEnabledMock,
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

import { action, loader, shouldShowBillingContext } from './billing'

describe('/settings/billing loader', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
    createCheckoutSessionMock.mockReset()
    externalPostingEnabledMock.mockClear()
  })

  afterEach(async () => {
    dbState.db = null
    await db.destroy()
  })

  test('admin loader returns manageable billing data', async () => {
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
    loadSubscriptionContractMock.mockResolvedValueOnce(contract as never)

    const result = await loader({
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(loadSubscriptionContractMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'sub_1',
    )
    expect(result).toEqual({
      contract,
      canManage: true,
      plan: 'plus',
      stripeSubscriptionStatus: 'active',
      hasSubscription: true,
      billingConfigured: true,
      defaultCurrency: 'usd',
      initialPlan: 'team',
      initialInterval: 'monthly',
      storageUsedBytes: 0,
      storageQuotaBytes: 10 * 1024 * 1024 * 1024,
      activeProjectCount: 0,
      projectLimit: 20,
      entryContext: 'default',
      externalPostingEnabled: true,
      monthlyEstimate: expect.objectContaining({ totalAmount: 5 }),
    })
  })

  test('loader returns jpy defaultCurrency for JP requests', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const request = new Request(
      'https://example.test/settings/billing',
    ) as Request<unknown, IncomingRequestCfProperties<unknown>>
    Object.defineProperty(request, 'cf', { value: { country: 'JP' } })

    const result = await loader({ context: {}, request } as never)

    expect(result.defaultCurrency).toBe('jpy')
  })

  test('free loader returns the free quotas and disabled external posting policy', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    externalPostingEnabledMock.mockResolvedValueOnce(false)

    const result = await loader({
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result).toMatchObject({
      plan: 'free',
      storageQuotaBytes: 100 * 1024 * 1024,
      projectLimit: 5,
      externalPostingEnabled: false,
    })
  })

  test('loader preserves a viewer workspace zero-byte storage quota', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_quota_bytes: 0 })
      .where('id', '=', 'ws-a')
      .execute()
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.storageQuotaBytes).toBe(0)
  })

  test('non-owner loader returns read-only billing data without owner contact', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await updateWorkspacePlan(db, 'ws-a', 'team', 'active', 'sub_1')
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result).toEqual({
      contract: null,
      canManage: false,
      plan: 'team',
      stripeSubscriptionStatus: 'active',
      hasSubscription: true,
      billingConfigured: true,
      defaultCurrency: 'usd',
      initialPlan: 'team',
      initialInterval: 'monthly',
      storageUsedBytes: 0,
      storageQuotaBytes: 100 * 1024 * 1024 * 1024,
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
      context: {},
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
        context: {},
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
    ['?reason=project_limit', 'projectLimit'],
    ['?source=usage', 'usage'],
    ['?reason=unknown&source=unknown', 'default'],
  ])('maps entry context for %s', async (search, entryContext) => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))
    const result = await loader({
      context: {},
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
      context: {},
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
      context: {},
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
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.canManage).toBe(false)
  })

  test('non-owner loader omits the contact when no workspace owner exists', async () => {
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const result = await loader({
      context: {},
      request: new Request('https://example.test/settings/billing'),
    } as never)

    expect(result.canManage).toBe(false)
  })
})

describe('billing context visibility', () => {
  test.each([
    [true, 'free', 'default', true],
    [true, 'free', 'projectLimit', true],
    [true, 'plus', 'plusOverage', true],
    [true, 'plus', 'projectLimit', true],
    [true, 'plus', 'usage', true],
    [true, 'plus', 'default', false],
    [true, 'team', 'plusOverage', false],
    [false, 'free', 'default', false],
  ] as const)(
    'canManage=%s plan=%s context=%s returns %s',
    (canManage, plan, entryContext, expected) => {
      expect(shouldShowBillingContext({ canManage, plan, entryContext })).toBe(
        expected,
      )
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
      context: {},
    } as never)

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(302)
    expect((response as Response).headers.get('Location')).toBe(
      '/settings/billing?status=forbidden',
    )
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
      context: {},
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      '/settings/billing?status=forbidden',
    )
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
      context: {},
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
      context: {},
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
      context: {},
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      '/settings/billing?status=invalid',
    )
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
      context: {},
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
      context: {},
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
      context: {},
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

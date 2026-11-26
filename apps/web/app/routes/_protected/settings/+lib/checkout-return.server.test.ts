import { RouterContextProvider } from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  role: 'owner' as string | null,
  configured: true,
  sync: vi.fn(),
  order: [] as string[],
}))

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', workspaceId: 'ws1' }),
}))
vi.mock('./settings-request.server', () => ({
  settingsActiveRole: async () => state.role,
}))
vi.mock('~/services/billing.server', () => ({
  createStripeClient: () => ({}),
  isBillingConfigured: () => state.configured,
}))
vi.mock('~/services/billing-sync.server', () => ({
  syncReturnedCheckout: (...args: unknown[]) => {
    state.order.push('sync')
    return state.sync(...args)
  },
}))

const { checkoutReturnMiddleware } = await import('./checkout-return.server')

async function run(search: string, method = 'GET') {
  const url = new URL(`https://app.test/settings/billing${search}`)
  const next = vi.fn(async () => {
    state.order.push('loaders')
    return new Response('page')
  })
  await checkoutReturnMiddleware(
    {
      url,
      request: new Request(url, { method }),
      context: new RouterContextProvider(),
      params: {},
      pattern: '/settings/billing',
    },
    next,
  )
  return next
}

beforeEach(() => {
  state.role = 'owner'
  state.configured = true
  state.sync.mockReset().mockResolvedValue({ kind: 'ok' })
  state.order = []
})

test('the owner returning from Checkout syncs that Checkout before the loaders run', async () => {
  const next = await run('?status=checkout-success&session_id=cs_test_1')
  expect(state.sync).toHaveBeenCalledWith({}, {}, {}, 'ws1', 'cs_test_1')
  expect(next).toHaveBeenCalledOnce()
  expect(state.order).toEqual(['sync', 'loaders'])
})

test.each([
  [
    'an admin who is not the owner',
    '?status=checkout-success&session_id=cs_test_1',
    () => (state.role = 'admin'),
  ],
  ['a return without a session', '?status=checkout-success', () => {}],
  [
    'a cancelled Checkout',
    '?status=checkout-cancelled&session_id=cs_test_1',
    () => {},
  ],
  [
    'billing that is not configured',
    '?status=checkout-success&session_id=cs_test_1',
    () => (state.configured = false),
  ],
])('%s does not sync', async (_, search, arrange) => {
  arrange()
  const next = await run(search)
  expect(state.sync).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledOnce()
})

test('a failed sync still shows the page, which keeps its pending notice', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  state.sync.mockRejectedValueOnce(new Error('stripe down'))
  const next = await run('?status=checkout-success&session_id=cs_test_1')
  expect(next).toHaveBeenCalledOnce()
})

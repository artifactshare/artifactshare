import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
  UNSAFE_withComponentProps,
} from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
  listCliRefreshCredentialFamilies: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'current-user' }),
}))
vi.mock('~/services/api-tokens.server', () => ({
  createApiToken: services.createApiToken,
  listApiTokens: services.listApiTokens,
  revokeApiToken: services.revokeApiToken,
}))

vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: services.listCliRefreshCredentialFamilies,
}))
import TokensRoute, { action, loader } from './tokens'

function request(values: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return new Request('https://example.test/settings/tokens', {
    method: 'POST',
    body: form,
  })
}

describe('/settings/tokens actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('revokes one API token for the current user', async () => {
    await action({
      request: request({ intent: 'revoke', tokenId: 'token-a' }),
      context: new RouterContextProvider(),
      params: {},
      url: new URL('https://example.test/settings/tokens'),
      pattern: '/settings/tokens',
    })

    expect(services.revokeApiToken).toHaveBeenCalledWith(
      {},
      'current-user',
      'token-a',
    )
  })

  test('does not dispatch a revoke without a token id', async () => {
    await action({
      request: request({ intent: 'revoke' }),
      context: new RouterContextProvider(),
      params: {},
      url: new URL('https://example.test/settings/tokens'),
      pattern: '/settings/tokens',
    })

    expect(services.revokeApiToken).not.toHaveBeenCalled()
  })
})

test('loads both current-user metadata lists without stored credentials', async () => {
  const tokens = [
    {
      id: 'token-a',
      name: 'Automation',
      createdAt: '2026-01-01',
      lastUsedAt: null,
    },
  ]
  const cliFamilies = [
    {
      familyId: 'family-a',
      deviceName: null,
      publisherClientName: null,
      preset: 'unrestricted',
      createdAt: '2026-01-01',
      lastUsedAt: null,
      expiresAt: '2099-01-01',
    },
  ]
  services.listApiTokens.mockResolvedValue(tokens)
  services.listCliRefreshCredentialFamilies.mockResolvedValue(cliFamilies)
  const result = await loader({
    context: new RouterContextProvider(),
    params: {},
    url: new URL('https://example.test/settings/tokens'),
    pattern: '/settings/tokens',
    request: new Request('https://example.test/settings/tokens'),
  })
  expect(JSON.stringify(result)).toBe(
    JSON.stringify({ tokens, createdToken: null, cliFamilies }),
  )
  expect(services.listApiTokens).toHaveBeenCalledWith({}, 'current-user')
  expect(services.listCliRefreshCredentialFamilies).toHaveBeenCalledWith(
    {},
    'current-user',
  )
  expect(JSON.stringify(result)).not.toMatch(
    /token_hash|rotation_request_hash|secret/,
  )
})
test('validates token names and returns a new one-time secret only on create', async () => {
  services.createApiToken.mockClear()
  for (const [name, kind] of [
    ['', 'name-required'],
    ['x'.repeat(101), 'name-too-long'],
  ])
    expect(
      await action({
        context: new RouterContextProvider(),
        params: {},
        url: new URL('https://example.test/settings/tokens'),
        pattern: '/settings/tokens',
        request: request({ intent: 'create', name }),
      }),
    ).toEqual({ kind })
  expect(services.createApiToken).not.toHaveBeenCalled()
  services.createApiToken.mockResolvedValue({
    name: 'Automation',
    token: 'as_test_one_time',
  })
  expect(
    await action({
      context: new RouterContextProvider(),
      params: {},
      url: new URL('https://example.test/settings/tokens'),
      pattern: '/settings/tokens',
      request: request({ intent: 'create', name: ' Automation ' }),
    }),
  ).toEqual({ kind: 'created', name: 'Automation', token: 'as_test_one_time' })
  expect(services.createApiToken).toHaveBeenCalledWith(
    {},
    'current-user',
    'Automation',
  )
})

// Unit imports do not run the framework's route-export transform. Guard its
// default-declaration boundary as well as rendering with router-owned data.
test('renders the tokens route with router-owned loader data', () => {
  const source = readFileSync(new URL('./tokens.tsx', import.meta.url), 'utf8')
  expect(source).toMatch(/export default function /)
  const router = createMemoryRouter(
    [
      {
        id: 'tokens',
        path: '/settings/tokens',
        Component: UNSAFE_withComponentProps(TokensRoute),
      },
    ],
    {
      initialEntries: ['/settings/tokens'],
      hydrationData: {
        loaderData: {
          tokens: {
            tokens: [
              {
                id: 'token-route',
                name: 'Route automation',
                createdAt: '2026-01-01',
                lastUsedAt: null,
              },
            ],
            cliFamilies: [],
            createdToken: null,
          },
        },
      },
    },
  )
  try {
    const html = renderToStaticMarkup(<RouterProvider router={router} />)
    expect(html).toContain('Route automation')
    expect(html).toContain('CLI sessions signed in')
    expect(html).toContain('API tokens')
  } finally {
    router.dispose()
  }
})

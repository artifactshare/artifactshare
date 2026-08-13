import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
  listCliRefreshCredentialFamilies: vi.fn(),
  revokeAllCliRefreshCredentialFamilies: vi.fn(),
  revokeCliRefreshCredentialFamily: vi.fn(),
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
  revokeAllCliRefreshCredentialFamilies:
    services.revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily: services.revokeCliRefreshCredentialFamily,
}))

import { action } from './tokens'

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

  test('revokes one family for the current user', async () => {
    await action({
      request: request({ intent: 'revoke-cli-family', familyId: 'family-a' }),
      context: new Map(),
    } as never)

    expect(services.revokeCliRefreshCredentialFamily).toHaveBeenCalledWith(
      {},
      'current-user',
      'family-a',
    )
  })

  test('does not dispatch a family revoke without a family id', async () => {
    await action({
      request: request({ intent: 'revoke-cli-family' }),
      context: new Map(),
    } as never)

    expect(services.revokeCliRefreshCredentialFamily).not.toHaveBeenCalled()
  })

  test('revokes all families for the current user', async () => {
    await action({
      request: request({ intent: 'revoke-all-cli-families' }),
      context: new Map(),
    } as never)

    expect(services.revokeAllCliRefreshCredentialFamilies).toHaveBeenCalledWith(
      {},
      'current-user',
    )
  })
})

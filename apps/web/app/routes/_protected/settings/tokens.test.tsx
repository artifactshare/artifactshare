import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
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

  test('revokes one API token for the current user', async () => {
    await action({
      request: request({ intent: 'revoke', tokenId: 'token-a' }),
      context: new Map(),
    } as never)

    expect(services.revokeApiToken).toHaveBeenCalledWith(
      {},
      'current-user',
      'token-a',
    )
  })

  test('does not dispatch a revoke without a token id', async () => {
    await action({
      request: request({ intent: 'revoke' }),
      context: new Map(),
    } as never)

    expect(services.revokeApiToken).not.toHaveBeenCalled()
  })
})

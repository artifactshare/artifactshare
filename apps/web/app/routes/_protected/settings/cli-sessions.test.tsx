import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const services = vi.hoisted(() => ({
  revokeAllCliRefreshCredentialFamilies: vi.fn(),
  revokeCliRefreshCredentialFamily: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'current-user' }),
}))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  listCliRefreshCredentialFamilies: vi.fn(),
  revokeAllCliRefreshCredentialFamilies:
    services.revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily: services.revokeCliRefreshCredentialFamily,
}))

import { action } from './cli-sessions'

function request(values: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(values)) form.set(key, value)
  return new Request('https://example.test/settings/cli-sessions', {
    method: 'POST',
    body: form,
  })
}

describe('/settings/cli-sessions actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('revokes one family for the current user', async () => {
    services.revokeCliRefreshCredentialFamily.mockResolvedValue('ok')
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

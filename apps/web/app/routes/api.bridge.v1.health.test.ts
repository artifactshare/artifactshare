import { beforeEach, describe, expect, test, vi } from 'vitest'

const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const readLiveBridgeAuthorityMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireBridgeBearerMiddleware: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: getCliAuthorityMock,
}))
vi.mock('~/services/db.server', () => ({ createDb: createDbMock }))
vi.mock('~/services/bridge-authorities.server', () => ({
  readLiveBridgeAuthority: readLiveBridgeAuthorityMock,
}))

import { loader } from './api.bridge.v1.health'

beforeEach(() => {
  getCliAuthorityMock.mockReset().mockReturnValue({
    kind: 'bridge',
    bridgeAuthorityId: 'bridge-1',
  })
  createDbMock.mockReset().mockReturnValue({})
  readLiveBridgeAuthorityMock.mockReset().mockResolvedValue({ kind: 'ok' })
})

describe('/api/bridge/v1/health', () => {
  test('reports the narrow bridge operation surface', async () => {
    const response = await loader({ context: new Map() } as never)
    await expect(response.json()).resolves.toEqual({
      schema_version: 1,
      ok: true,
      data: {
        authority: 'available',
        operations: ['publish', 'append', 'update', 'set_visibility'],
      },
    })
  })

  test('fails closed when the fallback is no longer valid', async () => {
    readLiveBridgeAuthorityMock.mockResolvedValue({ kind: 'fallback-invalid' })
    const response = await loader({ context: new Map() } as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'fallback-invalid' },
    })
  })
})

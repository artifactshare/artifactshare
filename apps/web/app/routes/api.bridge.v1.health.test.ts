import * as authorityPolicy from '~/lib/cli-authority-policy'
import type { CliAuthority } from '~/services/cli-authority.server'
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

// The compiler regression covers this shared guard; keep both routes using it.
const bridgeGuardSpy = vi.spyOn(authorityPolicy, 'bridgeCliAuthority')

beforeEach(() => {
  bridgeGuardSpy.mockClear()
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

  test('returns a retryable bridge error for unexpected health failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    readLiveBridgeAuthorityMock.mockRejectedValue(new Error('D1 unavailable'))

    const response = await loader({ context: new Map() } as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: {
        code: 'internal-error',
        retryable: true,
        retry_after_ms: 1_000,
      },
    })
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

test.each([null, 'unrestricted', 'bootstrap', 'agent', 'unknown'])(
  'rejects %s before bridge execution',
  async (kind) => {
    getCliAuthorityMock.mockReturnValue(
      kind === null ? null : ({ kind } as unknown as CliAuthority),
    )
    const request = new Request('https://example.test/api/bridge/v1/health')
    const response = await loader({ context: new Map(), request } as never)
    expect(bridgeGuardSpy).toHaveBeenCalledWith(kind === null ? null : { kind })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'unsupported-authority',
        message: 'This credential is not a bridge authority.',
      },
    })
    expect(readLiveBridgeAuthorityMock).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  },
)

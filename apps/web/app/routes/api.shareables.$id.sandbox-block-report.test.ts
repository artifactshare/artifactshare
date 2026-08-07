import { beforeEach, describe, expect, test, vi } from 'vitest'
import { action } from './api.shareables.$id.sandbox-block-report'

const executeTakeFirst = vi.hoisted(() => vi.fn())
vi.mock('~/services/db.server', () => ({
  createDb: () => {
    const chain: Record<string, unknown> = { executeTakeFirst }
    for (const method of ['selectFrom', 'select', 'where'])
      chain[method] = vi.fn(() => chain)
    return chain
  },
}))

const valid = {
  artifactId: 'abc123def4',
  failureType: 'forbidden',
  confirmedAt: '2026-07-04T00:00:00.000Z',
}

function request(
  method: string,
  body: unknown,
  artifactId = valid.artifactId,
): Request {
  return new Request(
    `https://artifactshare.com/api/shareables/${artifactId}/sandbox-block-report`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        Origin: 'https://artifactshare.com',
        'Sec-Fetch-Site': 'same-origin',
      },
      body:
        method === 'GET'
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    },
  )
}

describe('sandbox block report route', () => {
  beforeEach(() => {
    executeTakeFirst.mockReset()
    executeTakeFirst.mockResolvedValue({ id: valid.artifactId })
  })

  test.each(['forbidden', 'network-error', 'timeout'])(
    'accepts %s',
    async (failureType) => {
      const response = await action({
        request: request('POST', { ...valid, failureType }),
        params: { id: valid.artifactId },
        context: {} as never,
      } as never)
      expect(response.status).toBe(200)
    },
  )

  test.each(['GET', 'PUT', 'PATCH', 'DELETE'])('rejects %s', async (method) => {
    const response = await action({
      request: request(method, valid),
      params: { id: valid.artifactId },
      context: {},
    } as never)
    expect(response.status).toBe(405)
  })

  test.each([
    ['{', 'malformed JSON'],
    [[], 'array'],
    [null, 'null'],
    [{ ...valid, extra: true }, 'extra key'],
    [
      { artifactId: valid.artifactId, failureType: valid.failureType },
      'missing key',
    ],
    [{ ...valid, artifactId: 'other12345' }, 'param mismatch'],
    [{ ...valid, artifactId: 'ABC123DEF4' }, 'invalid artifact id'],
    [{ ...valid, failureType: 'other' }, 'invalid failure'],
    [{ ...valid, confirmedAt: '2026-02-30T00:00:00.000Z' }, 'normalized date'],
    [{ ...valid, confirmedAt: '2026-07-04T00:00:00Z' }, 'non milliseconds'],
    [{ ...valid, confirmedAt: '2026-07-04T09:00:00.000+09:00' }, 'non UTC'],
    [{ ...valid, confirmedAt: '2026-07-04T25:00:00.000Z' }, 'impossible time'],
  ])('rejects %s', async (body, _label) => {
    const response = await action({
      request: request('POST', body),
      params: { id: valid.artifactId },
      context: {},
    } as never)
    expect(response.status).toBe(400)
  })

  test('rejects cross-origin reports before querying the artifact', async () => {
    const crossOrigin = new Request(
      'https://artifactshare.com/api/shareables/abc123def4/sandbox-block-report',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify(valid),
      },
    )
    const response = await action({
      request: crossOrigin,
      params: { id: valid.artifactId },
      context: {},
    } as never)
    expect(response.status).toBe(403)
    expect(executeTakeFirst).not.toHaveBeenCalled()
  })

  test('accepts but does not log reports for unknown artifacts', async () => {
    executeTakeFirst.mockResolvedValue(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await action({
      request: request('POST', valid),
      params: { id: valid.artifactId },
      context: {},
    } as never)
    expect(response.status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('suppresses duplicate reports during the cooldown', async () => {
    const payload = { ...valid, artifactId: 'cool123abc' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const args = {
      params: { id: payload.artifactId },
      context: {},
    }
    await action({
      ...args,
      request: request('POST', payload, payload.artifactId),
    } as never)
    await action({
      ...args,
      request: request('POST', payload, payload.artifactId),
    } as never)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test('logs only the three marker fields', async () => {
    const payload = { ...valid, artifactId: 'xyz987uvw6' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await action({
      request: request('POST', payload, payload.artifactId),
      params: { id: payload.artifactId },
      context: {},
    } as never)
    expect(warn).toHaveBeenCalledWith(
      'artifactshare_sandbox_block_report',
      payload,
    )
    warn.mockRestore()
  })
})

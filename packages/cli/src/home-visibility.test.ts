import assert from 'node:assert/strict'
import { expect, test } from 'vitest'
import { resolveAccountHomeVisibility } from './home-visibility.js'
import { withServer } from './test/helpers.js'

type Seen = { method: string; path: string; authorization: string }

async function withWhoami<T>(
  respond: (seen: Seen) => { status: number; body: unknown },
  callback: (
    resolve: (
      resolution: Parameters<typeof resolveAccountHomeVisibility>[0],
    ) => ReturnType<typeof resolveAccountHomeVisibility>,
    requests: Seen[],
  ) => Promise<T>,
): Promise<T> {
  const requests: Seen[] = []
  return await withServer(
    (request, response) => {
      const seen: Seen = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization ?? '',
      }
      requests.push(seen)
      const { status, body } = respond(seen)
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body))
    },
    async (baseUrl) =>
      await callback(
        (resolution) =>
          resolveAccountHomeVisibility(
            resolution,
            'test-token',
            { baseUrl },
            {},
            { credentialSource: 'token_option' },
          ),
        requests,
      ),
  )
}

test.each([false, true, undefined, null, 'false'])(
  'only an explicit false capability selects private (%s)',
  async (capability) => {
    await withWhoami(
      () => ({
        status: 200,
        body: {
          workspace: { hosted_domain: null, visibility_available: capability },
        },
      }),
      async (resolve, requests) => {
        const result = await resolve({
          value: 'workspace',
          source: 'product_default',
        })
        expect(result).toEqual({
          value: capability === false ? 'private' : 'workspace',
          source: 'product_default',
          privateDefault: capability === false,
        })
        assert.deepEqual(requests, [
          {
            method: 'GET',
            path: '/api/cli/whoami',
            authorization: 'Bearer test-token',
          },
        ])
      },
    )
  },
)

test.each(['explicit', 'repository', 'user'] as const)(
  'preserves %s audiences without a request',
  async (source) => {
    await withWhoami(
      () => ({ status: 200, body: {} }),
      async (resolve, requests) => {
        expect(await resolve({ value: 'workspace', source })).toEqual({
          value: 'workspace',
          source,
          privateDefault: false,
        })
        assert.deepEqual(requests, [])
      },
    )
  },
)

test('keeps the workspace product default when the capability check fails', async () => {
  await withWhoami(
    () => ({ status: 500, body: { error: { code: 'service-error' } } }),
    async (resolve, requests) => {
      expect(
        await resolve({ value: 'workspace', source: 'product_default' }),
      ).toEqual({
        value: 'workspace',
        source: 'product_default',
        privateDefault: false,
      })
      assert.equal(requests.length, 1)
    },
  )
})

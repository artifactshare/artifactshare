import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('delete --help explains destructive artifact deletion', () => {
  const result = run(['delete', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /delete abc123def4/)
  assert.match(result.stdout, /cannot be undone/)
  assert.match(result.stdout, /target_not_found/)
})

test('delete --json fails with auth_required before network checks', () => {
  const result = run(['delete', 'abc123def4', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'delete', code: 'auth_required' })
})

test('delete rejects ambiguous target input before auth checks', () => {
  const result = run(['delete', 'Weekly report', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  const payload = expectFailure(result, {
    command: 'delete',
    code: 'target_not_found',
  })
  assert.match(payload.error.why, /Delete only accepts/)
  assert.match(payload.error.hint, /resolve/)
})

test('delete rejects a missing target before auth checks', () => {
  const result = run(['delete', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  const payload = expectFailure(result, {
    command: 'delete',
    code: 'validation_failed',
  })
  assert.match(payload.error.hint, /artifact-id-or-url/)
})

test('delete --json deletes by share URL', async () => {
  const requests: Array<{
    method: string | undefined
    url: string | undefined
    authorization: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'abc123def4', deleted: true }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'delete',
          'https://artifactshare.com/a/abc123def4',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'delete')
      assert.deepEqual(payload.data, { id: 'abc123def4', deleted: true })
    },
  )

  assert.deepEqual(requests, [
    {
      method: 'DELETE',
      url: '/api/cli/artifacts/abc123def4',
      authorization: 'Bearer test-token',
    },
  ])
})

test('delete --json maps not-found responses to target_not_found', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'not-found',
            message: 'Artifact not found.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'delete',
        code: 'target_not_found',
      })
    },
  )
})

test('delete --json maps invalid bearer tokens to token_invalid', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'unauthorized' } }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'bad-token' },
      )

      expectFailure(result, {
        command: 'delete',
        code: 'token_invalid',
      })
    },
  )
})

test('delete --json maps delete failures to service_error', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 502
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'delete-failed',
            message: 'Could not delete the artifact.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'delete',
        code: 'service_error',
      })
    },
  )
})

test('delete --json maps maintenance responses to retryable maintenance error', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 503
      response.setHeader('content-type', 'application/json')
      response.setHeader('retry-after', '300')
      response.end(
        JSON.stringify({
          error: {
            code: 'maintenance',
            message: 'Artifact Share is currently under maintenance.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'delete',
        code: 'maintenance',
      })
      assert.equal(payload.error.agent_recoverable, true)
      assert.equal(payload.error.requires_human, false)
      assert.deepEqual(payload.error.recovery, { kind: 'retry_later' })
      assert.match(payload.error.hint, /Retry/)
    },
  )
})

test('delete --json maps network failures', async () => {
  const result = await runAsync(
    ['delete', 'abc123def4', '--base-url', 'http://127.0.0.1:9', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, {
    command: 'delete',
    code: 'network_failed',
  })
})

test('delete --json rejects malformed success responses', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'abc123def4' }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'delete',
        code: 'service_error',
      })
      assert.match(payload.error.message, /deletion metadata/)
    },
  )
})

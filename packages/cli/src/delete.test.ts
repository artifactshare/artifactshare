import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

describe.each([['delete'], ['artifacts', 'delete']])(
  '%s deletion',
  (...command) => {
    test('delete --help explains destructive artifact deletion', () => {
      const result = run([...command, '--help'])

      assert.equal(result.status, 0)
      assert.match(result.stdout, /delete abc123def4/)
      assert.match(result.stdout, /cannot be undone/)
      assert.match(result.stdout, /target_not_found/)
      for (const option of [
        'artifactIdOrUrl',
        '--json',
        '--base-url',
        '--token',
        '--profile',
        '--insecure-localhost',
        '--allow-plaintext-token-store',
      ]) {
        assert.ok(result.stdout.includes(option), option)
      }
    })

    test('delete --json fails with auth_required before network checks', () => {
      const result = run([...command, 'abc123def4', '--json'], {
        ARTIFACTSHARE_TOKEN: '',
      })

      expectFailure(result, { command: 'delete', code: 'auth_required' })
    })

    test('delete rejects ambiguous target input before auth checks', () => {
      const result = run([...command, 'Weekly report', '--json'], {
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
      const result = run([...command, '--json'], {
        ARTIFACTSHARE_TOKEN: '',
      })

      const payload = expectFailure(result, {
        command: 'delete',
        code: 'validation_failed',
      })
      assert.match(payload.error.hint, /artifact-id-or-url/)
    })

    test.each([
      'abc123def4',
      'https://artifactshare.com/a/abc123def4',
      'https://abc123def4.artifactshare.link/',
      'https://abc123def4--v-7631.artifactshare.link/index.html',
      'https://abc123def4.sandbox.artifactshare.com/index.html?t=token',
    ])('delete --json deletes target %s', async (target) => {
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
            [...command, target, '--base-url', baseUrl, '--json'],
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
            [...command, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...command, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...command, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...command, 'abc123def4', '--base-url', baseUrl, '--json'],
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
        [
          ...command,
          'abc123def4',
          '--base-url',
          'http://127.0.0.1:9',
          '--json',
        ],
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
            [...command, 'abc123def4', '--base-url', baseUrl, '--json'],
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
  },
)

for (const options of [['--base-url'], ['--json=true'], ['--unknown-option']]) {
  for (const json of [false, true]) {
    test(`delete alias matches validation for ${options.join(' ')} (json=${json})`, () => {
      const args = ['abc123def4', ...(json ? ['--json'] : []), ...options]
      const env = { ARTIFACTSHARE_TOKEN: '' }
      const primary = run(['delete', ...args], env)
      const alias = run(['artifacts', 'delete', ...args], env)
      assert.equal(alias.status, 1)
      assert.equal(alias.status, primary.status)
      assert.equal(alias.stdout, primary.stdout)
      assert.equal(alias.stderr, primary.stderr)
      if (json)
        expectFailure(alias, {
          command: 'delete',
          // Unknown options are ignored by the existing delete command.
          code:
            options[0] === '--unknown-option'
              ? 'auth_required'
              : 'validation_failed',
        })
    })
  }
}

for (const status of [200, 404, 401, 502, 503]) {
  for (const json of [false, true]) {
    test(`delete alias matches response ${status} (json=${json})`, async () => {
      await withServer(
        (_request, response) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(
            JSON.stringify(
              status === 200
                ? { id: 'abc123def4', deleted: true }
                : {
                    error: {
                      code: status === 503 ? 'maintenance' : 'not-found',
                      message: 'Deletion failed.',
                    },
                  },
            ),
          )
        },
        async (baseUrl) => {
          const args = [
            'abc123def4',
            '--base-url',
            baseUrl,
            ...(json ? ['--json'] : []),
          ]
          const env = { ARTIFACTSHARE_TOKEN: 'test-token' }
          const primary = await runAsync(['delete', ...args], env)
          const alias = await runAsync(['artifacts', 'delete', ...args], env)
          assert.equal(alias.status, status === 200 ? 0 : 1)
          assert.deepEqual(alias, primary)
          if (json) {
            assert.equal(
              JSON.parse(status === 200 ? alias.stdout : alias.stderr).command,
              'delete',
            )
          } else if (status === 200) {
            assert.notEqual(alias.stdout.trim(), '')
            assert.equal(alias.stderr, '')
          } else {
            assert.equal(alias.stdout, '')
            assert.notEqual(alias.stderr.trim(), '')
          }
        },
      )
    })
  }
}

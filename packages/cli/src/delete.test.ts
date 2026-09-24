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
  'deletion via %s',
  (...invocation) => {
    test('delete --help explains destructive artifact deletion', () => {
      const result = run([...invocation, '--help'])

      assert.equal(result.status, 0)
      assert.match(result.stdout, /delete abc123def4/)
      assert.match(result.stdout, /cannot be undone/)
      assert.match(result.stdout, /target_not_found/)
      assert.match(result.stdout, /artifact-id-or-url|artifactIdOrUrl/)
      assert.match(result.stdout, /--token/)
      assert.match(result.stdout, /--profile/)
      assert.match(result.stdout, /Use resolve first/)
    })

    test('delete --json fails with auth_required before network checks', () => {
      const result = run([...invocation, 'abc123def4', '--json'], {
        ARTIFACTSHARE_TOKEN: '',
      })

      expectFailure(result, { command: 'delete', code: 'auth_required' })
    })

    test('delete rejects ambiguous target input before auth checks', () => {
      const result = run([...invocation, 'Weekly report', '--json'], {
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
      const result = run([...invocation, '--json'], {
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
              ...invocation,
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
            [...invocation, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...invocation, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...invocation, 'abc123def4', '--base-url', baseUrl, '--json'],
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
            [...invocation, 'abc123def4', '--base-url', baseUrl, '--json'],
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
          ...invocation,
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
            [...invocation, 'abc123def4', '--base-url', baseUrl, '--json'],
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

test('deletion invalid options have identical canonical envelopes', () => {
  for (const options of [
    ['--base-url'],
    ['--base-url='],
    ['--base-url', ''],
    ['--json=true'],
    ['--unknown-option'],
  ]) {
    const primary = run(['delete', 'abc123def4', '--json', ...options])
    const alias = run([
      'artifacts',
      'delete',
      'abc123def4',
      '--json',
      ...options,
    ])
    expectFailure(alias, {
      command: 'delete',
      code:
        options[0] === '--unknown-option'
          ? 'auth_required'
          : 'validation_failed',
    })
    assert.equal(alias.status, primary.status)
    assert.equal(alias.stdout, primary.stdout)
    assert.equal(alias.stderr, primary.stderr)
  }
})

test('both deletion paths resolve every supported target form', async () => {
  let expectedId = 'abc123def4'
  await withServer(
    (request, response) => {
      assert.equal(request.method, 'DELETE')
      assert.equal(request.url, `/api/cli/artifacts/${expectedId}`)
      assert.equal(request.headers.authorization, 'Bearer test-token')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: expectedId, deleted: true }))
    },
    async (baseUrl) => {
      for (const target of [
        'abc123def4',
        'https://artifactshare.com/a/abc123def4',
        'https://artifactshare.com/a/html123abc.data/',
        'https://abc123def4.artifactshare.link/',
        'https://abc123def4--v-ab12.artifactshare.link/index.html',
        'https://abc123def4.sandbox.artifactshare.com/index.html',
        'https://abc123def4--v-ab12.sandbox.artifactshare.com/index.html',
      ]) {
        expectedId =
          target === 'https://artifactshare.com/a/html123abc.data/'
            ? 'html123abc'
            : 'abc123def4'
        for (const command of [['delete'], ['artifacts', 'delete']]) {
          const result = await runAsync(
            [...command, target, '--base-url', baseUrl, '--json'],
            { ARTIFACTSHARE_TOKEN: 'test-token' },
          )
          assert.deepEqual(expectSuccess(result, 'delete').data, {
            id: expectedId,
            deleted: true,
          })
          assert.equal(result.stderr, '')
        }
      }
      for (const options of [
        ['--base-url', baseUrl, '--token', 'test-token'],
        [`--base-url=${baseUrl}`, '--token=test-token'],
      ]) {
        for (const command of [
          [...options, 'artifacts', 'delete'],
          ['artifacts', ...options, 'delete'],
        ]) {
          const result = await runAsync([...command, 'abc123def4', '--json'], {
            ARTIFACTSHARE_TOKEN: '',
          })
          assert.deepEqual(expectSuccess(result, 'delete').data, {
            id: 'abc123def4',
            deleted: true,
          })
          assert.equal(result.stderr, '')
        }
      }
    },
  )
})

test('human output matches for both deletion paths', async () => {
  // Explicitly emulate stdout TTY: piped subprocess output otherwise selects JSON.
  const env = {
    ARTIFACTSHARE_TOKEN: 'test-token',
    NODE_OPTIONS: '--import=data:text/javascript,process.stdout.isTTY=true',
  }
  for (const status of [200, 404]) {
    await withServer(
      (_request, response) => {
        response.statusCode = status
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            status === 200
              ? { id: 'abc123def4', deleted: true }
              : {
                  error: { code: 'not-found', message: 'Artifact not found.' },
                },
          ),
        )
      },
      async (baseUrl) => {
        const primary = await runAsync(
          ['delete', 'abc123def4', '--base-url', baseUrl],
          env,
        )
        const alias = await runAsync(
          ['artifacts', 'delete', 'abc123def4', '--base-url', baseUrl],
          env,
        )
        assert.deepEqual(alias, primary)
        assert.equal(alias.status, status === 200 ? 0 : 1)
        assert.ok((status === 200 ? alias.stdout : alias.stderr).length > 0)
        assert.equal(status === 200 ? alias.stderr : alias.stdout, '')
        assert.doesNotMatch(alias.stdout + alias.stderr, /schema_version/)
      },
    )
  }
})

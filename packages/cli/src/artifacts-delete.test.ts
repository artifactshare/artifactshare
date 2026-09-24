import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('artifacts --help lists delete with the other artifact commands', () => {
  const result = run(['artifacts', '--help'])

  assert.equal(result.status, 0)
  assert.match(
    result.stdout,
    /^  delete <OPTIONS> +Permanently delete an artifact you shared\.$/m,
  )
  assert.match(result.stdout, /^  get <OPTIONS> +Read a single-file artifact/m)
  assert.match(result.stdout, /^  list <OPTIONS> +List artifacts you shared/m)
})

test('artifacts delete --json has the same auth and target errors as delete', () => {
  const cases = [
    { target: 'abc123def4', code: 'auth_required' },
    { target: 'Weekly report', code: 'target_not_found' },
  ] as const

  for (const { target, code } of cases) {
    const primary = run(['delete', target, '--json'], {
      ARTIFACTSHARE_TOKEN: '',
    })
    const alias = run(['artifacts', 'delete', target, '--json'], {
      ARTIFACTSHARE_TOKEN: '',
    })

    const primaryPayload = expectFailure(primary, {
      command: 'delete',
      code,
    })
    const aliasPayload = expectFailure(alias, {
      command: 'delete',
      code,
    })
    assert.deepEqual(aliasPayload, primaryPayload)
  }
})

test('artifacts delete pre-dispatch validation matches delete JSON', () => {
  const primary = run(['delete', 'abc123def4', '--base-url=', '--json'])
  const alias = run([
    'artifacts',
    'delete',
    'abc123def4',
    '--base-url=',
    '--json',
  ])

  const primaryPayload = expectFailure(primary, {
    command: 'delete',
    code: 'validation_failed',
  })
  const aliasPayload = expectFailure(alias, {
    command: 'delete',
    code: 'validation_failed',
  })
  assert.deepEqual(aliasPayload, primaryPayload)
})

test('artifacts delete --json sends the same request and returns the same JSON as delete', async () => {
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
      const env = { ARTIFACTSHARE_TOKEN: 'test-token' }
      const primary = await runAsync(
        ['delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        env,
      )
      const alias = await runAsync(
        ['artifacts', 'delete', 'abc123def4', '--base-url', baseUrl, '--json'],
        env,
      )

      const primaryPayload = expectSuccess(primary, 'delete')
      const aliasPayload = expectSuccess(alias, 'delete')
      assert.deepEqual(aliasPayload, primaryPayload)
    },
  )

  assert.deepEqual(requests, [
    {
      method: 'DELETE',
      url: '/api/cli/artifacts/abc123def4',
      authorization: 'Bearer test-token',
    },
    {
      method: 'DELETE',
      url: '/api/cli/artifacts/abc123def4',
      authorization: 'Bearer test-token',
    },
  ])
})

import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('artifacts list --help explains finding ids for follow-up commands', () => {
  const result = run(['artifacts', 'list', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /artifacts list --project-id/)
  assert.match(result.stdout, /update, edit, move, delete, artifacts get/)
  assert.match(result.stdout, /invalid_destination/)
})

test('artifacts list --json fails with auth_required before network checks', () => {
  const result = run(['artifacts', 'list', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'artifacts list', code: 'auth_required' })
})

test('artifacts list rejects project and home filters together before auth checks', () => {
  const result = run(
    ['artifacts', 'list', '--project-id', 'prj1', '--home', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, {
    command: 'artifacts list',
    code: 'destination_conflict',
  })
})

test('artifacts list rejects blank project filters before auth checks', () => {
  const result = run(['artifacts', 'list', '--project-id', '   ', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, {
    command: 'artifacts list',
    code: 'validation_failed',
  })
})

test('artifacts list --json maps artifact responses and filters', async () => {
  const requests: Array<{
    method: string | undefined
    url: string | undefined
    auth: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        auth: request.headers.authorization,
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifacts: [
            {
              id: 'abc123def4',
              title: 'Weekly report',
              share_url: 'https://artifactshare.test/a/abc123def4',
              visibility: 'private',
              link_expires_at: null,
              updated_at: '2026-06-18T00:00:00.000Z',
              project_id: 'prj1',
              owner_email: 'owner@example.com',
            },
          ],
          limit: 50,
          has_more: false,
          next_cursor: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'artifacts',
          'list',
          '--project-id',
          'prj1',
          '--query',
          'Weekly report',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'artifacts list')
      assert.equal(payload.data.limit, 50)
      assert.equal(payload.data.has_more, false)
      assert.equal(payload.data.next_cursor, null)
      assert.equal(payload.data.artifacts[0].id, 'abc123def4')
      assert.equal(payload.data.artifacts[0].link_expires_at, null)
      assert.equal(payload.data.artifacts[0].owner_email, 'owner@example.com')
    },
  )

  assert.deepEqual(requests, [
    {
      method: 'GET',
      url: '/api/cli/artifacts?project_id=prj1&query=Weekly+report',
      auth: 'Bearer test-token',
    },
  ])
})

test('artifacts list --cursor sends the cursor query parameter and exposes the next page', async () => {
  await withServer(
    (request, response) => {
      assert.equal(
        request.url,
        '/api/cli/artifacts?project_id=prj1&cursor=page-2',
      )
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifacts: [],
          limit: 50,
          has_more: true,
          next_cursor: 'page-3',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'artifacts',
          'list',
          '--project-id',
          'prj1',
          '--cursor',
          'page-2',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const payload = expectSuccess(result, 'artifacts list')
      assert.equal(payload.data.next_cursor, 'page-3')
    },
  )
})

test('artifacts list --home sends the home project filter', async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, '/api/cli/artifacts?project_id=')
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifacts: [],
          limit: 50,
          has_more: false,
          next_cursor: null,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['artifacts', 'list', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectSuccess(result, 'artifacts list')
    },
  )
})

test('artifacts list maps invalid project responses', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'invalid-destination',
            message: 'Project not found.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'artifacts',
          'list',
          '--project-id',
          'missing',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'artifacts list',
        code: 'invalid_destination',
      })
    },
  )
})

test('artifacts list rejects malformed success responses', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ artifacts: [] }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['artifacts', 'list', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'artifacts list',
        code: 'service_error',
      })
      assert.match(payload.error.message, /list metadata/)
    },
  )
})

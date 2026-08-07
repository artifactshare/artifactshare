import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  collectBody,
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('move --json fails with auth_required before network checks', () => {
  const result = run(['move', 'abc123def4', '--project-id', 'prj1', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, { command: 'move', code: 'auth_required' })
})

test('move --project-id posts a project destination', async () => {
  const requests: Array<{
    url: string | undefined
    auth: string | undefined
    body: unknown
  }> = []

  await withServer(
    async (request, response) => {
      requests.push({
        url: request.url,
        auth: request.headers.authorization,
        body: JSON.parse(await collectBody(request)),
      })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: {
            id: 'abc123def4',
            url: 'https://artifactshare.test/a/abc123def4',
          },
          destination: { type: 'project', project_id: 'prj1' },
          share: {
            visibility: 'project',
            project_audience_may_change: true,
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'move',
          'https://artifactshare.test/a/abc123def4',
          '--project-id',
          'prj1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'move')
      assert.deepEqual(payload.data, {
        artifact: {
          id: 'abc123def4',
          url: 'https://artifactshare.test/a/abc123def4',
        },
        destination: { type: 'project', project_id: 'prj1' },
        share: {
          visibility: 'project',
          project_audience_may_change: true,
        },
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/shareables/abc123def4/move')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.body, {
    destination: { project_id: 'prj1' },
  })
})

test('move --home posts a home destination', async () => {
  const requests: Array<{ body: unknown }> = []

  await withServer(
    async (request, response) => {
      requests.push({ body: JSON.parse(await collectBody(request)) })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          destination: { type: 'home', project_id: null },
          share: {
            visibility: 'private',
            project_audience_may_change: false,
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['move', 'abc123def4', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'move')
      assert.deepEqual(payload.data.destination, {
        type: 'home',
        project_id: null,
      })
      assert.equal(payload.data.share.visibility, 'private')
    },
  )

  assert.deepEqual(requests[0]?.body, { destination: 'home' })
})

test('move rejects conflicting destinations before auth', () => {
  const result = run(
    ['move', 'abc123def4', '--project-id', 'prj1', '--home', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'move', code: 'destination_conflict' })
})

test('move treats blank project ids as present for destination conflicts', () => {
  const result = run(
    ['move', 'abc123def4', '--project-id', ' ', '--home', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'move', code: 'destination_conflict' })
})

test('move maps missing targets to target_not_found', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'not-found', message: 'Shareable not found.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['move', 'abc123def4', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'move', code: 'target_not_found' })
    },
  )
})

test('move maps invalid destinations to invalid_destination', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'invalid-destination',
            message: 'Invalid destination.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'move',
          'abc123def4',
          '--project-id',
          'missing',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'move', code: 'invalid_destination' })
    },
  )
})

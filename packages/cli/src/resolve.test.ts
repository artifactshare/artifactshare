import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

test('resolve --help explains target lookup before writing', () => {
  const result = run(['resolve', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /resolve "Weekly report"/)
  assert.match(result.stdout, /before write commands/)
  assert.match(result.stdout, /auth_required/)
})

test('resolve --json fails with auth_required before network checks', () => {
  const result = run(['resolve', 'Weekly report', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'resolve', code: 'auth_required' })
})

test('resolve --json maps candidate responses', async () => {
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          query: 'Weekly report',
          candidates: [
            {
              kind: 'artifact',
              id: 'abc123def4',
              title: 'Weekly report',
              artifact_kind: 'html_page',
              visibility: 'private',
              project: { id: 'proj_1', name: 'Launch review' },
              owner: { id: 'u1', email: 'owner@example.com' },
              updated_at: '2026-06-09T00:00:00.000Z',
              match: { kind: 'title', confidence: 'exact' },
            },
          ],
          has_more: false,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['resolve', 'Weekly report', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'resolve')
      assert.equal(payload.data.query, 'Weekly report')
      assert.equal(payload.data.candidates[0].kind, 'artifact')
      assert.equal(payload.data.candidates[0].id, 'abc123def4')
      assert.equal(payload.data.has_more, false)
    },
  )

  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/cli/resolve?q=Weekly+report' },
  ])
})

test('resolve --json rejects malformed success responses', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ candidates: [] }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['resolve', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'resolve',
        code: 'service_error',
      })
      assert.match(payload.error.message, /query, candidates, and has_more/)
    },
  )
})

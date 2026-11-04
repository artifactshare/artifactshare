import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

const page = {
  id: 'abc123def4',
  retain_versions: 3,
  version_count: 1,
  total_size_bytes: 42,
  versions: [
    {
      version_id: 'v1',
      created_at: '2026-01-01T00:00:00Z',
      size_bytes: 42,
      is_current: true,
      status: 'published',
      published_at: null,
      creator: null,
    },
  ],
  limit: 50,
  has_more: false,
  next_cursor: null,
}

test('versions dispatch preserves cursor, target and shared flags in every position', async () => {
  let requests = 0
  await withServer(
    (request, response) => {
      requests++
      assert.equal(
        request.url,
        '/api/cli/artifacts/abc123def4/versions?cursor=opaque-cursor',
      )
      assert.equal(request.headers.authorization, 'Bearer test-token')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(page))
    },
    async (baseUrl) => {
      for (const placement of ['before', 'between', 'after']) {
        const flags = ['--baseUrl', baseUrl, '--token=test-token', '--json']
        const target = 'https://artifactshare.com/a/abc123def4'
        const argv =
          placement === 'before'
            ? [...flags, 'artifacts', 'versions', target]
            : placement === 'between'
              ? ['artifacts', ...flags, 'versions', target]
              : ['artifacts', 'versions', target, ...flags]
        const result = await runAsync([...argv, '--cursor', 'opaque-cursor'])
        const payload = expectSuccess(result, 'artifacts versions')
        assert.equal(payload.schema_version, 2)
        assert.deepEqual(payload.data, page)
      }
    },
  )
  assert.equal(requests, 3)
})

test('versions maps concealed 404 and rejects malformed success', async () => {
  for (const status of [404, 200])
    await withServer(
      (_request, response) => {
        response.statusCode = status
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify(
            status === 404
              ? { error: { code: 'not-found', message: 'Artifact not found.' } }
              : { versions: [] },
          ),
        )
      },
      async (baseUrl) => {
        const result = await runAsync([
          'artifacts',
          'versions',
          'abc123def4',
          '--base-url',
          baseUrl,
          '--token',
          'test-token',
          '--json',
        ])
        expectFailure(result, {
          command: 'artifacts versions',
          code: status === 404 ? 'target_not_found' : 'service_error',
        })
        assert.equal(result.stdout, '')
        assert.equal(result.status, 1)
      },
    )
})

test('versions rejects invalid options before authentication and describes pagination', () => {
  expectFailure(
    run(['artifacts', 'versions', 'abc123def4', '--cursor=', '--json']),
    { command: 'artifacts versions', code: 'validation_failed' },
  )
  expectFailure(
    run(['artifacts', 'versions', 'abc123def4', '--offset', '0', '--json']),
    { command: 'artifacts versions', code: 'unknown_option' },
  )
  const help = run(['artifacts', 'versions', '-h'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--cursor/)
  assert.match(help.stdout, /total_size_bytes/)
  assert.equal(run(['artifacts', 'versions', '-v']).status, 0)
})

test('get accepts static-site metadata without inventing source', async () => {
  const metadata = {
    id: 'abc123def4',
    title: 'Site',
    share_url: 'https://example.com/a/abc123def4',
    version_id: 'v1',
    artifact_kind: 'static_site',
    visibility: 'private',
    project_id: null,
    link_expires_at: null,
    retain_versions: null,
    version_count: 2,
    total_size_bytes: 120,
  }
  await withServer(
    (request, response) => {
      assert.equal(request.headers['x-artifactshare-static-metadata'], '1')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(metadata))
    },
    async (baseUrl) => {
      const result = await runAsync([
        'artifacts',
        'get',
        'abc123def4',
        '--base-url',
        baseUrl,
        '--token',
        'test-token',
        '--json',
      ])
      assert.deepEqual(expectSuccess(result, 'artifacts get').data, metadata)
    },
  )
})

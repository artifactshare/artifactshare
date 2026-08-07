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
import { mapApiError } from './errors.js'

test('edit --json fails with auth_required before network checks', () => {
  const result = run(['edit', 'abc123def4', '--title', 'Renamed', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  })

  expectFailure(result, { command: 'edit', code: 'auth_required' })
})

test('edit posts title, sharing, grants, and project destination', async () => {
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
          title: 'Launch plan',
          destination: { type: 'project', project_id: 'prj1' },
          share: { visibility: 'workspace' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'https://artifactshare.test/a/abc123def4',
          '--title',
          'Launch plan',
          '--visibility',
          'workspace',
          '--grant-email',
          'viewer@example.com',
          '--revoke-email',
          'old@example.com',
          '--project-id',
          'prj1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.deepEqual(payload.data, {
        artifact: {
          id: 'abc123def4',
          url: 'https://artifactshare.test/a/abc123def4',
        },
        title: 'Launch plan',
        destination: { type: 'project', project_id: 'prj1' },
        share: { visibility: 'workspace', link_expires_at: null },
      })
    },
  )

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, '/api/cli/shareables/abc123def4/edit')
  assert.equal(requests[0]?.auth, 'Bearer test-token')
  assert.deepEqual(requests[0]?.body, {
    title: 'Launch plan',
    visibility: 'workspace',
    add_emails: ['viewer@example.com'],
    remove_emails: ['old@example.com'],
    destination: { project_id: 'prj1' },
  })
})

test('edit sends link visibility and unlimited expiry', async () => {
  let body: unknown
  await withServer(
    async (request, response) => {
      body = JSON.parse(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Report',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'link', link_expires_at: null },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--visibility',
          'link',
          '--no-link-expiry',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const payload = expectSuccess(result, 'edit')
      assert.equal(payload.data.share.visibility, 'link')
      assert.equal(payload.data.share.link_expires_at, null)
    },
  )
  assert.deepEqual(body, {
    visibility: 'link',
    link_expires_at: null,
  })
})

test('edit --home posts a home destination', async () => {
  const requests: Array<{ body: unknown }> = []

  await withServer(
    async (request, response) => {
      requests.push({ body: JSON.parse(await collectBody(request)) })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Backlog',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'private' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['edit', 'abc123def4', '--home', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.deepEqual(payload.data.destination, {
        type: 'home',
        project_id: null,
      })
      assert.equal(payload.data.share.visibility, 'private')
    },
  )

  assert.deepEqual(requests[0]?.body, { destination: 'home' })
})

test('edit allows an empty title to clear the display title', async () => {
  const requests: Array<{ body: unknown }> = []

  await withServer(
    async (request, response) => {
      requests.push({ body: JSON.parse(await collectBody(request)) })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          artifact: { id: 'abc123def4', url: null },
          title: 'Derived title',
          destination: { type: 'home', project_id: null },
          share: { visibility: 'private' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['edit', 'abc123def4', '--title', '', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'edit')
      assert.equal(payload.data.title, 'Derived title')
    },
  )

  assert.deepEqual(requests[0]?.body, { title: '' })
})

test('edit rejects missing changes before auth', () => {
  const result = run(['edit', 'abc123def4', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test('edit rejects conflicting destinations before auth', () => {
  const result = run(
    ['edit', 'abc123def4', '--project-id', 'prj1', '--home', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'edit', code: 'destination_conflict' })
})

test('edit rejects unsupported visibility before auth', () => {
  const result = run(
    ['edit', 'abc123def4', '--visibility', 'project', '--json'],
    { ARTIFACTSHARE_TOKEN: '' },
  )

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test('edit rejects --title without a value before auth', () => {
  const result = run(['edit', 'abc123def4', '--title', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  expectFailure(result, { command: 'edit', code: 'validation_failed' })
})

test.each([
  ['link-sharing-plan-required', 'link_sharing_plan_required'],
  ['link-sharing-disabled', 'link_sharing_disabled'],
  ['link-expiry-invalid', 'link_expiry_invalid'],
] as const)('maps %s to the CLI underscore contract', (apiCode, code) => {
  const mapped = mapApiError(400, {
    error: { code: apiCode, message: 'Link policy error.' },
  })
  assert.equal(mapped.code, code)
})

test('edit maps missing targets to target_not_found', async () => {
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
        [
          'edit',
          'abc123def4',
          '--title',
          'Nope',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'target_not_found' })
    },
  )
})

test('edit maps workspace scope failures to workspace_unavailable', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'workspace-unavailable',
            message: 'Workspace visibility is unavailable.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--visibility',
          'workspace',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'workspace_unavailable' })
    },
  )
})

test('edit maps grant limit failures to too_many_grants', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'too-many-grants',
            message: 'Share with at most 50 email addresses.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'edit',
          'abc123def4',
          '--grant-email',
          'new@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, { command: 'edit', code: 'too_many_grants' })
    },
  )
})

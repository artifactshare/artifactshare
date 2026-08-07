import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { runArtifactsGet } from './command-runners/artifacts-get.js'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

const deviceAuthEnv = {
  ARTIFACTSHARE_TOKEN: '',
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
}

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function mockDeviceCode(response: ServerResponse) {
  writeJson(response, {
    device_code: 'device-code-1',
    user_code: 'ABCD1234',
    verification_uri: 'https://artifactshare.test/device',
    verification_uri_complete:
      'https://artifactshare.test/device?user_code=ABCD1234',
    expires_in: 60,
    interval: 1,
  })
}

test('artifacts get --help explains read back before update', () => {
  const result = run(['artifacts', 'get', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /artifacts get abc123def4/)
  assert.match(result.stdout, /data\.content/)
  assert.match(result.stdout, /data\.version_id/)
  assert.match(result.stdout, /data\.truncated/)
  assert.match(result.stdout, /next_offset/)
  assert.match(result.stdout, /unsupported_kind/)
})

test('artifacts get --json fails before network checks when token store is unavailable', () => {
  const result = run(
    ['artifacts', 'get', 'abc123def4', '--json'],
    deviceAuthEnv,
  )

  const payload = expectFailure(result, {
    command: 'artifacts get',
    code: 'token_store_unavailable',
  })
  assert.equal(payload.error.details?.user_code, undefined)
})

test('artifacts get without --json keeps auth_required instead of starting login', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-artifacts-get-human-auth-'),
  )
  const previousToken = process.env.ARTIFACTSHARE_TOKEN
  const previousConfigHome = process.env.ARTIFACTSHARE_CONFIG_HOME
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true)
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true)

  try {
    process.env.ARTIFACTSHARE_TOKEN = ''
    process.env.ARTIFACTSHARE_CONFIG_HOME = configHome
    process.exitCode = undefined
    await runArtifactsGet(
      {
        command: 'artifacts get',
        options: {},
        positionals: ['abc123def4'],
      },
      { json: false },
    )
  } finally {
    if (previousToken === undefined) delete process.env.ARTIFACTSHARE_TOKEN
    else process.env.ARTIFACTSHARE_TOKEN = previousToken
    if (previousConfigHome === undefined) {
      delete process.env.ARTIFACTSHARE_CONFIG_HOME
    } else {
      process.env.ARTIFACTSHARE_CONFIG_HOME = previousConfigHome
    }
  }

  assert.equal(process.exitCode, 1)
  assert.equal(stdout.mock.calls.join(''), '')
  assert.match(stderr.mock.calls.join(''), /Error: Login is required\./)
  assert.doesNotMatch(stdout.mock.calls.join(''), /Starting device login/)
  stdout.mockRestore()
  stderr.mockRestore()
  process.exitCode = undefined
})

test('artifacts get --json returns pending device auth without saving artifact details', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-artifacts-get-auth-'),
  )
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'artifacts',
          'get',
          'https://artifactshare.com/a/abc123def4',
          '--include',
          'comments',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )

      const payload = expectFailure(result, {
        command: 'artifacts get',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(
        payload.error.details?.verification_uri_complete,
        'https://artifactshare.test/device?user_code=ABCD1234',
      )
      assert.match(
        payload.error.details?.retry_hint as string,
        /rerun the same command/,
      )

      const pendingRaw = await readFile(
        join(configHome, 'pending-device-auth.json'),
        'utf8',
      )
      const pending = JSON.parse(pendingRaw)
      assert.equal(pending[`${baseUrl}:default`].device_code, 'device-code-1')
      assert.doesNotMatch(pendingRaw, /abc123def4/)
      assert.doesNotMatch(pendingRaw, /comments/)
      assert.doesNotMatch(pendingRaw, /artifactshare\.com\/a/)
    },
  )
})

test('artifacts get --json with expired profile token returns pending device auth', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-artifacts-get-profile-auth-'),
  )
  let deviceCodeRequests = 0

  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response)
        return
      }
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'Unauthorized' }))
    },
    async (baseUrl) => {
      await writeFile(
        join(configHome, 'tokens.json'),
        `${JSON.stringify({ [`${baseUrl}:expired`]: 'expired-token' })}\n`,
      )

      const result = await runAsync(
        [
          'artifacts',
          'get',
          'abc123def4',
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'artifacts get',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(payload.error.details?.credential_source, 'profile')
      assert.equal(payload.error.details?.profile, 'expired')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('artifacts get --json completes after pending device auth approval', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-artifacts-get-auth-'),
  )
  const requests: string[] = []

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
      requests.push(url)
      if (url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      if (url === '/api/auth/device/token') {
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
        })
        return
      }
      if (url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: null },
        })
        return
      }
      if (url === '/api/cli/auth/refresh-credentials') {
        writeJson(response, {
          refresh_token: 'refresh-token-1',
          refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
        })
        return
      }
      if (url === '/api/cli/artifacts/abc123def4') {
        writeJson(response, {
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'artifacts',
        'get',
        'abc123def4',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      expectFailure(await runAsync(args, env), {
        command: 'artifacts get',
        code: 'auth_required',
      })
      const completed = await runAsync(args, env)
      const payload = expectSuccess(completed, 'artifacts get')
      assert.equal(payload.data.id, 'abc123def4')
      assert.equal(payload.data.content, '# Report')
    },
  )

  assert.ok(requests.includes('/api/cli/artifacts/abc123def4'))
})

test('artifacts get rejects ambiguous target input before auth checks', () => {
  const result = run(['artifacts', 'get', 'Weekly report', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  const payload = expectFailure(result, {
    command: 'artifacts get',
    code: 'target_not_found',
  })
  assert.match(payload.error.why, /Artifacts get only accepts/)
  assert.doesNotMatch(payload.error.why, /Update only accepts/)
  assert.match(payload.error.hint, /resolve/)
})

test('artifacts get validates offset before network checks', () => {
  const result = run(
    ['artifacts', 'get', 'abc123def4', '--offset', 'abc', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, {
    command: 'artifacts get',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /--offset/)
})

test('artifacts get validates include values before network checks', () => {
  const result = run(
    ['artifacts', 'get', 'abc123def4', '--include', 'owners', '--json'],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, {
    command: 'artifacts get',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /owners/)
})

test('artifacts get --json maps source responses', async () => {
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
          id: 'abc123def4',
          share_url: 'http://127.0.0.1/a/abc123def4',
          version_id: 'ver123',
          format: 'markdown',
          content: '# Report',
          size_bytes: 8,
          truncated: false,
          next_offset: null,
          link_expires_at: '2026-07-10T00:00:00Z',
          versions: [
            {
              version_id: 'ver123',
              status: 'published',
              size_bytes: 8,
              created_at: '2026-06-09T00:00:00.000Z',
              published_at: '2026-06-09T00:00:00.000Z',
              is_current: true,
            },
          ],
          versions_has_more: false,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'artifacts',
          'get',
          'https://artifactshare.com/a/abc123def4',
          '--offset',
          '200000',
          '--include',
          'versions',
          '--include',
          'comments',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'artifacts get')
      assert.equal(payload.data.id, 'abc123def4')
      assert.equal(payload.data.version_id, 'ver123')
      assert.equal(payload.data.format, 'markdown')
      assert.equal(payload.data.content, '# Report')
      assert.equal(payload.data.truncated, false)
      assert.equal(payload.data.next_offset, null)
      assert.equal(payload.data.link_expires_at, '2026-07-10T00:00:00Z')
      assert.equal(payload.data.versions[0].version_id, 'ver123')
    },
  )

  assert.deepEqual(requests, [
    {
      method: 'GET',
      url: '/api/cli/artifacts/abc123def4?offset=200000&include=versions&include=comments',
    },
  ])
})

test('artifacts get --json maps unsupported kinds', async () => {
  await withServer(
    (_request, response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'unsupported-kind',
            message: 'This artifact cannot be read as a single source file.',
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['artifacts', 'get', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'artifacts get',
        code: 'unsupported_kind',
      })
    },
  )
})

test('artifacts get --json rejects malformed success responses', async () => {
  await withServer(
    (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'abc123def4' }))
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['artifacts', 'get', 'abc123def4', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'artifacts get',
        code: 'service_error',
      })
      assert.match(payload.error.message, /source metadata/)
    },
  )
})

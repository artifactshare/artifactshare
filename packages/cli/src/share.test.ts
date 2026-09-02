import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  collectBody,
  runAsync,
  withServer,
} from './test/helpers.js'
import { mapApiError } from './errors.js'

const deviceAuthEnv = {
  ARTIFACTSHARE_TOKEN: '',
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
}

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function mockDeviceCode(
  response: ServerResponse,
  overrides: Partial<{ user_code: string; device_code: string }> = {},
) {
  writeJson(response, {
    device_code: overrides.device_code ?? 'device-code-1',
    user_code: overrides.user_code ?? 'ABCD1234',
    verification_uri: 'https://artifactshare.test/device',
    verification_uri_complete:
      'https://artifactshare.test/device?user_code=ABCD1234',
    expires_in: 60,
    interval: 1,
  })
}

function expectAuthRequiredWithDevice(
  payload: ReturnType<typeof expectFailure>,
  baseUrl: string,
) {
  assert.equal(payload.error.requires_human, true)
  assert.equal(payload.error.details?.token_url, `${baseUrl}/settings/tokens`)
  assert.equal(payload.error.details?.env_var, 'ARTIFACTSHARE_TOKEN')
  assert.equal(payload.error.details?.token_option, '--token')
  assert.equal(payload.error.details?.user_code, 'ABCD1234')
  assert.equal(
    payload.error.details?.verification_uri,
    'https://artifactshare.test/device',
  )
  assert.equal(
    payload.error.details?.verification_uri_complete,
    'https://artifactshare.test/device?user_code=ABCD1234',
  )
  assert.equal(typeof payload.error.details?.expires_at, 'string')
  assert.equal(payload.error.details?.interval_seconds, 1)
  assert.equal(typeof payload.error.details?.instruction, 'string')
  assert.match(
    payload.error.details?.retry_hint as string,
    /rerun the same command/,
  )
}

function formField(body: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = body.match(
    new RegExp(`name="${escaped}"\\r\\n\\r\\n([^\\r]*)\\r\\n`),
  )
  return match?.[1] ?? null
}

test('share --help prints share-specific options', () => {
  const result = run(['share', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /--project-id <project-id>/)
  assert.match(result.stdout, /--home/)
  assert.match(
    result.stdout,
    /Posting to a project delivers to the audience defined by that project/,
  )
  assert.match(
    result.stdout,
    /config get home_audience --scope effective --json/,
  )
  assert.match(
    result.stdout,
    /config set home_audience workspace --scope repository --json/,
  )
  assert.match(result.stdout, /One-time audience/)
  assert.match(result.stdout, /To keep an existing share URL, use update/)
  assert.match(result.stdout, /For repeat jobs, use --key/)
  assert.match(result.stdout, /Common failures:/)
  assert.match(result.stdout, /auth_required/)
})

test('share sends link visibility and finite expiry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []
  const expiry = '2026-08-01T00:00:00Z'

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'link',
        link_expires_at: expiry,
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--visibility',
          'link',
          '--link-expires-at',
          expiry,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.share.visibility, 'link')
      assert.equal(payload.data.share.link_expires_at, expiry)
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'link')
  assert.equal(formField(bodies[0] ?? '', 'link_expires_at'), expiry)
})

test('share --no-slack-notify sends slack_notify=false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-slack-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []
  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'workspace',
        link_expires_at: null,
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--no-slack-notify', '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )
      expectSuccess(result, 'share')
    },
  )
  assert.equal(formField(bodies[0] ?? '', 'slack_notify'), 'false')
})

test('share preserves Slack reauthorization warnings in successful JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-warning-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  await withServer(
    async (_request, response) => {
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'project',
        link_expires_at: null,
        shareUrl: 'https://example.com/a/abc123def4',
        warnings: [
          {
            code: 'slack_reauthorization_required',
            message: 'Slack notifications are not being delivered.',
          },
        ],
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--base-url', baseUrl, '--json'],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
        },
      )
      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.warnings, [
        {
          code: 'slack_reauthorization_required',
          message: 'Slack notifications are not being delivered.',
        },
      ])
    },
  )
})

test('share rejects mutually exclusive link expiry options before auth', () => {
  const result = run(
    [
      'share',
      'sample.html',
      '--link-expires-at',
      '2026-08-01T00:00:00Z',
      '--no-link-expiry',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: '' },
  )
  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share --artifact-id fails before it can create a new artifact', () => {
  for (const flag of ['--artifact-id', '--artifact-id=abc123def4']) {
    const result = run(
      [
        'share',
        'sample.html',
        '--home',
        flag,
        ...(flag.includes('=') ? [] : ['abc123def4']),
        '--json',
      ],
      { ARTIFACTSHARE_TOKEN: 'test-token' },
    )

    const payload = expectFailure(result, {
      command: 'share',
      code: 'validation_failed',
    })
    assert.match(payload.error.message, /--artifact-id/)
    assert.match(payload.error.hint, /update <artifact-id-or-url> <path>/)
    assert.match(payload.error.hint, /share --key <key>/)
  }
})

test('share --json fails with auth_required before destination checks', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
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
          'share',
          'missing.html',
          '--home',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )

      const payload = expectFailure(result, {
        command: 'share',
        code: 'auth_required',
      })
      assert.match(payload.error.hint, /\/settings\/tokens|ABCD1234/)
      expectAuthRequiredWithDevice(payload, baseUrl)

      const pending = JSON.parse(
        await readFile(join(configHome, 'pending-device-auth.json'), 'utf8'),
      )
      assert.equal(pending[`${baseUrl}:default`].device_code, 'device-code-1')
      assert.equal(pending[`${baseUrl}:default`].user_code, 'ABCD1234')
    },
  )
})

test('share --json reuses pending device auth before approval', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  let deviceCodeRequests = 0
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response, { user_code: 'WXYZ5678' })
        return
      }
      if (request.url === '/api/auth/device/token') {
        writeJson(response, { error: 'authorization_pending' }, 400)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'share',
        'missing.html',
        '--home',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      const first = await runAsync(args, env)
      const firstPayload = expectFailure(first, {
        command: 'share',
        code: 'auth_required',
      })
      assert.equal(firstPayload.error.details?.user_code, 'WXYZ5678')

      const second = await runAsync(args, env)
      const payload = expectFailure(second, {
        command: 'share',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'WXYZ5678')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('share --json keeps auth_required when device auth cannot start', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  await withServer(
    (_request, response) => {
      writeJson(response, { error: { code: 'not-found' } }, 404)
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          'missing.html',
          '--home',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'share',
        code: 'auth_required',
      })
      assert.equal(
        payload.error.details?.token_url,
        `${baseUrl}/settings/tokens`,
      )
      assert.equal(
        await readFile(
          join(configHome, 'pending-device-auth.json'),
          'utf8',
        ).catch(() => null),
        null,
      )
    },
  )
})

test('share --json does not consume approved pending auth without a token store', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  let tokenRequests = 0
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      if (request.url === '/api/auth/device/token') {
        tokenRequests += 1
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'share',
        'missing.html',
        '--home',
        '--base-url',
        baseUrl,
        '--json',
      ]

      expectFailure(await runAsync(args, env), {
        command: 'share',
        code: 'token_store_unavailable',
      })
      assert.equal(tokenRequests, 0)
      assert.equal(
        await readFile(
          join(configHome, 'pending-device-auth.json'),
          'utf8',
        ).catch(() => null),
        null,
      )
    },
  )
})

test('share --json completes after pending device auth approval', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-share-file-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
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
      if (url.startsWith('/api/shareables')) {
        request.resume()
        request.on('end', () => {
          writeJson(response, {
            id: 'abc123def4',
            versionId: 'v1',
            artifactKind: 'html_page',
            visibility: 'private',
            shareUrl: 'http://127.0.0.1/a/abc123def4',
          })
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'share',
        target,
        '--home',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      const pending = await runAsync(args, env)
      expectFailure(pending, { command: 'share', code: 'auth_required' })

      const completed = await runAsync(args, env)
      expectSuccess(completed, 'share')

      const pendingFile = join(configHome, 'pending-device-auth.json')
      const raw = await readFile(pendingFile, 'utf8').catch(() => null)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        assert.equal(parsed[`${baseUrl}:default`], undefined)
      }
    },
  )
})

test('share --json clears denied pending device auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        mockDeviceCode(response)
        return
      }
      if (request.url === '/api/auth/device/token') {
        writeJson(response, { error: 'access_denied' }, 400)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const env = { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome }
      const args = [
        'share',
        'missing.html',
        '--home',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]
      await runAsync(args, env)
      const denied = await runAsync(args, env)
      expectFailure(denied, { command: 'share', code: 'auth_denied' })

      const pending = JSON.parse(
        await readFile(join(configHome, 'pending-device-auth.json'), 'utf8'),
      )
      assert.equal(pending[`${baseUrl}:default`], undefined)
    },
  )
})

test('share --json replaces expired pending device auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))

  let deviceCodeRequests = 0
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response, { user_code: 'NEW99999' })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (serverBaseUrl) => {
      await writeFile(
        join(configHome, 'pending-device-auth.json'),
        `${JSON.stringify({
          [`${serverBaseUrl}:default`]: {
            base_url: serverBaseUrl,
            profile: 'default',
            device_code: 'old-device-code',
            verification_uri: 'https://artifactshare.test/old',
            verification_uri_complete: null,
            user_code: 'OLD12345',
            expires_at: '2000-01-01T00:00:00.000Z',
            interval_seconds: 1,
            created_at: '2000-01-01T00:00:00.000Z',
          },
        })}\n`,
      )

      const result = await runAsync(
        [
          'share',
          'missing.html',
          '--home',
          '--base-url',
          serverBaseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'share',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'NEW99999')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('share --json with invalid token returns token_invalid without pending auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-share-auth-'))
  let deviceCodeRequests = 0
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-share-file-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

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
      const result = await runAsync(
        ['share', target, '--home', '--base-url', baseUrl, '--json'],
        {
          ...deviceAuthEnv,
          ARTIFACTSHARE_CONFIG_HOME: configHome,
          ARTIFACTSHARE_TOKEN: 'bad-token',
        },
      )
      expectFailure(result, { command: 'share', code: 'token_invalid' })
      assert.equal(deviceCodeRequests, 0)
    },
  )
})

test('share --json with invalid --token returns token_invalid without pending auth', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-token-option-auth-'),
  )
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-share-file-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
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
      const result = await runAsync(
        [
          'share',
          target,
          '--home',
          '--base-url',
          baseUrl,
          '--token',
          'bad-token',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      expectFailure(result, { command: 'share', code: 'token_invalid' })
      assert.equal(deviceCodeRequests, 0)
    },
  )
})

test('share --json with expired profile token returns pending device auth', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-profile-auth-'),
  )
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-share-file-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
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
          'share',
          target,
          '--home',
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'share',
        code: 'auth_required',
      })
      expectAuthRequiredWithDevice(payload, baseUrl)
      assert.equal(payload.error.details?.credential_source, 'profile')
      assert.equal(payload.error.details?.profile, 'expired')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('share --json refreshes an expired session profile and retries once', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-refresh-auth-'),
  )
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-share-file-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const seenAuth: string[] = []
  let deviceCodeRequests = 0

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
      if (url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response)
        return
      }
      if (url === '/api/shareables/uploads') {
        seenAuth.push(request.headers.authorization ?? '')
        request.resume()
        request.on('end', () => {
          if (seenAuth.length === 1) {
            response.statusCode = 401
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ error: 'Unauthorized' }))
            return
          }
          writeJson(response, {
            id: 'abc123def4',
            versionId: 'v1',
            artifactKind: 'html_page',
            visibility: 'private',
            shareUrl: 'http://127.0.0.1/a/abc123def4',
          })
        })
        return
      }
      if (url === '/api/cli/auth/refresh') {
        request.resume()
        request.on('end', () => {
          writeJson(response, {
            access_token: 'session-token-2',
            token_type: 'Bearer',
            expires_at: '2026-06-28T00:00:00.000Z',
            refresh_token: 'refresh-token-2',
            refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
          })
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      await writeFile(
        join(configHome, 'tokens.json'),
        `${JSON.stringify({
          [`${baseUrl}:expired`]: JSON.stringify({
            kind: 'session',
            session_token: 'session-token-1',
            refresh_token: 'refresh-token-1',
            expires_at: '2026-06-14T00:00:00.000Z',
          }),
        })}\n`,
      )

      const result = await runAsync(
        [
          'share',
          target,
          '--home',
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.artifact.id, 'abc123def4')
      assert.deepEqual(seenAuth, [
        'Bearer session-token-1',
        'Bearer session-token-2',
      ])
      assert.equal(deviceCodeRequests, 0)
      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(JSON.parse(tokens[`${baseUrl}:expired`]), {
        kind: 'session',
        session_token: 'session-token-2',
        refresh_token: 'refresh-token-2',
        expires_at: '2026-06-28T00:00:00.000Z',
        refresh_credential_expires_at: '2026-12-31T00:00:00.000Z',
      })
    },
  )
})

test('share without a destination defaults to home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'workspace',
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: root },
      )
      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, { type: 'home' })
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'workspace')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), null)
})

test('share --key with a blank value fails with validation_failed', () => {
  const result = run(
    ['share', 'sample.html', '--home', '--key', ' ', '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
    },
  )

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share --key over 128 characters fails with validation_failed', () => {
  const result = run(
    ['share', 'sample.html', '--home', '--key', 'k'.repeat(129), '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
    },
  )

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share --key sends publish_key and reports created and key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const urls: string[] = []

  await withServer(
    async (request, response) => {
      urls.push(request.url ?? '')
      await collectBody(request)
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v2',
          artifactKind: 'html_page',
          visibility: 'workspace',
          shareUrl: 'https://example.com/a/abc123def4',
          created: false,
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--home',
          '--key',
          ' pr-482 ',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.result.created, false)
      assert.equal(payload.data.key, 'pr-482')
      assert.equal(payload.data.version.id, 'v2')
    },
  )

  assert.match(urls[0] ?? '', /publish_key=pr-482/)
})

test('share --key preserves version conflicts as recoverable input changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  await withServer(
    async (request, response) => {
      await collectBody(request)
      response.statusCode = 409
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: {
            code: 'version_conflict',
            message: 'changed',
            details: { current_version_id: 'v3' },
          },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--home',
          '--key',
          'report',
          '--expected-version',
          'v2',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'share',
        code: 'version_conflict',
      })
      assert.deepEqual(payload.error.recovery, { kind: 'change_input' })
      assert.equal(payload.error.details?.current_version_id, 'v3')
    },
  )
})

test('share --key maps key error codes from the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  for (const [apiCode, cliCode] of [
    ['key-target-moved', 'key_target_moved'],
    ['key-kind-mismatch', 'key_kind_mismatch'],
    ['key-conflict', 'key_conflict'],
  ] as const) {
    await withServer(
      (_request, response) => {
        response.statusCode = 409
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({ error: { code: apiCode, message: 'nope' } }),
        )
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'share',
            target,
            '--home',
            '--key',
            'pr-482',
            '--base-url',
            baseUrl,
            '--json',
          ],
          { ARTIFACTSHARE_TOKEN: 'test-token' },
        )

        expectFailure(result, { command: 'share', code: cliCode })
      },
    )
  }
})

test('share --json=true fails with validation_failed', () => {
  const result = run([
    'share',
    'sample.html',
    '--home',
    '--json=true',
    '--token',
    't',
  ])

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share --project-id without value fails with validation_failed', () => {
  const result = run(['share', 'sample.html', '--project-id', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share --token with empty inline value fails with validation_failed', () => {
  const result = run(['share', 'sample.html', '--home', '--token=', '--json'])

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share preserves --base-url inline value after equals sign', () => {
  const result = run(
    [
      'share',
      'missing.html',
      '--home',
      '--base-url=https://example.com:8443/path',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, { command: 'share' })
  assert.match(
    payload.error.code,
    /network_failed|service_error|validation_failed/,
  )
})

test('share accepts inline option values that begin with dashes', () => {
  const result = run(
    ['share', 'missing.html', '--home', '--base-url=--proxy', '--json'],
    {
      ARTIFACTSHARE_TOKEN: 'test-token',
    },
  )

  const payload = expectFailure(result, { command: 'share' })
  assert.notEqual(payload.error.message, '--base-url requires a value.')
})

test('collectDirectoryFiles skips local metadata and dependency directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<html></html>')
  await writeFile(join(root, '.env'), 'SECRET=1')
  await writeFile(join(root, 'node_modules', 'pkg', 'ignored.js'), 'x')

  const result = run(['share', root, '--home', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stderr, /ignored\.js/)
  assert.doesNotMatch(result.stderr, /\.env/)
})

test('collectDirectoryFiles keeps framework output directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  await mkdir(join(root, 'build'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'index.html'),
    '<script src="/build/app.js"></script>',
  )
  await writeFile(join(root, 'build', 'app.js'), 'console.log("ok")')
  await writeFile(join(root, 'dist', 'style.css'), 'body{}')

  const result = run(['share', root, '--home', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /build|dist/)
})

test('collectDirectoryFiles rejects symlinked directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'target')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'index.html'), '<html></html>')
  await writeFile(join(root, 'index.html'), '<html></html>')
  await symlink(target, join(root, 'linked'))

  const result = run(['share', root, '--home', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  const payload = expectFailure(result, {
    command: 'share',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /symbolic link/)
})

test('collectDirectoryFiles rejects symlinked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'shared.js')
  await writeFile(target, 'console.log("shared")')
  await writeFile(join(root, 'index.html'), '<script src="/app.js"></script>')
  await symlink(target, join(root, 'app.js'))

  const result = run(['share', root, '--home', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  const payload = expectFailure(result, {
    command: 'share',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /symbolic link/)
})

test('share to a project defaults visibility to project and reports the confirmed value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'project',
          shareUrl: 'https://example.com/a/abc123def4',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project-id',
          'prj1',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, {
        type: 'project',
        project_id: 'prj1',
      })
      assert.equal(payload.data.share.visibility, 'project')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'project')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), 'prj1')
})

test('share blocked by upload access asks a human for help', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  await withServer(
    (_request, response) => {
      response.statusCode = 403
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          error: { code: 'upload-not-allowed', message: 'Not allowed.' },
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--home', '--base-url', baseUrl, '--json'],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
        },
      )

      const failure = expectFailure(result, {
        command: 'share',
        code: 'upload_not_allowed',
      })
      assert.deepEqual(failure.error.recovery, { kind: 'ask_human' })
      assert.equal(failure.error.details?.suggested_command, undefined)
      assert.equal(failure.error.code, 'upload_not_allowed')
      assert.equal(failure.error.details?.limit, 'upload_access')
    },
  )
})

test('share reports revoked workspace access as a human-recovery error', async () => {
  const failure = mapApiError(403, {
    error: {
      code: 'workspace-access-revoked',
      message: 'Your access has been revoked.',
    },
  })
  assert.equal(failure.code, 'workspace_access_revoked')
  assert.equal(failure.requires_human, true)
  assert.equal(failure.agent_recoverable, false)
  assert.deepEqual(failure.recovery, { kind: 'ask_human' })
})

test('share keeps the contributor guardrail error when the API returns 403', () => {
  const failure = mapApiError(403, {
    error: {
      code: 'contributor-limit-exceeded',
      message:
        'This workspace cannot add more contributors. Contact the Artifact Share team.',
    },
  })
  assert.equal(failure.code, 'contributor_limit_exceeded')
  assert.equal(failure.requires_human, true)
  assert.equal(failure.agent_recoverable, false)
  assert.match(failure.hint ?? '', /Artifact Share team/)
  assert.deepEqual(failure.recovery, { kind: 'ask_human' })
})

test('share preserves storage upgrade guidance from the API', () => {
  const upgradeRequest = {
    kind: 'billing',
    limit_type: 'storage',
    current_plan: 'free',
    recommended_plan: 'plus',
    upgrade_url: 'https://artifactshare.test/settings/billing?plan=plus',
    action_message: 'Upgrade storage.',
  }
  const failure = mapApiError(413, {
    error: {
      code: 'quota-exceeded',
      message: 'Storage quota exceeded.',
      details: { upgrade_request: upgradeRequest },
    },
  })
  assert.equal(failure.code, 'storage_limit_exceeded')
  assert.deepEqual(failure.details?.upgrade_request, upgradeRequest)
})

test('share to home uses the workspace product default and server-confirmed visibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'workspace',
          shareUrl: 'https://example.com/a/abc123def4',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', target, '--home', '--base-url', baseUrl, '--json'],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
        },
      )

      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.share.visibility, 'workspace')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'workspace')
})

test('share to a project with explicit grant emails keeps project visibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'project',
          shareUrl: 'https://example.com/a/abc123def4',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project-id',
          'prj1',
          '--grant-email',
          'viewer@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.share.visibility, 'project')
      assert.deepEqual(payload.data.share.grant_emails, ['viewer@example.com'])
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'project')
})

test('share --home overrides the working-directory default project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  await mkdir(join(root, '.artifactshare'))
  await writeFile(
    join(root, '.artifactshare/config.json'),
    JSON.stringify({ default_project_id: 'prj1' }),
  )
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'workspace',
          shareUrl: 'https://example.com/a/abc123def4',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          'report.html',
          '--home',
          '--grant-email',
          'viewer@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
        { cwd: root },
      )

      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, { type: 'home' })
      assert.equal(payload.data.share.visibility, 'workspace')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'workspace')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), null)
  assert.equal(formField(bodies[0] ?? '', 'grant_email'), 'viewer@example.com')
})

test('share --home uses shared visibility with an explicit home despite local default project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-config-'),
  )
  await mkdir(join(root, '.artifactshare'))
  await writeFile(
    join(root, '.artifactshare/config.local.json'),
    JSON.stringify({ default_project_id: 'prj-local' }),
  )
  await writeFile(
    join(root, '.artifactshare/config.json'),
    JSON.stringify({ default_artifact_visibility: 'private' }),
  )
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'private',
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', 'report.html', '--home', '--base-url', baseUrl, '--json'],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
          ARTIFACTSHARE_CONFIG_HOME: configHome,
        },
        { cwd: root },
      )
      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, { type: 'home' })
      assert.equal(payload.data.share.visibility, 'private')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'private')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), null)
})

test('share --home prefers repository home audience over the legacy key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-config-'),
  )
  await mkdir(join(root, '.artifactshare'))
  await writeFile(
    join(root, '.artifactshare/config.json'),
    JSON.stringify({
      home_audience: 'workspace',
      default_artifact_visibility: 'private',
    }),
  )
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'workspace',
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['share', 'report.html', '--home', '--base-url', baseUrl, '--json'],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
          ARTIFACTSHARE_CONFIG_HOME: configHome,
        },
        { cwd: root },
      )
      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, { type: 'home' })
      assert.equal(payload.data.share.visibility, 'workspace')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'workspace')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), null)
})

test('share visibility explicit flag wins over project and default visibility, including grant email', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-share-config-'),
  )
  await mkdir(join(root, '.artifactshare'))
  await writeFile(
    join(root, '.artifactshare/config.json'),
    JSON.stringify({ default_artifact_visibility: 'private' }),
  )
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      bodies.push(await collectBody(request))
      writeJson(response, {
        id: 'abc123def4',
        versionId: 'v1',
        artifactKind: 'html_page',
        visibility: 'private',
        shareUrl: 'https://example.com/a/abc123def4',
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project-id',
          'prj1',
          '--visibility',
          'private',
          '--grant-email',
          'viewer@example.com',
          '--base-url',
          baseUrl,
          '--json',
        ],
        {
          ARTIFACTSHARE_TOKEN: 'test-token',
          ARTIFACTSHARE_CONFIG_HOME: configHome,
        },
        { cwd: root },
      )
      const payload = expectSuccess(result, 'share')
      assert.equal(payload.data.share.visibility, 'private')
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'visibility'), 'private')
  assert.equal(formField(bodies[0] ?? '', 'container_id'), 'prj1')
  assert.equal(formField(bodies[0] ?? '', 'grant_email'), 'viewer@example.com')
})

test('share --project resolves destination.project_id by exact name match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')
  const bodies: string[] = []

  await withServer(
    async (request, response) => {
      const url = request.url ?? ''
      if (url.includes('/api/cli/projects')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            projects: [
              {
                id: 'prj_weekly',
                name: 'Weekly report',
                updated_at: '2026-06-01T00:00:00.000Z',
              },
            ],
          }),
        )
        return
      }
      bodies.push(await collectBody(request))
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 'abc123def4',
          versionId: 'v1',
          artifactKind: 'html_page',
          visibility: 'project',
          shareUrl: 'https://example.com/a/abc123def4',
        }),
      )
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project',
          'Weekly report',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'share')
      assert.deepEqual(payload.data.destination, {
        type: 'project',
        project_id: 'prj_weekly',
      })
    },
  )

  assert.equal(formField(bodies[0] ?? '', 'container_id'), 'prj_weekly')
})

test('share --project with no match fails with project_not_found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
      if (url.includes('/api/cli/projects')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ projects: [] }))
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project',
          'Missing project',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const failure = expectFailure(result, {
        command: 'share',
        code: 'project_not_found',
      })
      assert.match(
        failure.error.hint,
        /npm exec --yes --package=@artifactshare\/cli -- artifactshare projects list --json/,
      )
      assert.equal(failure.error.recovery?.kind, 'run_command')
    },
  )
})

test('share --project with multiple matches fails with project_ambiguous', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'report.html')
  await writeFile(target, '<html></html>')

  await withServer(
    (request, response) => {
      const url = request.url ?? ''
      if (url.includes('/api/cli/projects')) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            projects: [
              {
                id: 'prj_01',
                name: 'Weekly report',
                updated_at: '2026-06-01T00:00:00.000Z',
              },
              {
                id: 'prj_02',
                name: 'Weekly report',
                updated_at: '2026-06-02T00:00:00.000Z',
              },
            ],
          }),
        )
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'share',
          target,
          '--project',
          'Weekly report',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const failure = expectFailure(result, {
        command: 'share',
        code: 'project_ambiguous',
      })
      assert.deepEqual(failure.error.details?.candidates, [
        {
          project_id: 'prj_01',
          name: 'Weekly report',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
        {
          project_id: 'prj_02',
          name: 'Weekly report',
          updated_at: '2026-06-02T00:00:00.000Z',
        },
      ])
      assert.match(failure.error.hint, /--project-id/)
    },
  )
})

test('share --project with --project-id fails with destination_conflict', () => {
  const result = run(
    [
      'share',
      'sample.html',
      '--project',
      'Weekly report',
      '--project-id',
      'prj1',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, { command: 'share', code: 'destination_conflict' })
})

test('share --project with empty value fails with validation_failed', () => {
  const result = run(['share', 'sample.html', '--project=', '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

test('share reports destination_conflict before insecure-localhost validation', () => {
  const result = run(
    [
      'share',
      'sample.html',
      '--home',
      '--project-id',
      'prj1',
      '--insecure-localhost',
      '--base-url',
      'https://example.com',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, { command: 'share', code: 'destination_conflict' })
})

test('share reports missing path before insecure-localhost validation', () => {
  const result = run(
    [
      'share',
      'missing.html',
      '--home',
      '--insecure-localhost',
      '--base-url',
      'https://example.com',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  expectFailure(result, { command: 'share', code: 'validation_failed' })
})

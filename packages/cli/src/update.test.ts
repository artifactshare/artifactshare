import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'
import { mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'vitest'
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

test('update --help prints update-specific options', () => {
  const result = run(['update', '--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /update <OPTIONS> <artifactIdOrUrl> <path>/)
  assert.match(result.stdout, /artifact ID/)
  assert.match(result.stdout, /Common failures:/)
  assert.match(result.stdout, /target_not_found/)
  assert.match(result.stdout, /artifact_kind_mismatch/)
})

test('update --json fails with auth_required before path checks', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
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
          'update',
          'abc123def4',
          'missing.html',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )

      const payload = expectFailure(result, {
        command: 'update',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(payload.error.details?.token_option, '--token')
    },
  )
})

test('update --json reuses pending device auth before approval', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
  let deviceCodeRequests = 0
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response)
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
        'update',
        'abc123def4',
        'missing.html',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      await runAsync(args, env)
      const second = await runAsync(args, env)
      const payload = expectFailure(second, {
        command: 'update',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('update --json clears denied pending device auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
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
        'update',
        'abc123def4',
        'missing.html',
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]
      await runAsync(args, env)
      expectFailure(await runAsync(args, env), {
        command: 'update',
        code: 'auth_denied',
      })

      const pending = JSON.parse(
        await readFile(join(configHome, 'pending-device-auth.json'), 'utf8'),
      )
      assert.equal(pending[`${baseUrl}:default`], undefined)
    },
  )
})

test('update --json completes after pending device auth approval', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-update-file-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')
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
      if (url === '/api/shareables/abc123def4/versions') {
        request.resume()
        request.on('end', () => {
          writeJson(response, {
            id: 'abc123def4',
            versionId: 'ver123',
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
        'update',
        'abc123def4',
        file,
        '--base-url',
        baseUrl,
        '--allow-plaintext-token-store',
        '--json',
      ]

      expectFailure(await runAsync(args, env), {
        command: 'update',
        code: 'auth_required',
      })
      const completed = await runAsync(args, env)
      const payload = expectSuccess(completed, 'update')
      assert.equal(payload.data.version.id, 'ver123')
    },
  )

  assert.ok(requests.includes('/api/shareables/abc123def4/versions'))
})

test('update --json replaces expired pending device auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
  let deviceCodeRequests = 0

  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        deviceCodeRequests += 1
        mockDeviceCode(response)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      await writeFile(
        join(configHome, 'pending-device-auth.json'),
        `${JSON.stringify({
          [`${baseUrl}:default`]: {
            base_url: baseUrl,
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
          'update',
          'abc123def4',
          'missing.html',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'update',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('update --json with invalid token returns token_invalid without pending auth', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-update-auth-'))
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-update-file-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')
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
        ['update', 'abc123def4', file, '--base-url', baseUrl, '--json'],
        {
          ...deviceAuthEnv,
          ARTIFACTSHARE_CONFIG_HOME: configHome,
          ARTIFACTSHARE_TOKEN: 'bad-token',
        },
      )
      expectFailure(result, { command: 'update', code: 'token_invalid' })
      assert.equal(deviceCodeRequests, 0)
    },
  )
})

test('update --json with expired profile token returns pending device auth', async () => {
  const configHome = await mkdtemp(
    join(tmpdir(), 'artifactshare-update-profile-auth-'),
  )
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-update-file-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')
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
          'update',
          'abc123def4',
          file,
          '--profile',
          'expired',
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ...deviceAuthEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(result, {
        command: 'update',
        code: 'auth_required',
      })
      assert.equal(payload.error.details?.user_code, 'ABCD1234')
      assert.equal(payload.error.details?.credential_source, 'profile')
      assert.equal(payload.error.details?.profile, 'expired')
      assert.equal(deviceCodeRequests, 1)
    },
  )
})

test('update rejects ambiguous target input before auth checks', () => {
  const result = run(['update', 'Weekly report', 'sample.html', '--json'], {
    ARTIFACTSHARE_TOKEN: '',
  })

  const payload = expectFailure(result, {
    command: 'update',
    code: 'target_not_found',
  })
  assert.match(payload.error.hint, /resolve/)
})

test('update accepts share URLs as artifact targets', () => {
  const result = run(
    [
      'update',
      'https://artifactshare.com/a/abc123def4',
      'missing.html',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, {
    command: 'update',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /Path was not found/)
})

test('update accepts sandbox URLs as artifact targets', () => {
  const result = run(
    [
      'update',
      'https://abc123def4.sandbox.artifactshare.com/index.html?t=token',
      'missing.html',
      '--json',
    ],
    { ARTIFACTSHARE_TOKEN: 'test-token' },
  )

  const payload = expectFailure(result, {
    command: 'update',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /Path was not found/)
})

test('update --json maps a successful version response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      request.resume()
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            versionId: 'ver123',
            shareUrl: 'http://127.0.0.1/a/abc123def4',
          }),
        )
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['update', 'abc123def4', file, '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'update')
      assert.equal(payload.data.artifact.id, 'abc123def4')
      assert.equal(payload.data.artifact.kind, 'html_page')
      assert.equal(payload.data.version.id, 'ver123')
      assert.equal(payload.data.result.updated, true)
    },
  )

  assert.deepEqual(requests, [
    { method: 'POST', url: '/api/shareables/abc123def4/versions' },
  ])
})

test('update --json keeps copy-forbidden as artifact_kind_mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')

  await withServer(
    (request, response) => {
      if (request.url === '/api/shareables/abc123def4/versions') {
        request.resume()
        request.on('end', () => {
          writeJson(response, { error: { code: 'copy-forbidden' } }, 403)
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['update', 'abc123def4', file, '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      expectFailure(result, {
        command: 'update',
        code: 'artifact_kind_mismatch',
      })
    },
  )
})

test('update --json rejects malformed success responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')

  await withServer(
    (request, response) => {
      request.resume()
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            shareUrl: 'http://127.0.0.1/a/abc123def4',
          }),
        )
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        ['update', 'abc123def4', file, '--base-url', baseUrl, '--json'],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectFailure(result, {
        command: 'update',
        code: 'service_error',
      })
      assert.match(payload.error.message, /version id/)
    },
  )
})

test('update prefers sandbox host artifact id over sandbox path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const file = join(root, 'index.html')
  await writeFile(file, '<html></html>')
  const requests: Array<{
    method: string | undefined
    url: string | undefined
  }> = []

  await withServer(
    (request, response) => {
      requests.push({ method: request.method, url: request.url })
      request.resume()
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            id: 'abc123def4',
            versionId: 'ver123',
            shareUrl: 'http://127.0.0.1/a/abc123def4',
          }),
        )
      })
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'update',
          'https://abc123def4.sandbox.artifactshare.com/a/dashboard?t=token',
          file,
          '--base-url',
          baseUrl,
          '--json',
        ],
        { ARTIFACTSHARE_TOKEN: 'test-token' },
      )

      const payload = expectSuccess(result, 'update')
      assert.equal(payload.data.artifact.id, 'abc123def4')
    },
  )

  assert.deepEqual(requests, [
    { method: 'POST', url: '/api/shareables/abc123def4/versions' },
  ])
})

test('update rejects unsupported options', () => {
  for (const [flag, value] of [
    ['--visibility', 'workspace'],
    ['--grant-email', 'person@example.com'],
    ['--project-id', 'proj_123'],
    ['--home'],
    ['--key', 'stable-key'],
    ['--ttl', '1h'],
  ] as Array<[string, string?]>) {
    const result = run(
      [
        'update',
        'abc123def4',
        'sample.html',
        flag,
        ...(value ? [value] : []),
        '--json',
      ],
      { ARTIFACTSHARE_TOKEN: 'test-token' },
    )

    const payload = expectFailure(result, {
      command: 'update',
      code: 'validation_failed',
    })
    assert.match(payload.error.message, new RegExp(flag))
  }
})

test('update reuses directory validation for symlinked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifactshare-cli-'))
  const target = join(root, 'shared.js')
  await writeFile(target, 'console.log("shared")')
  await writeFile(join(root, 'index.html'), '<script src="/app.js"></script>')
  await symlink(target, join(root, 'app.js'))

  const result = run(['update', 'abc123def4', root, '--json'], {
    ARTIFACTSHARE_TOKEN: 'test-token',
  })

  const payload = expectFailure(result, {
    command: 'update',
    code: 'validation_failed',
  })
  assert.match(payload.error.message, /symbolic link/)
})

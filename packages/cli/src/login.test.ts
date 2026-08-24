import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  type CliResult,
  expectFailure,
  expectSuccess,
  runAsync,
  withServer,
} from './test/helpers.js'

const loginEnv = {
  ARTIFACTSHARE_TOKEN: '',
  ARTIFACTSHARE_BASE_URL: '',
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TEST_BROWSER_OPENER: 'success',
}

test('login --json rejects an unavailable token store before device authorization', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  let requests = 0
  try {
    await withServer(
      (_request, response) => {
        requests += 1
        response.statusCode = 500
        response.end()
      },
      async (baseUrl) => {
        const result = await runAsync(
          ['login', '--profile', 'client-a', '--base-url', baseUrl, '--json'],
          { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
        )
        const payload = expectFailure(result, {
          command: 'login',
          code: 'token_store_unavailable',
        })
        assert.equal(payload.error.details.profile, 'client-a')
        assert.equal(payload.error.details.cause, 'native_store_unavailable')
        assert.equal(payload.error.recovery.kind, 'ask_human')
        assert.match(
          payload.error.hint,
          process.platform === 'win32'
            ? /Credential Manager/
            : /--allow-plaintext-token-store/,
        )
        assert.equal(requests, 0)
      },
    )
  } finally {
    await rm(configHome, { recursive: true, force: true })
  }
})

test('login --json completes device flow and saves a profile token', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  let tokenPolls = 0
  let whoamiAuth = ''
  let refreshCredentialBody: Record<string, unknown> | null = null
  let deviceCodeBody: Record<string, unknown> | null = null
  await withServer(
    async (request, response) => {
      if (request.url === '/api/auth/device/code') {
        let body = ''
        for await (const chunk of request) body += chunk
        deviceCodeBody = JSON.parse(body) as Record<string, unknown>
        writeJson(response, {
          device_code: 'device-code-1',
          user_code: 'ABCD1234',
          verification_uri: 'https://artifactshare.test/device',
          verification_uri_complete:
            'https://artifactshare.test/device?user_code=ABCD1234',
          expires_in: 60,
          interval: 1,
        })
        return
      }
      if (request.url === '/api/auth/device/token') {
        tokenPolls += 1
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      if (request.url === '/api/cli/whoami') {
        whoamiAuth = request.headers.authorization ?? ''
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
          auth: { kind: 'bearer_or_session' },
        })
        return
      }
      if (request.url === '/api/cli/auth/refresh-credentials') {
        assert.equal(request.headers.authorization, 'Bearer session-token-1')
        let body = ''
        for await (const chunk of request) body += chunk
        refreshCredentialBody = JSON.parse(body) as Record<string, unknown>
        writeJson(response, {
          refresh_token: 'refresh-token-1',
          refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'login',
          '--profile',
          'client-a',
          '--preset',
          'agent',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const { event, rest } = readPendingEvent(result)
      assert.equal(event.user_code, 'ABCD1234')
      assert.equal(event.verification_uri, 'https://artifactshare.test/device')
      assert.equal(event.interval_seconds, 1)
      assert.equal(typeof event.expires_at, 'string')
      assert.equal(event.browser_open.status, 'started')
      assert.equal(event.browser_open.attempted, true)
      assert.deepEqual(deviceCodeBody, {
        client_id: 'artifactshare-cli',
        preset: 'agent',
        device_name: deviceCodeBody?.device_name,
      })
      assert.match(String(deviceCodeBody?.device_name), /client-a/)

      const payload = expectSuccess(rest, 'login')
      assert.match(
        String(refreshCredentialBody?.device_name),
        /^Artifact Share CLI on \w+ \w+ \(client-a, [0-9a-f]{8}\)$/,
      )
      assert.match(
        String(refreshCredentialBody?.device_id),
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
      )
      assert.equal(payload.data.profile, 'client-a')
      assert.equal(payload.data.status, 'completed')
      assert.equal(payload.data.token_store, 'plaintext_file')
      assert.equal(payload.data.user_code, 'ABCD1234')
      assert.equal(payload.data.user.email, 'person@example.com')
      assert.equal(payload.data.workspace.id, 'wrk_1')
      assert.equal(payload.data.workspace.hosted_domain, 'example.com')
      assert.ok(
        new Date(payload.data.expires_at).getTime() - Date.now() > 1800 * 1000,
        'expires_at reflects the session token lifetime, not the device code',
      )
      assert.equal(tokenPolls, 1)

      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(JSON.parse(tokens[`${baseUrl}:client-a`]), {
        kind: 'session',
        session_token: 'session-token-1',
        refresh_token: 'refresh-token-1',
        expires_at: payload.data.expires_at,
        device_id: refreshCredentialBody?.device_id,
      })
      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.default_profile, 'client-a')
      assert.equal(config.profiles['client-a'].base_url, baseUrl)
      assert.equal(config.profiles['client-a'].preset, 'agent')

      // The saved token must be usable without repeating the plaintext flag
      // or the base URL: both come back from the profile config.
      const whoami = await runAsync(
        ['whoami', '--profile', 'client-a', '--json'],
        { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const whoamiPayload = expectSuccess(whoami, 'whoami')
      assert.equal(whoamiPayload.data.credential_source, 'profile')
      assert.equal(whoamiAuth, 'Bearer session-token-1')

      const unrestricted = await runAsync(
        [
          'login',
          '--profile',
          'client-a',
          '--preset',
          'unrestricted',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      expectSuccess(readPendingEvent(unrestricted).rest, 'login')
      const updatedConfig = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(updatedConfig.profiles['client-a'].preset, 'unrestricted')
      assert.equal(deviceCodeBody?.preset, 'unrestricted')
    },
  )
})

test('login hints when the saved profile differs from the effective default', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  const workDir = await mkdtemp(join(tmpdir(), 'artifactshare-login-work-'))
  try {
    await writeFile(
      join(configHome, 'config.json'),
      JSON.stringify({
        default_profile: 'default',
        profiles: { default: {} },
      }),
    )
    await mkdir(join(workDir, '.artifactshare'))
    await writeFile(
      join(workDir, '.artifactshare/config.local.json'),
      JSON.stringify({ default_profile: 'default' }),
    )
    await withServer(
      (request, response) => {
        if (request.url === '/api/auth/device/code') {
          writeJson(response, {
            device_code: 'device-code-1',
            user_code: 'ABCD1234',
            verification_uri: 'https://artifactshare.test/device',
            expires_in: 60,
            interval: 1,
          })
          return
        }
        if (request.url === '/api/auth/device/token') {
          writeJson(response, {
            access_token: 'session-token-1',
            token_type: 'Bearer',
            expires_in: 3600,
          })
          return
        }
        if (request.url === '/api/cli/whoami') {
          writeJson(response, {
            user: { id: 'usr_1', email: 'person@example.com' },
            workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
          })
          return
        }
        if (request.url === '/api/cli/auth/refresh-credentials') {
          writeJson(response, {
            refresh_token: 'refresh-token-1',
            refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
          })
          return
        }
        response.statusCode = 404
        response.end()
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'login',
            '--profile',
            'client-a',
            '--base-url',
            baseUrl,
            '--allow-plaintext-token-store',
            '--json',
          ],
          { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
          { cwd: workDir },
        )
        const payload = expectSuccess(readPendingEvent(result).rest, 'login')
        assert.equal(payload.data.profile, 'client-a')
        assert.equal(payload.data.effective_default_profile, 'default')
        assert.ok(
          payload.data.profile_switch_hint.includes('--profile client-a'),
        )
        assert.ok(
          payload.data.profile_switch_hint.includes('init --profile client-a'),
        )
        assert.ok(
          payload.data.profile_switch_hint.includes('profiles use client-a'),
        )
      },
    )
  } finally {
    await rm(configHome, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }
})

test('login keeps an existing default_profile', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({ default_profile: 'default' }),
  )
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        writeJson(response, {
          device_code: 'device-code-1',
          user_code: 'ABCD1234',
          verification_uri: 'https://artifactshare.test/device',
          expires_in: 60,
          interval: 1,
        })
        return
      }
      if (request.url === '/api/auth/device/token') {
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        })
        return
      }
      if (request.url === '/api/cli/auth/refresh-credentials') {
        writeJson(response, {
          refresh_token: 'refresh-token-1',
          refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'login',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      expectSuccess(readPendingEvent(result).rest, 'login')

      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.default_profile, 'default')
      assert.equal(config.profiles['client-a'].email, 'person@example.com')
    },
  )
})

test('login rejects account mismatch before saving the token', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  await writeFile(
    join(configHome, 'config.json'),
    JSON.stringify({
      default_profile: 'client-a',
      profiles: {
        'client-a': { email: 'expected@example.com' },
      },
    }),
  )

  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        writeJson(response, {
          device_code: 'device-code-1',
          user_code: 'ABCD1234',
          verification_uri: 'https://artifactshare.test/device',
          expires_in: 60,
          interval: 1,
        })
        return
      }
      if (request.url === '/api/auth/device/token') {
        writeJson(response, {
          access_token: 'session-token-1',
          token_type: 'Bearer',
          expires_in: 3600,
        })
        return
      }
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_2', email: 'actual@example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'login',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...loginEnv, ARTIFACTSHARE_CONFIG_HOME: configHome },
      )
      const payload = expectFailure(readPendingEvent(result).rest, {
        command: 'login',
        code: 'auth_account_mismatch',
      })
      assert.equal(payload.error.details.expected_email, 'expected@example.com')
      assert.equal(payload.error.details.actual_email, 'actual@example.com')
      await assert.rejects(readFile(join(configHome, 'tokens.json'), 'utf8'))
    },
  )
})

test('login --json skips browser open when CI=true', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  try {
    await withServer(
      (request, response) => {
        if (request.url === '/api/auth/device/code') {
          writeJson(response, {
            device_code: 'device-code-1',
            user_code: 'ABCD1234',
            verification_uri: 'https://artifactshare.test/device',
            verification_uri_complete:
              'https://artifactshare.test/device?user_code=ABCD1234',
            expires_in: 60,
            interval: 1,
          })
          return
        }
        if (request.url === '/api/auth/device/token') {
          writeJson(response, {
            access_token: 'session-token-1',
            token_type: 'Bearer',
            expires_in: 3600,
          })
          return
        }
        if (request.url === '/api/cli/whoami') {
          writeJson(response, {
            user: { id: 'usr_1', email: 'person@example.com' },
            workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
          })
          return
        }
        if (request.url === '/api/cli/auth/refresh-credentials') {
          writeJson(response, {
            refresh_token: 'refresh-token-1',
            refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
          })
          return
        }
        response.statusCode = 404
        response.end()
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'login',
            '--profile',
            'client-a',
            '--base-url',
            baseUrl,
            '--allow-plaintext-token-store',
            '--json',
          ],
          {
            ...loginEnv,
            ARTIFACTSHARE_CONFIG_HOME: configHome,
            ARTIFACTSHARE_TEST_BROWSER_OPENER: '',
            CI: 'true',
          },
        )
        const { event, rest } = readPendingEvent(result)
        assert.equal(event.browser_open.status, 'skipped')
        assert.equal(event.browser_open.reason, 'ci')
        assert.equal(event.browser_open.attempted, false)
        assert.equal(
          event.verification_uri_complete,
          'https://artifactshare.test/device?user_code=ABCD1234',
        )
        assert.equal(event.user_code, 'ABCD1234')
        expectSuccess(rest, 'login')
      },
    )
  } finally {
    await rm(configHome, { recursive: true, force: true })
  }
})

test('login --json reports browser open failure in pending event', async () => {
  const configHome = await mkdtemp(join(tmpdir(), 'artifactshare-login-'))
  try {
    await withServer(
      (request, response) => {
        if (request.url === '/api/auth/device/code') {
          writeJson(response, {
            device_code: 'device-code-1',
            user_code: 'ABCD1234',
            verification_uri: 'https://artifactshare.test/device',
            expires_in: 60,
            interval: 1,
          })
          return
        }
        if (request.url === '/api/auth/device/token') {
          writeJson(response, {
            access_token: 'session-token-1',
            token_type: 'Bearer',
            expires_in: 3600,
          })
          return
        }
        if (request.url === '/api/cli/whoami') {
          writeJson(response, {
            user: { id: 'usr_1', email: 'person@example.com' },
            workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
          })
          return
        }
        if (request.url === '/api/cli/auth/refresh-credentials') {
          writeJson(response, {
            refresh_token: 'refresh-token-1',
            refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
          })
          return
        }
        response.statusCode = 404
        response.end()
      },
      async (baseUrl) => {
        const result = await runAsync(
          [
            'login',
            '--profile',
            'client-a',
            '--base-url',
            baseUrl,
            '--allow-plaintext-token-store',
            '--json',
          ],
          {
            ...loginEnv,
            ARTIFACTSHARE_CONFIG_HOME: configHome,
            ARTIFACTSHARE_TEST_BROWSER_OPENER: 'fail',
          },
        )
        const { event, rest } = readPendingEvent(result)
        assert.equal(event.browser_open.status, 'failed')
        assert.equal(event.browser_open.attempted, true)
        assert.equal(typeof event.browser_open.reason, 'string')
        assert.equal(event.user_code, 'ABCD1234')
        expectSuccess(rest, 'login')
      },
    )
  } finally {
    await rm(configHome, { recursive: true, force: true })
  }
})

test('login maps denied device authorization to auth_denied', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/auth/device/code') {
        writeJson(response, {
          device_code: 'device-code-1',
          user_code: 'ABCD1234',
          verification_uri: 'https://artifactshare.test/device',
          expires_in: 60,
          interval: 1,
        })
        return
      }
      if (request.url === '/api/auth/device/token') {
        writeJson(
          response,
          {
            error: 'access_denied',
            error_description: 'Access denied',
          },
          400,
        )
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'login',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        loginEnv,
      )
      const payload = expectFailure(readPendingEvent(result).rest, {
        command: 'login',
        code: 'auth_denied',
      })
      assert.equal(payload.error.details.profile, 'client-a')
    },
  )
})

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

// `login --json` emits one single-line pending event to stderr before the
// final envelope; split it off so expectSuccess/expectFailure keep checking
// the remaining contract strictly.
function readPendingEvent(result: CliResult): {
  // biome-ignore lint/suspicious/noExplicitAny: test payloads are asserted field by field
  event: any
  rest: CliResult
} {
  const newline = result.stderr.indexOf('\n')
  assert.notEqual(newline, -1, 'stderr has a pending event line')
  const event = JSON.parse(result.stderr.slice(0, newline))
  assert.equal(event.status, 'pending')
  return {
    event,
    rest: { ...result, stderr: result.stderr.slice(newline + 1) },
  }
}

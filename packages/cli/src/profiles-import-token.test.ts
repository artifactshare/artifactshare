import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  expectFailure,
  expectSuccess,
  run,
  runAsync,
  withServer,
} from './test/helpers.js'

let configHome: string

const isolation = () => ({
  ARTIFACTSHARE_CONFIG_HOME: configHome,
  ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
  ARTIFACTSHARE_TOKEN: '',
})

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'artifactshare-cli-import-token-'))
})

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true })
})

async function writeGlobalConfig(config: unknown): Promise<void> {
  await mkdir(configHome, { recursive: true })
  await writeFile(join(configHome, 'config.json'), JSON.stringify(config))
}

function writeJson(response: ServerResponse, body: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

test('profiles import-token saves a piped token after whoami verification', async () => {
  let whoamiAuth = ''
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        whoamiAuth = request.headers.authorization ?? ''
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'api-token-1' },
      )
      const payload = expectSuccess(result, 'profiles import-token')
      assert.equal(payload.data.profile, 'client-a')
      assert.equal(payload.data.token_store, 'plaintext_file')
      assert.equal(payload.data.user.email, 'person@example.com')
      assert.equal(payload.data.workspace.id, 'wrk_1')
      assert.equal(payload.data.workspace.hosted_domain, 'example.com')
      assert.equal(payload.data.base_url, baseUrl)
      assert.equal(whoamiAuth, 'Bearer api-token-1')
      assert.ok(
        !JSON.stringify(payload).includes('api-token-1'),
        'token values never appear in output',
      )

      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(JSON.parse(tokens[`${baseUrl}:client-a`]), {
        kind: 'api_token',
        token: 'api-token-1',
      })
      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.default_profile, 'client-a')
      assert.equal(config.profiles['client-a'].base_url, baseUrl)
      assert.equal(config.profiles['client-a'].email, 'person@example.com')
      assert.ok(
        !JSON.stringify(config).includes('api-token-1'),
        'token values never appear in config',
      )
    },
  )
})

test('profiles import-token fails validation when stdin is empty', async () => {
  expectFailure(
    run(
      [
        'profiles',
        'import-token',
        '--profile',
        'client-a',
        '--allow-plaintext-token-store',
        '--json',
      ],
      isolation(),
      { input: '' },
    ),
    { command: 'profiles import-token', code: 'validation_failed' },
  )
})

test('profiles import-token does not save when whoami fails', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        writeJson(response, { error: 'Unauthorized' }, 401)
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'bad-token' },
      )
      expectFailure(result, {
        command: 'profiles import-token',
        code: 'token_invalid',
      })
      await assert.rejects(readFile(join(configHome, 'tokens.json'), 'utf8'))
      await assert.rejects(readFile(join(configHome, 'config.json'), 'utf8'))
    },
  )
})

test('profiles import-token rejects account mismatch before saving the token', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: {
      'client-a': { email: 'expected@example.com' },
    },
  })

  await withServer(
    (request, response) => {
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
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'api-token-1' },
      )
      const payload = expectFailure(result, {
        command: 'profiles import-token',
        code: 'auth_account_mismatch',
      })
      assert.equal(payload.error.details.expected_email, 'expected@example.com')
      assert.equal(payload.error.details.actual_email, 'actual@example.com')
      await assert.rejects(readFile(join(configHome, 'tokens.json'), 'utf8'))
    },
  )
})

test('profiles import-token rejects unconfirmed account before overwriting a profile email', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: {
      'client-a': { email: 'expected@example.com' },
    },
  })

  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_2' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'api-token-1' },
      )
      const payload = expectFailure(result, {
        command: 'profiles import-token',
        code: 'auth_account_mismatch',
      })
      assert.equal(payload.error.details.expected_email, 'expected@example.com')
      assert.equal(payload.error.details.actual_email, null)
      await assert.rejects(readFile(join(configHome, 'tokens.json'), 'utf8'))
      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.profiles['client-a'].email, 'expected@example.com')
    },
  )
})

test('profiles import-token keeps an existing default_profile', async () => {
  await writeGlobalConfig({ default_profile: 'default' })

  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
          workspace: { id: 'wrk_1', hosted_domain: 'example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        isolation(),
        { input: 'api-token-1' },
      )
      expectSuccess(result, 'profiles import-token')

      const config = JSON.parse(
        await readFile(join(configHome, 'config.json'), 'utf8'),
      )
      assert.equal(config.default_profile, 'default')
      assert.equal(config.profiles['client-a'].email, 'person@example.com')
    },
  )
})

test('profiles import-token requires --allow-plaintext-token-store without native store', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--json',
        ],
        isolation(),
        { input: 'api-token-1' },
      )
      const payload = expectFailure(result, {
        command: 'profiles import-token',
        code: 'token_store_unavailable',
      })
      assert.equal(
        payload.error.details.cause,
        'credential_store_unavailable_or_failed',
      )
      await assert.rejects(readFile(join(configHome, 'tokens.json'), 'utf8'))
    },
  )
})

test('profiles import-token help does not show --token input examples', async () => {
  const result = run(['profiles', 'import-token', '--help'], isolation())
  assert.equal(result.status, 0)
  const help = `${result.stdout}${result.stderr}`
  assert.ok(help.includes('import-token'))
  assert.ok(help.includes('standard input'))
  assert.ok(!help.includes('--token'))
})

test('profiles import-token rejects --token input', async () => {
  const payload = expectFailure(
    run(
      [
        'profiles',
        'import-token',
        '--profile',
        'client-a',
        '--token',
        'secret-in-argv',
        '--json',
      ],
      isolation(),
      { input: 'stdin-token' },
    ),
    { command: 'profiles import-token', code: 'validation_failed' },
  )
  assert.match(payload.error.message, /--token/)
})

test('profiles import-token rejects positional token input', async () => {
  const payload = expectFailure(
    run(
      [
        'profiles',
        'import-token',
        'secret-in-argv',
        '--profile',
        'client-a',
        '--allow-plaintext-token-store',
        '--json',
      ],
      isolation(),
      { input: 'stdin-token' },
    ),
    { command: 'profiles import-token', code: 'validation_failed' },
  )
  assert.match(payload.error.message, /positional/)
})

test('profiles import-token ignores ARTIFACTSHARE_TOKEN and reads stdin instead', async () => {
  let whoamiAuth = ''
  await withServer(
    (request, response) => {
      if (request.url === '/api/cli/whoami') {
        whoamiAuth = request.headers.authorization ?? ''
        writeJson(response, {
          user: { id: 'usr_1', email: 'person@example.com' },
        })
        return
      }
      response.statusCode = 404
      response.end()
    },
    async (baseUrl) => {
      const result = await runAsync(
        [
          'profiles',
          'import-token',
          '--profile',
          'client-a',
          '--base-url',
          baseUrl,
          '--allow-plaintext-token-store',
          '--json',
        ],
        { ...isolation(), ARTIFACTSHARE_TOKEN: 'env-token-should-not-be-used' },
        { input: 'stdin-token-1' },
      )
      expectSuccess(result, 'profiles import-token')
      assert.equal(whoamiAuth, 'Bearer stdin-token-1')

      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(JSON.parse(tokens[`${baseUrl}:client-a`]), {
        kind: 'api_token',
        token: 'stdin-token-1',
      })
    },
  )
})

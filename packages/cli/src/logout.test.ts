import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import {
  collectBody,
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
  configHome = await mkdtemp(join(tmpdir(), 'artifactshare-cli-logout-'))
})

afterEach(async () => {
  await rm(configHome, { recursive: true, force: true })
})

async function writeGlobalConfig(config: unknown): Promise<void> {
  await writeFile(join(configHome, 'config.json'), JSON.stringify(config))
}

test('logout reports an unresolved config home separately', () => {
  const payload = expectFailure(
    run(['logout', '--profile', 'client-a', '--json'], {
      ARTIFACTSHARE_CONFIG_HOME: '',
      XDG_CONFIG_HOME: '',
      HOME: '',
      USERPROFILE: '',
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      ARTIFACTSHARE_TOKEN: '',
    }),
    { command: 'logout', code: 'config_home_unavailable' },
  )
  assert.equal(payload.error.details.cause, 'config_home_unresolved')
  assert.equal(payload.error.details.profile, 'client-a')
})

async function writePlaintextCredential(
  profile: string,
  baseUrl: string,
  token: string,
): Promise<void> {
  await writeFile(
    join(configHome, 'tokens.json'),
    JSON.stringify({
      [`${baseUrl}:${profile}`]: JSON.stringify({
        kind: 'api_token',
        token,
      }),
    }),
  )
}

async function writePlaintextSessionCredential(
  profile: string,
  baseUrl: string,
  refreshToken: string,
): Promise<void> {
  await writeFile(
    join(configHome, 'tokens.json'),
    JSON.stringify({
      [`${baseUrl}:${profile}`]: JSON.stringify({
        kind: 'session',
        session_token: 'session-token',
        refresh_token: refreshToken,
        expires_at: '2026-12-31T00:00:00.000Z',
      }),
    }),
  )
}

test('logout --help describes local credential removal', () => {
  const result = run(['logout', '--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Revoke and remove the saved credential/)
  assert.match(result.stdout, /validation_failed/)
})

test('profiles delete --help describes profile removal', () => {
  const result = run(['profiles', 'delete', '--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Delete a saved CLI profile/)
  assert.match(result.stdout, /profile_not_found/)
})

test('logout --profile removes a plaintext credential and keeps profile metadata', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: {
      'client-a': {
        base_url: 'https://example.com',
        email: 'a@example.com',
      },
    },
  })
  await writePlaintextCredential('client-a', 'https://example.com', 'tok-a')

  const payload = expectSuccess(
    run(['logout', '--profile', 'client-a', '--json'], isolation()),
    'logout',
  )
  assert.deepEqual(payload.data, {
    profile: 'client-a',
    credential_removed: true,
    token_store: 'plaintext_file',
  })

  const tokens = JSON.parse(
    await readFile(join(configHome, 'tokens.json'), 'utf8'),
  )
  assert.deepEqual(tokens, {})
  const config = JSON.parse(
    await readFile(join(configHome, 'config.json'), 'utf8'),
  )
  assert.deepEqual(config.profiles['client-a'], {
    base_url: 'https://example.com',
    email: 'a@example.com',
  })
  assert.ok(
    !JSON.stringify(payload).includes('tok-a'),
    'token values never appear in output',
  )
})

test('logout without --profile targets default_profile', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': { base_url: 'https://example.com' } },
  })
  await writePlaintextCredential('client-a', 'https://example.com', 'tok-a')

  const payload = expectSuccess(
    run(['logout', '--json'], isolation()),
    'logout',
  )
  assert.equal(payload.data.profile, 'client-a')
  assert.equal(payload.data.credential_removed, true)
})

test('logout still targets default_profile when ARTIFACTSHARE_TOKEN is set', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': { base_url: 'https://example.com' } },
  })
  await writePlaintextCredential('client-a', 'https://example.com', 'tok-a')

  const payload = expectSuccess(
    run(['logout', '--json'], {
      ...isolation(),
      ARTIFACTSHARE_TOKEN: 'env-token',
    }),
    'logout',
  )
  assert.equal(payload.data.profile, 'client-a')
  assert.equal(payload.data.credential_removed, true)
})

test('logout fails validation when only ARTIFACTSHARE_TOKEN is set', () => {
  expectFailure(
    run(['logout', '--json'], {
      ...isolation(),
      ARTIFACTSHARE_TOKEN: 'env-token',
    }),
    { command: 'logout', code: 'validation_failed' },
  )
})

test('logout fails validation when only --token is set', () => {
  expectFailure(
    run(['logout', '--token', 'cli-token', '--json'], isolation()),
    { command: 'logout', code: 'validation_failed' },
  )
})

test('logout fails with profile_not_found for an unknown profile', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  expectFailure(run(['logout', '--profile', 'nope', '--json'], isolation()), {
    command: 'logout',
    code: 'profile_not_found',
  })
})

test('logout fails with profile_not_found when default_profile is stale', async () => {
  await writeGlobalConfig({
    default_profile: 'stale',
    profiles: { 'client-a': {} },
  })

  expectFailure(run(['logout', '--json'], isolation()), {
    command: 'logout',
    code: 'profile_not_found',
  })
})

test('logout succeeds when the profile exists but has no credential', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': { email: 'a@example.com' } },
  })

  const payload = expectSuccess(
    run(['logout', '--json'], isolation()),
    'logout',
  )
  assert.deepEqual(payload.data, {
    profile: 'client-a',
    credential_removed: false,
    token_store: null,
  })
})

test('logout clears credentials so later profile resolution fails', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': { base_url: 'https://example.com' } },
  })
  await writePlaintextCredential('client-a', 'https://example.com', 'tok-a')

  expectSuccess(run(['logout', '--json'], isolation()), 'logout')
  expectFailure(run(['whoami', '--json'], isolation()), {
    command: 'whoami',
    code: 'auth_required',
  })
})

test('logout revokes a session credential before deleting it locally', async () => {
  const requests: Array<{ url: string | undefined; body: string }> = []
  await withServer(
    async (request, response) => {
      requests.push({ url: request.url, body: await collectBody(request) })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ revoked: true }))
    },
    async (baseUrl) => {
      await writeGlobalConfig({
        default_profile: 'client-a',
        profiles: { 'client-a': { base_url: baseUrl } },
      })
      await writePlaintextSessionCredential(
        'client-a',
        baseUrl,
        'refresh-secret',
      )

      const result = await runAsync(['logout', '--json'], isolation())
      expectSuccess(result, 'logout')
      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.deepEqual(tokens, {})
    },
  )
  assert.deepEqual(requests, [
    {
      url: '/api/cli/auth/revoke',
      body: JSON.stringify({ refresh_token: 'refresh-secret' }),
    },
  ])
})

test('logout keeps the local credential when remote revoke fails', async () => {
  await withServer(
    async (_request, response) => {
      response.statusCode = 503
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'service-error' } }))
    },
    async (baseUrl) => {
      await writeGlobalConfig({
        default_profile: 'client-a',
        profiles: { 'client-a': { base_url: baseUrl } },
      })
      await writePlaintextSessionCredential(
        'client-a',
        baseUrl,
        'refresh-secret',
      )

      const result = await runAsync(['logout', '--json'], isolation())
      expectFailure(result, { command: 'logout', code: 'service_error' })
      const tokens = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      assert.equal(Object.keys(tokens).length, 1)
    },
  )
})

test('profiles delete removes credential and config entry', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: {
      'client-a': {
        base_url: 'https://example.com',
        email: 'a@example.com',
      },
      personal: {},
    },
  })
  await writePlaintextCredential('client-a', 'https://example.com', 'tok-a')

  const payload = expectSuccess(
    run(['profiles', 'delete', 'client-a', '--json'], isolation()),
    'profiles delete',
  )
  assert.deepEqual(payload.data, {
    profile: 'client-a',
    credential_removed: true,
    token_store: 'plaintext_file',
    profile_deleted: true,
    previous_default: 'client-a',
    default_profile: null,
  })

  const config = JSON.parse(
    await readFile(join(configHome, 'config.json'), 'utf8'),
  )
  assert.equal(config.default_profile, null)
  assert.deepEqual(config.profiles, { personal: {} })
  const tokens = JSON.parse(
    await readFile(join(configHome, 'tokens.json'), 'utf8'),
  )
  assert.deepEqual(tokens, {})
})

test('profiles delete succeeds when credential is already missing', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': { email: 'a@example.com' }, personal: {} },
  })

  const payload = expectSuccess(
    run(['profiles', 'delete', 'client-a', '--json'], isolation()),
    'profiles delete',
  )
  assert.equal(payload.data.credential_removed, false)
  assert.equal(payload.data.token_store, null)
  assert.equal(payload.data.profile_deleted, true)
})

test('profiles delete fails with profile_not_found for an unknown name', async () => {
  await writeGlobalConfig({ profiles: { 'client-a': {} } })

  expectFailure(run(['profiles', 'delete', 'nope', '--json'], isolation()), {
    command: 'profiles delete',
    code: 'profile_not_found',
  })
})

test('profiles delete works when a value flag precedes the command', async () => {
  await writeGlobalConfig({
    default_profile: 'client-a',
    profiles: { 'client-a': {}, personal: {} },
  })

  const payload = expectSuccess(
    run(
      [
        '--base-url',
        'https://example.com',
        'profiles',
        'delete',
        'personal',
        '--json',
      ],
      isolation(),
    ),
    'profiles delete',
  )
  assert.equal(payload.data.profile, 'personal')
  assert.equal(payload.data.default_profile, 'client-a')
})

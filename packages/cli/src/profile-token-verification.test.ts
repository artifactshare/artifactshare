import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readGlobalConfig, writeGlobalConfig } from './token-store.js'
import { verifyAndStoreApiTokenProfile } from './command-runners/login.js'
import { withServer } from './test/helpers.js'

let configHome: string
const authority = {
  preset: 'publisher',
  project_id: null,
  publisher_client_id: 'client1',
  publisher_client_name: 'Reports',
}
const whoamiBody = (withAuthority: unknown = authority) => ({
  user: { id: 'owner1', email: 'owner@example.test' },
  workspace: { id: 'workspace1', hosted_domain: 'example.test' },
  auth: { kind: 'bearer_or_session', authority: withAuthority },
})

let whoami: unknown = whoamiBody()
let bearers: string[] = []

async function withWhoamiServer<T>(
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  return await withServer((request, response) => {
    bearers.push(request.headers.authorization ?? '')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(whoami))
  }, callback)
}

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'publisher-token-import-'))
  process.env.ARTIFACTSHARE_CONFIG_HOME = configHome
  process.env.ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE = '1'
  whoami = whoamiBody()
  bearers = []
})
afterEach(async () => {
  delete process.env.ARTIFACTSHARE_CONFIG_HOME
  delete process.env.ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE
  await rm(configHome, { recursive: true, force: true })
})

test.each([undefined, 'unrestricted', 'agent'] as const)(
  'token import saves verified publisher scope over previous preset %s',
  async (preset) => {
    if (preset) await writeGlobalConfig({ profiles: { reports: { preset } } })
    await withWhoamiServer(async (baseUrl) => {
      const result = await verifyAndStoreApiTokenProfile(
        'reports',
        'publisher-test-token',
        {
          baseUrl,
          allowPlaintextTokenStore: true,
          preset: 'unrestricted',
        },
        {},
      )
      expect(result.ok).toBe(true)
      expect(bearers).toEqual(['Bearer publisher-test-token'])
      expect((await readGlobalConfig())?.profiles?.reports?.preset).toBe(
        'publisher',
      )
      const saved = JSON.parse(
        await readFile(join(configHome, 'tokens.json'), 'utf8'),
      )
      expect(JSON.parse(saved[`${baseUrl}:reports`])).toEqual({
        kind: 'api_token',
        token: 'publisher-test-token',
      })
    })
  },
)

test.each([
  { ...authority, preset: 'unknown' },
  { preset: 'publisher', project_id: null },
])(
  'token import rejects malformed authority without overwriting credentials: %j',
  async (invalidAuthority) => {
    await withWhoamiServer(async (baseUrl) => {
      await verifyAndStoreApiTokenProfile(
        'reports',
        'publisher-test-token',
        { baseUrl, allowPlaintextTokenStore: true },
        {},
      )
      const beforeConfig = await readFile(
        join(configHome, 'config.json'),
        'utf8',
      )
      const beforeTokens = await readFile(
        join(configHome, 'tokens.json'),
        'utf8',
      )
      whoami = whoamiBody(invalidAuthority)
      expect(
        await verifyAndStoreApiTokenProfile(
          'reports',
          'replacement-test-token',
          { baseUrl, allowPlaintextTokenStore: true },
          {},
        ),
      ).toMatchObject({ ok: false, error: { code: 'service_error' } })
      expect(await readFile(join(configHome, 'config.json'), 'utf8')).toBe(
        beforeConfig,
      )
      expect(await readFile(join(configHome, 'tokens.json'), 'utf8')).toBe(
        beforeTokens,
      )
    })
  },
)

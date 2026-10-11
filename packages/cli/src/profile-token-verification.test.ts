import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readGlobalConfig, writeGlobalConfig } from './token-store.js'

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api.js')>()),
  apiGet,
}))
import { verifyAndStoreApiTokenProfile } from './command-runners/login.js'

let configHome: string
const baseUrl = 'https://example.test'
const authority = {
  preset: 'publisher',
  project_id: null,
  publisher_client_id: 'client1',
  publisher_client_name: 'Reports',
}
beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'publisher-token-import-'))
  vi.stubEnv('ARTIFACTSHARE_CONFIG_HOME', configHome)
  vi.stubEnv('ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE', '1')
  apiGet.mockReset().mockResolvedValue({
    body: {
      user: { id: 'owner1', email: 'owner@example.test' },
      workspace: { id: 'workspace1', hosted_domain: 'example.test' },
      auth: { kind: 'bearer_or_session', authority },
    },
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(configHome, { recursive: true, force: true })
})

test.each([undefined, 'unrestricted', 'agent'] as const)(
  'token import saves verified publisher scope over previous preset %s',
  async (preset) => {
    if (preset) await writeGlobalConfig({ profiles: { reports: { preset } } })
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
  },
)

test.each([
  { ...authority, preset: 'unknown' },
  { preset: 'publisher', project_id: null },
])(
  'token import rejects malformed authority without overwriting credentials: %j',
  async (invalidAuthority) => {
    await verifyAndStoreApiTokenProfile(
      'reports',
      'publisher-test-token',
      { baseUrl, allowPlaintextTokenStore: true },
      {},
    )
    const beforeConfig = await readFile(join(configHome, 'config.json'), 'utf8')
    const beforeTokens = await readFile(join(configHome, 'tokens.json'), 'utf8')
    apiGet.mockResolvedValue({
      body: {
        user: { email: 'owner@example.test' },
        workspace: { id: 'workspace1', hosted_domain: 'example.test' },
        auth: { kind: 'bearer_or_session', authority: invalidAuthority },
      },
    })
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
  },
)

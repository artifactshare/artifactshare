import { createHash, createHmac } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import { seedSession, seedUser, seedWorkspace } from '~/test/db-seed-fixture'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))
const authSecret = vi.hoisted(
  () => 'test-secret-with-enough-entropy-for-oauth-tests',
)

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(sqliteRef),
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: 'https://example.com',
  },
}))

import { createAuth, oauthAuthServerMetadataHandler } from './auth.server'
import { MCP_OAUTH_SCOPES } from '~/lib/mcp-metadata'

const LEGACY_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const
const REDIRECT_URI = 'https://client.example/callback'
const CODE_VERIFIER = 'scope-regression-pkce-verifier-with-enough-characters'

describe('OAuth scope configuration and compatibility', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof createMigratedInMemoryDb>['db']
  let sessionCookie: string

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    const sessionToken = 'scope-test-session'
    seedSession(sqlite, 'u1', sessionToken)
    const signature = createHmac('sha256', authSecret)
      .update(sessionToken)
      .digest('base64')
    sessionCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`
  })

  afterEach(async () => {
    sqliteRef.current = null
    await db.destroy()
  })

  test('authorization metadata advertises the configured MCP scope set', async () => {
    const response = await oauthAuthServerMetadataHandler(
      new Request('https://example.com/.well-known/oauth-authorization-server'),
    )

    expect(response.status).toBe(200)
    const body = await jsonObject(response)
    expect(body.scopes_supported).toEqual([...MCP_OAUTH_SCOPES])
  })

  test.each([
    { name: 'explicit', scope: LEGACY_SCOPES.join(' ') },
    { name: 'omitted', scope: undefined },
  ])(
    'authorization_code preserves a legacy client scope set with $name scope',
    async ({ scope }) => {
      insertLegacyClient()

      const response = await authorizationRequest(
        'legacy-client',
        scope === undefined ? {} : { scope },
      )

      await consentAndExchangeCode(response, 'legacy-client', LEGACY_SCOPES)
    },
  )

  test('authorization_code rejects the product scope for a client registered with only legacy scopes', async () => {
    insertLegacyClient()

    const response = await authorizationRequest('legacy-client', {
      scope: MCP_OAUTH_SCOPES.join(' '),
    })

    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get('location')!)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('error')).toBe('invalid_scope')
    expect(redirect.searchParams.get('error_description')).toContain(
      'artifactshare:access',
    )
    expect(redirect.searchParams.get('state')).toBe('scope-test-state')
    expect(redirect.searchParams.has('code')).toBe(false)
  })

  test('registration without scope defaults a new authorization_code connection to the configured product scopes', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      }),
    )

    expect(response.status).toBe(200)
    const registration = await jsonObject(response)
    const expectedScopes = [...LEGACY_SCOPES, 'artifactshare:access']
    expect(registration.scope).toBe(expectedScopes.join(' '))
    expect(registration.client_id).toEqual(expect.any(String))
    const clientId = String(registration.client_id)
    const client = sqlite
      .prepare('SELECT scopes FROM oauthClient WHERE clientId = ?')
      .get(clientId)
    expect(client?.scopes).toBe(JSON.stringify(expectedScopes))

    await consentAndExchangeCode(
      await authorizationRequest(clientId),
      clientId,
      expectedScopes,
    )
  })

  test('omitted-scope refresh inherits migrated stored scopes', async () => {
    const migratedScopes = [...LEGACY_SCOPES, 'artifactshare:access']
    insertRefreshToken('refresh-migrated', 'migrated-refresh', migratedScopes)

    const response = await refreshTokenRequest('migrated-refresh')

    expect(response.status).toBe(200)
    const body = await jsonObject(response)
    expect(body.scope).toBe(migratedScopes.join(' '))
    expectActiveRefreshTokenScopes(body.refresh_token, migratedScopes)
  })

  test('explicit legacy-only refresh remains legacy-only after migration', async () => {
    const migratedScopes = [...LEGACY_SCOPES, 'artifactshare:access']
    insertRefreshToken('refresh-migrated', 'migrated-refresh', migratedScopes)

    const response = await refreshTokenRequest('migrated-refresh', {
      scope: LEGACY_SCOPES.join(' '),
    })

    expect(response.status).toBe(200)
    const body = await jsonObject(response)
    expect(body.scope).toBe(LEGACY_SCOPES.join(' '))
    expectActiveRefreshTokenScopes(body.refresh_token, LEGACY_SCOPES)
  })

  test('refresh persists an explicitly requested subset of an existing token scope', async () => {
    insertRefreshToken('refresh-subset', 'subset-refresh', LEGACY_SCOPES)

    const response = await refreshTokenRequest('subset-refresh', {
      scope: 'openid offline_access',
    })

    expect(response.status).toBe(200)
    const body = await jsonObject(response)
    expect(body.scope).toBe('openid offline_access')
    // The provider also narrows the rotated refresh token to this subset.
    expectActiveRefreshTokenScopes(body.refresh_token, [
      'openid',
      'offline_access',
    ])
  })

  test('refresh rejects a scope that was not saved on the existing token', async () => {
    insertRefreshToken(
      'refresh-invalid-scope',
      'invalid-scope-refresh',
      LEGACY_SCOPES,
    )

    const response = await refreshTokenRequest('invalid-scope-refresh', {
      scope: 'artifactshare:access',
    })

    expect(response.status).toBe(400)
    expect((await jsonObject(response)).error).toBe('invalid_scope')
  })

  function insertLegacyClient() {
    sqlite
      .prepare(
        `INSERT INTO oauthClient (
           id, clientId, public, scopes, redirectUris,
           tokenEndpointAuthMethod, grantTypes, responseTypes
         ) VALUES ('legacy-client-row', 'legacy-client', 1, ?, ?, 'none',
           '["authorization_code","refresh_token"]', '["code"]')`,
      )
      .run(JSON.stringify(LEGACY_SCOPES), JSON.stringify([REDIRECT_URI]))
  }

  function authorizationRequest(
    clientId: string,
    fields: { scope?: string } = {},
  ) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'scope-test-state',
      code_challenge: createHash('sha256')
        .update(CODE_VERIFIER)
        .digest('base64url'),
      code_challenge_method: 'S256',
      ...fields,
    })
    return createAuth().handler(
      new Request(`https://example.com/api/auth/oauth2/authorize?${query}`, {
        headers: { cookie: sessionCookie },
      }),
    )
  }

  async function consentAndExchangeCode(
    response: Response,
    clientId: string,
    expectedScopes: readonly string[],
  ) {
    expect(response.status).toBe(302)
    const consentUrl = new URL(
      response.headers.get('location')!,
      'https://example.com',
    )
    expect(consentUrl.pathname).toBe('/consent')
    expect(consentUrl.searchParams.get('scope')).toBe(expectedScopes.join(' '))

    const consentResponse = await createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/consent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
          cookie: sessionCookie,
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentUrl.searchParams.toString(),
        }),
      }),
    )
    expect(consentResponse.status).toBe(200)
    const consent = await jsonObject(consentResponse)
    expect(consent).toMatchObject({ redirect: true, url: expect.any(String) })
    const callback = new URL(String(consent.url))
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI)
    expect(callback.searchParams.get('state')).toBe('scope-test-state')
    expect(callback.searchParams.get('code')).toBeTruthy()

    const tokenResponse = await createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code: callback.searchParams.get('code')!,
          code_verifier: CODE_VERIFIER,
        }),
      }),
    )
    expect(tokenResponse.status).toBe(200)
    expect(await jsonObject(tokenResponse)).toMatchObject({
      access_token: expect.any(String),
      scope: expectedScopes.join(' '),
    })
  }

  function insertRefreshToken(
    id: string,
    token: string,
    scopes: readonly string[],
  ) {
    sqlite
      .prepare(
        `INSERT INTO oauthClient (id, clientId, public, redirectUris)
         VALUES ('client-row', 'client-1', 1, '[]')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO oauthRefreshToken (
           id, token, clientId, userId, expiresAt, createdAt, scopes
         ) VALUES (?, ?, 'client-1', 'u1', '2099-01-01T00:00:00.000Z',
           '2026-09-18T00:00:00.000Z', ?)`,
      )
      .run(
        id,
        createHash('sha256').update(token).digest('base64url'),
        JSON.stringify(scopes),
      )
  }

  function refreshTokenRequest(
    refreshToken: string,
    fields: { scope?: string } = {},
  ) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'client-1',
      refresh_token: refreshToken,
      ...fields,
    })
    return createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    )
  }

  function expectActiveRefreshTokenScopes(
    token: unknown,
    expectedScopes: readonly string[],
  ) {
    expect(token).toEqual(expect.any(String))
    const activeTokens = sqlite
      .prepare(
        `SELECT token, scopes FROM oauthRefreshToken
         WHERE clientId = ? AND userId = ? AND revoked IS NULL`,
      )
      .all('client-1', 'u1')
    expect(activeTokens).toEqual([
      {
        token: createHash('sha256').update(String(token)).digest('base64url'),
        scopes: JSON.stringify(expectedScopes),
      },
    ])
  }

  async function jsonObject(response: Response) {
    return (await response.json()) as Record<string, unknown>
  }
})

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
    sqlite.exec(`INSERT INTO oauthResource (id, identifier, name)
      VALUES ('mcp', 'https://example.com/mcp', 'MCP')`)
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

  test.each([
    REDIRECT_URI,
    'http://localhost:54321/callback',
    'http://127.0.0.1:54321/callback',
    'com.example.mcp:/callback',
  ])(
    'registration without application_type or scope supports %s',
    async (redirectUri) => {
      const response = await createAuth().handler(
        new Request('https://example.com/api/auth/oauth2/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
          }),
        }),
      )

      expect(response.status).toBe(201)
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
        await authorizationRequest(clientId, {}, redirectUri),
        clientId,
        expectedScopes,
        redirectUri,
      )
    },
  )

  test.each([
    { name: 'omitted', fields: {} },
    {
      name: 'explicit full legacy',
      fields: { scope: LEGACY_SCOPES.join(' ') },
    },
  ])(
    '$name scope refresh preserves unmigrated legacy-only scopes',
    async ({ fields }) => {
      insertRefreshToken('refresh-legacy', 'legacy-refresh', LEGACY_SCOPES)

      const response = await refreshTokenRequest('legacy-refresh', fields)

      expect(response.status).toBe(200)
      const body = await jsonObject(response)
      expect(body.scope).toBe(LEGACY_SCOPES.join(' '))
      expectActiveRefreshTokenScopes(body.refresh_token, LEGACY_SCOPES)
    },
  )

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

  test('dynamic registration cannot request another protected resource', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          resources: ['https://other.example/mcp'],
        }),
      }),
    )
    expect(response.status).toBe(400)
    expect(await jsonObject(response)).toMatchObject({
      error: 'invalid_target',
    })
  })

  test('sign-out revokes session-bound access tokens while preserving offline refresh and disabling the session JWT endpoint', async () => {
    insertRefreshToken(
      'session-refresh',
      'session-refresh-secret',
      LEGACY_SCOPES,
    )
    sqlite.exec(`UPDATE oauthRefreshToken SET sessionId = 'sess1';
      INSERT INTO oauthAccessToken (id, token, clientId, userId, sessionId, expiresAt, createdAt, scopes)
      VALUES ('session-access', 'opaque-access-secret', 'client-1', 'u1', 'sess1',
        '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '["openid"]')`)
    const disabled = await createAuth().handler(
      new Request('https://example.com/api/auth/token', {
        headers: { cookie: sessionCookie },
      }),
    )
    expect(disabled.status).toBe(404)
    const signedOut = await createAuth().handler(
      new Request('https://example.com/api/auth/sign-out', {
        method: 'POST',
        headers: {
          cookie: sessionCookie,
          origin: 'https://example.com',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    expect(signedOut.status).toBe(200)
    expect(
      sqlite.prepare("SELECT id FROM sessions WHERE id = 'sess1'").get(),
    ).toBeUndefined()
    expect(
      sqlite
        .prepare(
          "SELECT revoked FROM oauthAccessToken WHERE id = 'session-access'",
        )
        .get(),
    ).toEqual({ revoked: expect.any(String) })
    // offline_access deliberately survives the browser session ending.
    expect((await refreshTokenRequest('session-refresh-secret')).status).toBe(
      200,
    )
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
    bindClientResource('legacy-client')
  }

  function authorizationRequest(
    clientId: string,
    fields: { scope?: string } = {},
    redirectUri = REDIRECT_URI,
  ) {
    const query = new URLSearchParams({
      response_type: 'code',
      resource: 'https://example.com/mcp',
      client_id: clientId,
      redirect_uri: redirectUri,
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
    redirectUri = REDIRECT_URI,
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
    const callbackTarget = new URL(callback)
    callbackTarget.search = ''
    expect(callbackTarget.href).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe('scope-test-state')
    expect(callback.searchParams.get('code')).toBeTruthy()

    const tokenResponse = await createAuth().handler(
      new Request('https://example.com/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          resource: 'https://example.com/mcp',
          redirect_uri: redirectUri,
          code: callback.searchParams.get('code')!,
          code_verifier: CODE_VERIFIER,
        }),
      }),
    )
    expect(tokenResponse.status).toBe(200)
    const tokenBody = await jsonObject(tokenResponse)
    expect(tokenBody).toMatchObject({
      access_token: expect.any(String),
      scope: expectedScopes.join(' '),
    })
    const accessTokenPayload = decodeJwtPayload(tokenBody.access_token)
    expect(accessTokenPayload.aud).toEqual([
      'https://example.com/mcp',
      'https://example.com/api/auth/oauth2/userinfo',
    ])
    expect(typeof accessTokenPayload.scope).toBe('string')
    expect(accessTokenPayload.scope).toBe(expectedScopes.join(' '))
  }

  function insertRefreshToken(
    id: string,
    token: string,
    scopes: readonly string[],
  ) {
    sqlite
      .prepare(
        `INSERT INTO oauthClient (id, clientId, public, redirectUris, tokenEndpointAuthMethod)
         VALUES ('client-row', 'client-1', 1, '[]', 'none')`,
      )
      .run()
    bindClientResource('client-1')
    sqlite
      .prepare(
        `INSERT INTO oauthRefreshToken (
           id, token, clientId, userId, expiresAt, createdAt, scopes, resources
         ) VALUES (?, ?, 'client-1', 'u1', '2099-01-01T00:00:00.000Z',
           '2026-09-18T00:00:00.000Z', ?, '["https://example.com/mcp"]')`,
      )
      .run(
        id,
        createHash('sha256').update(token).digest('base64url'),
        JSON.stringify(scopes),
      )
  }

  function bindClientResource(clientId: string) {
    sqlite
      .prepare(`INSERT INTO oauthClientResource (id, clientId, resourceId)
      VALUES (?, ?, 'https://example.com/mcp')`)
      .run(clientId, clientId)
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

  function decodeJwtPayload(token: unknown): Record<string, unknown> {
    expect(token).toEqual(expect.any(String))
    const payload = String(token).split('.')[1]
    expect(payload).toBeTruthy()
    return JSON.parse(
      Buffer.from(payload!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
  }
})

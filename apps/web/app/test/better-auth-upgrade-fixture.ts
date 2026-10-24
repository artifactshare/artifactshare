import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { unstable_splitSqlQuery } from 'wrangler'
import { expect, vi } from 'vitest'

export const upgradeEnvironment = {
  DB: undefined as D1Database | undefined,
  BETTER_AUTH_URL: 'https://artifactshare.com',
  BETTER_AUTH_SECRET: Buffer.from(randomBytes(32)).toString('hex'),
  MICROSOFT_CLIENT_ID: 'upgrade-microsoft-client',
  MICROSOFT_CLIENT_SECRET: 'upgrade-microsoft-secret',
}
const environment = upgradeEnvironment
const resource = `${environment.BETTER_AUTH_URL}/mcp`
const tenant = '11111111-1111-4111-8111-111111111111'
const objectId = '22222222-2222-4222-8222-222222222222'

async function executeSqlBatch(database: D1Database, sql: string) {
  await database.batch(
    unstable_splitSqlQuery(sql).map((statement) => database.prepare(statement)),
  )
}

export async function applyPreUpgradeSchema(
  database: D1Database,
  execute: (sql: string) => Promise<unknown> = (sql) =>
    executeSqlBatch(database, sql),
) {
  // Reproduce the last 1.6 schema using the D1 rebuild baseline.
  const migrations = new URL('../../db/migrations/', import.meta.url)
  const baseline = '0055_d1_name_cutover_clean_rebuild_v2.sql'
  await execute(
    readFileSync(
      new URL(`../../db/baselines/${baseline}`, import.meta.url),
      'utf8',
    ),
  )
  for (const name of readdirSync(migrations).sort()) {
    if (name > baseline && name < '0118_better_auth_1_7.sql') {
      await execute(readFileSync(new URL(name, migrations), 'utf8'))
    }
  }
}

export async function assertBetterAuthUpgrade(
  database: D1Database,
  createAuth: typeof import('../services/auth.server').createAuth,
) {
  const executeSql = (sql: string) => executeSqlBatch(database, sql)
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'upgrade-test-key',
    use: 'sig',
    alg: 'RS256',
  }
  const microsoftToken = (oid = objectId) => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: jwk.kid }),
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        tid: tenant,
        ...(oid ? { oid } : {}),
        // A changed email makes recovery depend on account identity, not linking.
        email: 'renamed@example.com',
        preferred_username: 'renamed@example.com',
        name: 'Existing User',
        iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
        sub: 'pairwise-subject',
        aud: environment.MICROSOFT_CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url')
    const input = `${header}.${payload}`
    return `${input}.${Buffer.from(sign('RSA-SHA256', Buffer.from(input), keys.privateKey)).toString('base64url')}`
  }
  const idToken = await microsoftToken()
  await executeSql(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('upgrade-ws', 'Example', '2026-01-01');
    INSERT INTO users (id, email, email_verified, name, workspace_id, created_at, updated_at)
      VALUES ('upgrade-user', 'original@example.com', 1, 'Existing User', 'upgrade-ws', '2026-01-01', '2026-01-01');
    INSERT INTO accounts (id, user_id, provider_id, account_id, id_token, created_at, updated_at)
      VALUES ('upgrade-account', 'upgrade-user', 'microsoft', '${tenant}:${objectId}', '${idToken}', '2026-01-01', '2026-01-01');
    INSERT INTO oauthClient (id, clientId, public, redirectUris)
      VALUES ('upgrade-client-row', 'upgrade-client', 1, '["https://client.example/callback"]');
    INSERT INTO oauthRefreshToken (id, token, clientId, userId, expiresAt, createdAt, scopes)
      VALUES ('upgrade-refresh', '${createHash('sha256').update('old-refresh-token').digest('base64url')}',
        'upgrade-client', 'upgrade-user', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '["offline_access","artifactshare:access"]');
    INSERT INTO deviceCode (id, deviceCode, userCode, expiresAt, status)
      VALUES ('upgrade-device', 'device-secret', 'ABCD-EFGH', '2099-01-01T00:00:00.000Z', 'pending');
  `)
  await executeSql(
    readFileSync(
      new URL('../../db/migrations/0118_better_auth_1_7.sql', import.meta.url),
      'utf8',
    ),
  )

  expect(
    await database
      .prepare(
        'SELECT account_id, user_id, id_token FROM accounts WHERE id = ?',
      )
      .bind('upgrade-account')
      .first(),
  ).toEqual({
    account_id: objectId,
    user_id: 'upgrade-user',
    id_token: idToken,
  })
  expect(
    await database
      .prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
      .bind('upgrade-client')
      .first(),
  ).toEqual({ resourceId: resource })
  expect(
    await database
      .prepare('SELECT resources FROM oauthRefreshToken WHERE id = ?')
      .bind('upgrade-refresh')
      .first(),
  ).toEqual({ resources: JSON.stringify([resource]) })
  expect(
    await database
      .prepare('SELECT deviceCode, userCode FROM deviceCode WHERE id = ?')
      .bind('upgrade-device')
      .first(),
  ).toEqual({ deviceCode: 'device-secret', userCode: 'ABCD-EFGH' })
  await expect(
    database
      .prepare(`INSERT INTO deviceCode (id, deviceCode, userCode, expiresAt, status)
    VALUES ('duplicate-device', 'other-secret', 'ABCD-EFGH', '2099-01-01', 'pending')`)
      .run(),
  ).rejects.toThrow()
  await expect(
    database
      .prepare(`INSERT INTO oauthClientResource (id, clientId, resourceId)
    VALUES ('duplicate-link', 'upgrade-client', ?)`)
      .bind(resource)
      .run(),
  ).rejects.toThrow()

  const auth = createAuth()
  const context = await auth.$context
  expect(context.explicitSchemaCheck).toBeTypeOf('function')
  await context.explicitSchemaCheck!()

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (
        url ===
        'https://login.microsoftonline.com/organizations/discovery/v2.0/keys'
      ) {
        return Promise.resolve(Response.json({ keys: [jwk] }))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }),
  )
  const signIn = (token: string) =>
    auth.handler(
      new Request(`${environment.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'microsoft', idToken: { token } }),
      }),
    )
  const signedIn = await signIn(idToken)
  expect(signedIn.status, await signedIn.clone().text()).toBe(200)
  expect(await signedIn.json()).toMatchObject({ user: { id: 'upgrade-user' } })
  expect((await signIn(microsoftToken(''))).status).toBe(401)
  expect(
    await database.prepare('SELECT count(*) AS count FROM users').first(),
  ).toEqual({ count: 1 })

  const refresh = (token: string, requestedResource?: string) =>
    auth.handler(
      new Request(`${environment.BETTER_AUTH_URL}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'upgrade-client',
          refresh_token: token,
          ...(requestedResource ? { resource: requestedResource } : {}),
        }),
      }),
    )
  const refreshed = await refresh('old-refresh-token')
  expect(refreshed.status, await refreshed.clone().text()).toBe(200)
  const tokens = (await refreshed.json()) as {
    access_token: string
    refresh_token: string
  }
  const jwksResponse = await auth.handler(
    new Request(`${environment.BETTER_AUTH_URL}/api/auth/jwks`),
  )
  const jwks = (await jwksResponse.json()) as {
    keys: Array<{
      kty: string
      kid?: string
      alg?: string
      crv?: string
      x?: string
      n?: string
      e?: string
    }>
  }
  const claims = await verifyJwsAccessToken(tokens.access_token, {
    jwksFetch: () => Promise.resolve(jwks),
    verifyOptions: {
      audience: resource,
      issuer: `${environment.BETTER_AUTH_URL}/api/auth`,
    },
  })
  expect(claims).toMatchObject({ sub: 'upgrade-user', aud: resource })
  const rejected = await refresh(
    tokens.refresh_token,
    'https://other.example/mcp',
  )
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ error: 'invalid_target' })
  // A rejected target must not consume the carried-over refresh credential.
  expect((await refresh(tokens.refresh_token)).status).toBe(200)
}

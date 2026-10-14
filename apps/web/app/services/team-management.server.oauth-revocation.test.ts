import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1BatchFixture } from '~/test/d1-batch-mock'
import { createD1MockFromSqliteRef } from '~/test/sqlite-fixture'
import { seedSession, seedUser, seedWorkspace } from '~/test/db-seed-fixture'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null as
    | ((stmts: { sql: string; params: unknown[] }[]) => void)
    | null,
}))
const authSecret = vi.hoisted(
  () => 'test-secret-with-enough-entropy-for-oauth-tests',
)
const handled = vi.hoisted(() => vi.fn())
vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(sqliteRef),
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: 'https://example.com',
  },
}))
vi.mock('./mcp/server.server', () => ({
  createMcpServer: () => ({ connect: async () => {} }),
}))
vi.mock(
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js',
  () => ({
    WebStandardStreamableHTTPServerTransport: class {
      handleRequest() {
        handled()
        return new Response('ok')
      }
    },
  }),
)
import { createAuth } from './auth.server'
import { createApiToken, findUserByApiToken } from './api-tokens.server'
import { handleMcpRequest } from './mcp/transport.server'
import {
  removeWorkspaceMember,
  restoreWorkspaceMember,
} from './team-management.server'
import { MCP_OAUTH_SCOPES } from '~/lib/mcp-metadata'

const REDIRECT_URI = 'https://client.example/callback'
const CODE_VERIFIER = 'scope-regression-pkce-verifier-with-enough-characters'
let sqlite: DatabaseSync
let db: ReturnType<typeof createD1BatchFixture>['db']
let sessionCookie: string

function login() {
  const token = randomUUID()
  seedSession(sqlite, 'u1', token)
  const signature = createHmac('sha256', authSecret)
    .update(token)
    .digest('base64')
  sessionCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

beforeEach(() => {
  const fixture = createD1BatchFixture({ sqlite: sqliteRef })
  sqlite = fixture.sqlite
  db = fixture.db
  sqliteRef.current = sqlite
  sqliteRef.beforeNextBatch = null
  seedWorkspace(sqlite)
  seedUser(sqlite, 'u1')
  seedUser(sqlite, 'u2')
  sqlite.exec(
    "UPDATE workspaces SET plan = 'team'; INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES ('ws1', 'u1', 'member', 'active', '2026-01-01', '2026-01-01'), ('ws1', 'u2', 'owner', 'active', '2026-01-01', '2026-01-01')",
  )
  login()
})
afterEach(async () => {
  sqliteRef.current = null
  await db.destroy()
})

async function issue(): Promise<
  Record<string, unknown> & { clientId: string }
> {
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
  const client = await jsonObject(response)
  const clientId = String(client.client_id)
  return {
    clientId,
    ...(await consentAndExchangeCode(
      await authorizationRequest(clientId),
      clientId,
      MCP_OAUTH_SCOPES,
    )),
  }
}
async function refresh(clientId: string, token: unknown) {
  return createAuth().handler(
    new Request('https://example.com/api/auth/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: String(token),
        resource: 'https://example.com/mcp',
      }),
    }),
  )
}
async function mcp(token: unknown) {
  return handleMcpRequest(
    new Request('https://example.com/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${String(token)}` },
    }),
    { waitUntil: vi.fn() } as unknown as ExecutionContext,
  )
}

test('real OAuth JWTs and refresh exchanges stop on removal and new personal authorization works', async () => {
  const old = await issue()
  expect(decodeJwtPayload(old.access_token).oauth_token_version).toBe(0)
  expect((await mcp(old.access_token)).status).toBe(200)
  const legacy = await signLegacy('u1')
  const other = await signLegacy('u2')
  expect((await mcp(legacy)).status).toBe(200)
  expect((await mcp(other)).status).toBe(200)
  sqlite.exec('UPDATE oauthRefreshToken SET sessionId = NULL')
  const exchange = await refresh(old.clientId, old.refresh_token)
  expect(exchange.status).toBe(200)
  const rotated = await jsonObject(exchange)
  expect(decodeJwtPayload(rotated.access_token).sid).toBeNull()
  expect((await mcp(rotated.access_token)).status).toBe(200)
  const actor = { id: 'u2', workspaceId: 'ws1' }
  expect(await removeWorkspaceMember(db, actor, 'u1')).toEqual({ kind: 'ok' })
  handled.mockClear()
  expect((await mcp(old.access_token)).status).toBe(401)
  expect((await mcp(rotated.access_token)).status).toBe(401)
  expect((await mcp(legacy)).status).toBe(401)
  expect(handled).not.toHaveBeenCalled()
  expect((await mcp(other)).status).toBe(200)
  expect((await refresh(old.clientId, rotated.refresh_token)).status).toBe(400)
  login()
  const fresh = await issue()
  expect(decodeJwtPayload(fresh.access_token).oauth_token_version).toBe(1)
  expect((await mcp(fresh.access_token)).status).toBe(200)
  expect((await refresh(fresh.clientId, fresh.refresh_token)).status).toBe(200)
  await restoreWorkspaceMember(db, actor, 'u1')
  expect((await mcp(old.access_token)).status).toBe(401)
})

test('replaying old refresh tokens cannot invalidate a fresh authorization for the same client', async () => {
  const old = await issue()
  // Keep both a previously rotated token and its active successor. Both old
  // rows must disappear so neither replay can invalidate the new family.
  const rotatedResponse = await refresh(old.clientId, old.refresh_token)
  expect(rotatedResponse.status).toBe(200)
  const rotated = await jsonObject(rotatedResponse)
  expect(
    await removeWorkspaceMember(db, { id: 'u2', workspaceId: 'ws1' }, 'u1'),
  ).toEqual({ kind: 'ok' })
  login()
  const fresh = await consentAndExchangeCode(
    await authorizationRequest(old.clientId, { prompt: 'consent' }),
    old.clientId,
    MCP_OAUTH_SCOPES,
  )
  expect(decodeJwtPayload(fresh.access_token).oauth_token_version).toBe(1)
  expect((await mcp(fresh.access_token)).status).toBe(200)
  expect((await refresh(old.clientId, old.refresh_token)).status).toBe(400)
  expect((await refresh(old.clientId, rotated.refresh_token)).status).toBe(400)
  const nextResponse = await refresh(old.clientId, fresh.refresh_token)
  expect(nextResponse.status).toBe(200)
  const next = await jsonObject(nextResponse)
  expect((await mcp(next.access_token)).status).toBe(200)
  expect((await mcp(old.access_token)).status).toBe(401)
  expect((await mcp(rotated.access_token)).status).toBe(401)
})

test('failed removal preserves the workspace and credentials; retry rejects them', async () => {
  const old = await issue()
  const api = await createApiToken(db, 'u1', 'existing')
  sqlite.exec(
    "CREATE TRIGGER fail_removal BEFORE UPDATE OF status ON workspace_members WHEN NEW.status = 'removed' BEGIN SELECT RAISE(ABORT, 'induced removal failure'); END",
  )
  await expect(
    removeWorkspaceMember(db, { id: 'u2', workspaceId: 'ws1' }, 'u1'),
  ).rejects.toThrow('induced removal failure')
  expect(await findUserByApiToken(db, api.token)).not.toBeNull()
  expect((await mcp(old.access_token)).status).toBe(200)
  const exchange = await refresh(old.clientId, old.refresh_token)
  expect(exchange.status).toBe(200)
  const rotated = await jsonObject(exchange)
  expect(
    sqlite
      .prepare("SELECT oauth_token_version FROM users WHERE id = 'u1'")
      .get(),
  ).toEqual({ oauth_token_version: 0 })
  expect(
    sqlite
      .prepare(
        "SELECT status FROM workspace_members WHERE workspace_id = 'ws1' AND user_id = 'u1'",
      )
      .get(),
  ).toEqual({ status: 'active' })
  expect(
    sqlite
      .prepare("SELECT id FROM audit_events WHERE action = 'member.remove'")
      .all(),
  ).toEqual([])
  expect(
    sqlite.prepare("SELECT workspace_id FROM users WHERE id = 'u1'").get(),
  ).toEqual({ workspace_id: 'ws1' })
  expect(sqlite.prepare('SELECT count(*) AS n FROM workspaces').get()).toEqual({
    n: 1,
  })
  sqlite.exec('DROP TRIGGER fail_removal')
  expect(
    await removeWorkspaceMember(db, { id: 'u2', workspaceId: 'ws1' }, 'u1'),
  ).toEqual({ kind: 'ok' })
  expect(await findUserByApiToken(db, api.token)).toBeNull()
  expect((await mcp(old.access_token)).status).toBe(401)
  expect((await mcp(rotated.access_token)).status).toBe(401)
  expect((await refresh(old.clientId, rotated.refresh_token)).status).toBe(400)
})

function authorizationRequest(
  clientId: string,
  fields: { scope?: string; prompt?: string } = {},
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
        resource: 'https://example.com/mcp',
        redirect_uri: REDIRECT_URI,
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
  expect(typeof accessTokenPayload.scope).toBe('string')
  expect(accessTokenPayload.scope).toBe(expectedScopes.join(' '))
  return tokenBody
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

async function signLegacy(sub: string) {
  const api = createAuth().api as unknown as {
    signJWT: (input: {
      body: { payload: Record<string, unknown> }
    }) => Promise<{ token: string }>
  }
  const { token } = await api.signJWT({
    body: {
      payload: {
        sub,
        azp: 'client-1',
        scope: 'artifactshare:access',
        iss: 'https://example.com/api/auth',
        aud: 'https://example.com/mcp',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  })
  return token
}

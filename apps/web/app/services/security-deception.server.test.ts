import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import { seedSession, seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import type { Db } from './db.server'

const state = vi.hoisted(() => ({ current: null as DatabaseSync | null }))
const transport = vi.hoisted(() => vi.fn())
const syntheticCookieKey = vi.hoisted(() => 'synthetic-cookie-verification-key')
const authEnv = vi.hoisted(() => ({
  APP_ENV: 'production',
  BETTER_AUTH_URL: 'https://app.example.test',
  BETTER_AUTH_SECRET: syntheticCookieKey,
}))
vi.mock('cloudflare:workers', () => ({
  env: Object.assign(authEnv, { DB: createD1MockFromSqliteRef(state) }),
}))
vi.mock('./slack.server', () => ({ postSlackWebhook: transport }))
vi.mock('./auth.server', () => ({
  readBearerSessionToken: (request: Request) => {
    const header = request.headers.get('authorization')
    if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return null
    return decodeURIComponent(header.slice(7).trim()).split('.')[0] || null
  },
}))
import {
  admitDeceptionSignal,
  claimDeceptionSignals,
  DECEPTION_PATH,
  deceptionDigest,
  drainDeceptionSignals,
  handleDeceptionRequest,
  reserveDeceptionDelivery,
} from './security-deception.server'
import {
  resolveDeceptionIdentity,
  type DeceptionPrincipal,
} from './security-deception-auth.server'
import { createApiToken } from './api-tokens.server'
import { cleanupExpiredDeceptionSignals } from './security-audit.server'
import { mcpResourceUrl, oauthIssuer } from '~/lib/mcp-metadata'

const at = Date.parse('2026-11-15T12:00:00.000Z')
const principal: DeceptionPrincipal = {
  actor_id: 'u1',
  actor_kind: 'human',
  workspace_id: 'ws1',
  auth_route: 'cookie',
  client_kind: null,
  client_id: null,
  authority_kind: null,
  agent_profile_id: null,
  publisher_client_id: null,
}
let db: Db
let sqlite: DatabaseSync
let logs: ReturnType<typeof vi.spyOn>
let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  authEnv.APP_ENV = 'production'
  Object.assign(authEnv, { BETTER_AUTH_SECRET: syntheticCookieKey })
  const fixture = createMigratedInMemoryDb()
  db = fixture.db
  sqlite = fixture.sqlite
  state.current = sqlite
  seedWorkspace(sqlite)
  seedUser(sqlite, 'u1')
  seedSession(sqlite, 'u1', 'synthetic-session')
  sqlite.exec(
    "INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES ('ws1','u1','owner','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  )
  logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  transport.mockReset().mockResolvedValue({ ok: true })
})
afterEach(async () => {
  state.current = null
  await db.destroy()
  vi.restoreAllMocks()
})
function cookie() {
  const value = 'synthetic-session'
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${value}.${createHmac('sha256', authEnv.BETTER_AUTH_SECRET).update(value).digest('base64')}`)}`
}
function probe(headers: HeadersInit = {}, method = 'POST') {
  return new Request(
    `${authEnv.BETTER_AUTH_URL}${DECEPTION_PATH}?secret=CANARY_QUERY`,
    {
      method,
      headers: {
        'X-ArtifactShare-Inventory': 'inspect',
        cookie: cookie(),
        ...headers,
      },
      ...(method === 'POST' ? { body: 'CANARY_BODY' } : {}),
    },
  )
}
async function rows() {
  return db
    .selectFrom('security_deception_signals')
    .selectAll()
    .orderBy('id')
    .execute()
}
function snapshot() {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'security_deception_%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[]
  return tables.map(({ name }) => [
    name,
    sqlite.prepare(`SELECT * FROM "${name}"`).all(),
  ])
}
function oauth(overrides: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const id = crypto.randomUUID()
  sqlite
    .prepare(
      'INSERT INTO jwks(id,publicKey,privateKey,createdAt) VALUES (?,?,?,?)',
    )
    .run(
      id,
      JSON.stringify(publicKey.export({ format: 'jwk' })),
      'unused-synthetic-private-key',
      new Date().toISOString(),
    )
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', kid: id }),
  ).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'u1',
      azp: 'verified-client',
      iss: oauthIssuer(authEnv.BETTER_AUTH_URL),
      aud: mcpResourceUrl(authEnv.BETTER_AUTH_URL),
      scope: 'artifactshare:access',
      exp: Math.floor(Date.now() / 1000) + 3600,
      oauth_token_version: 0,
      sid: 'sess1',
      ...overrides,
    }),
  ).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`
}

describe('read-only attributed probes', () => {
  test.each(['cookie', 'api_token', 'cli_session', 'oauth'] as const)(
    'accepts %s with no product changes or content reads',
    async (route) => {
      const token =
        route === 'api_token'
          ? (await createApiToken(db, 'u1', 'synthetic')).token
          : route === 'oauth'
            ? oauth()
            : 'synthetic-session'
      const before = snapshot()
      const reads = vi.spyOn(sqlite, 'prepare')
      const request = probe(
        route === 'cookie'
          ? { 'x-client-id': 'CANARY_FORGED' }
          : {
              authorization: `Bearer ${token}`,
              'x-workspace-id': 'CANARY_FORGED',
            },
      )
      const response = await handleDeceptionRequest(
        request,
        authEnv.BETTER_AUTH_URL,
      )
      const queries = reads.mock.calls.map(([query]) => query)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('')
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.has('set-cookie')).toBe(false)
      expect(response.headers.has('access-control-allow-origin')).toBe(false)
      expect(queries.join('\n')).not.toMatch(
        /(?:from|join) ["`]*(shareables|versions|artifact_containers|slack_workspaces|accounts)/i,
      )
      expect(queries.join('\n')).not.toMatch(
        /(?:users["`]*\.["`]*)(?:email|name)/i,
      )
      expect(snapshot()).toEqual(before)
      expect(await rows()).toMatchObject([
        { actor_id: 'u1', workspace_id: 'ws1', auth_route: route },
      ])
      await drainDeceptionSignals(db, 'https://synthetic.invalid/webhook')
      const visible = JSON.stringify([
        await rows(),
        logs.mock.calls,
        errors.mock.calls,
        transport.mock.calls,
      ])
      expect(visible).not.toMatch(
        /CANARY_|synthetic-session|synthetic-cookie-verification-key/,
      )
    },
  )
  test.each([
    ['GET', {}],
    ['HEAD', {}],
    ['OPTIONS', {}],
    ['PUT', {}],
    ['POST', { 'X-ArtifactShare-Inventory': '' }],
    ['POST', { 'X-ArtifactShare-Inventory': 'Inspect' }],
    ['POST', { purpose: 'prefetch' }],
    ['POST', { 'sec-purpose': 'prefetch;prerender' }],
    ['POST', { origin: 'https://cross.example.test' }],
    ['POST', { 'sec-fetch-site': 'cross-site' }],
  ] as [string, Record<string, string>][])(
    'ignores noise %s %j before auth',
    async (method, headers) => {
      const prepare = vi.spyOn(sqlite, 'prepare')
      expect(
        (
          await handleDeceptionRequest(
            probe(headers, method),
            authEnv.BETTER_AUTH_URL,
          )
        ).status,
      ).toBe(404)
      expect(prepare).not.toHaveBeenCalled()
      expect(await rows()).toHaveLength(0)
    },
  )
  test.each([
    'Bearer invalid',
    'Basic synthetic',
    'Bearer synthetic-session.payload.signature',
    '',
  ])(
    'explicit bad authorization never falls back: %s',
    async (authorization) => {
      expect(
        (
          await handleDeceptionRequest(
            probe({ authorization }),
            authEnv.BETTER_AUTH_URL,
          )
        ).status,
      ).toBe(404)
      expect(await rows()).toHaveLength(0)
    },
  )
  test.each([
    'DELETE FROM sessions',
    "UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'",
    'DELETE FROM workspace_members',
    "UPDATE workspace_members SET status='removed'",
  ])('revocation/expiry/member denial is read-only: %s', async (mutation) => {
    sqlite.exec(mutation)
    const before = snapshot()
    const request = probe({
      cookie: `${cookie()}; __Secure-better-auth.session_data=CANARY_CACHE`,
    })
    expect(
      (await handleDeceptionRequest(request, authEnv.BETTER_AUTH_URL)).status,
    ).toBe(404)
    expect(snapshot()).toEqual(before)
    expect(await rows()).toHaveLength(0)
  })
  test.each([
    `${cookie()}; ${cookie()}`,
    'better-auth.session_token=unsigned',
    '__Secure-better-auth.session_token=%XX',
    '__Secure-better-auth.session_token=synthetic-session.invalid',
  ])('rejects ambiguous/unsigned/invalid cookie %s', async (value) => {
    expect(
      (await resolveDeceptionIdentity(db, probe({ cookie: value }))).kind,
    ).toBe('unauthenticated')
  })
  test.each([
    { iss: 'https://forged.invalid' },
    { aud: 'other' },
    { scope: 'openid' },
    { exp: 1 },
    { oauth_token_version: 1 },
    { oauth_token_version: -1 },
    { sid: 'deleted' },
    { sub: '' },
    { azp: '', client_id: '' },
  ])('rejects signed but unauthorized OAuth claims %j', async (claims) => {
    const token = oauth(claims)
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: `Bearer ${token}` }),
        )
      ).kind,
    ).toBe('unauthenticated')
  })
  test('rejects invalid signature and reports missing keys/database safely', async () => {
    const token = oauth()
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: `Bearer ${token.slice(0, -10)}aaaaaaaaaa` }),
        )
      ).kind,
    ).toBe('unauthenticated')
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation(() => {
      throw new Error('CANARY_DATABASE_ERROR')
    })
    expect(
      (await handleDeceptionRequest(probe(), authEnv.BETTER_AUTH_URL)).status,
    ).toBe(503)
    expect(JSON.stringify(errors.mock.calls)).not.toContain('CANARY')
    prepare.mockRestore()
  })
  test.each(['cookie', 'oauth'] as const)(
    'rejects bot %s identities',
    async (route) => {
      sqlite.exec(
        "INSERT INTO users(id,email,created_at,updated_at,workspace_id,kind) VALUES ('bot','bot@example.test','2026-01-01','2026-01-01','ws1','bot'); UPDATE sessions SET user_id='bot'",
      )
      const token = route === 'oauth' ? oauth({ sub: 'bot' }) : null
      const request = probe(token ? { authorization: `Bearer ${token}` } : {})
      expect((await resolveDeceptionIdentity(db, request)).kind).toBe(
        'unauthenticated',
      )
      expect(await rows()).toHaveLength(0)
    },
  )
  test('bot API credentials cannot be created under the canonical schema', async () => {
    sqlite.exec(
      "INSERT INTO users(id,email,created_at,updated_at,workspace_id,kind) VALUES ('bot','bot@example.test','2026-01-01','2026-01-01','ws1','bot')",
    )
    await expect(createApiToken(db, 'bot', 'synthetic')).rejects.toThrow(
      'api tokens are not available to bot users',
    )
    expect(await rows()).toHaveLength(0)
  })
  test('missing keys are unavailable with no key generation', async () => {
    const token = oauth()
    sqlite.exec('DELETE FROM jwks')
    const before = snapshot()
    expect(
      (
        await handleDeceptionRequest(
          probe({ authorization: `Bearer ${token}` }),
          authEnv.BETTER_AUTH_URL,
        )
      ).status,
    ).toBe(503)
    expect(snapshot()).toEqual(before)
    expect(await rows()).toHaveLength(0)
  })
  test('accepts scoped CLI identifiers without project content or name reads', async () => {
    sqlite.exec(`INSERT INTO artifact_containers(id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('project','ws1','project','u1','u1','CANARY_PROJECT','2026-01-01','2026-01-01');
      INSERT INTO agent_profiles(id,user_id,workspace_id,created_at) VALUES ('agent','u1','ws1','2026-01-01');
      INSERT INTO cli_family_authorities(family_id,user_id,preset,workspace_id,project_id,project_name_snapshot,agent_profile_id,approved_at,status,created_at,updated_at) VALUES ('family','u1','agent','ws1','project','CANARY_PROJECT','agent','2026-01-01','active','2026-01-01','2026-01-01');
      INSERT INTO cli_session_authorities(session_id,family_id,kind,preset,bearer_only,created_at) VALUES ('sess1','family','family','agent',1,'2026-01-01');`)
    const before = snapshot()
    const prepare = vi.spyOn(sqlite, 'prepare')
    const result = await resolveDeceptionIdentity(
      db,
      probe({ authorization: 'Bearer synthetic-session' }),
    )
    const queries = prepare.mock.calls.map(([query]) => query).join('\n')
    expect(result).toMatchObject({
      kind: 'trusted',
      principal: {
        authority_kind: 'agent',
        agent_profile_id: 'agent',
        client_kind: 'agent_profile',
        client_id: 'agent',
      },
    })
    expect(queries).not.toMatch(/from "artifact_containers"/i)
    expect(JSON.stringify(result)).not.toContain('CANARY')
    expect(snapshot()).toEqual(before)
    sqlite.exec("UPDATE cli_family_authorities SET status='revoked'")
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: 'Bearer synthetic-session' }),
        )
      ).kind,
    ).toBe('unauthenticated')
  })
  test('absent OAuth version keeps the existing zero-version rule; sid ownership is checked', async () => {
    const token = oauth({ oauth_token_version: undefined })
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: `Bearer ${token}` }),
        )
      ).kind,
    ).toBe('trusted')
    seedUser(sqlite, 'u2')
    sqlite.exec("UPDATE sessions SET user_id='u2'")
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: `Bearer ${token}` }),
        )
      ).kind,
    ).toBe('unauthenticated')
  })
  test('development cookie name is accepted only outside production', async () => {
    const request = probe({ cookie: cookie().replace('__Secure-', '') })
    expect((await resolveDeceptionIdentity(db, request)).kind).toBe(
      'unauthenticated',
    )
    authEnv.APP_ENV = 'development'
    expect((await resolveDeceptionIdentity(db, request)).kind).toBe('trusted')
  })
  test('missing signing configuration fails unavailable without a cookie fallback', async () => {
    const request = probe()
    authEnv.BETTER_AUTH_SECRET = ''
    expect((await resolveDeceptionIdentity(db, request)).kind).toBe(
      'unavailable',
    )
    expect(await rows()).toHaveLength(0)
  })
  test('rejects revoked API tokens without a last-use write', async () => {
    const token = await createApiToken(db, 'u1', 'synthetic')
    sqlite.exec("UPDATE api_tokens SET revoked_at='2026-01-01T00:00:00.000Z'")
    const before = snapshot()
    expect(
      (
        await resolveDeceptionIdentity(
          db,
          probe({ authorization: `Bearer ${token.token}` }),
        )
      ).kind,
    ).toBe('unauthenticated')
    expect(snapshot()).toEqual(before)
  })
})

describe('durable admission and delivery', () => {
  test('deduplicates clients per full date-hour, permits next hour and same hour next day', async () => {
    expect(await admitDeceptionSignal(db, principal, new Date(at))).toBe(
      'admitted',
    )
    expect(
      await admitDeceptionSignal(
        db,
        { ...principal, client_kind: 'api_token', client_id: 'rotated' },
        new Date(at),
      ),
    ).toBe('duplicate')
    await admitDeceptionSignal(db, principal, new Date(at + 3600000))
    await admitDeceptionSignal(db, principal, new Date(at + 86400000))
    expect(await rows()).toHaveLength(3)
    expect((await rows()).map((r) => r.hour_bucket).sort()).toEqual([
      '2026-11-15T12',
      '2026-11-15T13',
      '2026-11-16T12',
    ])
    expect(() =>
      sqlite.exec("UPDATE security_deception_signals SET hour_bucket='12'"),
    ).toThrow()
  })
  test('idle cron consumes no budget; overlapping drainers send once and ack durably', async () => {
    await drainDeceptionSignals(db, undefined, () => at)
    expect(
      (
        await db
          .selectFrom('security_deception_delivery_control')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).next_send_at,
    ).toBe('1970-01-01T00:00:00.000Z')
    await admitDeceptionSignal(db, principal, new Date(at))
    await Promise.all([
      drainDeceptionSignals(db, 'https://synthetic.invalid', () => at),
      drainDeceptionSignals(db, 'https://synthetic.invalid', () => at),
    ])
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]![2]).toEqual({
      timeoutMs: 5000,
      redirect: 'error',
    })
    expect(await rows()).toMatchObject([
      { status: 'delivered', attempt_count: 1, lease_token: null },
    ])
  })
  test('missing configuration is durable, consumes no HTTP attempts, rechecks and expires at 24h', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    await expect(
      drainDeceptionSignals(db, undefined, () => at),
    ).rejects.toThrow('unhealthy')
    expect(await rows()).toMatchObject([
      {
        status: 'retry',
        failure_code: 'configuration_missing',
        attempt_count: 0,
        next_attempt_at: new Date(at + 300000).toISOString(),
      },
    ])
    await expect(
      drainDeceptionSignals(db, undefined, () => at + 300000),
    ).rejects.toThrow('unhealthy')
    await expect(
      drainDeceptionSignals(db, undefined, () => at + 86400000),
    ).rejects.toThrow('unhealthy')
    expect(await rows()).toMatchObject([
      { status: 'expired', failure_code: 'age_limit', attempt_count: 0 },
    ])
    await expect(
      drainDeceptionSignals(db, undefined, () => at + 86400001),
    ).resolves.toBeUndefined()
    expect(transport).not.toHaveBeenCalled()
  })
  test.each([0, 429, 500, 503, 302, 400, 403])(
    'classifies transport status %i with bounded retry',
    async (status) => {
      transport.mockResolvedValue({ ok: false, status })
      await admitDeceptionSignal(db, principal, new Date(at))
      const run = drainDeceptionSignals(
        db,
        'https://synthetic.invalid',
        () => at,
      )
      await expect(run).rejects.toThrow('unhealthy')
      const row = (await rows())[0]!
      expect(row.status).toBe(
        status === 400 || status === 403 ? 'failed' : 'retry',
      )
      expect(row.attempt_count).toBe(1)
      expect(row.next_attempt_at).toBe(new Date(at + 300000).toISOString())
      expect(row.failure_code).toBe(
        status === 0
          ? 'network'
          : status === 400 || status === 403
            ? 'http_rejected'
            : 'http_retry',
      )
      expect(
        (
          await db
            .selectFrom('security_deception_delivery_control')
            .selectAll()
            .executeTakeFirstOrThrow()
        ).next_send_at,
      ).toBe(new Date(at + 300000).toISOString())
    },
  )
  test('stops at 12 HTTP attempts, backoff is capped and duplicates never rearm', async () => {
    transport.mockResolvedValue({ ok: false, status: 429 })
    await admitDeceptionSignal(db, principal, new Date(at))
    let time = at
    for (let attempt = 1; attempt <= 12; attempt++) {
      await drainDeceptionSignals(
        db,
        'https://synthetic.invalid',
        () => time,
      ).catch(() => {})
      const row = (await rows())[0]!
      expect(row.attempt_count).toBe(attempt)
      expect(Date.parse(row.next_attempt_at) - time).toBe(
        Math.min(60, 5 * 2 ** (attempt - 1)) * 60000,
      )
      time = Date.parse(row.next_attempt_at)
    }
    expect(transport).toHaveBeenCalledTimes(12)
    expect(await rows()).toMatchObject([
      { status: 'failed', failure_code: 'attempt_limit' },
    ])
    expect(await admitDeceptionSignal(db, principal, new Date(at))).toBe(
      'duplicate',
    )
    await drainDeceptionSignals(db, undefined, () => time)
    expect(transport).toHaveBeenCalledTimes(12)
  })
  test('crash/restart and delayed starts retain actual-time budget and reject stale reservations', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    expect(await reserveDeceptionDelivery(db, at + 299000, 'crashed')).toBe(
      true,
    )
    expect(
      await claimDeceptionSignals(db, at + 359000, 'crashed'),
    ).toHaveLength(0)
    expect(await reserveDeceptionDelivery(db, at + 300000, 'boundary')).toBe(
      false,
    )
    expect(await reserveDeceptionDelivery(db, at + 598999, 'early')).toBe(false)
    expect(await reserveDeceptionDelivery(db, at + 599000, 'next')).toBe(true)
    expect(await claimDeceptionSignals(db, at + 658999, 'next')).toHaveLength(1)
    expect(await reserveDeceptionDelivery(db, at + 899000, 'third')).toBe(true)
    // Latest allowed previous start at +658999, earliest next at +899000.
    expect(899000 - 658999).toBeGreaterThanOrEqual(240000)
  })
  test('rejects a lease that expires while the final database fence is in flight', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    let time = at
    const original = sqlite.prepare.bind(sqlite)
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation((query) => {
      if (
        query.startsWith(
          'select "lease_expires_at" from "security_deception_delivery_control"',
        )
      )
        time = at + 60000
      return original(query)
    })
    await drainDeceptionSignals(db, 'https://synthetic.invalid', () => time)
    expect(transport).not.toHaveBeenCalled()
    prepare.mockRestore()
    expect(await rows()).toMatchObject([
      { status: 'pending', attempt_count: 1 },
    ])
    await drainDeceptionSignals(
      db,
      'https://synthetic.invalid',
      () => at + 300000,
    )
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await rows()).toMatchObject([
      { status: 'delivered', attempt_count: 2 },
    ])
  })
  test('delayed actual HTTP starts respect reservation spacing across UTC five-minute boundaries', async () => {
    let time = at + 299000
    const starts: number[] = []
    transport.mockImplementation(async () => {
      starts.push(time)
      return { ok: true }
    })
    await admitDeceptionSignal(db, principal, new Date(time))
    const original = sqlite.prepare.bind(sqlite)
    const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation((query) => {
      if (
        query.startsWith(
          'select "lease_expires_at" from "security_deception_delivery_control"',
        )
      )
        time = at + 358000
      return original(query)
    })
    await drainDeceptionSignals(db, 'https://synthetic.invalid', () => time)
    prepare.mockRestore()
    await admitDeceptionSignal(
      db,
      { ...principal, actor_id: 'second' },
      new Date(time),
    )
    time = at + 599000
    await drainDeceptionSignals(db, 'https://synthetic.invalid', () => time)
    await admitDeceptionSignal(
      db,
      { ...principal, actor_id: 'third' },
      new Date(time),
    )
    time = at + 899000
    await drainDeceptionSignals(db, 'https://synthetic.invalid', () => time)
    expect(starts).toEqual([at + 358000, at + 599000, at + 899000])
    for (let i = 1; i < starts.length; i++)
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(240000)
    for (const start of starts)
      expect(
        starts.filter((t) => t >= start && t < start + 300000).length,
      ).toBeLessThanOrEqual(2)
  })
  test('ack failure conservatively consumes attempt; later retry retains correlation', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    const id = (await rows())[0]!.id
    const original = sqlite.prepare.bind(sqlite)
    const prepare = vi.spyOn(sqlite, 'prepare')
    // Throw only after transport accepts, on acknowledgement.
    transport.mockImplementationOnce(async () => {
      prepare.mockImplementation((query) => {
        if (/update "security_deception_signals" set "status"/i.test(query))
          throw new Error('CANARY_ACK')
        return original.call(sqlite, query)
      })
      return { ok: true }
    })
    await expect(
      drainDeceptionSignals(db, 'https://synthetic.invalid', () => at),
    ).rejects.toThrow('unhealthy')
    prepare.mockRestore()
    expect(await rows()).toMatchObject([
      { id, status: 'pending', attempt_count: 1 },
    ])
    await drainDeceptionSignals(
      db,
      'https://synthetic.invalid',
      () => at + 300000,
    )
    expect(transport).toHaveBeenCalledTimes(2)
    expect(transport.mock.calls[0]![1]).toContain(id)
    expect(transport.mock.calls[1]![1]).toContain(id)
  })
  test('bounded digest retains ten correlations and escapes identifiers', async () => {
    const signals = Array.from({ length: 10 }, (_, i) => ({
      ...principal,
      actor_id: `<@everyone>\nhttps://evil.invalid/${'x'.repeat(1000)}${i}`,
      client_kind: 'oauth_client' as const,
      client_id: 'y'.repeat(1000),
      agent_profile_id: 'z'.repeat(1000),
      publisher_client_id: 'p'.repeat(1000),
    }))
    for (const p of signals) await admitDeceptionSignal(db, p, new Date(at))
    const admitted = await rows()
    const text = deceptionDigest(admitted)
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text).not.toContain('<@')
    expect(text).not.toContain('https://')
    for (const row of admitted) expect(text).toContain(row.id)
  })
  test('pending age >10min is unhealthy, historical failures/saturation are summary only', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    await db
      .updateTable('security_deception_signals')
      .set({ next_attempt_at: new Date(at + 3600000).toISOString() })
      .execute()
    await expect(
      drainDeceptionSignals(db, 'https://synthetic.invalid', () => at + 600001),
    ).rejects.toThrow('unhealthy')
    await db
      .updateTable('security_deception_signals')
      .set({ status: 'failed', failure_code: 'http_rejected' })
      .execute()
    await db
      .updateTable('security_deception_delivery_control')
      .set({ saturated_day: '2026-01-01' })
      .execute()
    await drainDeceptionSignals(db, undefined, () => at + 600002)
    expect(logs).toHaveBeenLastCalledWith(
      'security_deception_delivery',
      expect.objectContaining({
        active: 0,
        failed: 1,
        saturated_day: '2026-01-01',
      }),
    )
  })
  test('inclusive retention deletes pending/failed regardless of identity deletion', async () => {
    await admitDeceptionSignal(db, principal, new Date(at))
    await admitDeceptionSignal(
      db,
      { ...principal, actor_id: 'u2' },
      new Date(at + 1),
    )
    sqlite.exec(
      'DELETE FROM sessions; DELETE FROM workspace_members; DELETE FROM users; DELETE FROM workspaces;',
    )
    expect(
      await cleanupExpiredDeceptionSignals(db, new Date(at + 400 * 86400000)),
    ).toBe(1)
    expect(await rows()).toHaveLength(1)
  })
})

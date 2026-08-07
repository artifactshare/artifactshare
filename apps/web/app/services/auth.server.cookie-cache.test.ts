import { createHmac } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedSession, seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const testRefs = vi.hoisted(() => ({
  authSecret: 'test-secret-with-enough-entropy-for-cookie-cache',
  sqliteRef: { current: null as DatabaseSync | null },
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(testRefs.sqliteRef),
    BETTER_AUTH_SECRET: testRefs.authSecret,
    BETTER_AUTH_URL: 'https://example.com',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  },
}))

import { getSessionUser } from './auth.server'

describe('getSessionUser cookie cache', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    testRefs.sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
  })

  afterEach(async () => {
    testRefs.sqliteRef.current = null
    await db.destroy()
  })

  test('uses cookie cache for session data but reloads auth context from the canonical join', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    const observed = countTableQueries(sqlite, [
      'sessions',
      'users',
      'workspaces',
      'workspace_domain_claims',
    ])
    testRefs.sqliteRef.current = observed.db

    const user = await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      }),
    )

    expect(user).toMatchObject({
      id: 'u1',
      email: 'u1@example.com',
      name: 'User u1',
      image: null,
      locale: null,
      workspaceId: 'ws1',
      hd: 'example.com',
    })

    expect(observed.counts).toEqual({
      sessions: 0,
      users: 1,
      workspaces: 1,
      workspace_domain_claims: 1,
    })
  })

  test('rechecks domain claims on every request despite the cookie cache', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      }),
    )
    const observed = countTableQueries(sqlite, ['workspace_domain_claims'])
    testRefs.sqliteRef.current = observed.db

    const user = await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      }),
    )

    expect(user?.hd).toBe('example.com')
    expect(observed.counts).toEqual({ workspace_domain_claims: 1 })
  })

  test('ignores a stale cookie workspace after the user moves', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at, self_upload_enabled)
      VALUES ('ws-current', 'Current', '2026-07-20T00:00:00.000Z', 0);
      UPDATE users SET workspace_id = 'ws-current' WHERE id = 'u1';
    `)

    await expect(
      getSessionUser(
        cachedSessionRequest({
          sessionToken: 'sess_cookie_cache',
          userId: 'u1',
        }),
      ),
    ).resolves.toMatchObject({
      workspaceId: 'ws-current',
      selfUploadEnabled: false,
    })
  })

  test('reflects self-upload changes on the next request', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    const request = () =>
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      })

    sqlite.exec(
      "UPDATE workspaces SET self_upload_enabled = 0 WHERE id = 'ws1'",
    )
    await expect(getSessionUser(request())).resolves.toMatchObject({
      selfUploadEnabled: false,
    })

    sqlite.exec(
      "UPDATE workspaces SET self_upload_enabled = 1 WHERE id = 'ws1'",
    )
    await expect(getSessionUser(request())).resolves.toMatchObject({
      selfUploadEnabled: true,
    })
  })

  test('reflects domain claim changes on the next request', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec(`
      UPDATE workspaces SET hd = NULL, email_domain = NULL WHERE id = 'ws1';
      INSERT INTO workspace_domain_claims (
        domain, workspace_id, source, provider_tenant_id, created_at, updated_at
      ) VALUES (
        'first.example', 'ws1', 'google_hd', NULL,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
    `)
    const request = () =>
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      })

    await expect(getSessionUser(request())).resolves.toMatchObject({
      hd: 'first.example',
    })
    sqlite.exec(`
      UPDATE workspace_domain_claims
      SET domain = 'second.example'
      WHERE domain = 'first.example'
    `)
    await expect(getSessionUser(request())).resolves.toMatchObject({
      hd: 'second.example',
    })
  })

  test('returns null when the cookie user is missing from the source tables', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec("DELETE FROM users WHERE id = 'u1'")

    await expect(
      getSessionUser(
        cachedSessionRequest({
          sessionToken: 'sess_cookie_cache',
          userId: 'u1',
        }),
      ),
    ).resolves.toBeNull()
  })

  test('returns null when the current workspace is missing from the source tables', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec('PRAGMA foreign_keys = OFF')
    sqlite.exec("DELETE FROM workspaces WHERE id = 'ws1'")

    await expect(
      getSessionUser(
        cachedSessionRequest({
          sessionToken: 'sess_cookie_cache',
          userId: 'u1',
        }),
      ),
    ).resolves.toBeNull()
  })

  test('refreshes a just-created cached session image from the user row', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite
      .prepare("UPDATE users SET image = ? WHERE id = 'u1'")
      .run('https://example.com/api/avatar/u1')
    const observed = countTableQueries(sqlite, ['sessions', 'users'])
    testRefs.sqliteRef.current = observed.db

    const user = await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
        updatedAt: new Date().toISOString(),
      }),
    )

    expect(user?.image).toBe('https://example.com/api/avatar/u1')
    expect(observed.counts).toEqual({ sessions: 0, users: 2 })
  })

  test('treats a domain claim workspace as an organization context', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec(`
      UPDATE workspaces
      SET hd = NULL, email_domain = 'example.com'
      WHERE id = 'ws1';

      INSERT INTO workspace_domain_claims (
        domain, workspace_id, source, provider_tenant_id, created_at, updated_at
      )
      VALUES (
        'example.com', 'ws1', 'microsoft_verified_domain', 'tenant-1',
        '2026-06-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z'
      );
    `)

    const user = await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      }),
    )

    expect(user).toMatchObject({
      workspaceId: 'ws1',
      hd: 'example.com',
      msTenantId: null,
    })
  })

  test('does not move a self-upload disabled viewer into a claimed workspace', async () => {
    seedSession(sqlite, 'u1', 'sess_cookie_cache')
    sqlite.exec(`
      UPDATE workspaces
      SET hd = NULL, email_domain = NULL, self_upload_enabled = 0, storage_quota_bytes = 0
      WHERE id = 'ws1';

      INSERT INTO workspaces (
        id, hd, name, created_at, email_domain, self_upload_enabled
      )
      VALUES (
        'ws-claimed', NULL, 'example.com', '2026-06-26T00:00:00.000Z',
        'example.com', 1
      );

      INSERT INTO workspace_domain_claims (
        domain, workspace_id, source, provider_tenant_id, created_at, updated_at
      )
      VALUES (
        'example.com', 'ws-claimed', 'microsoft_verified_domain', 'tenant-1',
        '2026-06-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z'
      );
    `)

    const user = await getSessionUser(
      cachedSessionRequest({
        sessionToken: 'sess_cookie_cache',
        userId: 'u1',
      }),
    )

    expect(user).toMatchObject({
      workspaceId: 'ws1',
      selfUploadEnabled: false,
    })
    expect(
      sqlite.prepare("SELECT workspace_id FROM users WHERE id = 'u1'").get(),
    ).toEqual({ workspace_id: 'ws1' })
  })
})

function cachedSessionRequest({
  sessionToken,
  userId,
  updatedAt = '2026-06-11T00:00:00.000Z',
}: {
  sessionToken: string
  userId: string
  updatedAt?: string
}): Request {
  return new Request('https://example.com/projects', {
    headers: {
      cookie: [
        `__Secure-better-auth.session_token=${signedCookieValue(sessionToken)}`,
        `__Secure-better-auth.session_data=${sessionDataCookie({ sessionToken, userId, updatedAt })}`,
      ].join('; '),
    },
  })
}

function sessionDataCookie({
  sessionToken,
  userId,
  updatedAt,
}: {
  sessionToken: string
  userId: string
  updatedAt: string
}): string {
  const session = {
    session: {
      id: 'sess1',
      token: sessionToken,
      userId,
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt,
    },
    user: {
      id: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      name: `User ${userId}`,
      image: null,
      createdAt: '2026-05-26T00:00:00.000Z',
      updatedAt: '2026-05-26T00:00:00.000Z',
      workspaceId: 'ws1',
      locale: null,
    },
    updatedAt: Date.parse(updatedAt),
    version: '1',
  }
  const expiresAt = Date.now() + 5 * 60 * 1000
  const signature = hmacBase64UrlNoPad(
    JSON.stringify({ ...session, expiresAt }),
  )

  return base64Url(
    JSON.stringify({
      session,
      expiresAt,
      signature,
    }),
  )
}

function signedCookieValue(value: string): string {
  const signature = createHmac('sha256', testRefs.authSecret)
    .update(value)
    .digest('base64')
  return encodeURIComponent(`${value}.${signature}`)
}

function hmacBase64UrlNoPad(value: string): string {
  return createHmac('sha256', testRefs.authSecret)
    .update(value)
    .digest('base64url')
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function countTableQueries(db: DatabaseSync, tables: string[]) {
  const counts = Object.fromEntries(
    tables.map((table) => [table, 0]),
  ) as Record<string, number>
  return {
    counts,
    db: new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            for (const table of tables) {
              if (new RegExp(`\\b${table}\\b`, 'i').test(sql)) counts[table]++
            }
            return target.prepare(sql)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
}

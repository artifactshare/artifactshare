import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(sqliteRef),
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-oauth-tests',
    BETTER_AUTH_URL: 'https://example.com',
  },
}))

import { createAuth, oauthAuthServerMetadataHandler } from './auth.server'
import { MCP_OAUTH_SCOPES } from '~/lib/mcp-metadata'

const LEGACY_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

describe('OAuth scope configuration and refresh compatibility', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof createMigratedInMemoryDb>['db']

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
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

  test('refresh without scope preserves scopes from an existing token', async () => {
    insertRefreshToken('refresh-omitted', 'legacy-refresh', LEGACY_SCOPES)

    const response = await refreshTokenRequest('legacy-refresh')

    expect(response.status).toBe(200)
    expect((await jsonObject(response)).scope).toBe(LEGACY_SCOPES.join(' '))
  })

  test('refresh accepts only a subset of an existing token scope', async () => {
    insertRefreshToken('refresh-subset', 'subset-refresh', LEGACY_SCOPES)

    const response = await refreshTokenRequest('subset-refresh', {
      scope: 'openid offline_access',
    })

    expect(response.status).toBe(200)
    expect((await jsonObject(response)).scope).toBe('openid offline_access')
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

  async function jsonObject(response: Response) {
    return (await response.json()) as Record<string, unknown>
  }
})

import { describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'

vi.mock('cloudflare:workers', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'https://example.com',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
  },
}))

import {
  decodeMicrosoftIdTokenPayload,
  ensureWorkspace,
  getMicrosoftUserInfo,
  mapMicrosoftProfileToUser,
  persistGoogleHostedDomainClaimForAccount,
} from './auth.server'
import { ensureWorkspaceDomainClaim } from './workspace-domain-claims.server'

function createMicrosoftIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  return `${header}.${body}.sig`
}

function createGoogleIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  return `${header}.${body}.sig`
}

describe('decodeMicrosoftIdTokenPayload', () => {
  test('decodes UTF-8 Japanese display names from the payload segment', () => {
    const idToken = createMicrosoftIdToken({
      tid: 'tenant-1',
      oid: 'object-1',
      name: '山田 太郎',
      email: 'taro@example.com',
    })

    expect(decodeMicrosoftIdTokenPayload(idToken).name).toBe('山田 太郎')
  })
})

describe('mapMicrosoftProfileToUser', () => {
  const baseProfile = {
    sub: 'sub-1',
    tid: 'tenant-1',
    oid: 'object-1',
    preferred_username: 'user@example.com',
  }

  test('resolves email in email, verified_primary_email, preferred_username order', () => {
    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'primary@example.com',
        verified_primary_email: ['verified@example.com'],
        preferred_username: 'preferred@example.com',
      }).email,
    ).toBe('primary@example.com')

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        verified_primary_email: ['verified@example.com'],
        preferred_username: 'preferred@example.com',
      }).email,
    ).toBe('verified@example.com')

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        preferred_username: 'preferred@example.com',
      }).email,
    ).toBe('preferred@example.com')
  })

  test('derives emailVerified from email_verified, xms_edov, and verified lists', () => {
    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
        email_verified: true,
      }).emailVerified,
    ).toBe(true)

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
        xms_edov: true,
      }).emailVerified,
    ).toBe(true)

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'User@Example.com',
        verified_secondary_email: ['user@example.com'],
      }).emailVerified,
    ).toBe(true)

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
      }).emailVerified,
    ).toBe(false)
  })

  test('maps registered user fields only', () => {
    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
        name: 'Display Name',
      }),
    ).toEqual({
      id: 'tenant-1:object-1',
      name: 'Display Name',
      email: 'user@example.com',
      emailVerified: false,
      image: undefined,
    })

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
        given_name: 'Given',
        family_name: 'Family',
      }).name,
    ).toBe('Given Family')

    expect(
      mapMicrosoftProfileToUser({
        ...baseProfile,
        email: 'user@example.com',
      }).name,
    ).toBe('user@example.com')
  })

  test('throws when tid or oid is missing', () => {
    expect(() =>
      mapMicrosoftProfileToUser({
        ...baseProfile,
        tid: '',
        email: 'user@example.com',
      }),
    ).toThrow('Microsoft profile missing tid or oid')

    expect(() =>
      mapMicrosoftProfileToUser({
        ...baseProfile,
        oid: '',
        email: 'user@example.com',
      }),
    ).toThrow('Microsoft profile missing tid or oid')
  })

  test('throws when no email can be resolved', () => {
    expect(() =>
      mapMicrosoftProfileToUser({
        ...baseProfile,
        preferred_username: 'not-an-email',
      }),
    ).toThrow('Microsoft profile missing email')
  })
})

describe('getMicrosoftUserInfo', () => {
  test('returns null when idToken is missing', async () => {
    await expect(
      getMicrosoftUserInfo({ accessToken: 'access-token' }),
    ).resolves.toBeNull()
  })

  test('fetches matching non-initial verified domain from Microsoft organization', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            {
              id: 'tenant-1',
              displayName: 'Tenant',
              verifiedDomains: [
                { name: 'tenant.onmicrosoft.com', isInitial: true },
                { name: 'example.com', isInitial: false },
                { name: 'other.example.com', isInitial: false },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const idToken = createMicrosoftIdToken({
      tid: 'tenant-1',
      oid: 'object-1',
      email: 'user@example.com',
      email_verified: true,
      preferred_username: 'user@example.com',
    })

    await expect(
      getMicrosoftUserInfo({
        idToken,
        accessToken: 'access-token',
      }),
    ).resolves.toMatchObject({
      user: { email: 'user@example.com', emailVerified: true },
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    )
    fetchSpy.mockRestore()
  })

  test('falls back to unselected organization request when selected request fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                verifiedDomains: [{ name: 'example.com', isInitial: false }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    const idToken = createMicrosoftIdToken({
      tid: 'tenant-1',
      oid: 'object-1',
      email: 'user@example.com',
      email_verified: true,
      preferred_username: 'user@example.com',
    })

    await expect(
      getMicrosoftUserInfo({ idToken, accessToken: 'access-token' }),
    ).resolves.toMatchObject({
      user: { email: 'user@example.com', emailVerified: true },
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      'https://graph.microsoft.com/v1.0/organization',
    )
    fetchSpy.mockRestore()
  })

  test('falls back when selected organization omits verified domains', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ id: 'tenant-1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                verifiedDomains: [{ name: 'example.com', isInitial: false }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    const idToken = createMicrosoftIdToken({
      tid: 'tenant-1',
      oid: 'object-1',
      email: 'user@example.com',
      email_verified: true,
      preferred_username: 'user@example.com',
    })

    await expect(
      getMicrosoftUserInfo({ idToken, accessToken: 'access-token' }),
    ).resolves.toMatchObject({
      user: { email: 'user@example.com', emailVerified: true },
    })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      'https://graph.microsoft.com/v1.0/organization',
    )
    fetchSpy.mockRestore()
  })

  test('returns mapped user and decoded profile data', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const idToken = createMicrosoftIdToken({
      tid: 'tenant-1',
      oid: 'object-1',
      name: '山田 太郎',
      email: 'taro@example.com',
      preferred_username: 'taro@example.com',
    })

    await expect(
      getMicrosoftUserInfo({ idToken, accessToken: 'access-token' }),
    ).resolves.toEqual({
      user: {
        id: 'tenant-1:object-1',
        name: '山田 太郎',
        email: 'taro@example.com',
        emailVerified: false,
        image: undefined,
      },
      data: expect.objectContaining({
        tid: 'tenant-1',
        oid: 'object-1',
        name: '山田 太郎',
        email: 'taro@example.com',
      }),
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('persistGoogleHostedDomainClaimForAccount', () => {
  test('creates a Google hosted-domain claim for an existing user account link', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-personal',
          hd: null,
          name: "alice@corp.com's workspace",
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: null,
          self_upload_enabled: 0,
          storage_quota_bytes: 0,
        })
        .execute()
      await db
        .insertInto('users')
        .values({
          id: 'user-1',
          email: 'alice@corp.com',
          email_verified: 1,
          name: 'Alice',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: 'ws-personal',
        })
        .execute()

      const resolvedWorkspaceId =
        await persistGoogleHostedDomainClaimForAccount(db, {
          userId: 'user-1',
          idToken: createGoogleIdToken({
            email: 'alice@corp.com',
            email_verified: true,
            hd: 'Corp.COM',
          }),
          now: '2026-06-26T00:00:00.000Z',
        })
      expect(resolvedWorkspaceId).not.toBe('ws-personal')
      expect(
        await db
          .selectFrom('users')
          .select('workspace_id')
          .where('id', '=', 'user-1')
          .executeTakeFirstOrThrow(),
      ).toEqual({ workspace_id: resolvedWorkspaceId })

      const claim = await db
        .selectFrom('workspace_domain_claims')
        .select(['domain', 'workspace_id', 'source'])
        .executeTakeFirstOrThrow()
      expect(claim).toEqual({
        domain: 'corp.com',
        workspace_id: resolvedWorkspaceId,
        source: 'google_hd',
      })
    } finally {
      await db.destroy()
    }
  })

  test('does not claim an active personal workspace on Google account link', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-personal',
          hd: null,
          name: 'Personal',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: null,
          self_upload_enabled: 0,
          storage_quota_bytes: 0,
        })
        .execute()
      await db
        .insertInto('users')
        .values({
          id: 'user-1',
          email: 'alice@corp.com',
          email_verified: 1,
          name: 'Alice',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: 'ws-personal',
        })
        .execute()
      await db
        .insertInto('api_tokens')
        .values({
          id: 'token-1',
          user_id: 'user-1',
          name: 'CLI',
          token_hash: 'hash-1',
          created_at: '2026-06-26T00:00:00.000Z',
        })
        .execute()

      await expect(
        persistGoogleHostedDomainClaimForAccount(db, {
          userId: 'user-1',
          idToken: createGoogleIdToken({
            email: 'alice@corp.com',
            email_verified: true,
            hd: 'Corp.COM',
          }),
          now: '2026-06-26T00:00:00.000Z',
        }),
      ).resolves.toBeNull()

      await expect(
        db.selectFrom('workspace_domain_claims').select('domain').execute(),
      ).resolves.toEqual([])
    } finally {
      await db.destroy()
    }
  })
})

describe('ensureWorkspace Microsoft domain fallback', () => {
  test('joins existing mixed-case Google hd claim before inserting normalized workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-existing',
          hd: 'Corp.COM',
          name: 'Corp.COM',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
        })
        .execute()
      await ensureWorkspaceDomainClaim(db, {
        domain: 'corp.com',
        workspaceId: 'ws-existing',
        source: 'google_hd',
        now: '2026-06-26T00:00:00.000Z',
      })

      await expect(
        ensureWorkspace(db, 'alice@corp.com', 'corp.com'),
      ).resolves.toMatchObject({ workspaceId: 'ws-existing', created: false })

      const workspaces = await db
        .selectFrom('workspaces')
        .select(['id', 'hd'])
        .orderBy('id')
        .execute()
      expect(workspaces).toEqual([
        {
          id: 'ws-existing',
          hd: 'Corp.COM',
        },
      ])
    } finally {
      await db.destroy()
    }
  })

  test('joins existing domain claim when Microsoft Graph verifies the domain', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-claim',
          hd: 'corp.com',
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
        })
        .execute()
      await ensureWorkspaceDomainClaim(db, {
        domain: 'corp.com',
        workspaceId: 'ws-claim',
        source: 'google_hd',
        now: '2026-06-26T00:00:00.000Z',
      })

      await expect(
        ensureWorkspace(db, 'bob@corp.com', null, 'tenant-1', 'corp.com', true),
      ).resolves.toMatchObject({ workspaceId: 'ws-claim', created: false })

      const microsoftTenantWorkspaces = await db
        .selectFrom('workspaces')
        .select('id')
        .where('ms_tenant_id', '=', 'tenant-1')
        .execute()
      expect(microsoftTenantWorkspaces).toEqual([])
    } finally {
      await db.destroy()
    }
  })

  test('falls back to Microsoft tenant workspace when Graph domain verification is absent', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-claim',
          hd: 'corp.com',
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
        })
        .execute()
      await ensureWorkspaceDomainClaim(db, {
        domain: 'corp.com',
        workspaceId: 'ws-claim',
        source: 'google_hd',
        now: '2026-06-26T00:00:00.000Z',
      })

      const { workspaceId } = await ensureWorkspace(
        db,
        'bob@corp.com',
        null,
        'tenant-1',
        null,
        true,
      )

      expect(workspaceId).not.toBe('ws-claim')
      const workspace = await db
        .selectFrom('workspaces')
        .select(['id', 'ms_tenant_id'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
      expect(workspace).toEqual({
        id: workspaceId,
        ms_tenant_id: 'tenant-1',
      })
    } finally {
      await db.destroy()
    }
  })

  test('does not join an existing domain claim for unverified Microsoft email', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-claim',
          hd: 'corp.com',
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
        })
        .execute()
      await ensureWorkspaceDomainClaim(db, {
        domain: 'corp.com',
        workspaceId: 'ws-claim',
        source: 'google_hd',
        now: '2026-06-26T00:00:00.000Z',
      })

      const { workspaceId } = await ensureWorkspace(
        db,
        'mallory@corp.com',
        null,
        'tenant-1',
        null,
        false,
      )

      expect(workspaceId).not.toBe('ws-claim')
      const workspace = await db
        .selectFrom('workspaces')
        .select(['id', 'ms_tenant_id'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
      expect(workspace).toEqual({
        id: workspaceId,
        ms_tenant_id: 'tenant-1',
      })
    } finally {
      await db.destroy()
    }
  })
})

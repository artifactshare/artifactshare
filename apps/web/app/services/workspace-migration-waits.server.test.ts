import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import {
  reconcileWorkspaceMigrationWaits,
  WORKSPACE_MIGRATION_WAIT_LOG_MARKER,
} from './workspace-migration-waits.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
  },
}))

describe('workspace migration waits', () => {
  let fixture: ReturnType<typeof createD1BatchFixture> | null = null

  afterEach(async () => {
    await fixture?.db.destroy()
    fixture = null
    sqliteRef.current = null
  })

  function setup() {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    return fixture.db
  }

  test('records once, resolves, and notifies again only after recurrence', async () => {
    const db = setup()
    await db
      .insertInto('workspaces')
      .values([
        {
          id: 'ws-org',
          name: 'corp.com',
          email_domain: 'corp.com',
          created_at: '2026-08-27T00:00:00.000Z',
        },
        {
          id: 'ws-personal',
          name: "alice@corp.com's workspace",
          created_at: '2026-08-27T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('workspace_domain_claims')
      .values({
        domain: 'corp.com',
        workspace_id: 'ws-org',
        source: 'google_hd',
        provider_tenant_id: null,
        created_at: '2026-08-27T00:00:00.000Z',
        updated_at: '2026-08-27T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'user-1',
        email: 'alice@corp.com',
        email_verified: 1,
        name: 'Alice',
        created_at: '2026-08-27T00:00:00.000Z',
        updated_at: '2026-08-27T00:00:00.000Z',
        workspace_id: 'ws-personal',
        kind: 'human',
      })
      .execute()
    await db
      .insertInto('api_tokens')
      .values({
        id: 'token-1',
        user_id: 'user-1',
        name: 'CLI',
        token_hash: 'hash',
        created_at: '2026-08-27T00:00:00.000Z',
      })
      .execute()

    const first = await reconcileWorkspaceMigrationWaits(
      db,
      new Date('2026-08-27T01:00:00.000Z'),
    )
    expect(first).toMatchObject({ active: 1, newlyDetected: 1, resolved: 0 })
    expect(first.notifications).toHaveLength(1)
    expect(JSON.stringify(first.notifications)).not.toMatch(
      /alice|corp\.com|ws-personal|ws-org/u,
    )
    const waitId = first.notifications[0]?.waitId
    expect(waitId).toHaveLength(16)

    const repeated = await reconcileWorkspaceMigrationWaits(
      db,
      new Date('2026-08-27T02:00:00.000Z'),
    )
    expect(repeated).toEqual({
      active: 1,
      newlyDetected: 0,
      resolved: 0,
      notifications: [],
    })

    await db.deleteFrom('api_tokens').where('id', '=', 'token-1').execute()
    const resolved = await reconcileWorkspaceMigrationWaits(
      db,
      new Date('2026-08-27T03:00:00.000Z'),
    )
    expect(resolved).toEqual({
      active: 0,
      newlyDetected: 0,
      resolved: 1,
      notifications: [],
    })

    await db
      .insertInto('api_tokens')
      .values({
        id: 'token-2',
        user_id: 'user-1',
        name: 'CLI again',
        token_hash: 'hash-2',
        created_at: '2026-08-27T04:00:00.000Z',
      })
      .execute()
    const recurring = await reconcileWorkspaceMigrationWaits(
      db,
      new Date('2026-08-27T04:00:00.000Z'),
    )
    expect(recurring).toMatchObject({
      active: 1,
      newlyDetected: 1,
      resolved: 0,
      notifications: [{ waitId, generation: 2 }],
    })

    await expect(
      db
        .selectFrom('workspace_migration_waits')
        .select(['reason_codes', 'generation', 'resolved_at'])
        .where('id', '=', waitId ?? '')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      reason_codes: '["user_has_api_tokens"]',
      generation: 2,
      resolved_at: null,
    })
  })

  test('uses a stable PII-free log marker', () => {
    expect(WORKSPACE_MIGRATION_WAIT_LOG_MARKER).toBe(
      'artifactshare_workspace_migration_wait',
    )
  })
})

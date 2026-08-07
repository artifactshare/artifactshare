import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  isExternalPostingAllowedForWorkspace,
  isExternalPostingEnabledForWorkspace,
} from './project-external-posting.server'

describe('workspace external posting policy', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await db
      .insertInto('workspaces')
      .values([
        {
          id: 'ws-plus',
          hd: 'plus.example',
          name: 'Plus',
          created_at: '2026-07-20T00:00:00.000Z',
          plan: 'plus',
          external_posting_enabled: 1,
        },
        {
          id: 'ws-team-off',
          hd: 'team.example',
          name: 'Team',
          created_at: '2026-07-20T00:00:00.000Z',
          plan: 'team',
          external_posting_enabled: 0,
        },
        {
          id: 'ws-free',
          hd: 'free.example',
          name: 'Free',
          created_at: '2026-07-20T00:00:00.000Z',
          plan: 'free',
          external_posting_enabled: 1,
        },
      ])
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('uses the workspace policy and plan', async () => {
    await expect(
      isExternalPostingEnabledForWorkspace(db, 'ws-plus'),
    ).resolves.toBe(true)
    await expect(
      isExternalPostingEnabledForWorkspace(db, 'ws-team-off'),
    ).resolves.toBe(false)
    await expect(
      isExternalPostingEnabledForWorkspace(db, 'ws-free'),
    ).resolves.toBe(false)
  })

  test('allows only workspaces enabled by the policy', async () => {
    await expect(
      isExternalPostingAllowedForWorkspace(db, 'ws-plus'),
    ).resolves.toBe(true)
    await expect(
      isExternalPostingAllowedForWorkspace(db, 'ws-team-off'),
    ).resolves.toBe(false)
  })
})

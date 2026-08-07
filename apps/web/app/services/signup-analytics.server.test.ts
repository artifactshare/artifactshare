import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  claimPendingSignup,
  clearPendingSignupWorkspaceCreated,
  clearWorkspaceCreatedIfMoved,
  insertPendingSignup,
  markPendingSignupTracked,
} from './signup-analytics.server'

describe('signup analytics pending rows', () => {
  test('claims with a lease, supports retry after expiry, and tracks atomically', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-1',
          hd: null,
          ms_tenant_id: null,
          email_domain: null,
          name: 'Workspace',
          created_at: '2026-07-24T00:00:00.000Z',
        })
        .execute()
      await db
        .insertInto('users')
        .values({
          id: 'user-1',
          email: 'user@example.com',
          email_verified: 1,
          name: 'User',
          image: null,
          created_at: '2026-07-24T00:00:00.000Z',
          updated_at: '2026-07-24T00:00:00.000Z',
          workspace_id: 'ws-1',
          locale: null,
        })
        .execute()
      const now = '2026-07-24T00:00:00.000Z'
      await insertPendingSignup(db, {
        userId: 'user-1',
        method: 'email',
        workspaceCreated: true,
        now,
      })
      expect(await claimPendingSignup(db, 'user-1', { now })).toEqual({
        method: 'email',
        workspace_created: 1,
        created_at: now,
      })
      expect(
        await claimPendingSignup(db, 'user-1', {
          now: '2026-07-24T00:01:00.000Z',
        }),
      ).toBeNull()
      expect(
        await claimPendingSignup(db, 'user-1', {
          now: '2026-07-24T00:06:00.000Z',
        }),
      ).not.toBeNull()
      await markPendingSignupTracked(db, 'user-1', '2026-07-24T00:07:00.000Z')
      expect(
        await claimPendingSignup(db, 'user-1', {
          now: '2026-07-24T00:12:00.000Z',
        }),
      ).toBeNull()
      await clearPendingSignupWorkspaceCreated(db, 'user-1')
      expect(
        (
          await db
            .selectFrom('pending_signup_analytics')
            .select('workspace_created')
            .executeTakeFirstOrThrow()
        ).workspace_created,
      ).toBe(0)
      await insertPendingSignup(db, {
        userId: 'user-1',
        method: 'google',
        workspaceCreated: false,
        now,
      })
      expect(
        await db.selectFrom('pending_signup_analytics').selectAll().execute(),
      ).toHaveLength(1)
    } finally {
      await db.destroy()
    }
  })

  test('clearWorkspaceCreatedIfMoved clears only when the workspace changed', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-1',
          hd: null,
          ms_tenant_id: null,
          email_domain: null,
          name: 'W',
          created_at: '2026-07-24T00:00:00.000Z',
        })
        .execute()
      await db
        .insertInto('users')
        .values({
          id: 'user-1',
          email: 'u@example.com',
          email_verified: 1,
          name: 'U',
          image: null,
          created_at: '2026-07-24T00:00:00.000Z',
          updated_at: '2026-07-24T00:00:00.000Z',
          workspace_id: 'ws-1',
          locale: null,
        })
        .execute()
      const readFlag = async () =>
        (
          await db
            .selectFrom('pending_signup_analytics')
            .select('workspace_created')
            .where('user_id', '=', 'user-1')
            .executeTakeFirstOrThrow()
        ).workspace_created
      await insertPendingSignup(db, {
        userId: 'user-1',
        method: 'google',
        workspaceCreated: true,
        now: '2026-07-24T00:00:00.000Z',
      })

      // Moved into an existing (domain-claimed) workspace ⇒ cleared to 0.
      expect(
        await clearWorkspaceCreatedIfMoved(db, {
          userId: 'user-1',
          originalWorkspaceId: 'ws-1',
          finalWorkspaceId: 'ws-company',
        }),
      ).toBe(true)
      expect(await readFlag()).toBe(0)

      // Same workspace ⇒ not a move ⇒ left as-is.
      await db
        .updateTable('pending_signup_analytics')
        .set({ workspace_created: 1 })
        .where('user_id', '=', 'user-1')
        .execute()
      expect(
        await clearWorkspaceCreatedIfMoved(db, {
          userId: 'user-1',
          originalWorkspaceId: 'ws-1',
          finalWorkspaceId: 'ws-1',
        }),
      ).toBe(false)
      expect(await readFlag()).toBe(1)

      // No resolved workspace ⇒ not a move.
      expect(
        await clearWorkspaceCreatedIfMoved(db, {
          userId: 'user-1',
          originalWorkspaceId: 'ws-1',
          finalWorkspaceId: null,
        }),
      ).toBe(false)
      expect(await readFlag()).toBe(1)
    } finally {
      await db.destroy()
    }
  })
})

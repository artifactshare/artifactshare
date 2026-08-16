import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  cleanupExpiredSecurityAuditRecords,
  securityAuditInsertQuery,
} from './security-audit.server'

describe('security audit records', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    db = createMigratedInMemoryDb().db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('stores only durable MCP attribution values', async () => {
    await (
      securityAuditInsertQuery(db, {
        workspaceId: 'workspace-1',
        actorId: 'user-1',
        clientId: 'oauth-client-1',
        development: false,
        subjectId: 'artifact-1',
        action: 'artifact.publish',
        createdAt: '2026-08-16T00:00:00.000Z',
      }) as unknown as { execute(): Promise<unknown> }
    ).execute()

    expect(
      await db
        .selectFrom('security_audit_records')
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      workspace_id: 'workspace-1',
      actor_type: 'user',
      actor_id: 'user-1',
      client_type: 'oauth_client',
      client_id: 'oauth-client-1',
      subject_type: 'shareable',
      subject_id: 'artifact-1',
      action: 'artifact.publish',
      created_at: '2026-08-16T00:00:00.000Z',
    })
  })

  test('deletes records at the 400-day boundary and keeps newer rows', async () => {
    const values = [
      ['old', '2025-07-12T00:00:00.000Z'],
      ['boundary', '2025-07-13T00:00:00.000Z'],
      ['new', '2025-07-13T00:00:00.001Z'],
    ] as const
    for (const [subjectId, createdAt] of values) {
      await (
        securityAuditInsertQuery(db, {
          workspaceId: 'workspace-1',
          actorId: 'user-1',
          clientId: null,
          development: true,
          subjectId,
          action: 'artifact.update',
          createdAt,
        }) as unknown as { execute(): Promise<unknown> }
      ).execute()
    }

    expect(
      await cleanupExpiredSecurityAuditRecords(
        db,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).toBe(2)
    expect(
      await db
        .selectFrom('security_audit_records')
        .select('subject_id')
        .execute(),
    ).toEqual([{ subject_id: 'new' }])
  })
})

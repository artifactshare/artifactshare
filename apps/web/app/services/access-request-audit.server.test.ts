import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { deliverAuditedAccessRequestNotification } from './access-request-audit.server'

describe('access request notification audit', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await db
      .insertInto('workspaces')
      .values({
        id: 'workspace',
        name: 'Workspace',
        plan: 'team',
        created_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('audit_events')
      .values({
        id: 'access-request-created:request-1',
        workspace_id: 'workspace',
        actor_user_id: null,
        action: 'access_request.created',
        subject_type: 'access_request',
        subject_id: 'request-1',
        detail: JSON.stringify({
          access_request_id: 'request-1',
          artifact_id: 'artifact',
          artifact_title: 'Roadmap',
          project_id: null,
          project_name: null,
          requester_id: 'requester',
          requester_name: 'Requester',
          requester_email: 'requester@example.com',
          handler_id: 'handler',
          handler_name: 'Handler',
          handler_email: 'handler@example.com',
          actor_id: 'requester',
          actor_name: 'Requester',
          actor_email: 'requester@example.com',
        }),
        created_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.destroy()
  })

  test('reserves once per endpoint and never delivers a duplicate', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined)
    const input = {
      requestId: 'request-1',
      channel: 'slack' as const,
      endpointKey: 'link-1',
      recipientUserId: 'handler',
      recipientEmail: 'handler@example.com',
    }

    await expect(
      deliverAuditedAccessRequestNotification(db, input, deliver),
    ).resolves.toBe('succeeded')
    await expect(
      deliverAuditedAccessRequestNotification(db, input, deliver),
    ).resolves.toBe('not-attempted')
    expect(deliver).toHaveBeenCalledOnce()
    await expect(notificationRows(db)).resolves.toMatchObject([
      {
        action: 'access_request.slack.succeeded',
        subject_id: 'request-1',
      },
    ])
  })

  test('keeps the shipped request notification idempotency key', async () => {
    const endpointKey = 'legacy-handler'
    const identity = `request-1\u0000email\u0000${endpointKey}`
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity),
    )
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    await db
      .insertInto('audit_events')
      .values({
        id: `access-request-notification:${hex}`,
        workspace_id: 'workspace',
        actor_user_id: null,
        action: 'access_request.email.succeeded',
        subject_type: 'access_request',
        subject_id: 'request-1',
        detail: '{}',
        created_at: '2026-09-01T00:00:30.000Z',
      })
      .execute()
    const deliver = vi.fn().mockResolvedValue(undefined)

    await expect(
      deliverAuditedAccessRequestNotification(
        db,
        {
          requestId: 'request-1',
          channel: 'email',
          endpointKey,
          recipientUserId: 'handler',
          recipientEmail: 'handler@example.com',
        },
        deliver,
      ),
    ).resolves.toBe('not-attempted')
    expect(deliver).not.toHaveBeenCalled()
  })

  test('keeps distinct provider endpoints and records failed delivery', async () => {
    const failed = () => Promise.reject(new Error('provider failure'))
    const common = {
      requestId: 'request-1',
      channel: 'slack' as const,
      recipientUserId: 'handler',
      recipientEmail: 'handler@example.com',
    }

    await expect(
      deliverAuditedAccessRequestNotification(
        db,
        { ...common, endpointKey: 'link-1' },
        failed,
      ),
    ).resolves.toBe('failed')
    await expect(
      deliverAuditedAccessRequestNotification(
        db,
        { ...common, endpointKey: 'link-2' },
        async () => undefined,
      ),
    ).resolves.toBe('succeeded')
    const rows = await notificationRows(db)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.action).sort()).toEqual([
      'access_request.slack.failed',
      'access_request.slack.succeeded',
    ])
    expect(rows.every((row) => !row.detail?.includes('link-'))).toBe(true)
  })

  test('reserves request and resolution notifications independently', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined)
    const common = {
      requestId: 'request-1',
      channel: 'email' as const,
      endpointKey: 'same-user',
      recipientUserId: 'same-user',
      recipientEmail: 'same@example.com',
    }

    const created = await db
      .selectFrom('audit_events')
      .select(['workspace_id', 'detail'])
      .where('id', '=', 'access-request-created:request-1')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('audit_events')
      .values({
        id: 'access-request-decision:request-1',
        workspace_id: created.workspace_id,
        actor_user_id: null,
        action: 'access_request.approved',
        subject_type: 'access_request',
        subject_id: 'request-1',
        detail: created.detail,
        created_at: '2026-09-01T00:01:00.000Z',
      })
      .execute()

    await deliverAuditedAccessRequestNotification(db, common, deliver)
    await deliverAuditedAccessRequestNotification(
      db,
      { ...common, purpose: 'resolution' },
      deliver,
    )
    await deliverAuditedAccessRequestNotification(
      db,
      { ...common, purpose: 'resolution' },
      deliver,
    )

    expect(deliver).toHaveBeenCalledTimes(2)
    const rows = await db
      .selectFrom('audit_events')
      .select('detail')
      .where('action', '=', 'access_request.email.succeeded')
      .execute()
    expect(
      rows.map((row) => JSON.parse(row.detail!).notification_purpose).sort(),
    ).toEqual(['request', 'resolution'])
  })

  test('fails closed when the created snapshot is unavailable', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined)
    await expect(
      deliverAuditedAccessRequestNotification(
        db,
        {
          requestId: 'missing-request',
          channel: 'email',
          endpointKey: 'handler',
          recipientUserId: 'handler',
          recipientEmail: 'handler@example.com',
        },
        deliver,
      ),
    ).resolves.toBe('not-attempted')
    expect(deliver).not.toHaveBeenCalled()
  })
})

async function notificationRows(db: Kysely<DB>) {
  return await db
    .selectFrom('audit_events')
    .select(['action', 'subject_id', 'detail'])
    .where('action', 'like', 'access_request.slack.%')
    .orderBy('id')
    .execute()
}

import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const mail = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('cloudflare:workers', () => ({
  env: { EMAIL: { send: mail.send } },
}))

import { sendAccessRequestNotifications } from './access-request-email.server'

describe('access request email notifications', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    mail.send.mockReset().mockResolvedValue(undefined)
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

  test('sends after reservation and records the successful outcome', async () => {
    await send(db)

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'handler@example.com' }),
    )
    expect(mail.send.mock.calls[0]?.[0]?.text).toContain(
      'https://artifactshare.test/access-requests?request=request-1',
    )
    await expect(emailAudit(db)).resolves.toMatchObject({
      action: 'access_request.email.succeeded',
    })
  })

  test('keeps provider failure best effort and records it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mail.send.mockRejectedValueOnce(new Error('private provider detail'))

    await expect(send(db)).resolves.toBeUndefined()
    await expect(emailAudit(db)).resolves.toMatchObject({
      action: 'access_request.email.failed',
    })
    const serialized = JSON.stringify(error.mock.calls)
    expect(serialized).toContain('access_request_email_failed')
    expect(serialized).not.toContain('private provider detail')
  })
})

async function send(db: Kysely<DB>) {
  await sendAccessRequestNotifications(db, {
    requestId: 'request-1',
    requesterName: 'Requester',
    requesterEmail: 'requester@example.com',
    shareableTitle: 'Roadmap',
    approvers: [
      {
        userId: 'handler',
        email: 'handler@example.com',
        locale: 'ja',
      },
    ],
    origin: 'https://artifactshare.test',
  })
}

async function emailAudit(db: Kysely<DB>) {
  return await db
    .selectFrom('audit_events')
    .select(['action', 'detail'])
    .where('subject_id', '=', 'request-1')
    .where('action', 'like', 'access_request.email.%')
    .executeTakeFirstOrThrow()
}

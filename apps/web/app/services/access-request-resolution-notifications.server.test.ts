import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const mail = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('cloudflare:workers', () => ({
  env: { EMAIL: { send: mail.send } },
}))

import {
  accessRequestResolutionSlackPayload,
  sendAccessRequestResolutionNotifications,
} from './access-request-resolution-notifications.server'

describe('access request resolution notifications', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    mail.send.mockReset().mockResolvedValue(undefined)
    await seed(db)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.destroy()
  })

  test.each([
    {
      status: 'approved' as const,
      expectedSubject: 'Access request approved',
      expectedSlack: '閲覧リクエストが承認されました',
    },
    {
      status: 'rejected' as const,
      expectedSubject: 'Access request rejected',
      expectedSlack: '閲覧リクエストは却下されました',
    },
  ])(
    'sends and audits one $status result by email and same-workspace Slack',
    async ({ status, expectedSubject, expectedSlack }) => {
      await setResolution(db, status)
      const postMessage = vi.fn().mockResolvedValue(undefined)
      const send = () =>
        sendAccessRequestResolutionNotifications(
          db,
          {
            requestId: 'request-1',
            status,
            resolvedByUserId: 'handler',
            origin: 'https://artifactshare.test',
          },
          (token) => ({
            postMessage: async (payload) => {
              await postMessage(token, payload)
            },
          }),
        )

      await send()
      await send()

      expect(mail.send).toHaveBeenCalledOnce()
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'requester@example.com',
          subject: expect.stringContaining(expectedSubject),
          text: expect.stringContaining(
            'https://artifactshare.test/a/artifact-1',
          ),
        }),
      )
      expect(postMessage).toHaveBeenCalledOnce()
      expect(postMessage).toHaveBeenCalledWith(
        'token-capable',
        expect.objectContaining({ channel: 'U-REQUESTER' }),
      )
      expect(JSON.stringify(postMessage.mock.calls[0]?.[1])).toContain(
        expectedSlack,
      )
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain(
        'token-foreign',
      )
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain(
        'token-no-scope',
      )

      const audits = await resolutionAudits(db)
      expect(audits).toHaveLength(2)
      expect(audits.map((row) => row.action).sort()).toEqual([
        'access_request.email.succeeded',
        'access_request.slack.succeeded',
      ])
      for (const row of audits) {
        expect(JSON.parse(row.detail!)).toMatchObject({
          recipient_id: 'requester',
          recipient_email: 'requester@example.com',
          notification_purpose: 'resolution',
          delivery_outcome: 'succeeded',
        })
      }
    },
  )

  test('keeps provider failures best effort and records each outcome', async () => {
    await setResolution(db, 'approved')
    mail.send.mockRejectedValueOnce(new Error('mail secret'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendAccessRequestResolutionNotifications(
        db,
        {
          requestId: 'request-1',
          status: 'approved',
          resolvedByUserId: 'handler',
          origin: 'https://artifactshare.test',
        },
        () => ({
          postMessage: () => Promise.reject(new Error('slack secret')),
        }),
      ),
    ).resolves.toBeUndefined()

    expect(
      (await resolutionAudits(db)).map((row) => row.action).sort(),
    ).toEqual(['access_request.email.failed', 'access_request.slack.failed'])
    const logged = JSON.stringify(error.mock.calls)
    expect(logged).not.toContain('mail secret')
    expect(logged).not.toContain('slack secret')
  })

  test('notifies a pending request that predates the created-event trigger', async () => {
    await db
      .deleteFrom('audit_events')
      .where('id', '=', 'access-request-created:request-1')
      .execute()
    await setResolution(db, 'approved')
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await sendAccessRequestResolutionNotifications(
      db,
      {
        requestId: 'request-1',
        status: 'approved',
        resolvedByUserId: 'handler',
        origin: 'https://artifactshare.test',
      },
      () => ({ postMessage }),
    )

    expect(mail.send).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenCalledOnce()
    expect(await resolutionAudits(db)).toHaveLength(2)
  })

  test('keeps email tracked when Slack recipient lookup rejects', async () => {
    await setResolution(db, 'approved')
    await db.schema.dropTable('slack_user_links').execute()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendAccessRequestResolutionNotifications(db, {
        requestId: 'request-1',
        status: 'approved',
        resolvedByUserId: 'handler',
        origin: 'https://artifactshare.test',
      }),
    ).resolves.toBeUndefined()

    expect(mail.send).toHaveBeenCalledOnce()
    expect((await resolutionAudits(db)).map((row) => row.action)).toEqual([
      'access_request.email.succeeded',
    ])
    expect(JSON.stringify(error.mock.calls)).toContain(
      'access_request_resolution_notification_failed',
    )
  })

  test('does not send when the resolver or terminal status does not match', async () => {
    await setResolution(db, 'approved')
    const postMessage = vi.fn().mockResolvedValue(undefined)
    await sendAccessRequestResolutionNotifications(
      db,
      {
        requestId: 'request-1',
        status: 'rejected',
        resolvedByUserId: 'someone-else',
        origin: 'https://artifactshare.test',
      },
      () => ({ postMessage }),
    )

    expect(mail.send).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    expect(await resolutionAudits(db)).toEqual([])
  })

  test('uses plain-text Slack blocks for result content', () => {
    const payload = accessRequestResolutionSlackPayload({
      channel: 'U1',
      locale: 'en',
      status: 'approved',
      shareableTitle: '<!channel> Roadmap',
      requestUrl: 'https://artifactshare.test/a/artifact-1',
    })
    expect(payload.blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'plain_text' },
    })
    expect(payload.text).not.toContain('\n')
    expect(payload.text).not.toContain('<!channel>')
    expect(payload.text).toContain('&lt;!channel&gt;')
  })
})

async function seed(db: Kysely<DB>) {
  const now = '2026-09-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values([
      { id: 'workspace-a', name: 'A', plan: 'team', created_at: now },
      { id: 'workspace-b', name: 'B', plan: 'team', created_at: now },
      {
        id: 'requester-workspace',
        name: 'Requester',
        plan: 'free',
        created_at: now,
      },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      {
        id: 'handler',
        email: 'handler@example.com',
        email_verified: 1,
        name: 'Handler',
        image: null,
        workspace_id: 'workspace-a',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'requester',
        email: 'requester@example.com',
        email_verified: 1,
        name: 'Requester',
        image: null,
        locale: 'ja',
        workspace_id: 'requester-workspace',
        created_at: now,
        updated_at: now,
      },
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'inbox-a',
      workspace_id: 'workspace-a',
      kind: 'inbox',
      owner_user_id: 'handler',
      created_by_id: 'handler',
      name: 'Inbox',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'artifact-1',
      workspace_id: 'workspace-a',
      owner_user_id: 'handler',
      name: 'Roadmap.html',
      derived_title: 'Roadmap',
      artifact_kind: 'html_page',
      visibility: 'private',
      container_id: 'inbox-a',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('access_requests')
    .values({
      id: 'request-1',
      shareable_id: 'artifact-1',
      requester_user_id: 'requester',
      handler_user_id: 'handler',
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('slack_workspaces')
    .values([
      {
        id: 'slack-capable',
        team_id: 'T-CAPABLE',
        team_name: 'Capable',
        bot_user_id: 'B1',
        bot_token: 'token-capable',
        bot_scopes: 'chat:write',
        installed_by_user_id: 'handler',
        installed_at: now,
        workspace_id: 'workspace-a',
      },
      {
        id: 'slack-no-scope',
        team_id: 'T-NO-SCOPE',
        team_name: 'No scope',
        bot_user_id: 'B2',
        bot_token: 'token-no-scope',
        bot_scopes: null,
        installed_by_user_id: 'handler',
        installed_at: now,
        workspace_id: 'workspace-a',
      },
      {
        id: 'slack-foreign',
        team_id: 'T-FOREIGN',
        team_name: 'Foreign',
        bot_user_id: 'B3',
        bot_token: 'token-foreign',
        bot_scopes: 'chat:write',
        installed_by_user_id: 'handler',
        installed_at: now,
        workspace_id: 'workspace-b',
      },
    ])
    .execute()
  await db
    .insertInto('slack_user_links')
    .values([
      {
        id: 'link-capable',
        slack_team_id: 'T-CAPABLE',
        slack_user_id: 'U-REQUESTER',
        artifactshare_user_id: 'requester',
        linked_at: now,
      },
      {
        id: 'link-no-scope',
        slack_team_id: 'T-NO-SCOPE',
        slack_user_id: 'U-REQUESTER',
        artifactshare_user_id: 'requester',
        linked_at: now,
      },
      {
        id: 'link-foreign',
        slack_team_id: 'T-FOREIGN',
        slack_user_id: 'U-REQUESTER',
        artifactshare_user_id: 'requester',
        linked_at: now,
      },
    ])
    .execute()
}

async function setResolution(db: Kysely<DB>, status: 'approved' | 'rejected') {
  await db
    .updateTable('access_requests')
    .set({
      status,
      resolution_scope: status === 'approved' ? 'artifact' : null,
      resolved_by_user_id: 'handler',
      resolved_at: '2026-09-01T00:01:00.000Z',
      updated_at: '2026-09-01T00:01:00.000Z',
    })
    .where('id', '=', 'request-1')
    .execute()
}

async function resolutionAudits(db: Kysely<DB>) {
  const rows = await db
    .selectFrom('audit_events')
    .select(['action', 'detail'])
    .where('subject_id', '=', 'request-1')
    .where('action', 'like', 'access_request.%')
    .execute()
  return rows.filter((row) => {
    const detail = row.detail ? JSON.parse(row.detail) : null
    return detail?.notification_purpose === 'resolution'
  })
}

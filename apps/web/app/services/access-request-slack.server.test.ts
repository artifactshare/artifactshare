import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  accessRequestSlackPayload,
  sendAccessRequestSlackNotifications,
} from './access-request-slack.server'

describe('access request Slack notifications', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    await seedBase(db)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.destroy()
  })

  test('DMs only linked approvers in the artifact workspace with chat:write', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await sendAccessRequestSlackNotifications(
      db,
      {
        requestId: 'request-1',
        requesterName: 'Requester',
        requesterEmail: 'requester@example.com',
        shareableTitle: 'Roadmap',
        workspaceId: 'workspace-a',
        approvers: [
          { userId: 'approver-ja', email: 'ja@example.com', locale: 'ja' },
        ],
        origin: 'https://artifactshare.test',
      },
      (botToken) => ({
        postMessage: async (payload) => {
          await postMessage(botToken, payload)
        },
      }),
    )

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      'token-capable',
      expect.objectContaining({
        channel: 'U-JA',
        text: expect.stringContaining('閲覧リクエスト'),
      }),
    )
    const payload = postMessage.mock.calls[0]?.[1]
    expect(JSON.stringify(payload)).toContain(
      'Requester (requester@example.com)',
    )
    expect(JSON.stringify(payload)).toContain(
      'https://artifactshare.test/access-requests?request=request-1',
    )
  })

  test('uses plain-text blocks and escapes mention-like content in fallback text', () => {
    const payload = accessRequestSlackPayload({
      channel: 'U1',
      locale: 'en',
      requester: '<!channel> <https://evil.test|click>',
      shareableTitle: '*Roadmap*',
      requestUrl: 'https://artifactshare.test/access-requests?request=r1',
    })

    expect(payload.text).not.toContain('<!channel>')
    expect(payload.text).not.toContain('<https://evil.test|click>')
    expect(payload.blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'plain_text' },
    })
    expect(JSON.stringify(payload.blocks)).not.toContain('approve')
  })

  test('chunks large approver sets below the D1 parameter limit', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const approvers = [
      { userId: 'approver-ja', email: 'ja@example.com', locale: 'ja' },
      ...Array.from({ length: 99 }, (_, index) => ({
        userId: `unlinked-${index}`,
        email: `unlinked-${index}@example.com`,
        locale: null,
      })),
    ]

    await sendAccessRequestSlackNotifications(
      db,
      {
        requestId: 'request-large',
        requesterName: 'Requester',
        requesterEmail: 'requester@example.com',
        shareableTitle: 'Roadmap',
        workspaceId: 'workspace-a',
        approvers,
        origin: 'https://artifactshare.test',
      },
      () => ({ postMessage }),
    )

    expect(postMessage).toHaveBeenCalledOnce()
  })

  test('logs a delivery failure without rejecting or exposing the token', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      sendAccessRequestSlackNotifications(
        db,
        {
          requestId: 'request-2',
          requesterName: null,
          requesterEmail: 'requester@example.com',
          shareableTitle: 'Roadmap',
          workspaceId: 'workspace-a',
          approvers: [
            {
              userId: 'approver-ja',
              email: 'ja@example.com',
              locale: 'ja',
            },
          ],
          origin: 'https://artifactshare.test',
        },
        () => ({
          postMessage: () => Promise.reject(new Error('token-capable')),
        }),
      ),
    ).resolves.toBeUndefined()

    const serialized = JSON.stringify(error.mock.calls)
    expect(serialized).toContain('access_request_slack_failed')
    expect(serialized).toContain('request-2')
    expect(serialized).not.toContain('token-capable')
    expect(serialized).not.toContain('Roadmap')
  })
})

async function seedBase(db: Kysely<DB>) {
  const now = '2026-09-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values([
      { id: 'workspace-a', name: 'A', plan: 'free', created_at: now },
      { id: 'workspace-b', name: 'B', plan: 'free', created_at: now },
    ])
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'approver-ja',
      email: 'ja@example.com',
      email_verified: 1,
      name: 'Approver',
      image: null,
      workspace_id: 'workspace-a',
      locale: 'ja',
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
        bot_scopes: 'links:read,chat:write',
        installed_by_user_id: 'approver-ja',
        installed_at: now,
        workspace_id: 'workspace-a',
      },
      {
        id: 'slack-legacy',
        team_id: 'T-LEGACY',
        team_name: 'Legacy',
        bot_user_id: 'B2',
        bot_token: 'token-legacy',
        bot_scopes: null,
        installed_by_user_id: 'approver-ja',
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
        installed_by_user_id: 'approver-ja',
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
        slack_user_id: 'U-JA',
        artifactshare_user_id: 'approver-ja',
        linked_at: now,
      },
      {
        id: 'link-legacy',
        slack_team_id: 'T-LEGACY',
        slack_user_id: 'U-JA',
        artifactshare_user_id: 'approver-ja',
        linked_at: now,
      },
      {
        id: 'link-foreign',
        slack_team_id: 'T-FOREIGN',
        slack_user_id: 'U-JA',
        artifactshare_user_id: 'approver-ja',
        linked_at: now,
      },
    ])
    .execute()
}

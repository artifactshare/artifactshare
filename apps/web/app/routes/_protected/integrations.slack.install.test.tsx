import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { verifySlackInstallState } from '~/services/slack.server'

const dbState = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    SLACK_CLIENT_ID: 'test-slack-client-id',
    SLACK_LINK_STATE_SECRET: 'test-slack-link-secret',
  },
}))

vi.mock('~/services/db.server', () => ({
  createDb: () => {
    if (!dbState.db) throw new Error('missing sqlite fixture')
    return dbState.db
  },
}))

const requireUserMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))

import { loader } from './integrations.slack.install'

describe('/integrations/slack/install loader', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
  })

  afterEach(async () => {
    dbState.db = null
    await db.destroy()
  })

  test('admin is redirected to Slack authorize URL', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const response = await loader({
      request: new Request('https://example.test/integrations/slack/install'),
      context: {},
    } as never)

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(302)
    const location = (response as Response).headers.get('Location')
    expect(location).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/)
    expect(location).toContain('client_id=test-slack-client-id')
    const slackUrl = new URL(location!)
    expect(slackUrl.searchParams.get('scope')?.split(',')).toContain(
      'chat:write',
    )
    await expect(
      verifySlackInstallState(
        slackUrl.searchParams.get('state')!,
        'test-slack-link-secret',
      ),
    ).resolves.toEqual({
      admin_user_id: 'u-a',
      workspace_id: 'ws-a',
      connection_id: null,
      expected_team_id: null,
    })
  })

  test('binds a reauthorization state to the selected Slack team', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await db
      .insertInto('slack_workspaces')
      .values({
        id: 'connection-a',
        team_id: 'T-A',
        team_name: 'Slack A',
        bot_user_id: 'B-A',
        bot_token: 'old-token',
        bot_scopes: null,
        installed_by_user_id: 'u-a',
        installed_at: '2026-06-01T00:00:00.000Z',
        workspace_id: 'ws-a',
      })
      .execute()
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const response = await loader({
      request: new Request(
        'https://example.test/integrations/slack/install?connection=connection-a',
      ),
      context: {},
    } as never)
    const location = (response as Response).headers.get('Location')!
    const state = new URL(location).searchParams.get('state')!

    await expect(
      verifySlackInstallState(state, 'test-slack-link-secret'),
    ).resolves.toEqual({
      admin_user_id: 'u-a',
      workspace_id: 'ws-a',
      connection_id: 'connection-a',
      expected_team_id: 'T-A',
    })
  })

  test('non-admin is redirected to integrations settings with forbidden status', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    requireUserMock.mockReturnValue(sessionUser('u-b', 'ws-a'))

    const response = await loader({
      request: new Request('https://example.test/integrations/slack/install'),
      context: {},
    } as never)

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(302)
    expect((response as Response).headers.get('Location')).toBe(
      '/settings/integrations?status=forbidden',
    )
  })
})

async function seedBase(db: Kysely<DB>) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      name: 'A',
      created_at: now,
    })
    .execute()
  await db
    .insertInto('users')
    .values([
      {
        id: 'u-a',
        email: 'a@example.com',
        email_verified: 1,
        name: 'User A',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws-a',
        locale: null,
      },
      {
        id: 'u-b',
        email: 'b@example.com',
        email_verified: 1,
        name: 'User B',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: 'ws-a',
        locale: null,
      },
    ])
    .execute()
}

async function seedAdmin(db: Kysely<DB>, userId: string, workspaceId: string) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'user_id']).doUpdateSet({
        role: 'admin',
        status: 'active',
        updated_at: now,
      }),
    )
    .execute()
}

function sessionUser(id: string, workspaceId: string): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    workspaceId,
    hd: null,
    msTenantId: null,
    kind: 'human' as const,
    locale: null,
  }
}

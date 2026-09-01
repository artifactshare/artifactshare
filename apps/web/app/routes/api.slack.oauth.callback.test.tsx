import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbState = vi.hoisted(() => ({ db: null as Kysely<DB> | null }))

vi.mock('cloudflare:workers', () => ({
  env: {
    SLACK_CLIENT_ID: 'client-id',
    SLACK_CLIENT_SECRET: 'client-secret',
    SLACK_LINK_STATE_SECRET: 'state-secret',
  },
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => {
    if (!dbState.db) throw new Error('missing db')
    return dbState.db
  },
}))

import { signSlackInstallState } from '~/services/slack.server'
import { loader } from './api.slack.oauth.callback'

describe('/api/slack/oauth/callback', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    dbState.db = null
    await db.destroy()
  })

  test('does not mutate a connection when Slack returns a different team', async () => {
    mockOauth('T-OTHER', 'new-token', 'chat:write,links:read')
    const state = await reauthorizationState()

    const response = await runCallback(state)

    expect(response.headers.get('Location')).toBe(
      '/settings/integrations?status=slack-team-mismatch',
    )
    await expect(connection()).resolves.toMatchObject({
      bot_token: 'old-token',
      bot_scopes: null,
    })
  })

  test('updates the token and granted scopes for the bound connection', async () => {
    mockOauth('T-A', 'new-token', 'links:read, chat:write,links:read')
    const state = await reauthorizationState()

    const response = await runCallback(state)

    expect(response.headers.get('Location')).toBe(
      '/settings/integrations?connected=slack',
    )
    await expect(connection()).resolves.toMatchObject({
      bot_token: 'new-token',
      bot_scopes: 'chat:write,links:read',
    })
  })

  test('cannot take over a Slack team connected to another workspace', async () => {
    mockOauth('T-FOREIGN', 'attacker-token', 'chat:write')
    const state = await signSlackInstallState({
      admin_user_id: 'admin-a',
      workspace_id: 'workspace-a',
    })

    const response = await runCallback(state)

    expect(response.headers.get('Location')).toBe(
      '/settings/integrations?status=slack-team-in-use',
    )
    const foreign = await db
      .selectFrom('slack_workspaces')
      .select(['bot_token', 'workspace_id'])
      .where('team_id', '=', 'T-FOREIGN')
      .executeTakeFirstOrThrow()
    expect(foreign).toEqual({
      bot_token: 'foreign-token',
      workspace_id: 'workspace-b',
    })
  })

  async function reauthorizationState() {
    return signSlackInstallState({
      admin_user_id: 'admin-a',
      workspace_id: 'workspace-a',
      connection_id: 'connection-a',
      expected_team_id: 'T-A',
    })
  }

  async function runCallback(state: string) {
    return loader({
      request: new Request(
        `https://artifactshare.test/api/slack/oauth/callback?code=code&state=${encodeURIComponent(state)}`,
      ),
    } as never)
  }

  function connection() {
    return db
      .selectFrom('slack_workspaces')
      .select(['bot_token', 'bot_scopes'])
      .where('id', '=', 'connection-a')
      .executeTakeFirstOrThrow()
  }
})

function mockOauth(teamId: string, token: string, scope: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: token,
        bot_user_id: 'B-NEW',
        scope,
        team: { id: teamId, name: `Team ${teamId}` },
      }),
    ),
  )
}

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
      id: 'admin-a',
      email: 'admin@example.com',
      email_verified: 1,
      name: 'Admin',
      image: null,
      workspace_id: 'workspace-a',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: 'workspace-a',
      user_id: 'admin-a',
      role: 'admin',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute()
  await db
    .insertInto('slack_workspaces')
    .values([
      {
        id: 'connection-a',
        team_id: 'T-A',
        team_name: 'Team A',
        bot_user_id: 'B-OLD',
        bot_token: 'old-token',
        bot_scopes: null,
        installed_by_user_id: 'admin-a',
        installed_at: now,
        workspace_id: 'workspace-a',
      },
      {
        id: 'connection-foreign',
        team_id: 'T-FOREIGN',
        team_name: 'Team Foreign',
        bot_user_id: 'B-FOREIGN',
        bot_token: 'foreign-token',
        bot_scopes: 'chat:write',
        installed_by_user_id: null,
        installed_at: now,
        workspace_id: 'workspace-b',
      },
    ])
    .execute()
}

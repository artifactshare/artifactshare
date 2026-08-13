import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbState = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
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

import { action, loader } from './integrations'

describe('/settings/integrations loader', () => {
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

  test('returns slack connections filtered by workspace_id', async () => {
    await seedSlackConnection(db, {
      id: 'sw-a',
      teamId: 'T-A',
      teamName: 'Slack A',
      workspaceId: 'ws-a',
      installedByUserId: 'u-a',
      installedAt: '2026-06-20T12:00:00.000Z',
    })
    await seedSlackConnection(db, {
      id: 'sw-b',
      teamId: 'T-B',
      teamName: 'Slack B',
      workspaceId: 'ws-b',
      installedByUserId: 'u-b',
      installedAt: '2026-06-21T12:00:00.000Z',
    })

    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const result = await loader({ context: {} } as never)

    expect(result.connections).toEqual([
      {
        id: 'sw-a',
        teamName: 'Slack A',
        installedAt: '2026-06-20T12:00:00.000Z',
        installedByName: 'User A',
      },
    ])
  })

  test('does not include connections owned by another workspace', async () => {
    await seedSlackConnection(db, {
      id: 'sw-b',
      teamId: 'T-B',
      teamName: 'Other workspace Slack',
      workspaceId: 'ws-b',
      installedByUserId: 'u-b',
      installedAt: '2026-06-21T12:00:00.000Z',
    })

    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const result = await loader({ context: {} } as never)

    expect(result.connections).toEqual([])
  })
})

describe('/settings/integrations action', () => {
  let db: Kysely<DB>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
    await seedBase(db)
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revoked: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    dbState.db = null
    await db.destroy()
  })

  test('admin can delete own workspace connection', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await seedSlackConnection(db, {
      id: 'sw-a',
      teamId: 'T-A',
      teamName: 'Slack A',
      workspaceId: 'ws-a',
      installedByUserId: 'u-a',
      installedAt: '2026-06-20T12:00:00.000Z',
    })
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'disconnect-slack',
        connectionId: 'sw-a',
      }),
      context: {},
    } as never)

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(302)
    expect((response as Response).headers.get('Location')).toBe(
      '/settings/integrations?status=ok',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/auth.revoke',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test',
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({}),
      },
    )
    const remaining = await db
      .selectFrom('slack_workspaces')
      .selectAll()
      .execute()
    expect(remaining).toEqual([])
  })

  test('non-admin cannot delete workspace connection', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await seedSlackConnection(db, {
      id: 'sw-a',
      teamId: 'T-A',
      teamName: 'Slack A',
      workspaceId: 'ws-a',
      installedByUserId: 'u-a',
      installedAt: '2026-06-20T12:00:00.000Z',
    })
    requireUserMock.mockReturnValue(sessionUser('u-c', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'disconnect-slack',
        connectionId: 'sw-a',
      }),
      context: {},
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      '/settings/integrations?status=forbidden',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([{ id: 'sw-a' }])
  })

  test('admin cannot delete another workspace connection', async () => {
    await seedAdmin(db, 'u-a', 'ws-a')
    await seedSlackConnection(db, {
      id: 'sw-b',
      teamId: 'T-B',
      teamName: 'Slack B',
      workspaceId: 'ws-b',
      installedByUserId: 'u-b',
      installedAt: '2026-06-21T12:00:00.000Z',
    })
    requireUserMock.mockReturnValue(sessionUser('u-a', 'ws-a'))

    const response = await action({
      request: postForm({
        intent: 'disconnect-slack',
        connectionId: 'sw-b',
      }),
      context: {},
    } as never)

    expect((response as Response).headers.get('Location')).toBe(
      '/settings/integrations?status=not-found',
    )
    expect(fetchMock).not.toHaveBeenCalled()
    const remaining = await db
      .selectFrom('slack_workspaces')
      .select('id')
      .execute()
    expect(remaining).toEqual([{ id: 'sw-b' }])
  })
})

async function seedBase(db: Kysely<DB>) {
  const now = '2026-06-01T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'ws-a',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        name: 'A',
        created_at: now,
      },
      {
        id: 'ws-b',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        name: 'B',
        created_at: now,
      },
    ])
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
        workspace_id: 'ws-b',
        locale: null,
      },
      {
        id: 'u-c',
        email: 'c@example.com',
        email_verified: 1,
        name: 'User C',
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

async function seedSlackConnection(
  db: Kysely<DB>,
  values: {
    id: string
    teamId: string
    teamName: string
    workspaceId: string
    installedByUserId: string
    installedAt: string
  },
) {
  await db
    .insertInto('slack_workspaces')
    .values({
      id: values.id,
      team_id: values.teamId,
      team_name: values.teamName,
      bot_user_id: 'B123',
      bot_token: 'xoxb-test',
      installed_by_user_id: values.installedByUserId,
      installed_at: values.installedAt,
      workspace_id: values.workspaceId,
    })
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

function postForm(fields: Record<string, string>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value)
  }
  return new Request('https://example.test/settings/integrations', {
    method: 'POST',
    body: form,
  })
}

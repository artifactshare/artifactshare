import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BOT_EMAIL_DOMAIN } from '~/lib/bot-account'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: { APP_ENV: 'development' } }))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: vi.fn(async () => ({ kind: 'allowed' })),
}))

import { suggestRecipients } from './recipient-suggestions.server'

const BOT_EMAIL = `bot@${BOT_EMAIL_DOMAIN}`
const DELETED_BOT_EMAIL = `deleted-bot@${BOT_EMAIL_DOMAIN}`

const OWNER: SessionUser = {
  id: 'owner',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Owner',
  image: null,
  workspaceId: 'ws-a',
  selfUploadEnabled: true,
  hd: 'example.com',
  msTenantId: null,
  locale: 'en',
  kind: 'human',
}

describe('suggestRecipients', () => {
  let db: Kysely<DB>
  let sqlite: DatabaseSync

  beforeEach(async () => {
    ;({ db, sqlite } = createMigratedInMemoryDb())
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-a',
        hd: 'example.com',
        name: 'Workspace A',
        created_at: '2026-08-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values([
        userRow('owner', 'owner@example.com', 'Owner'),
        userRow('amy', 'amy@example.com', 'Amy Active'),
        userRow('contains', 'team-amy@example.com', 'Zoe'),
        userRow('removed', 'amy.removed@example.com', 'Amy Removed'),
        {
          ...userRow('bot', BOT_EMAIL, 'Bot'),
          kind: 'bot',
        },
      ])
      .execute()
    await db
      .insertInto('workspace_members')
      .values([
        memberRow('owner', 'active'),
        memberRow('amy', 'active'),
        memberRow('contains', 'active'),
        memberRow('removed', 'removed'),
        memberRow('bot', 'active'),
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox',
        workspace_id: 'ws-a',
        kind: 'inbox',
        owner_user_id: 'owner',
        created_by_id: 'owner',
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values([shareableRow('owned'), shareableRow('another')])
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('ranks prefix workspace matches and excludes self, pending, current, removed, and bots', async () => {
    await db
      .insertInto('shareable_grants')
      .values([
        grantRow('owned', 'team-amy@example.com', '2026-08-20T00:00:00.000Z'),
        grantRow(
          'another',
          'amy.external@example.org',
          '2026-08-19T00:00:00.000Z',
        ),
      ])
      .execute()

    const result = await suggestRecipients(
      db,
      OWNER,
      { kind: 'shareable', id: 'owned' },
      'amy',
      ['amy.external@example.org'],
    )

    expect(result).toEqual({
      kind: 'ok',
      candidates: [
        {
          email: 'amy@example.com',
          user: { id: 'amy', name: 'Amy Active', image: null },
          displayName: 'Amy Active',
        },
      ],
    })
  })

  test('returns current personal history but rechecks bots and removed workspace members', async () => {
    await db
      .insertInto('shareable_grants')
      .values([
        grantRow('another', 'bob@example.org', '2026-08-22T00:00:00.000Z'),
        grantRow('another', BOT_EMAIL, '2026-08-23T00:00:00.000Z'),
        grantRow('another', DELETED_BOT_EMAIL, '2026-08-25T00:00:00.000Z'),
        grantRow(
          'another',
          'amy.removed@example.com',
          '2026-08-24T00:00:00.000Z',
        ),
      ])
      .execute()

    const result = await suggestRecipients(
      db,
      OWNER,
      { kind: 'shareable', id: 'owned' },
      'bo',
      [],
    )

    expect(result).toEqual({
      kind: 'ok',
      candidates: [
        {
          email: 'bob@example.org',
          user: null,
          displayName: null,
        },
      ],
    })
  })

  test('matches a registered historical recipient by their current name', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-history',
        hd: 'history.example',
        name: 'History workspace',
        created_at: '2026-08-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        ...userRow('julia', 'person@example.org', 'Julia History'),
        workspace_id: 'ws-history',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        ...memberRow('julia', 'active'),
        workspace_id: 'ws-history',
      })
      .execute()
    await db
      .insertInto('shareable_grants')
      .values(
        grantRow('another', 'person@example.org', '2026-08-22T00:00:00.000Z'),
      )
      .execute()

    const result = await suggestRecipients(
      db,
      OWNER,
      { kind: 'shareable', id: 'owned' },
      'julia',
      [],
    )
    expect(result).toEqual({
      kind: 'ok',
      candidates: [
        {
          email: 'person@example.org',
          user: { id: 'julia', name: 'Julia History', image: null },
          displayName: 'Julia History',
        },
      ],
    })
  })

  test('uses the case-insensitive email index for historical name resolution', async () => {
    const plan = sqlite
      .prepare(`
      EXPLAIN QUERY PLAN
      SELECT g.granted_email
      FROM shareable_grants AS g
      LEFT JOIN users AS u
        ON lower(u.email) = lower(g.granted_email)
      WHERE g.granted_by = ?
        AND (
          instr(lower(g.granted_email), 'julia') > 0
          OR instr(lower(coalesce(u.name, '')), 'julia') > 0
        )
      ORDER BY g.granted_at DESC
      LIMIT 32
    `)
      .all(OWNER.id) as Array<{ detail: string }>

    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'users_email_lower',
    )
  })

  test('keeps a prefix match when more than 32 workspace members match', async () => {
    const users = Array.from({ length: 33 }, (_, index) =>
      userRow(
        `member-${index}`,
        `z-${String(index).padStart(2, '0')}-match@example.com`,
        `Member ${index}`,
      ),
    )
    users.push(userRow('prefix', 'match-first@example.com', 'Prefix'))
    for (const group of chunk(users, 8)) {
      await db.insertInto('users').values(group).execute()
      await db
        .insertInto('workspace_members')
        .values(group.map((row) => memberRow(row.id, 'active')))
        .execute()
    }

    const result = await suggestRecipients(
      db,
      OWNER,
      { kind: 'shareable', id: 'owned' },
      'match',
      [],
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.candidates[0]?.email).toBe('match-first@example.com')
    }
  })

  test('denies upload suggestions for a removed member even with a stale upload-enabled session', async () => {
    await db
      .updateTable('workspace_members')
      .set({ status: 'removed' })
      .where('workspace_id', '=', 'ws-a')
      .where('user_id', '=', OWNER.id)
      .execute()

    await expect(
      suggestRecipients(db, OWNER, { kind: 'upload' }, 'am', []),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('excludes a known historical user removed from another workspace', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-b',
        hd: 'external.example',
        name: 'Workspace B',
        created_at: '2026-08-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        ...userRow('external', 'external@example.org', 'External'),
        workspace_id: 'ws-b',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        ...memberRow('external', 'removed'),
        workspace_id: 'ws-b',
      })
      .execute()
    await db
      .insertInto('shareable_grants')
      .values(
        grantRow('another', 'external@example.org', '2026-08-24T00:00:00.000Z'),
      )
      .execute()

    const result = await suggestRecipients(
      db,
      OWNER,
      { kind: 'shareable', id: 'owned' },
      'external@',
      [],
    )
    expect(result).toEqual({ kind: 'ok', candidates: [] })
  })

  test('denies suggestions for a shareable the actor does not own', async () => {
    await db
      .updateTable('shareables')
      .set({ owner_user_id: 'amy' })
      .where('id', '=', 'owned')
      .execute()

    await expect(
      suggestRecipients(
        db,
        OWNER,
        { kind: 'shareable', id: 'owned' },
        'am',
        [],
      ),
    ).resolves.toEqual({ kind: 'forbidden' })
  })
})

function userRow(id: string, email: string, name: string) {
  const now = '2026-08-01T00:00:00.000Z'
  return {
    id,
    email,
    email_verified: 1,
    name,
    image: null,
    created_at: now,
    updated_at: now,
    workspace_id: 'ws-a',
    locale: 'en',
    kind: 'human' as const,
  }
}

function memberRow(userId: string, status: 'active' | 'removed') {
  const now = '2026-08-01T00:00:00.000Z'
  return {
    workspace_id: 'ws-a',
    user_id: userId,
    role: userId === 'owner' ? ('owner' as const) : ('member' as const),
    status,
    first_contributed_at: null,
    last_contributed_at: null,
    removed_at: status === 'removed' ? now : null,
    removed_by: status === 'removed' ? 'owner' : null,
    created_at: now,
    updated_at: now,
  }
}

function grantRow(shareableId: string, email: string, grantedAt: string) {
  return {
    shareable_id: shareableId,
    granted_email: email,
    granted_at: grantedAt,
    granted_by: 'owner',
  }
}

function shareableRow(id: string) {
  return {
    id,
    workspace_id: 'ws-a',
    owner_user_id: 'owner',
    name: id,
    artifact_kind: 'html_page' as const,
    visibility: 'private' as const,
    current_version_id: null,
    container_id: 'inbox',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    last_accessed_at: null,
    link_expires_at: null,
    created_by_agent_profile_id: null,
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size))
  }
  return groups
}

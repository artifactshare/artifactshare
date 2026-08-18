import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: {},
}))

import type { Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  countShareableViewers,
  listShareableViewers,
} from './viewer-list.server'

const T0 = '2026-08-01T00:00:00.000Z'

const ownerUser = sessionUser('u-owner', 'owner@example.com', 'ws1')
const memberUser = sessionUser('u-member', 'member@example.com', 'ws1')
const removedUser = sessionUser('u-removed', 'removed@example.com', 'ws2')
const outsiderUser = sessionUser(
  'u-outsider',
  'outsider@outside.example',
  'ws2',
)
const botUser: SessionUser = {
  ...sessionUser('u-bot', 'bot-list@bots.artifactshare.invalid', 'ws1'),
  kind: 'bot',
}

describe('viewer-list.server', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb>
  let db: Kysely<DB>

  beforeEach(async () => {
    fixture = createMigratedInMemoryDb()
    db = fixture.db
    await seedBase(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  describe('listShareableViewers access and eligibility', () => {
    test('non-existent shareable is not-found', async () => {
      expect(
        await listShareableViewers(db, {
          user: memberUser,
          shareableId: 'missing',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'not-found' })
    })

    test('same-workspace member without view access is not-found', async () => {
      // s-private is visible to its owner only.
      expect(
        await listShareableViewers(db, {
          user: memberUser,
          shareableId: 's-private',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'not-found' })
    })

    test('removed requester without residual access is not-found', async () => {
      expect(
        await listShareableViewers(db, {
          user: removedUser,
          shareableId: 's1',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'not-found' })
    })

    test('removed requester with a residual grant is forbidden', async () => {
      await grant(db, 's1', removedUser.email)
      expect(
        await listShareableViewers(db, {
          user: removedUser,
          shareableId: 's1',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'forbidden' })
    })

    test('other-workspace requester with a grant is forbidden', async () => {
      await grant(db, 's1', outsiderUser.email)
      expect(
        await listShareableViewers(db, {
          user: outsiderUser,
          shareableId: 's1',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'forbidden' })
    })

    test('bot requester is forbidden', async () => {
      expect(
        await listShareableViewers(db, {
          user: botUser,
          shareableId: 's1',
          cursor: null,
          limit: null,
        }),
      ).toEqual({ kind: 'forbidden' })
    })

    test('parameters are checked after eligibility: ineligible caller with a bad cursor gets forbidden, not 400', async () => {
      await grant(db, 's1', outsiderUser.email)
      expect(
        await listShareableViewers(db, {
          user: outsiderUser,
          shareableId: 's1',
          cursor: 'not-a-cursor',
          limit: 'x',
        }),
      ).toEqual({ kind: 'forbidden' })
    })
  })

  describe('listShareableViewers disclosure', () => {
    test('owner and non-owner member both list disclosed viewers, newest first', async () => {
      await seedViewers(db)
      for (const user of [ownerUser, memberUser]) {
        const result = await listShareableViewers(db, {
          user,
          shareableId: 's1',
          cursor: null,
          limit: null,
        })
        expect(result.kind).toBe('ok')
        if (result.kind !== 'ok') return
        expect(result.rows.map((row) => row.userId)).toEqual([
          'u-member',
          'u-owner',
        ])
        expect(result.totalViewers).toBe(2)
        expect(result.nextCursor).toBeNull()
        expect(result.rows.map((row) => row.isSelf)).toEqual([
          user.id === 'u-member',
          user.id === 'u-owner',
        ])
      }
    })

    test('other-workspace, removed-member, and bot viewer rows are excluded', async () => {
      await seedViewers(db)
      const result = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      const ids = result.rows.map((row) => row.userId)
      expect(ids).not.toContain('u-outsider')
      expect(ids).not.toContain('u-removed')
      expect(ids).not.toContain('u-bot')
      expect(result.totalViewers).toBe(2)
    })

    test('restoring a removed member (workspace_id back + status active) re-discloses the old row', async () => {
      await seedViewers(db)
      // Real path: restoreWorkspaceMember moves users.workspace_id back and
      // reactivates the membership row.
      await db
        .updateTable('users')
        .set({ workspace_id: 'ws1' })
        .where('id', '=', 'u-removed')
        .execute()
      await db
        .updateTable('workspace_members')
        .set({ status: 'active', removed_at: null })
        .where('user_id', '=', 'u-removed')
        .where('workspace_id', '=', 'ws1')
        .execute()

      const result = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.rows.map((row) => row.userId)).toContain('u-removed')
      expect(result.totalViewers).toBe(3)
    })

    test('a member whose view access was narrowed away stays listed for the rest', async () => {
      await seedViewers(db)
      // The disclosure predicate does not look at the viewer's own access to
      // the file; u-owner and u-member remain listed even if sharing later
      // narrows. Simulate by keeping the recency row while the requester is a
      // third eligible member with late-granted access to the full history.
      await db
        .insertInto('users')
        .values(userRow('u-late', 'late@example.com', 'ws1'))
        .execute()
      await activeMember(db, 'u-late')
      const result = await listShareableViewers(db, {
        user: sessionUser('u-late', 'late@example.com', 'ws1'),
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.rows.map((row) => row.userId)).toEqual([
        'u-member',
        'u-owner',
      ])
    })

    test('name is passed through raw: null, empty, and whitespace', async () => {
      await db
        .insertInto('users')
        .values([
          userRow('u-null', 'null@example.com', 'ws1', null),
          userRow('u-empty', 'empty@example.com', 'ws1', ''),
          userRow('u-blank', 'blank@example.com', 'ws1', '   '),
        ])
        .execute()
      for (const id of ['u-null', 'u-empty', 'u-blank']) {
        await activeMember(db, id)
      }
      await recency(db, 's1', 'u-null', '2026-08-01T03:00:00.000Z')
      await recency(db, 's1', 'u-empty', '2026-08-01T02:00:00.000Z')
      await recency(db, 's1', 'u-blank', '2026-08-01T01:00:00.000Z')

      const result = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.rows.map((row) => [row.userId, row.name])).toEqual([
        ['u-null', null],
        ['u-empty', ''],
        ['u-blank', '   '],
      ])
    })
  })

  describe('listShareableViewers pagination', () => {
    test('51 disclosed viewers: default limit returns 50 + nextCursor; the second page drains without a cursor', async () => {
      await seedManyViewers(db, 51)
      const first = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(first.kind).toBe('ok')
      if (first.kind !== 'ok') return
      expect(first.rows).toHaveLength(50)
      expect(first.nextCursor).not.toBeNull()
      expect(first.totalViewers).toBe(51)

      const second = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: first.nextCursor,
        limit: null,
      })
      expect(second.kind).toBe('ok')
      if (second.kind !== 'ok') return
      expect(second.rows).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(second.totalViewers).toBe(51)
      const all = [...first.rows, ...second.rows].map((row) => row.userId)
      expect(new Set(all).size).toBe(51)
    })

    test('exactly 50 disclosed viewers exhausts the first page with a null cursor', async () => {
      await seedManyViewers(db, 50)
      const result = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      expect(result.rows).toHaveLength(50)
      expect(result.nextCursor).toBeNull()
    })

    test('limit=1 pages one row at a time and a tie across the page boundary loses no row', async () => {
      // Two viewers share the same last_viewed_at; the id tiebreaker must
      // carry the keyset across the boundary.
      await seedViewers(db)
      await db
        .updateTable('shareable_viewer_recency')
        .set({ last_viewed_at: '2026-08-01T05:00:00.000Z' })
        .where('shareable_id', '=', 's1')
        .execute()

      const seen: string[] = []
      let cursor: string | null = null
      let totalIterations = 0
      do {
        const page = await listShareableViewers(db, {
          user: memberUser,
          shareableId: 's1',
          cursor,
          limit: '1',
        })
        expect(page.kind).toBe('ok')
        if (page.kind !== 'ok') return
        expect(page.rows).toHaveLength(1)
        seen.push(...page.rows.map((row) => row.userId))
        cursor = page.nextCursor
        totalIterations += 1
      } while (cursor && totalIterations < 10)
      expect(seen).toEqual(['u-owner', 'u-member'])
    })

    test('issued cursors are always re-accepted, including synthetic non-canonical timestamps', async () => {
      // Defensive coverage: real data is canonical on every path; these
      // synthetic values prove the cursor round-trip is format-agnostic.
      await seedViewers(db)
      await db
        .updateTable('shareable_viewer_recency')
        .set({ last_viewed_at: '2024-01-01 09:00:00' })
        .where('viewer_user_id', '=', 'u-owner')
        .execute()
      await db
        .updateTable('shareable_viewer_recency')
        .set({ last_viewed_at: '2024-01-01T09:00:00+09:00' })
        .where('viewer_user_id', '=', 'u-member')
        .execute()

      const seen: string[] = []
      let cursor: string | null = null
      let iterations = 0
      do {
        const page = await listShareableViewers(db, {
          user: memberUser,
          shareableId: 's1',
          cursor,
          limit: '1',
        })
        expect(page.kind).toBe('ok')
        if (page.kind !== 'ok') return
        seen.push(...page.rows.map((row) => row.userId))
        cursor = page.nextCursor
        iterations += 1
      } while (cursor && iterations < 10)
      expect(new Set(seen)).toEqual(new Set(['u-owner', 'u-member']))
      expect(seen).toHaveLength(2)
    })

    test('totalViewers is identical on every page of static data', async () => {
      await seedManyViewers(db, 7)
      const totals: number[] = []
      let cursor: string | null = null
      let iterations = 0
      do {
        const page = await listShareableViewers(db, {
          user: memberUser,
          shareableId: 's1',
          cursor,
          limit: '3',
        })
        expect(page.kind).toBe('ok')
        if (page.kind !== 'ok') return
        totals.push(page.totalViewers)
        cursor = page.nextCursor
        iterations += 1
      } while (cursor && iterations < 10)
      expect(totals).toEqual([7, 7, 7])
    })
  })

  describe('listShareableViewers parameter validation', () => {
    const invalidCursors: Array<[string, string]> = [
      ['garbage', '!!!not-base64url!!!'],
      ['non-object JSON', encode('"a-string"')],
      ['array', encode('[1,2,3]')],
      ['missing keys', encode('{"last_viewed_at":"t","viewer_user_id":"u"}')],
      [
        'extra keys',
        encode(
          '{"last_viewed_at":"t","viewer_user_id":"u","filter":"s1","x":1}',
        ),
      ],
      [
        'non-string value',
        encode('{"last_viewed_at":1,"viewer_user_id":"u","filter":"s1"}'),
      ],
      [
        'wrong filter',
        encode(
          '{"last_viewed_at":"t","viewer_user_id":"u","filter":"other-id"}',
        ),
      ],
    ]

    test.each(invalidCursors)(
      'cursor %s is invalid-cursor',
      async (_label, cursor) => {
        expect(
          await listShareableViewers(db, {
            user: memberUser,
            shareableId: 's1',
            cursor,
            limit: null,
          }),
        ).toEqual({ kind: 'invalid-cursor' })
      },
    )

    test.each([['0'], ['-1'], ['1.5'], ['x'], ['101']])(
      'limit %s is invalid-limit',
      async (limit) => {
        expect(
          await listShareableViewers(db, {
            user: memberUser,
            shareableId: 's1',
            cursor: null,
            limit,
          }),
        ).toEqual({ kind: 'invalid-limit' })
      },
    )

    test('limit bounds 1 and 100 are accepted', async () => {
      for (const limit of ['1', '100']) {
        const result = await listShareableViewers(db, {
          user: memberUser,
          shareableId: 's1',
          cursor: null,
          limit,
        })
        expect(result.kind).toBe('ok')
      }
    })
  })

  describe('countShareableViewers', () => {
    test('member requester with viewers: eligible, counted, multi-member', async () => {
      await seedViewers(db)
      expect(
        await countShareableViewers(db, {
          shareableId: 's1',
          artifactWorkspaceId: 'ws1',
          requesterUserId: memberUser.id,
        }),
      ).toEqual({
        requesterIsActiveHumanMember: true,
        viewerCount: 2,
        hasMultipleActiveHumanMembers: true,
      })
    })

    test('viewerCount equals listShareableViewers totalViewers on the same fixture', async () => {
      await seedViewers(db)
      const stats = await countShareableViewers(db, {
        shareableId: 's1',
        artifactWorkspaceId: 'ws1',
        requesterUserId: memberUser.id,
      })
      const list = await listShareableViewers(db, {
        user: memberUser,
        shareableId: 's1',
        cursor: null,
        limit: null,
      })
      expect(list.kind).toBe('ok')
      if (list.kind !== 'ok') return
      expect(stats.viewerCount).toBe(list.totalViewers)
    })

    test('self-absent transient: without a recency row the requester is not counted', async () => {
      // Right after a first view, waitUntil has not persisted the requester's
      // own recency row yet; the count excludes them by design (no synthesis,
      // no +1 correction).
      await recency(db, 's1', 'u-owner', '2026-08-01T01:00:00.000Z')
      const stats = await countShareableViewers(db, {
        shareableId: 's1',
        artifactWorkspaceId: 'ws1',
        requesterUserId: memberUser.id,
      })
      expect(stats.requesterIsActiveHumanMember).toBe(true)
      expect(stats.viewerCount).toBe(1)
    })

    test('bot requester and removed requester are not active human members', async () => {
      for (const requesterUserId of ['u-bot', 'u-removed', 'u-outsider']) {
        const stats = await countShareableViewers(db, {
          shareableId: 's1',
          artifactWorkspaceId: 'ws1',
          requesterUserId,
        })
        expect(stats.requesterIsActiveHumanMember).toBe(false)
      }
    })

    test('a solo workspace has no multiple active human members', async () => {
      // Remove every eligible member except the owner.
      await db
        .updateTable('workspace_members')
        .set({ status: 'removed' })
        .where('workspace_id', '=', 'ws1')
        .where('user_id', '!=', 'u-owner')
        .execute()
      const stats = await countShareableViewers(db, {
        shareableId: 's1',
        artifactWorkspaceId: 'ws1',
        requesterUserId: ownerUser.id,
      })
      expect(stats).toEqual({
        requesterIsActiveHumanMember: true,
        viewerCount: 0,
        hasMultipleActiveHumanMembers: false,
      })
    })
  })
})

function encode(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url')
}

function sessionUser(
  id: string,
  email: string,
  workspaceId: string,
): SessionUser {
  return {
    id,
    email,
    emailVerified: true,
    name: `User ${id}`,
    image: null,
    workspaceId,
    hd: 'example.com',
    msTenantId: null,
    locale: null,
    kind: 'human',
  }
}

function userRow(
  id: string,
  email: string,
  workspaceId: string,
  name: string | null = `User ${id}`,
  kind: 'human' | 'bot' = 'human',
) {
  return {
    id,
    email,
    email_verified: 1,
    name,
    image: null,
    created_at: T0,
    updated_at: T0,
    workspace_id: workspaceId,
    locale: null,
    kind,
  }
}

async function activeMember(
  db: Kysely<DB>,
  userId: string,
  workspaceId = 'ws1',
  status: 'active' | 'removed' = 'active',
) {
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'member',
      status,
      created_at: T0,
      updated_at: T0,
    })
    .execute()
}

async function recency(
  db: Kysely<DB>,
  shareableId: string,
  viewerUserId: string,
  lastViewedAt: string,
) {
  await db
    .insertInto('shareable_viewer_recency')
    .values({
      shareable_id: shareableId,
      viewer_user_id: viewerUserId,
      first_viewed_at: lastViewedAt,
      last_viewed_at: lastViewedAt,
      version_seen_through_at: null,
      comment_seen_through_at: null,
      viewed_title: null,
      viewed_owner_name: null,
    })
    .execute()
}

async function grant(db: Kysely<DB>, shareableId: string, email: string) {
  await db
    .insertInto('shareable_grants')
    .values({
      shareable_id: shareableId,
      granted_email: email,
      granted_at: T0,
      granted_by: 'u-owner',
    })
    .execute()
}

async function seedBase(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      { id: 'ws1', hd: 'example.com', name: 'Example', created_at: T0 },
      { id: 'ws2', hd: 'outside.example', name: 'Outside', created_at: T0 },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      userRow('u-owner', 'owner@example.com', 'ws1'),
      userRow('u-member', 'member@example.com', 'ws1'),
      // Removed member: users.workspace_id has been moved off ws1 and the
      // membership row is status 'removed'.
      userRow('u-removed', 'removed@example.com', 'ws2'),
      userRow('u-outsider', 'outsider@outside.example', 'ws2'),
      userRow(
        'u-bot',
        'bot-list@bots.artifactshare.invalid',
        'ws1',
        'Bot',
        'bot',
      ),
    ])
    .execute()
  // Eligible users need an active workspace_members row; without one, nobody
  // satisfies the disclosure predicate.
  await activeMember(db, 'u-owner')
  await activeMember(db, 'u-member')
  await activeMember(db, 'u-removed', 'ws1', 'removed')
  await activeMember(db, 'u-outsider', 'ws2')
  await activeMember(db, 'u-bot')
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws1',
      kind: 'inbox',
      owner_user_id: 'u-owner',
      created_by_id: 'u-owner',
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
    })
    .execute()
  await seedShareable(db, 's1', 'workspace')
  await seedShareable(db, 's-private', 'private')
}

async function seedShareable(
  db: Kysely<DB>,
  id: string,
  visibility: 'workspace' | 'private',
) {
  await db
    .insertInto('shareables')
    .values({
      id,
      workspace_id: 'ws1',
      owner_user_id: 'u-owner',
      slug: null,
      name: `${id}.html`,
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility,
      current_version_id: `v-${id}`,
      container_id: 'owner-inbox',
      created_at: T0,
      updated_at: T0,
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `v-${id}`,
      shareable_id: id,
      artifact_kind: 'html_page',
      status: 'published',
      entrypoint_path: `/${id}.html`,
      r2_key: `ws1/${id}/v1/${id}.html`,
      size_bytes: 100,
      sha256: 'sha',
      created_by_id: 'u-owner',
      created_at: T0,
      published_at: T0,
    })
    .execute()
}

// Disclosed rows: u-owner + u-member. Excluded rows: u-outsider (other
// workspace), u-removed (moved workspace + removed membership), u-bot.
async function seedViewers(db: Kysely<DB>) {
  await recency(db, 's1', 'u-member', '2026-08-01T04:00:00.000Z')
  await recency(db, 's1', 'u-owner', '2026-08-01T03:00:00.000Z')
  await recency(db, 's1', 'u-removed', '2026-08-01T02:30:00.000Z')
  await recency(db, 's1', 'u-outsider', '2026-08-01T02:00:00.000Z')
  await recency(db, 's1', 'u-bot', '2026-08-01T01:00:00.000Z')
}

async function seedManyViewers(db: Kysely<DB>, count: number) {
  // memberUser stays a viewer so requester eligibility is stable; add
  // count - 1 extra members with distinct timestamps.
  await recency(db, 's1', 'u-member', '2026-08-02T00:00:00.000Z')
  for (let i = 0; i < count - 1; i += 1) {
    const id = `u-v${String(i).padStart(3, '0')}`
    await db
      .insertInto('users')
      .values(userRow(id, `${id}@example.com`, 'ws1'))
      .execute()
    await activeMember(db, id)
    const minute = String(i % 60).padStart(2, '0')
    const hour = String(Math.floor(i / 60)).padStart(2, '0')
    await recency(db, 's1', id, `2026-08-01T${hour}:${minute}:00.000Z`)
  }
}

import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: {},
}))

import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  ANON_VIEWER_COOKIE,
  anonymousViewIdentifier,
  recordView,
  recordViewAndNotifyViewCount,
  recordViewerRecency,
} from './views.server'

describe('views.server', () => {
  let current: ReturnType<typeof createMigratedInMemoryDb> | null = null

  afterEach(async () => {
    await current?.db.destroy()
    current = null
  })

  test('records viewer recency without running view-count deduplication', async () => {
    const { db } = await setup()

    await recordViewerRecency(db, 's1', 'u2', {
      now: '2026-06-29T00:00:00.000Z',
      versionSeenThroughAt: '2026-06-28T00:00:00.000Z',
    })

    await expect(
      db
        .selectFrom('shareable_viewer_recency')
        .select(['last_viewed_at', 'version_seen_through_at'])
        .where('shareable_id', '=', 's1')
        .where('viewer_user_id', '=', 'u2')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      last_viewed_at: '2026-06-29T00:00:00.000Z',
      version_seen_through_at: '2026-06-28T00:00:00.000Z',
    })
    await expect(
      db
        .selectFrom('shareables')
        .select('view_count')
        .where('id', '=', 's1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ view_count: 0 })
  })

  test('counts signed-in views only once inside the KV dedup window while updating recency', async () => {
    const { db } = await setup()
    const kv = memoryKv()

    const first = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
      },
    )
    const duplicate = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:01:00.000Z',
      },
    )

    expect(first).toEqual({ counted: true })
    expect(duplicate).toEqual({ counted: false })
    expect(await db.selectFrom('events').selectAll().execute()).toHaveLength(1)

    const shareable = await db
      .selectFrom('shareables')
      .select(['view_count', 'last_accessed_at'])
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      view_count: 1,
      last_accessed_at: '2026-06-29T00:00:00.000Z',
    })

    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .select([
        'first_viewed_at',
        'last_viewed_at',
        'effective_view_count',
        'viewed_title',
        'viewed_owner_name',
      ])
      .where('shareable_id', '=', 's1')
      .where('viewer_user_id', '=', 'u2')
      .executeTakeFirstOrThrow()
    expect(recency).toEqual({
      first_viewed_at: '2026-06-29T00:00:00.000Z',
      last_viewed_at: '2026-06-29T00:01:00.000Z',
      effective_view_count: 1,
      viewed_title: 'demo.html',
      viewed_owner_name: null,
    })
  })

  test('stores the displayed version boundary independently from comments', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
        versionSeenThroughAt: '2026-06-29T00:02:00.000Z',
      },
    )
    expect(
      await db
        .selectFrom('shareable_viewer_recency')
        .select('version_seen_through_at')
        .where('shareable_id', '=', 's1')
        .where('viewer_user_id', '=', 'u2')
        .executeTakeFirstOrThrow(),
    ).toEqual({ version_seen_through_at: '2026-06-29T00:02:00.000Z' })
    expect(
      await db
        .selectFrom('shareable_viewer_recency')
        .select(['version_seen_through_at', 'comment_seen_through_at'])
        .where('shareable_id', '=', 's1')
        .where('viewer_user_id', '=', 'u2')
        .executeTakeFirstOrThrow(),
    ).toEqual({
      version_seen_through_at: '2026-06-29T00:02:00.000Z',
      comment_seen_through_at: null,
    })
  })

  test('stores version and comment boundaries monotonically', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
        versionSeenThroughAt: '2026-06-29T00:20:00.000Z',
        commentSeenThroughAt: '2026-06-29T00:30:00.000Z',
      },
    )
    await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:01:00.000Z',
        versionSeenThroughAt: '2026-06-29T00:10:00.000Z',
        commentSeenThroughAt: '2026-06-29T00:15:00.000Z',
      },
    )

    expect(
      await db
        .selectFrom('shareable_viewer_recency')
        .select(['version_seen_through_at', 'comment_seen_through_at'])
        .where('shareable_id', '=', 's1')
        .where('viewer_user_id', '=', 'u2')
        .executeTakeFirstOrThrow(),
    ).toEqual({
      version_seen_through_at: '2026-06-29T00:20:00.000Z',
      comment_seen_through_at: '2026-06-29T00:30:00.000Z',
    })
  })

  test('updates viewed title and owner snapshots on every signed-in view', async () => {
    const { db } = await setup()
    const kv = memoryKv()

    await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
      },
    )
    await db
      .updateTable('shareables')
      .set({ derived_title: 'Updated title' })
      .where('id', '=', 's1')
      .execute()
    await db
      .updateTable('users')
      .set({ name: 'Updated Owner' })
      .where('id', '=', 'u1')
      .execute()

    await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:02:00.000Z',
      },
    )

    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .select(['viewed_title', 'viewed_owner_name', 'last_viewed_at'])
      .where('shareable_id', '=', 's1')
      .where('viewer_user_id', '=', 'u2')
      .executeTakeFirstOrThrow()
    expect(recency).toEqual({
      viewed_title: 'Updated title',
      viewed_owner_name: 'Updated Owner',
      last_viewed_at: '2026-06-29T00:02:00.000Z',
    })
  })

  test('deduplicates anonymous views by fallback key before the cookie returns', async () => {
    const { db } = await setup()
    const kv = memoryKv()

    const first = await recordView(
      db,
      kv,
      's1',
      { kind: 'anon', id: 'cookie-a', fallbackId: 'ip-a' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
      },
    )
    const duplicate = await recordView(
      db,
      kv,
      's1',
      { kind: 'anon', id: 'cookie-b', fallbackId: 'ip-a' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:01:00.000Z',
      },
    )

    expect(first).toEqual({ counted: true })
    expect(duplicate).toEqual({ counted: false })

    const shareable = await db
      .selectFrom('shareables')
      .select(['view_count', 'last_accessed_at'])
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      view_count: 1,
      last_accessed_at: '2026-06-29T00:00:00.000Z',
    })

    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .select((eb) => eb.fn.count<number>('shareable_id').as('count'))
      .executeTakeFirstOrThrow()
    expect(recency.count).toBe(0)
    const events = await db.selectFrom('events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'artifact_viewed',
      actor_user_id: null,
      subject_id: null,
    })
  })

  test('notifies live viewers only when the view is counted', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    const notifyViewCountChanged = vi.fn()
    const live = {
      getByName: () => ({ notifyViewCountChanged }),
    }

    await recordViewAndNotifyViewCount(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
      },
      live,
    )
    expect(notifyViewCountChanged).toHaveBeenCalledWith(1)

    notifyViewCountChanged.mockClear()
    const duplicate = await recordViewAndNotifyViewCount(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:01:00.000Z',
      },
      live,
    )
    expect(duplicate).toEqual({ counted: false })
    expect(notifyViewCountChanged).not.toHaveBeenCalled()
  })

  test('does not notify live viewers for a deferred duplicate view', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    const notifyViewCountChanged = vi.fn()
    const live = {
      getByName: () => ({ notifyViewCountChanged }),
    }
    const first = await recordViewAndNotifyViewCount(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
        deferAfterRecency: true,
      },
      live,
    )
    await first.deferred
    notifyViewCountChanged.mockClear()

    const duplicate = await recordViewAndNotifyViewCount(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:01:00.000Z',
        deferAfterRecency: true,
      },
      live,
    )
    await duplicate.deferred

    expect(duplicate.counted).toBe(false)
    expect(notifyViewCountChanged).not.toHaveBeenCalled()
  })

  test('writes the dedup marker before returning deferred event work', async () => {
    const { db } = await setup()
    const kv = memoryKv()

    const first = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:00.000Z',
        deferAfterRecency: true,
      },
    )
    const immediateRepeat = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      {
        hmacSecret: 'test-secret',
        now: '2026-06-29T00:00:01.000Z',
        deferAfterRecency: true,
      },
    )

    expect(first.counted).toBe(true)
    expect(immediateRepeat.counted).toBe(false)
    await Promise.all([first.deferred, immediateRepeat.deferred])
  })

  test('returns recordView result when live notification fails', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    const live = {
      getByName: () => ({
        notifyViewCountChanged: () => {
          throw new Error('live unavailable')
        },
      }),
    }

    await expect(
      recordViewAndNotifyViewCount(
        db,
        kv,
        's1',
        { kind: 'user', id: 'u2' },
        {
          hmacSecret: 'test-secret',
          now: '2026-06-29T00:00:00.000Z',
        },
        live,
      ),
    ).resolves.toEqual({ counted: true })

    const shareable = await db
      .selectFrom('shareables')
      .select('view_count')
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow()
    expect(shareable.view_count).toBe(1)
  })

  test('keeps the view successful when only the event insert fails', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    await sql`DROP TABLE events`.execute(db)

    const first = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      { hmacSecret: 'test-secret', now: '2026-06-29T00:00:00.000Z' },
    )
    expect(first).toEqual({ counted: true })

    const shareable = await db
      .selectFrom('shareables')
      .select('view_count')
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow()
    expect(shareable.view_count).toBe(1)
    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .where('viewer_user_id', '=', 'u2')
      .execute()
    expect(recency).toHaveLength(1)

    const duplicate = await recordView(
      db,
      kv,
      's1',
      { kind: 'user', id: 'u2' },
      { hmacSecret: 'test-secret', now: '2026-06-29T00:01:00.000Z' },
    )
    expect(duplicate).toEqual({ counted: false })
  })

  test('does not write an event when KV persistence fails', async () => {
    const { db } = await setup()
    const kv = memoryKv()
    kv.put = vi.fn(async () => {
      throw new Error('kv unavailable')
    }) as KVNamespace['put']
    await expect(
      recordView(
        db,
        kv,
        's1',
        { kind: 'user', id: 'u2' },
        { hmacSecret: 'test-secret', now: '2026-06-29T00:00:00.000Z' },
      ),
    ).rejects.toThrow('kv unavailable')
    expect(await db.selectFrom('events').selectAll().execute()).toHaveLength(0)
  })

  test('issues and verifies the anonymous viewer cookie', async () => {
    const request = new Request('https://artifactshare.com/a/s1', {
      headers: { 'cf-connecting-ip': '203.0.113.10' },
    })

    const first = await anonymousViewIdentifier(request, 'test-secret')
    expect(first.cookieHeader).toContain(`${ANON_VIEWER_COOKIE}=`)
    expect(first.cookieHeader).toContain('HttpOnly')
    expect(first.cookieHeader).toContain('SameSite=Lax')
    expect(first.cookieHeader).toContain('Secure')

    const cookieValue = first.cookieHeader!.match(/__as_viewer=([^;]+)/)?.[1]
    expect(cookieValue).toBeTruthy()

    const second = await anonymousViewIdentifier(
      new Request('https://artifactshare.com/a/s1', {
        headers: {
          cookie: `${ANON_VIEWER_COOKIE}=${cookieValue}`,
          'cf-connecting-ip': '203.0.113.10',
        },
      }),
      'test-secret',
    )
    expect(second.cookieHeader).toBeNull()
    expect(second.identifier.id).toBe(first.identifier.id)
    expect(second.identifier.fallbackId).toBe(first.identifier.fallbackId)
  })

  async function setup(): Promise<{ db: Kysely<DB> }> {
    current = createMigratedInMemoryDb()
    const { db } = current
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws1',
        hd: 'example.com',
        ms_tenant_id: null,
        email_domain: 'example.com',
        name: 'Example',
        created_at: '2026-06-29T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values([
        user('u1', 'owner@example.com'),
        user('u2', 'viewer@example.com'),
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox-u1',
        workspace_id: 'ws1',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'すべての成果物',
        description: null,
        archived_at: null,
        created_at: '2026-06-29T00:00:00.000Z',
        updated_at: '2026-06-29T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 's1',
        workspace_id: 'ws1',
        owner_user_id: 'u1',
        slug: null,
        name: 'demo.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: 'inbox-u1',
        created_at: '2026-06-29T00:00:00.000Z',
        updated_at: '2026-06-29T00:00:00.000Z',
        last_accessed_at: null,
      })
      .execute()
    return { db }
  }
})

function user(id: string, email: string) {
  return {
    id,
    email,
    email_verified: 1,
    name: null,
    image: null,
    created_at: '2026-06-29T00:00:00.000Z',
    updated_at: '2026-06-29T00:00:00.000Z',
    workspace_id: 'ws1',
    locale: null,
  }
}

function memoryKv(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    put: (key: string, value: string) => {
      values.set(key, value)
      return Promise.resolve()
    },
  } as unknown as KVNamespace
}

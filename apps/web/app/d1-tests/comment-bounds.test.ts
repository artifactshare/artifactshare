import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { createDb } from '../services/db.server'
import { admitCommentPost } from '../services/comment-post-admission.server'
import {
  deleteCommentMessage,
  loadCommentThreadPage,
  replyToCommentThread,
  type CommentAccess,
} from '../services/comments.server'
import type { SessionUser } from '../lib/user'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
const at = '2026-05-01T00:00:00.000Z'
const actor: SessionUser = {
  id: 'comment-owner',
  email: 'comment@example.com',
  emailVerified: true,
  name: 'Reviewer',
  image: null,
  workspaceId: 'comment-ws',
  hd: null,
  msTenantId: null,
  kind: 'human',
  locale: null,
}
const access: CommentAccess = {
  shareableId: 'comment-artifact',
  workspaceId: 'comment-ws',
  ownerUserId: actor.id,
  visibility: 'link',
  linkExpiresAt: null,
  currentVersionId: null,
  artifactKind: 'html_page',
  entrypointPath: '/index.html',
  r2Key: 'synthetic.html',
  isOwner: false,
  isTeamWorkspaceAdmin: false,
}

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
  await database.batch([
    database
      .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)')
      .bind('comment-ws', 'Comments', at),
    database
      .prepare(
        'INSERT INTO users (id, email, email_verified, name, workspace_id, created_at, updated_at, google_sub, kind) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        actor.id,
        actor.email,
        actor.name,
        actor.workspaceId,
        at,
        at,
        'comment-sub',
        'human',
      ),
    database
      .prepare(
        "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('comment-inbox', 'comment-ws', 'inbox', ?, ?, 'Inbox', ?, ?)",
      )
      .bind(actor.id, actor.id, at, at),
    database
      .prepare(
        "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('comment-artifact', 'comment-ws', ?, 'Comments', 'html_page', 'link', ?, ?, 'comment-inbox')",
      )
      .bind(actor.id, at, at),
  ])
})
afterAll(async () => {
  await server.close()
})

async function seedThread(id: string, count: number) {
  await database
    .prepare(
      "INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at) VALUES (?, 'comment-artifact', 'open', ?, ?, ?)",
    )
    .bind(id, actor.id, at, at)
    .run()
  if (count)
    await database
      .prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?)
    INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at)
    SELECT ? || '-' || printf('%04d', n), ?, 'Synthetic message', ?, ?, ? FROM numbers`)
      .bind(count, id, id, actor.id, at, at)
      .run()
}
async function stored(id: string) {
  return database
    .prepare(
      'SELECT message_count, (SELECT count(*) FROM comment_messages WHERE thread_id = ?) AS actual FROM comment_threads WHERE id = ?',
    )
    .bind(id, id)
    .first<{ message_count: number; actual: number }>()
}

describe('D1 comment bounds', () => {
  it('admits at most one concurrent reply at 499, and its event agrees with the committed message', async () => {
    await seedThread('capacity', 499)
    const db = createDb(database)
    const results = await Promise.all([
      replyToCommentThread(db, access, actor, 'capacity', 'First contender'),
      replyToCommentThread(db, access, actor, 'capacity', 'Second contender'),
    ])
    expect(results.map((result) => result.kind).sort()).toEqual([
      'ok',
      'thread-capacity',
    ])
    expect(await stored('capacity')).toEqual({
      message_count: 500,
      actual: 500,
    })
    const events = await database
      .prepare(
        "SELECT count(*) AS count FROM events WHERE shareable_id = 'comment-artifact' AND type = 'comment_posted'",
      )
      .first<{ count: number }>()
    expect(events?.count).toBe(1)
    expect(
      (await replyToCommentThread(db, access, actor, 'capacity', 'Full')).kind,
    ).toBe('thread-capacity')
    expect(
      (await deleteCommentMessage(db, access, actor, 'capacity-0000')).kind,
    ).toBe('ok')
    expect(await stored('capacity')).toEqual({
      message_count: 499,
      actual: 499,
    })
    const page = await loadCommentThreadPage(db, access, actor, 'capacity')
    if (page.kind !== 'ok') throw new Error('page missing')
    expect(page.thread.messages[0].id).toBe('capacity-0001')
    expect(
      (
        await replyToCommentThread(
          db,
          access,
          actor,
          'capacity',
          'Restored capacity',
        )
      ).kind,
    ).toBe('ok')
    expect(await stored('capacity')).toEqual({
      message_count: 500,
      actual: 500,
    })
    await db.destroy()
  })

  it('rolls back message, counter and event on a status race and on an unrelated batch error', async () => {
    await seedThread('race', 1)
    const racingDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await database
              .prepare(
                "UPDATE comment_threads SET status = 'resolved' WHERE id = 'race'",
              )
              .run()
            return database.batch(statements)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const db = createDb(racingDatabase)
    expect(
      await replyToCommentThread(
        db,
        access,
        actor,
        'race',
        'Resolved during admission',
      ),
    ).toEqual({ kind: 'closed-thread' })
    expect(await stored('race')).toEqual({ message_count: 1, actual: 1 })
    await db.destroy()
    await database
      .prepare("UPDATE comment_threads SET status = 'open' WHERE id = 'race'")
      .run()
    const failingDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'batch')
          return (statements: D1PreparedStatement[]) =>
            database.batch([
              ...statements,
              database.prepare(
                'INSERT INTO comment_messages (id) VALUES (NULL)',
              ),
            ])
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const failing = createDb(failingDatabase)
    expect(
      await replyToCommentThread(
        failing,
        access,
        actor,
        'race',
        'Injected rollback',
      ),
    ).toEqual({ kind: 'commit-failed' })
    expect(await stored('race')).toEqual({ message_count: 1, actual: 1 })
    await failing.destroy()
  })

  it('preserves legacy excess messages and uses the tuple index for bounded pages', async () => {
    await seedThread('legacy', 500)
    // Simulate pre-migration data without dropping the production guard. This
    // fixture resets the counter only while adding the legacy excess rows.
    await database
      .prepare(
        "UPDATE comment_threads SET message_count = 0 WHERE id = 'legacy'",
      )
      .run()
    await database
      .prepare(
        "INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('legacy-0500', 'legacy', 'Legacy excess', ?, ?, ?)",
      )
      .bind(actor.id, at, at)
      .run()
    await database
      .prepare(
        "UPDATE comment_threads SET message_count = (SELECT count(*) FROM comment_messages WHERE thread_id = 'legacy') WHERE id = 'legacy'",
      )
      .run()
    const db = createDb(database)
    expect(await stored('legacy')).toEqual({ message_count: 501, actual: 501 })
    expect(
      await replyToCommentThread(db, access, actor, 'legacy', 'Cannot add'),
    ).toEqual({ kind: 'thread-capacity' })
    let page = await loadCommentThreadPage(db, access, actor, 'legacy')
    const ids = new Set<string>()
    while (page.kind === 'ok') {
      expect(page.thread.messages.length).toBeLessThanOrEqual(51)
      for (const message of page.thread.messages) ids.add(message.id)
      if (!page.thread.olderCursor) break
      page = await loadCommentThreadPage(db, access, actor, 'legacy', {
        before: page.thread.olderCursor,
      })
    }
    expect(ids.size).toBe(501)
    const plan = await database
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM comment_messages WHERE thread_id = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 50',
      )
      .bind('legacy', at, 'legacy-0500')
      .all()
    expect(JSON.stringify(plan.results)).toContain(
      'comment_messages_thread_tuple',
    )
    expect(JSON.stringify(plan.results)).not.toContain('TEMP B-TREE')
    await db.destroy()
  })

  it('serializes durable admissions, reuses the window row and isolates actors/artifacts', async () => {
    const db = createDb(database)
    const now = Date.parse('2099-06-01T00:00:59.001Z')
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        admitCommentPost(db, actor.id, access.shareableId, now),
      ),
    )
    expect(results.filter((result) => result.kind === 'ok')).toHaveLength(20)
    expect(
      results.filter((result) => result.kind === 'rate-limited'),
    ).toHaveLength(4)
    expect(
      results.find((result) => result.kind === 'rate-limited'),
    ).toMatchObject({
      retry_after_seconds: 1,
      retry_at: '2099-06-01T00:01:00.000Z',
    })
    expect(
      await admitCommentPost(db, actor.id, access.shareableId, now + 1000),
    ).toEqual({ kind: 'ok' })
    const rows = await db
      .selectFrom('comment_post_windows')
      .selectAll()
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].admissions).toBe(1)
    await db.destroy()
  })

  it('keeps the D1 posting window monotonic across delayed admissions and rollover', async () => {
    const db = createDb(database)
    const now = Date.parse('2100-06-01T00:01:30.000Z')
    const admit = (time: number) =>
      admitCommentPost(db, actor.id, access.shareableId, time)
    for (let i = 0; i < 18; i++)
      expect(await admit(now)).toEqual({ kind: 'ok' })
    expect(await admit(now - 60_000)).toEqual({ kind: 'ok' })
    expect(await admit(now)).toEqual({ kind: 'ok' })
    expect(await admit(now - 60_000)).toEqual({
      kind: 'rate-limited',
      retry_after_seconds: 90,
      retry_at: '2100-06-01T00:02:00.000Z',
    })
    expect(await admit(now)).toMatchObject({
      kind: 'rate-limited',
      retry_after_seconds: 30,
    })
    const row = await db
      .selectFrom('comment_post_windows')
      .selectAll()
      .where('user_id', '=', actor.id)
      .where('shareable_id', '=', access.shareableId)
      .executeTakeFirstOrThrow()
    expect(row.minute_start).toBe(now - 30_000)
    expect(row.admissions).toBe(20)
    expect(await admit(now + 30_000)).toEqual({ kind: 'ok' })
    expect(await admit(now)).toEqual({ kind: 'ok' })
    const advanced = await db
      .selectFrom('comment_post_windows')
      .selectAll()
      .where('user_id', '=', actor.id)
      .where('shareable_id', '=', access.shareableId)
      .executeTakeFirstOrThrow()
    expect(advanced.minute_start).toBe(now + 30_000)
    expect(advanced.admissions).toBe(2)
    await db.destroy()
  })

  it('last-message deletion removes its thread and counter', async () => {
    await seedThread('last', 1)
    const db = createDb(database)
    expect(
      (await deleteCommentMessage(db, access, actor, 'last-0000')).kind,
    ).toBe('ok')
    expect(await stored('last')).toBeNull()
    await db.destroy()
  })
})

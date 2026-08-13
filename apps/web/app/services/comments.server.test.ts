import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock } from '~/test/d1-batch-mock'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import {
  changeComment,
  COMMENT_THREAD_LIST_LIMIT,
  createCommentThread,
  clearCommentAnchorTextCache,
  deleteCommentMessage,
  deleteCommentThread,
  loadCommentAccess,
  loadCommentThreads,
  latestOtherCommentCreatedAt,
  replyToCommentThread,
  setCommentThreadResolved,
  updateCommentMessage,
} from './comments.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  failNextBatch: false,
  bucketText: '<p>Updated body keeps the selected words here.</p>',
  failBucketGet: false,
  bucketGetCount: 0,
  liveNotifications: [] as Array<{
    shareableId: string
    originMutationId: string | undefined
    originUserId: string | undefined
  }>,
  failLiveNotify: false,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
    BUCKET: {
      get: vi.fn(async () => {
        sqliteRef.bucketGetCount += 1
        if (sqliteRef.failBucketGet) throw new Error('R2 unavailable')
        return {
          body: null,
          text: async () => sqliteRef.bucketText,
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
          size: 52,
          uploaded: new Date('2026-05-29T00:00:00.000Z'),
        }
      }),
    },
    ARTIFACT_LIVE: {
      getByName: (name: string) => ({
        notifyCommentsChanged: async (
          originMutationId?: string,
          originUserId?: string,
        ) => {
          sqliteRef.liveNotifications.push({
            shareableId: name,
            originMutationId,
            originUserId,
          })
          if (sqliteRef.failLiveNotify) {
            throw new Error('live room unavailable')
          }
        },
      }),
    },
  },
}))

describe('comments server', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'))
    fixture = createMigratedInMemoryDb()
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.bucketText = '<p>Updated body keeps the selected words here.</p>'
    sqliteRef.failBucketGet = false
    sqliteRef.bucketGetCount = 0
    sqliteRef.liveNotifications = []
    sqliteRef.failLiveNotify = false
    clearCommentAnchorTextCache()
    await seedShareable(fixture.db)
  })

  afterEach(async () => {
    await fixture.db.destroy()
    sqliteRef.current = null
    sqliteRef.failNextBatch = false
    sqliteRef.bucketText = '<p>Updated body keeps the selected words here.</p>'
    sqliteRef.failBucketGet = false
    sqliteRef.bucketGetCount = 0
    sqliteRef.liveNotifications = []
    sqliteRef.failLiveNotify = false
    clearCommentAnchorTextCache()
    vi.useRealTimers()
  })

  test('returns the latest other-author message regardless of thread state or window', async () => {
    const viewerAccess = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const ownerAccess = await loadCommentAccess(fixture.db, ownerUser, 's1')
    await createCommentThread(fixture.db, viewerAccess!, viewerUser, 'Viewer')
    vi.setSystemTime(new Date('2026-05-29T00:10:00.000Z'))
    const latest = await createCommentThread(
      fixture.db,
      ownerAccess!,
      ownerUser,
      'Owner latest',
    )
    await setCommentThreadResolved(
      fixture.db,
      ownerAccess!,
      ownerUser,
      latest.kind === 'ok' ? latest.threadId : '',
      true,
    )
    vi.setSystemTime(new Date('2026-05-29T00:20:00.000Z'))
    await createCommentThread(
      fixture.db,
      viewerAccess!,
      viewerUser,
      'Viewer latest',
    )
    expect(
      await latestOtherCommentCreatedAt(fixture.db, 's1', viewerUser.id),
    ).toBe('2026-05-29T00:10:00.000Z')
  })

  test('creates artifact-level thread and appends replies', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    expect(access).not.toBeNull()

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      ' First comment ',
    )
    expect(created.kind).toBe('ok')
    expect(
      created.kind === 'ok' ? created.threads[0]?.messages[0]?.body : '',
    ).toBe('First comment')

    vi.setSystemTime(new Date('2026-05-29T00:05:00.000Z'))
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''
    const replied = await replyToCommentThread(
      fixture.db,
      access!,
      ownerUser,
      threadId,
      'Reply',
    )
    expect(replied.kind).toBe('ok')

    const threads = await loadCommentThreads(fixture.db, access!, viewerUser)
    expect(threads).toHaveLength(1)
    expect(threads[0]?.messages.map((message) => message.body)).toEqual([
      'First comment',
      'Reply',
    ])
    expect(threads[0]?.updatedAt).toBe('2026-05-29T00:05:00.000Z')

    const events = await fixture.db
      .selectFrom('events')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'comment_posted',
      shareable_id: 's1',
      actor_user_id: viewerUser.id,
    })
    expect(events[1]).toMatchObject({
      type: 'comment_posted',
      shareable_id: 's1',
      actor_user_id: ownerUser.id,
    })
    const messageIds = threads[0]!.messages.map((message) => message.id)
    expect(events.map((event) => event.subject_id)).toEqual(messageIds)
  })

  test('notifies the live room after successful comment changes', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    expect(access).not.toBeNull()

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First',
      null,
      { originMutationId: 'mutation-1', originUserId: viewerUser.id },
    )
    expect(created.kind).toBe('ok')
    const replied = await replyToCommentThread(
      fixture.db,
      access!,
      viewerUser,
      created.kind === 'ok' ? created.threadId : '',
      'Reply',
    )
    expect(replied.kind).toBe('ok')

    expect(sqliteRef.liveNotifications).toEqual([
      {
        shareableId: 's1',
        originMutationId: 'mutation-1',
        originUserId: viewerUser.id,
      },
      {
        shareableId: 's1',
        originMutationId: undefined,
        originUserId: undefined,
      },
    ])
  })

  test('keeps comment changes successful when live notification fails', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    expect(access).not.toBeNull()
    sqliteRef.failLiveNotify = true

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First',
    )

    expect(created.kind).toBe('ok')
    expect(sqliteRef.liveNotifications).toEqual([
      {
        shareableId: 's1',
        originMutationId: undefined,
        originUserId: undefined,
      },
    ])
  })

  test('creates text-anchored thread and returns attached subject', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: 'body > p:nth-of-type(1)',
      },
    )

    expect(created.kind).toBe('ok')
    const thread = created.kind === 'ok' ? created.threads[0] : null
    expect(thread?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: 'selected words',
      textStart: 24,
      textEnd: 38,
    })
  })

  test('returns orphaned subject when current version cannot restore anchor', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText = '<p>The selected sentence was removed.</p>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'orphaned',
      quotedText: 'selected words',
      textStart: null,
      textEnd: null,
    })
  })

  test('reuses current anchor text for repeated restoration in a short window', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText = '<p>Updated body keeps the selected words here.</p>'
    sqliteRef.bucketGetCount = 0

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    await loadCommentThreads(fixture.db, refreshedAccess!, viewerUser)
    await loadCommentThreads(fixture.db, refreshedAccess!, viewerUser)

    expect(sqliteRef.bucketGetCount).toBe(1)
  })

  test('restores markdown anchors against rendered text after a version change', async () => {
    await fixture.db
      .updateTable('shareables')
      .set({ artifact_kind: 'markdown_page' })
      .where('id', '=', 's1')
      .execute()
    await fixture.db
      .updateTable('versions')
      .set({
        artifact_kind: 'markdown_page',
        entrypoint_path: '/artifact.md',
        r2_key: 'ws1/s1/v1/artifact.md',
      })
      .where('id', '=', 'v1')
      .execute()
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'bold text',
        prefixText: 'Some',
        suffixText: 'stays here',
        textStart: 5,
        textEnd: 14,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: '/artifact.md',
        r2_key: 'ws1/s1/v2/artifact.md',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText = 'Some **bold text** stays here'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: 'bold text',
      textStart: 5,
      textEnd: 14,
    })
  })

  test('re-resolves current markdown anchors when renderer offsets differ', async () => {
    await fixture.db
      .updateTable('shareables')
      .set({ artifact_kind: 'markdown_page' })
      .where('id', '=', 's1')
      .execute()
    await fixture.db
      .updateTable('versions')
      .set({
        artifact_kind: 'markdown_page',
        entrypoint_path: '/artifact.md',
        r2_key: 'ws1/s1/v1/artifact.md',
      })
      .where('id', '=', 'v1')
      .execute()
    sqliteRef.bucketText = 'Some **bold text** stays here'
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'bold text',
        prefixText: 'Some',
        suffixText: 'stays here',
        textStart: 0,
        textEnd: 9,
        cssPath: null,
      },
    )

    expect(created.kind).toBe('ok')
    expect(
      created.kind === 'ok' ? created.threads[0]?.subject : null,
    ).toMatchObject({
      state: 'attached',
      textStart: 5,
      textEnd: 14,
    })
  })

  test('restores html anchors with script text, entities, and changed entry path', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: '© selected words',
        prefixText: 'Intro',
        suffixText: 'here',
        textStart: 6,
        textEnd: 22,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/renamed.html',
        r2_key: 'ws1/s1/v2/renamed.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText =
      '<body><script>ignored()</script><p>Intro &copy; selected words here</p></body>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: '© selected words',
      textStart: 6,
      textEnd: 22,
    })
  })

  test('restores html anchors with named punctuation and accented entities', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'café — selected words…',
        prefixText: 'Intro',
        suffixText: 'here',
        textStart: 6,
        textEnd: 28,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText =
      '<body><p>Intro caf&eacute; &mdash; selected words&hellip; here</p></body>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: 'café — selected words…',
      textStart: 6,
      textEnd: 28,
    })
  })

  test('restores html anchors with non-breaking space entities', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: '10\u00A0kg',
        prefixText: 'Intro',
        suffixText: 'here',
        textStart: 6,
        textEnd: 11,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText = '<body><p>Intro 10&nbsp;kg here</p></body>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: '10\u00A0kg',
      textStart: 6,
      textEnd: 11,
    })
  })

  test('leaves unknown named entities unchanged during anchor restoration', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'selected words',
        prefixText: 'Intro &constructor;',
        suffixText: 'here',
        textStart: 20,
        textEnd: 34,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText =
      '<body><p>Intro &constructor; selected words here</p></body>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: 'selected words',
      textStart: 20,
      textEnd: 34,
    })
  })

  test('does not decode unknown dash-like entity names', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: '&emdash; selected',
        prefixText: 'Intro',
        suffixText: 'here',
        textStart: 6,
        textEnd: 23,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.bucketText = '<body><p>Intro &emdash; selected here</p></body>'

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'attached',
      quotedText: '&emdash; selected',
      textStart: 6,
      textEnd: 23,
    })
  })

  test('keeps viewer comments loadable when anchor restoration cannot read R2', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this sentence.',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')
    await fixture.db
      .insertInto('versions')
      .values({
        id: 'v2',
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: 'ws1/s1/v2/artifact.html',
        size_bytes: 100,
        sha256: 'sha2',
        created_by_id: ownerUser.id,
        created_at: '2026-05-29T00:05:00.000Z',
        published_at: '2026-05-29T00:05:00.000Z',
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: 'v2' })
      .where('id', '=', 's1')
      .execute()
    sqliteRef.failBucketGet = true

    const refreshedAccess = await loadCommentAccess(
      fixture.db,
      viewerUser,
      's1',
    )
    const threads = await loadCommentThreads(
      fixture.db,
      refreshedAccess!,
      viewerUser,
    )

    expect(threads[0]?.subject).toMatchObject({
      kind: 'text',
      state: 'orphaned',
      quotedText: 'selected words',
    })
  })

  test('allows owner and thread creator to resolve, but rejects another viewer', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this.',
    )
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''

    const otherAccess = await loadCommentAccess(
      fixture.db,
      otherViewerUser,
      's1',
    )
    const rejected = await setCommentThreadResolved(
      fixture.db,
      otherAccess!,
      otherViewerUser,
      threadId,
      true,
    )
    expect(rejected.kind).toBe('forbidden')

    const resolvedByOwner = await setCommentThreadResolved(
      fixture.db,
      access!,
      ownerUser,
      threadId,
      true,
    )
    expect(resolvedByOwner.kind).toBe('ok')
    expect(
      resolvedByOwner.kind === 'ok' ? resolvedByOwner.threads[0]?.status : '',
    ).toBe('resolved')

    const reopenedByCreator = await setCommentThreadResolved(
      fixture.db,
      access!,
      viewerUser,
      threadId,
      false,
    )
    expect(reopenedByCreator.kind).toBe('ok')
    expect(
      reopenedByCreator.kind === 'ok'
        ? reopenedByCreator.threads[0]?.status
        : '',
    ).toBe('open')
  })

  test('allows workspace admin to resolve', async () => {
    await fixture.db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws1')
      .execute()
    await fixture.db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws1',
        user_id: adminUser.id,
        role: 'admin',
        status: 'active',
        created_at: '2026-05-29T00:00:00.000Z',
        updated_at: '2026-05-29T00:00:00.000Z',
      })
      .execute()
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this.',
    )
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''
    const adminAccess = await loadCommentAccess(fixture.db, adminUser, 's1')

    const resolved = await setCommentThreadResolved(
      fixture.db,
      adminAccess!,
      adminUser,
      threadId,
      true,
    )

    expect(resolved.kind).toBe('ok')
    expect(resolved.kind === 'ok' ? resolved.threads[0]?.status : '').toBe(
      'resolved',
    )
  })

  test('lets authors edit messages and permitted users physically delete messages', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
    )
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''
    vi.setSystemTime(new Date('2026-05-29T00:05:00.000Z'))
    await replyToCommentThread(
      fixture.db,
      access!,
      ownerUser,
      threadId,
      'Reply',
    )
    const before = await loadCommentThreads(fixture.db, access!, viewerUser)
    const firstMessage = before[0]!.messages[0]!
    const replyMessage = before[0]!.messages[1]!

    vi.setSystemTime(new Date('2026-05-29T00:10:00.000Z'))
    const unchanged = await updateCommentMessage(
      fixture.db,
      access!,
      viewerUser,
      firstMessage.id,
      'First comment',
    )
    expect(unchanged.kind).toBe('ok')
    expect(
      unchanged.kind === 'ok'
        ? unchanged.threads[0]?.messages[0]?.updatedAt
        : '',
    ).toBe(firstMessage.updatedAt)

    const edited = await updateCommentMessage(
      fixture.db,
      access!,
      viewerUser,
      firstMessage.id,
      'Edited comment',
    )
    expect(edited.kind).toBe('ok')
    expect(
      edited.kind === 'ok' ? edited.threads[0]?.messages[0]?.body : '',
    ).toBe('Edited comment')
    await expect(
      updateCommentMessage(
        fixture.db,
        access!,
        otherViewerUser,
        firstMessage.id,
        'Not mine',
      ),
    ).resolves.toEqual({ kind: 'forbidden' })

    const deleted = await deleteCommentMessage(
      fixture.db,
      access!,
      ownerUser,
      replyMessage.id,
      undefined,
    )
    expect(deleted.kind).toBe('ok')
    expect(
      deleted.kind === 'ok' ? deleted.threads[0]?.messages : [],
    ).toHaveLength(1)
  })

  test('changeComment returns target thread state for edits and status changes', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
    )
    const threadId = created.kind === 'ok' ? created.threadId : ''
    const messageId =
      created.kind === 'ok' ? created.threads[0]!.messages[0]!.id : ''

    const edited = await changeComment(fixture.db, access!, viewerUser, {
      kind: 'update',
      messageId,
      body: 'Edited comment',
    })

    expect(edited.kind).toBe('ok')
    expect(edited.kind === 'ok' ? edited.threadId : '').toBe(threadId)
    expect(
      edited.kind === 'ok' && !('deleted' in edited)
        ? edited.thread.messages[0]?.body
        : '',
    ).toBe('Edited comment')

    const resolved = await changeComment(fixture.db, access!, viewerUser, {
      kind: 'update',
      threadId,
      resolved: true,
    })

    expect(resolved.kind).toBe('ok')
    expect(
      resolved.kind === 'ok' && !('deleted' in resolved)
        ? resolved.thread.status
        : '',
    ).toBe('resolved')
  })

  test('changeComment reports whether deleting a message removed the thread', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
    )
    const threadId = created.kind === 'ok' ? created.threadId : ''
    vi.setSystemTime(new Date('2026-05-29T00:05:00.000Z'))
    await replyToCommentThread(
      fixture.db,
      access!,
      ownerUser,
      threadId,
      'Reply',
    )
    const before = await loadCommentThreads(fixture.db, access!, viewerUser)
    const firstMessageId = before[0]!.messages[0]!.id
    const replyMessageId = before[0]!.messages[1]!.id

    const deletedReply = await changeComment(fixture.db, access!, ownerUser, {
      kind: 'delete',
      messageId: replyMessageId,
    })

    expect(deletedReply.kind).toBe('ok')
    expect(
      deletedReply.kind === 'ok' && 'deleted' in deletedReply
        ? deletedReply.threadDeleted
        : true,
    ).toBe(false)
    expect(
      deletedReply.kind === 'ok' && 'deleted' in deletedReply
        ? deletedReply.thread?.messages.map((message) => message.id)
        : [],
    ).toEqual([firstMessageId])

    const deletedLastMessage = await changeComment(
      fixture.db,
      access!,
      viewerUser,
      { kind: 'delete', threadId, messageId: firstMessageId },
    )

    expect(deletedLastMessage.kind).toBe('ok')
    expect(
      deletedLastMessage.kind === 'ok' && 'deleted' in deletedLastMessage
        ? deletedLastMessage.threadDeleted
        : false,
    ).toBe(true)
  })

  test('deleting the last message removes the thread and anchor', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: null,
      },
    )
    const messageId =
      created.kind === 'ok' ? created.threads[0]!.messages[0]!.id : ''
    fixture.sqlite.exec('PRAGMA foreign_keys = OFF')

    const deleted = await deleteCommentMessage(
      fixture.db,
      access!,
      viewerUser,
      messageId,
      undefined,
    )

    expect(deleted).toEqual({ kind: 'ok', threads: [] })
    const anchorCount = await fixture.db
      .selectFrom('comment_anchors')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow()
    expect(Number(anchorCount.count)).toBe(0)
  })

  test('lets permitted users delete a whole thread with replies', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
      {
        quotedText: 'selected words',
        prefixText: 'the',
        suffixText: 'here',
        textStart: 24,
        textEnd: 38,
        cssPath: null,
      },
    )
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''
    await replyToCommentThread(
      fixture.db,
      access!,
      ownerUser,
      threadId,
      'Reply',
    )

    await expect(
      deleteCommentThread(fixture.db, access!, otherViewerUser, threadId),
    ).resolves.toEqual({ kind: 'forbidden' })

    const deleted = await deleteCommentThread(
      fixture.db,
      access!,
      viewerUser,
      threadId,
    )

    expect(deleted).toEqual({ kind: 'ok', threads: [] })
    const messageCount = await fixture.db
      .selectFrom('comment_messages')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow()
    const anchorCount = await fixture.db
      .selectFrom('comment_anchors')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow()
    expect(Number(messageCount.count)).toBe(0)
    expect(Number(anchorCount.count)).toBe(0)
  })

  test('rejects invalid bodies and replies to resolved threads', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    await expect(
      createCommentThread(fixture.db, access!, viewerUser, '   '),
    ).resolves.toEqual({ kind: 'invalid-body' })
    await expect(
      createCommentThread(fixture.db, access!, viewerUser, 'x'.repeat(4001)),
    ).resolves.toEqual({ kind: 'invalid-body' })

    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'Please check this.',
    )
    const threadId = created.kind === 'ok' ? created.threads[0]!.id : ''
    await setCommentThreadResolved(
      fixture.db,
      access!,
      viewerUser,
      threadId,
      true,
    )

    await expect(
      replyToCommentThread(fixture.db, access!, ownerUser, threadId, 'Reply'),
    ).resolves.toEqual({ kind: 'closed-thread' })
  })

  test('uses batch for thread creation so partial failures leave no empty thread', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    sqliteRef.failNextBatch = true

    const result = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
    )

    expect(result.kind).toBe('commit-failed')
    const threadCount = await fixture.db
      .selectFrom('comment_threads')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .executeTakeFirstOrThrow()
    expect(Number(threadCount.count)).toBe(0)
  })

  test('deleting the shareable cascades comment threads, messages, and anchors', async () => {
    const access = await loadCommentAccess(fixture.db, viewerUser, 's1')
    const created = await createCommentThread(
      fixture.db,
      access!,
      viewerUser,
      'First comment',
      {
        quotedText: 'First',
        prefixText: '',
        suffixText: 'comment',
        textStart: 0,
        textEnd: 5,
        cssPath: null,
      },
    )
    expect(created.kind).toBe('ok')

    await fixture.db.deleteFrom('shareables').where('id', '=', 's1').execute()

    const [threads, messages, anchors] = await Promise.all([
      fixture.db
        .selectFrom('comment_threads')
        .select((eb) => eb.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow(),
      fixture.db
        .selectFrom('comment_messages')
        .select((eb) => eb.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow(),
      fixture.db
        .selectFrom('comment_anchors')
        .select((eb) => eb.fn.count<number>('id').as('count'))
        .executeTakeFirstOrThrow(),
    ])
    expect(Number(threads.count)).toBe(0)
    expect(Number(messages.count)).toBe(0)
    expect(Number(anchors.count)).toBe(0)
  })

  test('denies comment access when the viewer cannot open the shareable', async () => {
    const strangerAccess = await loadCommentAccess(
      fixture.db,
      strangerUser,
      's1',
    )
    expect(strangerAccess).toBeNull()
  })
})

const ownerUser = makeUser('owner', 'owner@example.com')
const adminUser = makeUser('admin', 'admin@example.com')
const viewerUser = makeUser('viewer', 'viewer@example.com')
const otherViewerUser = makeUser('other', 'other@example.com')
const strangerUser = makeUser('stranger', 'stranger@outside.example')

function makeUser(id: string, email: string): SessionUser {
  return {
    id,
    email,
    emailVerified: true,
    name: id,
    image: null,
    workspaceId: id === 'stranger' ? 'ws2' : 'ws1',
    hd: id === 'stranger' ? 'outside.example' : 'example.com',
    msTenantId: null,
    kind: 'human' as const,
    locale: null,
  }
}

async function seedShareable(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'ws1',
        hd: 'example.com',
        name: 'Example',
        created_at: '2026-05-29T00:00:00.000Z',
      },
      {
        id: 'ws2',
        hd: 'outside.example',
        name: 'Outside',
        created_at: '2026-05-29T00:00:00.000Z',
      },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      userRow(ownerUser, 'sub-owner'),
      userRow(adminUser, 'sub-admin'),
      userRow(viewerUser, 'sub-viewer'),
      userRow(otherViewerUser, 'sub-other'),
      userRow(strangerUser, 'sub-stranger'),
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws1',
      kind: 'inbox',
      owner_user_id: ownerUser.id,
      created_by_id: ownerUser.id,
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 's1',
      workspace_id: 'ws1',
      owner_user_id: ownerUser.id,
      slug: null,
      name: 'artifact.html',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'private',
      current_version_id: 'v1',
      container_id: 'owner-inbox',
      created_at: '2026-05-29T00:00:00.000Z',
      updated_at: '2026-05-29T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v1',
      shareable_id: 's1',
      artifact_kind: 'html_page',
      status: 'published',
      entrypoint_path: '/artifact.html',
      r2_key: 'ws1/s1/v1/artifact.html',
      size_bytes: 100,
      sha256: 'sha',
      created_by_id: ownerUser.id,
      created_at: '2026-05-29T00:00:00.000Z',
      published_at: '2026-05-29T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareable_grants')
    .values([
      {
        shareable_id: 's1',
        granted_email: viewerUser.email,
        granted_at: '2026-05-29T00:00:00.000Z',
        granted_by: ownerUser.id,
      },
      {
        shareable_id: 's1',
        granted_email: adminUser.email,
        granted_at: '2026-05-29T00:00:00.000Z',
        granted_by: ownerUser.id,
      },
      {
        shareable_id: 's1',
        granted_email: otherViewerUser.email,
        granted_at: '2026-05-29T00:00:00.000Z',
        granted_by: ownerUser.id,
      },
    ])
    .execute()
}

function userRow(user: SessionUser, sub: string) {
  return {
    id: user.id,
    email: user.email,
    email_verified: 1,
    name: user.name,
    image: null,
    created_at: '2026-05-29T00:00:00.000Z',
    updated_at: '2026-05-29T00:00:00.000Z',
    workspace_id: user.workspaceId,
    locale: null,
  }
}

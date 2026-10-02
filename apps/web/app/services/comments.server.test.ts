import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import {
  changeComment,
  COMMENT_THREAD_LIST_LIMIT,
  createCommentThread,
  buildQuoteAnchor,
  storeAnchorResolutions,
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
  let fixture: ReturnType<typeof createD1BatchFixture>

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-29T00:00:00.000Z'))
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.bucketText = '<p>Updated body keeps the selected words here.</p>'
    sqliteRef.failBucketGet = false
    sqliteRef.bucketGetCount = 0
    sqliteRef.liveNotifications = []
    sqliteRef.failLiveNotify = false
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

  const selector = {
    selectorFormat: 'normalized-v1' as const,
    versionId: 'v1',
    quotedText: 'selected words',
    prefixText: 'the ',
    suffixText: ' here',
    textStart: 24,
    textEnd: 38,
    textHash: 'a'.repeat(64),
    ambiguousAtCreation: false,
    cssPath: null,
  }
  const frameToken = 'b'.repeat(64)

  async function addVersion(id: string, minute: number) {
    await fixture.db
      .insertInto('versions')
      .values({
        id,
        shareable_id: 's1',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/artifact.html',
        r2_key: `ws1/s1/${id}/artifact.html`,
        size_bytes: 100,
        sha256: id,
        created_by_id: ownerUser.id,
        created_at: `2026-05-29T00:0${minute}:00.000Z`,
        published_at: null,
      })
      .execute()
    await fixture.db
      .updateTable('shareables')
      .set({ current_version_id: id })
      .where('id', '=', 's1')
      .execute()
    return (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
  }

  test('keeps modern and legacy selectors unchecked without reading artifact text', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    for (const anchor of [
      selector,
      {
        ...selector,
        selectorFormat: undefined,
        textHash: undefined,
        ambiguousAtCreation: undefined,
      },
    ]) {
      const created = await createCommentThread(
        fixture.db,
        access,
        viewerUser,
        'Check',
        anchor,
      )
      expect(created.kind).toBe('ok')
      if (created.kind !== 'ok') throw new Error('creation failed')
      expect(
        created.threads.find((t) => t.id === created.threadId)?.subject,
      ).toMatchObject({
        kind: 'text',
        state: 'orphaned',
        positionState: 'unchecked',
        quotedText: selector.quotedText,
      })
    }
    sqliteRef.failBucketGet = true
    await loadCommentThreads(fixture.db, access, viewerUser)
    expect(sqliteRef.bucketGetCount).toBe(0)
  })

  test('quote creation is hintless and preserves context boundary spaces without R2 reads', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const result = await buildQuoteAnchor(access, {
      quote: ' missing   words ',
      before: 'before  ',
      after: '  after',
    })
    expect(result).toEqual({
      kind: 'ok',
      anchor: {
        selectorFormat: 'quote-v1',
        quotedText: 'missing words',
        prefixText: 'before ',
        suffixText: ' after',
        textStart: null,
        textEnd: null,
        cssPath: null,
      },
    })
    expect(sqliteRef.bucketGetCount).toBe(0)
  })

  test.each([
    { textStart: -1 },
    { textEnd: 999 },
    { textStart: Number.NaN },
    { textHash: 'bad' },
    { ambiguousAtCreation: undefined },
    { versionId: undefined },
    { prefixText: 'x'.repeat(401) },
    { quotedText: 42 },
    { selectorFormat: 'unknown' },
  ])('rejects malformed modern selectors without writes: %j', async (patch) => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const result = await createCommentThread(
      fixture.db,
      access,
      viewerUser,
      'Check',
      { ...selector, ...patch } as typeof selector,
    )
    expect(result.kind).toBe('invalid-anchor')
    expect(
      await fixture.db.selectFrom('comment_threads').selectAll().execute(),
    ).toEqual([])
  })

  test('rejects both an already stale selection and a version change at commit atomically', async () => {
    const oldAccess = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const newAccess = await addVersion('v2', 1)
    expect(
      (
        await createCommentThread(
          fixture.db,
          newAccess,
          viewerUser,
          'Check',
          selector,
        )
      ).kind,
    ).toBe('version-conflict')
    expect(
      (
        await createCommentThread(
          fixture.db,
          oldAccess,
          viewerUser,
          'Check',
          selector,
        )
      ).kind,
    ).toBe('version-conflict')
    expect(
      await fixture.db.selectFrom('comment_threads').selectAll().execute(),
    ).toEqual([])
    expect(
      await fixture.db.selectFrom('comment_messages').selectAll().execute(),
    ).toEqual([])
    expect(
      await fixture.db.selectFrom('comment_anchors').selectAll().execute(),
    ).toEqual([])
  })

  test('persists per-version results and reuses the last valid hint without changing the selector', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const created = await createCommentThread(
      fixture.db,
      access,
      viewerUser,
      'Check',
      selector,
    )
    if (created.kind !== 'ok') throw new Error('creation failed')
    const attached = (start: number) => ({
      threadId: created.threadId,
      state: 'attached' as const,
      textStart: start,
      textEnd: start + 14,
      textHash: 'c'.repeat(64),
    })
    const write = (
      versionId: string,
      generation: number,
      result:
        | ReturnType<typeof attached>
        | {
            threadId: string
            state: 'needs-check'
            textStart: null
            textEnd: null
            textHash: null
          },
    ) =>
      storeAnchorResolutions(fixture.db, access, {
        versionId,
        generation,
        frameToken,
        targetPath: '/artifact.html',
        results: [result],
      })
    expect(await write('v1', 1, attached(24))).toBe(true)
    expect(
      (await loadCommentThreads(fixture.db, access, viewerUser))[0].subject,
    ).toMatchObject({ state: 'attached', positionState: 'attached' })
    const v2 = await addVersion('v2', 1)
    expect(
      (await loadCommentThreads(fixture.db, v2, viewerUser))[0].subject,
    ).toMatchObject({ positionState: 'unchecked', textStart: 24 })
    expect(await write('v2', 2, attached(100))).toBe(true)
    expect(await write('v2', 1, attached(999))).toBe(true)
    expect(await write('v2', 2, attached(888))).toBe(true)
    expect(
      (await loadCommentThreads(fixture.db, v2, viewerUser))[0].subject,
    ).toMatchObject({ positionState: 'attached', textStart: 100 })
    expect(
      await write('v2', 3, {
        threadId: created.threadId,
        state: 'needs-check',
        textStart: null,
        textEnd: null,
        textHash: null,
      }),
    ).toBe(true)
    const v3 = await addVersion('v3', 2)
    expect(
      (await loadCommentThreads(fixture.db, v3, viewerUser))[0].subject,
    ).toMatchObject({
      positionState: 'unchecked',
      textStart: 100,
      textHash: 'c'.repeat(64),
    })
    expect(
      (await loadCommentThreads(fixture.db, access, viewerUser))[0].subject,
    ).toMatchObject({ positionState: 'attached', textStart: 24 })
    const row = await fixture.db
      .selectFrom('comment_anchors')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      quoted_text: selector.quotedText,
      prefix_text: selector.prefixText,
      suffix_text: selector.suffixText,
      text_start: 24,
      text_hash: selector.textHash,
    })
    await fixture.db
      .deleteFrom('comment_threads')
      .where('id', '=', created.threadId)
      .execute()
    expect(
      await fixture.db
        .selectFrom('comment_anchor_results')
        .selectAll()
        .execute(),
    ).toEqual([])
    expect(sqliteRef.bucketGetCount).toBe(0)
  })

  test('rejects cross-artifact, path and malformed resolution batches before any write', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const created = await createCommentThread(
      fixture.db,
      access,
      viewerUser,
      'Check',
      selector,
    )
    if (created.kind !== 'ok') throw new Error('creation failed')
    const input = {
      versionId: 'v1',
      targetPath: '/artifact.html',
      frameToken,
      generation: 1,
      results: [
        {
          threadId: created.threadId,
          state: 'attached' as const,
          textStart: 24,
          textEnd: 38,
          textHash: selector.textHash,
        },
      ],
    }
    const shareable = await fixture.db
      .selectFrom('shareables')
      .selectAll()
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow()
    await fixture.db
      .insertInto('shareables')
      .values({ ...shareable, id: 's2', current_version_id: null })
      .execute()
    const thread = await fixture.db
      .selectFrom('comment_threads')
      .selectAll()
      .where('id', '=', created.threadId)
      .executeTakeFirstOrThrow()
    await fixture.db
      .insertInto('comment_threads')
      .values({ ...thread, id: 'other-thread', shareable_id: 's2' })
      .execute()
    const anchor = await fixture.db
      .selectFrom('comment_anchors')
      .selectAll()
      .where('thread_id', '=', created.threadId)
      .executeTakeFirstOrThrow()
    await fixture.db
      .insertInto('comment_anchors')
      .values({ ...anchor, id: 'other-anchor', thread_id: 'other-thread' })
      .execute()
    for (const patch of [
      {
        results: [
          ...input.results,
          { ...input.results[0], threadId: 'other-thread' },
        ],
      },
      { versionId: 'other-version' },
      { targetPath: '/other.html' },
      { generation: NaN },
      { frameToken: 'bad' },
    ]) {
      expect(
        await storeAnchorResolutions(fixture.db, access, {
          ...input,
          ...patch,
        }),
      ).toBe(false)
    }
    expect(
      await fixture.db
        .selectFrom('comment_anchor_results')
        .selectAll()
        .execute(),
    ).toEqual([])
  })

  test('persists trimmed legacy quotes and valid peers while skipping a mismatched result', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const quote = ' selected   words \n'
    const ids: string[] = []
    for (const selectorFormat of [
      undefined,
      'quote-v1',
      'normalized-v1',
    ] as const) {
      const anchor =
        selectorFormat === 'normalized-v1'
          ? selector
          : {
              quotedText: quote,
              prefixText: 'before',
              suffixText: 'after',
              selectorFormat,
              textStart: selectorFormat ? null : 0,
              textEnd: selectorFormat ? null : quote.length,
              cssPath: null,
            }
      const created = await createCommentThread(
        fixture.db,
        access,
        viewerUser,
        'Check',
        anchor,
      )
      if (created.kind !== 'ok') throw new Error('creation failed')
      ids.push(created.threadId)
    }
    const invalid = await createCommentThread(
      fixture.db,
      access,
      viewerUser,
      'Invalid position',
      selector,
    )
    if (invalid.kind !== 'ok') throw new Error('creation failed')
    const result = (threadId: string, textEnd = 21) => ({
      threadId,
      state: 'attached' as const,
      textStart: 7,
      textEnd,
      textHash: 'c'.repeat(64),
    })
    expect(
      await storeAnchorResolutions(fixture.db, access, {
        versionId: 'v1',
        targetPath: '/artifact.html',
        frameToken,
        generation: 1,
        results: [
          result(ids[0]),
          result(invalid.threadId, 99),
          result(ids[1]),
          result(ids[2]),
        ],
      }),
    ).toBe(true)
    const rows = await fixture.db
      .selectFrom('comment_anchor_results')
      .innerJoin(
        'comment_anchors',
        'comment_anchors.id',
        'comment_anchor_results.anchor_id',
      )
      .select([
        'comment_anchors.thread_id',
        'comment_anchors.quoted_text',
        'comment_anchor_results.hint_start',
        'comment_anchor_results.hint_end',
        'comment_anchor_results.state',
      ])
      .execute()
    expect(rows.map((row) => row.thread_id).sort()).toEqual([...ids].sort())
    for (const row of rows) {
      expect(row).toMatchObject({
        state: 'attached',
        hint_start: 7,
        hint_end: 21,
      })
      expect(row.quoted_text).toBe(
        row.thread_id === ids[2] ? selector.quotedText : quote,
      )
    }
  })

  test('skips deleted threads and preserves attachment against late missing results from other frames', async () => {
    const access = (await loadCommentAccess(fixture.db, viewerUser, 's1'))!
    const created = await createCommentThread(
      fixture.db,
      access,
      viewerUser,
      'Check',
      selector,
    )
    if (created.kind !== 'ok') throw new Error('creation failed')
    const write = (token: string, generation: number, attached: boolean) =>
      storeAnchorResolutions(fixture.db, access, {
        versionId: 'v1',
        targetPath: '/artifact.html',
        frameToken: token,
        generation,
        results: [
          {
            threadId: 'deleted-thread',
            state: 'needs-check',
            textStart: null,
            textEnd: null,
            textHash: null,
          },
          {
            threadId: created.threadId,
            state: attached ? 'attached' : 'needs-check',
            textStart: attached ? 24 : null,
            textEnd: attached ? 38 : null,
            textHash: attached ? selector.textHash : null,
          },
        ],
      })
    const state = async () =>
      (
        await fixture.db
          .selectFrom('comment_anchor_results')
          .selectAll()
          .executeTakeFirstOrThrow()
      ).state
    expect(await write('a'.repeat(64), 1, false)).toBe(true)
    expect(await state()).toBe('needs-check')
    expect(await write('b'.repeat(64), 1, true)).toBe(true)
    expect(await state()).toBe('attached')
    expect(await write('c'.repeat(64), 1, false)).toBe(true)
    expect(await state()).toBe('attached')
    const retained = await fixture.db
      .selectFrom('comment_anchor_results')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(retained).toMatchObject({
      state: 'attached',
      frame_token: 'b'.repeat(64),
      generation: 1,
      hint_start: 24,
      hint_end: 38,
      text_hash: selector.textHash,
    })
    expect(await write('b'.repeat(64), 2, false)).toBe(true)
    expect(await state()).toBe('needs-check')
    expect(await write('b'.repeat(64), 1, true)).toBe(true)
    expect(await state()).toBe('needs-check')
    expect(await write('c'.repeat(64), 1, true)).toBe(true)
    expect(await state()).toBe('attached')
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

  test('uses the DB-authorized Agent context through the final comment access check', async () => {
    const staleSession = {
      ...viewerUser,
      email: 'stale@example.com',
      emailVerified: false,
      workspaceId: 'ws2',
    }
    const authorization = {
      kind: 'agent-read' as const,
      artifactId: 's1',
      viewerUserId: viewerUser.id,
      viewerWorkspaceId: 'ws1',
    }

    await expect(
      loadCommentAccess(fixture.db, staleSession, 's1'),
    ).resolves.toBeNull()
    await expect(
      loadCommentAccess(fixture.db, staleSession, 's1', authorization),
    ).resolves.toMatchObject({
      shareableId: 's1',
      workspaceId: 'ws1',
    })
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

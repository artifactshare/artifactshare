import { sql } from 'kysely'
import { describe, expect, test } from 'vitest'
import { localDayKeyFromTimezone } from '~/lib/datetime'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { mergeFeedRows } from '~/lib/feed-merge'
import {
  artifactCreatedEventQuery,
  artifactViewedEventQuery,
  listFeedEvents,
  listProjectViewRanking,
  timezoneDayUtcRange,
  resolveFeedTimezone,
} from './events.server'

async function fixture() {
  const f = createMigratedInMemoryDb()
  await f.db
    .insertInto('workspaces')
    .values({
      id: 'w1',
      name: 'Workspace',
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  await f.db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'u@example.com',
      name: 'User',
      email_verified: 1,
      image: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      workspace_id: 'w1',
      locale: null,
    })
    .execute()
  await f.db
    .insertInto('artifact_containers')
    .values({
      id: 'c1',
      workspace_id: 'w1',
      kind: 'inbox',
      owner_user_id: 'u1',
      created_by_id: 'u1',
      name: 'Container',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  await f.db
    .insertInto('shareables')
    .values({
      id: 's1',
      workspace_id: 'w1',
      owner_user_id: 'u1',
      name: 'Artifact',
      artifact_kind: 'markdown_page',
      visibility: 'private',
      container_id: 'c1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  await f.db
    .insertInto('versions')
    .values({
      id: 'v1',
      shareable_id: 's1',
      artifact_kind: 'markdown_page',
      status: 'published',
      entrypoint_path: '/index.md',
      r2_key: 'k',
      size_bytes: 1,
      sha256: 'x',
      created_by_id: 'u1',
      created_at: '2026-01-01T00:00:00Z',
      published_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  return f
}

describe('events helpers', () => {
  const feedUser = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u@example.com',
    emailVerified: true,
  }

  async function insertUser(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    id: string,
  ) {
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@example.com`,
        name: id,
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
  }

  async function insertShareable(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    id: string,
    ownerUserId: string,
    visibility: 'workspace' | 'private',
  ) {
    await db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: 'w1',
        owner_user_id: ownerUserId,
        name: `Artifact ${id}`,
        artifact_kind: 'markdown_page',
        visibility,
        container_id: 'c1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }

  async function insertVersion(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    id: string,
    shareableId: string,
    createdById: string,
    publishedAt = '2026-01-01T00:00:00Z',
  ) {
    await db
      .insertInto('versions')
      .values({
        id,
        shareable_id: shareableId,
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: '/index.md',
        r2_key: id,
        size_bytes: 1,
        sha256: id,
        created_by_id: createdById,
        created_at: '2026-01-01T00:00:00Z',
        published_at: publishedAt,
      })
      .execute()
  }

  async function setupViewedOtherShareable(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    owner = 'u2',
  ) {
    await insertUser(db, owner)
    await insertShareable(db, 's2', owner, 'workspace')
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's2',
        viewer_user_id: 'u1',
        first_viewed_at: '2026-01-01T00:00:00Z',
        last_viewed_at: '2026-01-01T00:00:00Z',
        effective_view_count: 1,
      })
      .execute()
  }

  async function insertVersionUpdate(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    id: string,
    versionId: string,
    actor: string,
    at: string,
  ) {
    await insertEvent(db, {
      id,
      type: 'version_published',
      shareableId: 's2',
      actorUserId: actor,
      subjectId: versionId,
      createdAt: at,
    })
  }

  async function insertEvent(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    values: {
      id: string
      type: 'artifact_created' | 'version_published' | 'comment_posted'
      shareableId: string
      actorUserId: string
      subjectId: string
      createdAt: string
    },
  ) {
    await db
      .insertInto('events')
      .values({
        id: values.id,
        workspace_id: 'w1',
        type: values.type,
        shareable_id: values.shareableId,
        actor_user_id: values.actorUserId,
        subject_id: values.subjectId,
        created_at: values.createdAt,
      })
      .execute()
  }

  async function insertComment(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    values: {
      eventId: string
      messageId: string
      actor: string
      shareableId: string
      body: string
      createdAt: string
    },
  ) {
    const threadId = `thread-${values.messageId}`
    await db
      .insertInto('comment_threads')
      .values({
        id: threadId,
        shareable_id: values.shareableId,
        status: 'open',
        created_by_id: values.actor,
        resolved_by_id: null,
        resolved_at: null,
        created_at: values.createdAt,
        updated_at: values.createdAt,
      })
      .execute()
    await db
      .insertInto('comment_messages')
      .values({
        id: values.messageId,
        thread_id: threadId,
        body: values.body,
        agent: null,
        created_by_id: values.actor,
        created_at: values.createdAt,
        updated_at: values.createdAt,
      })
      .execute()
    await insertEvent(db, {
      id: values.eventId,
      type: 'comment_posted',
      shareableId: values.shareableId,
      actorUserId: values.actor,
      subjectId: values.messageId,
      createdAt: values.createdAt,
    })
  }

  async function insertView(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    id: string,
    at: string,
    actorUserId: string | null = 'u2',
    shareableId = 's1',
  ) {
    await db
      .insertInto('events')
      .values({
        id,
        workspace_id: 'w1',
        type: 'artifact_viewed',
        shareable_id: shareableId,
        actor_user_id: actorUserId,
        subject_id: null,
        created_at: at,
      })
      .execute()
  }

  test('aggregates views by UTC day, mixing authenticated and anonymous views', async () => {
    const { db } = await fixture()
    await db
      .insertInto('users')
      .values({
        id: 'u2',
        email: 'two@example.com',
        name: 'Two',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    await insertView(db, 'view-1', '2026-01-02T12:00:00Z', 'u2')
    await insertView(db, 'view-2', '2026-01-02T13:00:00Z', null)
    await insertView(db, 'view-3', '2026-01-02T14:00:00Z', null)
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 10,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      viewUniqueCount: 1,
      anonymousViewCount: 2,
    })
  })

  test('mine keeps complete counts for each UTC day across multiple days', async () => {
    const { db } = await fixture()
    await insertView(db, 'mine-day-2', '2026-01-02T12:00:00Z', null)
    await insertView(db, 'mine-day-1', '2026-01-01T12:00:00Z', null)
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'artifact_viewed'),
    ).toHaveLength(2)
    expect(result.rows.map((row) => row.anonymousViewCount)).toEqual([1, 1])
  })

  test('mine emits one view digest for a day with multiple files', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertShareable(db, 's2', 'u1', 'workspace')
    await insertView(db, 'mine-file-1', '2026-01-02T12:00:00Z', 'u2')
    await insertView(db, 'mine-file-2', '2026-01-02T11:00:00Z', 'u2', 's2')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'artifact_viewed'),
    ).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ viewedFileCount: 2 })
  })

  test('mine counts repeated views as rows while keeping unique viewers distinct', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertView(db, 'mine-repeat-1', '2026-01-02T12:00:00Z', 'u2')
    await insertView(db, 'mine-repeat-2', '2026-01-02T11:00:00Z', 'u2')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows[0]?.viewTopItems?.[0]).toMatchObject({ count: 2 })
    expect(result.rows[0]?.viewUniqueCount).toBe(1)
  })

  test('mine ignores the feed user views and keeps digest position and counts stable', async () => {
    const baseline = await fixture()
    await insertUser(baseline.db, 'u2')
    await insertView(baseline.db, 'other-before', '2026-01-02T14:00:00Z', 'u2')
    await insertView(baseline.db, 'other-after', '2026-01-02T12:00:00Z', null)
    const expected = await listFeedEvents(baseline.db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })

    const withOwnViews = await fixture()
    await insertUser(withOwnViews.db, 'u2')
    await insertView(
      withOwnViews.db,
      'other-before',
      '2026-01-02T14:00:00Z',
      'u2',
    )
    await insertView(
      withOwnViews.db,
      'own-middle',
      '2026-01-02T13:00:00Z',
      'u1',
    )
    await insertView(
      withOwnViews.db,
      'other-after',
      '2026-01-02T12:00:00Z',
      null,
    )
    const actual = await listFeedEvents(withOwnViews.db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(actual.rows).toEqual(expected.rows)
  })

  test('mine excludes views outside the workspace and on other-owned files', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertShareable(db, 's2', 'u2', 'workspace')
    await insertView(db, 'owned-file', '2026-01-02T14:00:00Z', 'u2')
    await insertView(db, 'other-owned-file', '2026-01-02T13:00:00Z', 'u2', 's2')
    await db
      .insertInto('workspaces')
      .values({
        id: 'w2',
        name: 'Other',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 's3',
        workspace_id: 'w2',
        owner_user_id: 'u2',
        name: 'Other workspace',
        artifact_kind: 'markdown_page',
        visibility: 'workspace',
        container_id: 'c1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await insertView(
      db,
      'other-workspace-file',
      '2026-01-02T12:00:00Z',
      'u2',
      's3',
    )
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      viewedFileCount: 1,
      viewUniqueCount: 1,
    })
    expect(
      result.rows[0]?.viewTopItems?.map((item) => item.shareableId),
    ).toEqual(['s1'])
  })

  test('all view rows keep the legacy null viewedFileCount', async () => {
    const { db } = await fixture()
    await insertView(db, 'all-view', '2026-01-02T12:00:00Z', null)
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows[0]).toMatchObject({
      type: 'artifact_viewed',
      viewedFileCount: null,
    })
  })

  test('mine preserves complete view counts and non-view rows across folded pages', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertView(db, 'page-view-new', '2026-01-02T14:00:00Z', 'u2')
    await insertComment(db, {
      eventId: 'page-comment',
      messageId: 'page-message',
      actor: 'u2',
      shareableId: 's1',
      body: 'kept',
      createdAt: '2026-01-02T13:00:00Z',
    })
    await insertView(db, 'page-view-old', '2026-01-02T12:00:00Z', null)
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 1,
      maxRawEvents: 2,
    })
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 2,
    })
    expect(
      first.rows.find((row) => row.type === 'artifact_viewed'),
    ).toMatchObject({
      viewUniqueCount: 1,
      anonymousViewCount: 1,
      viewedFileCount: 1,
    })
    expect(
      second.rows.find((row) => row.type === 'artifact_viewed'),
    ).toMatchObject({
      viewUniqueCount: 1,
      anonymousViewCount: 1,
      viewedFileCount: 1,
    })
    expect(
      [...first.rows, ...second.rows].some((row) => row.id === 'page-comment'),
    ).toBe(true)
  })

  test('aggregates same actor and shareable comments in all slice with latest body', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertComment(db, {
      eventId: 'c1',
      messageId: 'm1',
      actor: 'u2',
      shareableId: 's1',
      body: 'old',
      createdAt: '2026-01-02T10:00:00Z',
    })
    await insertComment(db, {
      eventId: 'c2',
      messageId: 'm2',
      actor: 'u2',
      shareableId: 's1',
      body: 'latest',
      createdAt: '2026-01-02T11:00:00Z',
    })
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      commentCount: 2,
      commentBody: 'latest',
      id: 'c2',
    })
  })

  test.each([
    ['mine owned', 's1', false],
    ['mine viewed', 's2', true],
  ])(
    'aggregates same actor comments in %s',
    async (_label, shareableId, viewed) => {
      const { db } = await fixture()
      if (viewed) await setupViewedOtherShareable(db)
      else await insertUser(db, 'u2')
      await insertComment(db, {
        eventId: `${shareableId}-1`,
        messageId: `${shareableId}-m1`,
        actor: 'u2',
        shareableId,
        body: 'a',
        createdAt: '2026-01-02T10:00:00Z',
      })
      await insertComment(db, {
        eventId: `${shareableId}-2`,
        messageId: `${shareableId}-m2`,
        actor: 'u2',
        shareableId,
        body: 'b',
        createdAt: '2026-01-02T11:00:00Z',
      })
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: 'UTC',
        slice: 'mine',
        targetRows: 10,
        maxRawEvents: 100,
      })
      expect(
        result.rows.filter((row) => row.shareableId === shareableId),
      ).toHaveLength(1)
      expect(
        result.rows.find((row) => row.shareableId === shareableId),
      ).toMatchObject({ commentCount: 2, commentBody: 'b' })
    },
  )

  test('does not aggregate across actor, shareable, or UTC day and keeps singleton null', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertUser(db, 'u3')
    await insertShareable(db, 's2', 'u2', 'workspace')
    const entries = [
      ['a', 'ma', 'u2', 's1', '2026-01-02T10:00:00Z'],
      ['b', 'mb', 'u3', 's1', '2026-01-02T11:00:00Z'],
      ['c', 'mc', 'u2', 's2', '2026-01-02T12:00:00Z'],
      ['d', 'md', 'u2', 's1', '2026-01-03T00:00:00Z'],
    ] as const
    for (const [eventId, messageId, actor, shareableId, createdAt] of entries)
      await insertComment(db, {
        eventId,
        messageId,
        actor,
        shareableId,
        body: eventId,
        createdAt,
      })
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'comment_posted'),
    ).toHaveLength(4)
    expect(result.rows.every((row) => row.commentCount === null)).toBe(true)
  })

  test('reports complete count across comment page boundary', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertComment(db, {
      eventId: 'c1',
      messageId: 'm1',
      actor: 'u2',
      shareableId: 's1',
      body: 'a',
      createdAt: '2026-01-02T10:00:00Z',
    })
    await insertComment(db, {
      eventId: 'c2',
      messageId: 'm2',
      actor: 'u2',
      shareableId: 's1',
      body: 'b',
      createdAt: '2026-01-02T11:00:00Z',
    })
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 1,
      maxRawEvents: 1,
    })
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(first.rows[0].commentCount).toBe(2)
    expect(second.rows[0].commentCount).toBe(2)
  })

  test('excludes deleted comments and selects highest event id for ties', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertComment(db, {
      eventId: 'same-a',
      messageId: 'm-a',
      actor: 'u2',
      shareableId: 's1',
      body: 'a',
      createdAt: '2026-01-02T10:00:00Z',
    })
    await insertComment(db, {
      eventId: 'same-b',
      messageId: 'm-b',
      actor: 'u2',
      shareableId: 's1',
      body: 'b',
      createdAt: '2026-01-02T10:00:00Z',
    })
    await insertComment(db, {
      eventId: 'deleted',
      messageId: 'm-deleted',
      actor: 'u2',
      shareableId: 's1',
      body: 'gone',
      createdAt: '2026-01-02T11:00:00Z',
    })
    await db
      .deleteFrom('comment_messages')
      .where('id', '=', 'm-deleted')
      .execute()
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ commentCount: 2, commentBody: 'b' })
  })

  test('cursor stops at the last emitted raw event when targetRows is reached', async () => {
    const { db } = await fixture()
    await insertView(db, 'view-1', '2026-01-03T12:00:00Z', null)
    await db
      .insertInto('events')
      .values({
        id: 'event-2',
        workspace_id: 'w1',
        type: 'artifact_created',
        shareable_id: 's1',
        actor_user_id: 'u1',
        subject_id: 'v1',
        created_at: '2026-01-02T12:00:00Z',
      })
      .execute()
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 1,
      maxRawEvents: 10,
    })
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 10,
    })
    expect(second.rows.map((row) => row.id)).toContain('event-2')
  })

  test('mine slice keeps reactions and viewed-shareable updates, drops own actions', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertShareable(db, 's2', 'u2', 'workspace')
    await insertShareable(db, 's3', 'u2', 'workspace')
    // 自分の行為 (混入しない)
    await insertEvent(db, {
      id: 'own-created',
      type: 'artifact_created',
      shareableId: 's1',
      actorUserId: 'u1',
      subjectId: 'v1',
      createdAt: '2026-01-02T10:00:00Z',
    })
    // 自分の shareable への他者閲覧と匿名閲覧 (含む)
    await insertView(db, 'view-auth', '2026-01-02T11:00:00Z', 'u2')
    await insertView(db, 'view-anon', '2026-01-02T11:30:00Z', null)
    // 閲覧履歴にある他人の shareable の版更新 (含む)
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's2',
        viewer_user_id: 'u1',
        first_viewed_at: '2026-01-01T00:00:00Z',
        last_viewed_at: '2026-01-01T00:00:00Z',
        effective_view_count: 1,
      })
      .execute()
    await insertVersion(db, 'v-s2', 's2', 'u2')
    await insertEvent(db, {
      id: 'seen-version',
      type: 'version_published',
      shareableId: 's2',
      actorUserId: 'u2',
      subjectId: 'v-s2',
      createdAt: '2026-01-02T12:00:00Z',
    })
    // 閲覧履歴にない他人の shareable のコメント (含まない)
    await insertEvent(db, {
      id: 'unseen-comment',
      type: 'comment_posted',
      shareableId: 's3',
      actorUserId: 'u2',
      subjectId: 'm-s3',
      createdAt: '2026-01-02T13:00:00Z',
    })
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    const ids = result.rows.map((row) => row.id)
    expect(ids).not.toContain('own-created')
    expect(ids).not.toContain('unseen-comment')
    expect(ids).toContain('seen-version')
    const viewRow = result.rows.find((row) => row.type === 'artifact_viewed')
    expect(viewRow).toMatchObject({
      viewUniqueCount: 1,
      anonymousViewCount: 1,
    })
  })

  test('mine aggregates two consecutive versions on a viewed other-owned shareable with full range and latest position', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u2', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u2', '2026-01-02T11:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      versionStart: 1,
      versionEnd: 2,
      versionAuthorCount: 1,
      id: 'e3',
    })
  })

  test('mine keeps one viewed other-owned version as an individual row with null range', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows[0]).toMatchObject({
      id: 'e2',
      versionNumber: 1,
      versionStart: null,
      versionEnd: null,
    })
  })

  test('mine does not aggregate other-user updates on an owned shareable', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertVersion(db, 'v2', 's1', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's1', 'u2', '2026-01-02T11:00:00Z')
    await db
      .insertInto('events')
      .values([
        {
          id: 'e2',
          workspace_id: 'w1',
          type: 'version_published',
          shareable_id: 's1',
          actor_user_id: 'u2',
          subject_id: 'v2',
          created_at: '2026-01-02T10:00:00Z',
        },
        {
          id: 'e3',
          workspace_id: 'w1',
          type: 'version_published',
          shareable_id: 's1',
          actor_user_id: 'u2',
          subject_id: 'v3',
          created_at: '2026-01-02T11:00:00Z',
        },
      ])
      .execute()
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'version_published'),
    ).toHaveLength(2)
  })

  test('mine keeps nonconsecutive viewed other-owned versions as individual rows', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u1', '2026-01-02T10:30:00Z')
    await insertVersion(db, 'v4', 's2', 'u2', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e4', 'v4', 'u2', '2026-01-02T11:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'version_published'),
    ).toHaveLength(2)
  })

  test('mine reports two authors for a consecutive version aggregate', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertUser(db, 'u3')
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u3', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u3', '2026-01-02T11:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows[0].versionAuthorCount).toBe(2)
  })

  test('mine separates version aggregates across UTC days', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T23:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u2', '2026-01-03T01:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T23:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u2', '2026-01-03T01:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'version_published'),
    ).toHaveLength(2)
  })

  test('all keeps same-day multiple version updates as individual rows', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u2', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u2', '2026-01-02T11:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(
      result.rows.filter((row) => row.type === 'version_published'),
    ).toHaveLength(2)
  })

  test('version aggregate crossing a page boundary returns complete range on both pages without loss', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u2', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u2', '2026-01-02T11:00:00Z')
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 1,
      maxRawEvents: 1,
    })
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(first.rows[0]).toMatchObject({ versionStart: 1, versionEnd: 2 })
    expect(second.rows[0]).toMatchObject({ versionStart: 1, versionEnd: 2 })
  })

  test('version aggregation reaches maxRawEvents with a short page and hasMore', async () => {
    const { db } = await fixture()
    await setupViewedOtherShareable(db)
    await insertVersion(db, 'v2', 's2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersion(db, 'v3', 's2', 'u2', '2026-01-02T11:00:00Z')
    await insertVersionUpdate(db, 'e2', 'v2', 'u2', '2026-01-02T10:00:00Z')
    await insertVersionUpdate(db, 'e3', 'v3', 'u2', '2026-01-02T11:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 1,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.hasMore).toBe(true)
  })

  test('excludes shareables the viewer cannot see from both slices', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertShareable(db, 's-hidden', 'u2', 'private')
    await insertEvent(db, {
      id: 'hidden-version',
      type: 'version_published',
      shareableId: 's-hidden',
      actorUserId: 'u2',
      subjectId: 'v-hidden',
      createdAt: '2026-01-02T12:00:00Z',
    })
    for (const slice of ['all', 'mine'] as const) {
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: 'UTC',
        slice,
        targetRows: 10,
        maxRawEvents: 100,
      })
      expect(result.rows.map((row) => row.id)).not.toContain('hidden-version')
    }
  })

  test('returns partial rows with hasMore when maxRawEvents is reached', async () => {
    const { db } = await fixture()
    await insertView(db, 'day1', '2026-01-01T12:00:00Z', null)
    await insertView(db, 'day2', '2026-01-02T12:00:00Z', null)
    await insertView(db, 'day3', '2026-01-03T12:00:00Z', null)
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 2,
    })
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows.length).toBeLessThan(3)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).not.toBeNull()
  })

  test('advances the cursor past view events folded into an emitted aggregate', async () => {
    const { db } = await fixture()
    await insertView(db, 'fold-1', '2026-01-02T14:00:00Z', null)
    await insertView(db, 'fold-2', '2026-01-02T12:00:00Z', null)
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 5,
      maxRawEvents: 2,
    })
    expect(first.rows).toHaveLength(1)
    expect(first.nextCursor?.id).toBe('fold-2')
  })

  test('hides comment and version events whose subject rows were deleted', async () => {
    const { db } = await fixture()
    await insertEvent(db, {
      id: 'orphan-comment',
      type: 'comment_posted',
      shareableId: 's1',
      actorUserId: 'u1',
      subjectId: 'missing-message',
      createdAt: '2026-01-02T10:00:00Z',
    })
    await insertEvent(db, {
      id: 'orphan-version',
      type: 'version_published',
      shareableId: 's1',
      actorUserId: 'u1',
      subjectId: 'missing-version',
      createdAt: '2026-01-02T11:00:00Z',
    })
    await insertEvent(db, {
      id: 'live-version',
      type: 'version_published',
      shareableId: 's1',
      actorUserId: 'u1',
      subjectId: 'v1',
      createdAt: '2026-01-02T12:00:00Z',
    })
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    const ids = result.rows.map((row) => row.id)
    expect(ids).toContain('live-version')
    expect(ids).not.toContain('orphan-comment')
    expect(ids).not.toContain('orphan-version')
  })

  test('keeps hasMore true when targetRows is reached mid-batch below the SQL limit', async () => {
    const { db } = await fixture()
    await insertView(db, 'mid-1', '2026-01-04T12:00:00Z', null)
    await insertView(db, 'mid-2', '2026-01-03T12:00:00Z', null)
    await insertView(db, 'mid-3', '2026-01-02T12:00:00Z', null)
    await insertView(db, 'mid-4', '2026-01-01T12:00:00Z', null)
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 3,
      maxRawEvents: 100,
    })
    expect(first.rows).toHaveLength(3)
    expect(first.hasMore).toBe(true)
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(second.rows.map((row) => row.id)).toEqual(['mid-4'])
    expect(second.hasMore).toBe(false)
  })

  test('reports the full distinct count when an aggregate key spans pages', async () => {
    const { db } = await fixture()
    await insertUser(db, 'u2')
    await insertView(db, 'span-1', '2026-01-02T14:00:00Z', 'u2')
    await insertView(db, 'span-2', '2026-01-02T12:00:00Z', 'u2')
    const first = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 1,
      maxRawEvents: 1,
    })
    expect(first.rows[0]).toMatchObject({ viewUniqueCount: 1 })
    const second = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      cursor: first.nextCursor!,
      targetRows: 10,
      maxRawEvents: 100,
    })
    for (const row of second.rows.filter((r) => r.type === 'artifact_viewed')) {
      expect(row.viewUniqueCount).toBe(1)
    }
  })

  test('derives workspace and is idempotent', async () => {
    const { db } = await fixture()
    await artifactCreatedEventQuery(db, { versionId: 'v1' }).execute()
    await artifactCreatedEventQuery(db, { versionId: 'v1' }).execute()
    expect(await db.selectFrom('events').selectAll().execute()).toHaveLength(1)
    expect(
      (
        await db
          .selectFrom('events')
          .select('workspace_id')
          .executeTakeFirstOrThrow()
      ).workspace_id,
    ).toBe('w1')
    expect(
      (
        await artifactCreatedEventQuery(db, { versionId: 'missing' }).execute()
      )[0]?.numInsertedOrUpdatedRows,
    ).toBe(0n)
  })

  test('allows anonymous view events and enforces checks', async () => {
    const { db } = await fixture()
    await artifactViewedEventQuery(db, {
      shareableId: 's1',
      actorUserId: null,
      viewedAt: '2026-01-02T00:00:00Z',
    }).execute()
    expect(
      (
        await db
          .selectFrom('events')
          .select('actor_user_id')
          .executeTakeFirstOrThrow()
      ).actor_user_id,
    ).toBeNull()
    await expect(
      db
        .insertInto('events')
        .values({
          id: 'bad',
          workspace_id: 'w1',
          type: 'artifact_created',
          shareable_id: 's1',
          actor_user_id: null,
          subject_id: 'v1',
          created_at: 'x',
        })
        .execute(),
    ).rejects.toThrow()
  })

  test.each([
    ['unknown type', { type: 'bogus', actor_user_id: 'u1', subject_id: 'v1' }],
    [
      'view with subject',
      { type: 'artifact_viewed', actor_user_id: 'u1', subject_id: 'v1' },
    ],
    [
      'non-view with null subject',
      { type: 'comment_posted', actor_user_id: 'u1', subject_id: null },
    ],
    [
      'non-view with null actor',
      { type: 'version_published', actor_user_id: null, subject_id: 'v1' },
    ],
  ] as const)('%s is rejected by the events checks', async (name, values) => {
    const { db } = await fixture()
    await expect(
      sql`
        INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at)
        VALUES (${`bad-${name}`}, 'w1', ${values.type}, 's1', ${values.actor_user_id}, ${values.subject_id}, 'x')
      `.execute(db),
    ).rejects.toThrow()
  })

  test('cascades events when a shareable is deleted', async () => {
    const { db, sqlite } = await fixture()
    sqlite.exec('PRAGMA foreign_keys = ON')
    await artifactViewedEventQuery(db, {
      shareableId: 's1',
      actorUserId: null,
      viewedAt: 'x',
    }).execute()
    await db.deleteFrom('shareables').where('id', '=', 's1').execute()
    expect(await db.selectFrom('events').selectAll().execute()).toEqual([])
  })

  describe('local day bundling (tz offset)', () => {
    const jst = 'Asia/Tokyo'
    const localDay = '2026-07-30'
    const earlyUtc = '2026-07-29T15:05:00.000Z'
    const lateUtc = '2026-07-30T14:55:00.000Z'
    const afterLocalMidnightUtc = '2026-07-30T15:05:00.000Z'

    async function assertCompiledRecountQuery(
      distinguishingColumn: string,
      slice: 'all' | 'mine' = 'mine',
    ) {
      const { db, sqlite } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'compiled-view', earlyUtc, 'u2')
      await insertEvent(db, {
        id: 'compiled-version-event',
        type: 'version_published',
        shareableId: 's1',
        actorUserId: 'u2',
        subjectId: 'v1',
        createdAt: earlyUtc,
      })
      await insertComment(db, {
        eventId: 'compiled-comment-event',
        messageId: 'compiled-comment-message',
        actor: 'u2',
        shareableId: 's1',
        body: 'comment',
        createdAt: earlyUtc,
      })
      await insertEvent(db, {
        id: 'compiled-add-event',
        type: 'artifact_created',
        shareableId: 's1',
        actorUserId: 'u2',
        subjectId: 's1',
        createdAt: earlyUtc,
      })

      const captured: string[] = []
      const originalPrepare = sqlite.prepare.bind(sqlite)
      ;(sqlite as unknown as { prepare: (query: string) => unknown }).prepare =
        (query) => {
          captured.push(query)
          return originalPrepare(query)
        }
      try {
        await listFeedEvents(db, {
          user: feedUser,
          timeZone: jst,
          slice,
          targetRows: 10,
          maxRawEvents: 100,
        })
      } finally {
        ;(sqlite as unknown as { prepare: typeof sqlite.prepare }).prepare =
          originalPrepare
      }

      const query = captured.find(
        (sqlText) =>
          sqlText.includes('events.created_at >= ?') &&
          sqlText.includes('events.created_at < ?') &&
          sqlText.includes(distinguishingColumn),
      )
      expect(
        query,
        `compiled recount query containing ${distinguishingColumn}`,
      ).toBeDefined()
      expect(query).not.toMatch(/strftime\([^)]*events\.created_at[^)]*\)\s*=/)
    }

    test('offset +540 recounts views at both ends of a local day into one aggregate', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'jst-view-1', earlyUtc, 'u2')
      await insertView(db, 'jst-view-2', lateUtc, null)
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'all',
        targetRows: 10,
        maxRawEvents: 10,
      })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({
        viewUniqueCount: 1,
        anonymousViewCount: 1,
        dayKey: localDay,
      })
    })

    test('offset 0 keeps UTC-day view aggregation unchanged', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'utc-1', earlyUtc, 'u2')
      await insertView(db, 'utc-2', lateUtc, null)
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: 'UTC',
        slice: 'all',
        targetRows: 10,
        maxRawEvents: 10,
      })
      expect(result.rows).toHaveLength(2)
      expect(result.rows.map((row) => row.dayKey).sort()).toEqual([
        '2026-07-29',
        '2026-07-30',
      ])
    })

    test('mine view digest splits events across local midnight with offset +540', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'digest-before', '2026-07-29T14:55:00.000Z', 'u2')
      await insertView(db, 'digest-after', afterLocalMidnightUtc, 'u2')
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'mine',
        targetRows: 10,
        maxRawEvents: 100,
      })
      const views = result.rows.filter((row) => row.type === 'artifact_viewed')
      expect(views).toHaveLength(2)
      expect(views.map((row) => row.dayKey).sort()).toEqual([
        '2026-07-29',
        '2026-07-31',
      ])
    })

    test('all view aggregate splits shareable views across local midnight with offset +540', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'all-before', '2026-07-29T14:55:00.000Z', 'u2')
      await insertView(db, 'all-after', afterLocalMidnightUtc, 'u2')
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'all',
        targetRows: 10,
        maxRawEvents: 100,
      })
      const views = result.rows.filter((row) => row.type === 'artifact_viewed')
      expect(views).toHaveLength(2)
      expect(views.every((row) => row.commentCount === null)).toBe(true)
    })

    test('version bundle splits across local midnight with offset +540', async () => {
      const { db } = await fixture()
      await setupViewedOtherShareable(db)
      await insertVersion(db, 'vj1', 's2', 'u2', earlyUtc)
      await insertVersion(db, 'vj2', 's2', 'u2', afterLocalMidnightUtc)
      await insertVersionUpdate(db, 'ev-j1', 'vj1', 'u2', earlyUtc)
      await insertVersionUpdate(db, 'ev-j2', 'vj2', 'u2', afterLocalMidnightUtc)
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'mine',
        targetRows: 10,
        maxRawEvents: 100,
      })
      const versions = result.rows.filter(
        (row) => row.type === 'version_published',
      )
      expect(versions).toHaveLength(2)
      expect(versions.map((row) => row.dayKey).sort()).toEqual([
        localDay,
        '2026-07-31',
      ])
    })

    test('comment bundle splits across local midnight with offset +540', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertComment(db, {
        eventId: 'jc1',
        messageId: 'jm1',
        actor: 'u2',
        shareableId: 's1',
        body: 'a',
        createdAt: '2026-07-29T14:55:00.000Z',
      })
      await insertComment(db, {
        eventId: 'jc2',
        messageId: 'jm2',
        actor: 'u2',
        shareableId: 's1',
        body: 'b',
        createdAt: afterLocalMidnightUtc,
      })
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'all',
        targetRows: 10,
        maxRawEvents: 100,
      })
      const comments = result.rows.filter(
        (row) => row.type === 'comment_posted',
      )
      expect(comments).toHaveLength(2)
      expect(comments.every((row) => row.commentCount === null)).toBe(true)
    })

    test('add bundle splits across local midnight with offset +540', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await db
        .insertInto('artifact_containers')
        .values({
          id: 'c-proj-jst',
          workspace_id: 'w1',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u2',
          name: 'Proj',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
      await db
        .insertInto('project_members')
        .values({
          container_id: 'c-proj-jst',
          user_id: 'u1',
          joined_at: '2026-01-01T00:00:00Z',
          last_seen_at: '2026-01-01T00:00:00Z',
        })
        .execute()
      for (const [eid, sid, at] of [
        ['add-j1', 's-add-1', '2026-07-29T14:55:00.000Z'],
        ['add-j2', 's-add-2', afterLocalMidnightUtc],
      ] as const) {
        await db
          .insertInto('shareables')
          .values({
            id: sid,
            workspace_id: 'w1',
            owner_user_id: 'u2',
            name: sid,
            artifact_kind: 'markdown_page',
            visibility: 'workspace',
            container_id: 'c-proj-jst',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          })
          .execute()
        await db
          .insertInto('events')
          .values({
            id: eid,
            workspace_id: 'w1',
            type: 'artifact_created',
            shareable_id: sid,
            actor_user_id: 'u2',
            subject_id: sid,
            created_at: at,
          })
          .execute()
      }
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'mine',
        targetRows: 10,
        maxRawEvents: 100,
      })
      const adds = result.rows.filter((row) => row.type === 'artifact_created')
      expect(adds).toHaveLength(2)
      expect(adds.map((row) => row.dayKey).sort()).toEqual([
        '2026-07-29',
        '2026-07-31',
      ])
      expect(adds.every((row) => row.addCount === null)).toBe(true)
    })

    test('dayKey is set on every row and matches offset-derived local day', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'dk-1', earlyUtc, 'u2')
      const result = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'all',
        targetRows: 10,
        maxRawEvents: 10,
      })
      expect(result.rows.length).toBeGreaterThan(0)
      expect(
        result.rows.every(
          (row) => row.dayKey === localDayKeyFromTimezone(row.createdAt, jst),
        ),
      ).toBe(true)
    })

    test('cursor timeZone falls back to request offset when invalid', () => {
      expect(
        resolveFeedTimezone(
          { createdAt: 'x', id: 'y', timeZone: 'Invalid/Timezone' },
          'UTC',
        ),
      ).toBe('UTC')
      expect(
        resolveFeedTimezone(
          { createdAt: 'x', id: 'y', timeZone: '1.5' },
          'UTC',
        ),
      ).toBe('UTC')
      expect(
        resolveFeedTimezone(
          { createdAt: 'x', id: 'y', timeZone: 'Asia/Tokyo' },
          'UTC',
        ),
      ).toBe('Asia/Tokyo')
      expect(resolveFeedTimezone(undefined, 'UTC')).toBe('UTC')
      expect(resolveFeedTimezone(undefined, 'aSiA/tOkYo')).toBe('Asia/Tokyo')
    })

    test('page two recount uses cursor timezone over request timezone', async () => {
      const { db } = await fixture()
      await insertUser(db, 'u2')
      await insertView(db, 'page-j1', earlyUtc, 'u2')
      await insertView(db, 'page-j2', lateUtc, null)
      await insertView(db, 'page-j3', '2026-01-01T00:00:00.000Z', 'u2')
      const first = await listFeedEvents(db, {
        user: feedUser,
        timeZone: jst,
        slice: 'all',
        targetRows: 1,
        maxRawEvents: 2,
      })
      expect(first.nextCursor?.timeZone).toBe(jst)
      const second = await listFeedEvents(db, {
        user: feedUser,
        timeZone: 'UTC',
        slice: 'all',
        cursor: first.nextCursor!,
        targetRows: 10,
        maxRawEvents: 10,
      })
      const jstRow = second.rows.find((row) => row.dayKey === localDay)
      expect(jstRow).toMatchObject({
        viewUniqueCount: 1,
        anonymousViewCount: 1,
      })
    })

    test('negative control: UTC midnight window excludes early-JST same-local-day event', () => {
      const { start, end } = timezoneDayUtcRange(localDay, jst)
      const utcDayStart = `${localDay}T00:00:00.000Z`
      const utcDayEnd = '2026-07-31T00:00:00.000Z'
      expect(earlyUtc >= start && earlyUtc < end).toBe(true)
      expect(earlyUtc >= utcDayStart && earlyUtc < utcDayEnd).toBe(false)
    })

    test('compiled owner view digest query keeps a created_at range', async () => {
      await assertCompiledRecountQuery('as "ownerId"')
    })

    test('compiled artifact view query keeps a created_at range', async () => {
      await assertCompiledRecountQuery('as "unique"', 'all')
    })

    test('compiled version query keeps a created_at range', async () => {
      await assertCompiledRecountQuery('as "versionNumber"')
    })

    test('compiled comment query keeps a created_at range', async () => {
      await assertCompiledRecountQuery('as "body"')
    })

    test('compiled artifact add query keeps a created_at range', async () => {
      await assertCompiledRecountQuery('shareables"."container_id')
    })
  })
})

describe('feed location fields', () => {
  const feedUser = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u@example.com',
    emailVerified: true,
  }

  test('rows carry containerKind and isViewerInbox per container owner', async () => {
    const { db } = await fixture()
    // 他人 u2 の inbox とプロジェクト、それぞれに workspace 可視のファイル + イベント
    await db
      .insertInto('users')
      .values({
        id: 'u2',
        email: 'u2@example.com',
        name: 'u2',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    for (const [cid, kind, owner] of [
      ['c-other', 'inbox', 'u2'],
      ['c-proj', 'project', null],
    ] as const)
      await db
        .insertInto('artifact_containers')
        .values({
          id: cid,
          workspace_id: 'w1',
          kind,
          owner_user_id: owner,
          created_by_id: 'u2',
          name: kind === 'inbox' ? '未整理' : 'Metrics',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
    await db
      .updateTable('shareables')
      .set({ visibility: 'workspace' })
      .where('id', '=', 's1')
      .execute()
    for (const [sid, cid] of [
      ['s-other', 'c-other'],
      ['s-proj', 'c-proj'],
    ] as const)
      await db
        .insertInto('shareables')
        .values({
          id: sid,
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: sid,
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          container_id: cid,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
    for (const [eid, sid, at] of [
      ['e-own', 's1', '2026-01-03T00:00:00Z'],
      ['e-other', 's-other', '2026-01-04T00:00:00Z'],
      ['e-proj', 's-proj', '2026-01-05T00:00:00Z'],
    ] as const)
      await db
        .insertInto('events')
        .values({
          id: eid,
          workspace_id: 'w1',
          type: 'artifact_created',
          shareable_id: sid,
          actor_user_id: 'u2',
          subject_id: sid,
          created_at: at,
        })
        .execute()
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'all',
      targetRows: 10,
      maxRawEvents: 100,
    })
    const byId = new Map(result.rows.map((r) => [r.shareableId, r]))
    // 自分の inbox の行だけ isViewerInbox
    expect(byId.get('s1')).toMatchObject({
      containerKind: 'inbox',
      isViewerInbox: true,
    })
    expect(byId.get('s-other')).toMatchObject({
      containerKind: 'inbox',
      isViewerInbox: false,
    })
    expect(byId.get('s-proj')).toMatchObject({
      containerKind: 'project',
      isViewerInbox: false,
      containerName: 'Metrics',
    })
  })
})

describe('project slice and ranking', () => {
  const feedUser = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u@example.com',
    emailVerified: true,
  }

  async function projectFixture() {
    const f = await fixture()
    const { db } = f
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'w1',
        user_id: 'u1',
        role: 'owner',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'proj1',
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u1',
        name: 'Project',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u2',
        email: 'u2@example.com',
        name: 'u2',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    // プロジェクト内の workspace 可視の成果物と、u2 だけの private 成果物
    for (const [id, visibility] of [
      ['p1', 'workspace'],
      ['p2', 'private'],
    ] as const) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: `Artifact ${id}`,
          artifact_kind: 'markdown_page',
          visibility,
          container_id: 'proj1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
    }
    return f
  }

  function projectEvent(values: {
    id: string
    type:
      | 'artifact_created'
      | 'version_published'
      | 'comment_posted'
      | 'artifact_viewed'
    shareableId: string
    actorUserId: string | null
    subjectId: string | null
    createdAt: string
  }) {
    return {
      id: values.id,
      workspace_id: 'w1',
      type: values.type,
      shareable_id: values.shareableId,
      actor_user_id: values.actorUserId,
      subject_id: values.subjectId,
      created_at: values.createdAt,
    }
  }

  async function insertProjectComment(
    db: Awaited<ReturnType<typeof projectFixture>>['db'],
    values: {
      eventId: string
      messageId: string
      shareableId: string
      createdAt: string
    },
  ) {
    const threadId = `thread-${values.messageId}`
    await db
      .insertInto('comment_threads')
      .values({
        id: threadId,
        shareable_id: values.shareableId,
        status: 'open',
        created_by_id: 'u2',
        resolved_by_id: null,
        resolved_at: null,
        created_at: values.createdAt,
        updated_at: values.createdAt,
      })
      .execute()
    await db
      .insertInto('comment_messages')
      .values({
        id: values.messageId,
        thread_id: threadId,
        body: `body ${values.messageId}`,
        agent: null,
        created_by_id: 'u2',
        created_at: values.createdAt,
        updated_at: values.createdAt,
      })
      .execute()
    await db
      .insertInto('events')
      .values(
        projectEvent({
          id: values.eventId,
          type: 'comment_posted',
          shareableId: values.shareableId,
          actorUserId: 'u2',
          subjectId: values.messageId,
          createdAt: values.createdAt,
        }),
      )
      .execute()
  }

  test('project slice returns only events for the container and hides invisible shareables', async () => {
    const { db } = await projectFixture()
    // container 外 (c1 の s1) のイベントは出ない。private (p2) は u1 に見えない。
    await db
      .insertInto('events')
      .values([
        projectEvent({
          id: 'e-in',
          type: 'artifact_viewed',
          shareableId: 'p1',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T10:00:00Z',
        }),
        projectEvent({
          id: 'e-priv',
          type: 'artifact_viewed',
          shareableId: 'p2',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T11:00:00Z',
        }),
        projectEvent({
          id: 'e-out',
          type: 'artifact_viewed',
          shareableId: 's1',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T12:00:00Z',
        }),
      ])
      .execute()
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'project',
      containerId: 'proj1',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows.map((r) => r.shareableId)).toEqual(['p1'])
  })

  test('project slice aggregates same-day comments by one actor into a single row', async () => {
    const { db } = await projectFixture()
    await insertProjectComment(db, {
      eventId: 'ec1',
      messageId: 'm1',
      shareableId: 'p1',
      createdAt: '2026-07-01T10:00:00Z',
    })
    await insertProjectComment(db, {
      eventId: 'ec2',
      messageId: 'm2',
      shareableId: 'p1',
      createdAt: '2026-07-01T11:00:00Z',
    })
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'project',
      containerId: 'proj1',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.commentCount).toBe(2)
  })

  test('same-day views on two files stay as two aggregate rows in project slice', async () => {
    const { db } = await projectFixture()
    await db
      .insertInto('shareables')
      .values({
        id: 'p3',
        workspace_id: 'w1',
        owner_user_id: 'u2',
        name: 'Artifact p3',
        artifact_kind: 'markdown_page',
        visibility: 'workspace',
        container_id: 'proj1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('events')
      .values([
        projectEvent({
          id: 'va1',
          type: 'artifact_viewed',
          shareableId: 'p1',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T10:00:00Z',
        }),
        projectEvent({
          id: 'va2',
          type: 'artifact_viewed',
          shareableId: 'p3',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T11:00:00Z',
        }),
      ])
      .execute()
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'project',
      containerId: 'proj1',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows.map((r) => r.shareableId).sort()).toEqual(['p1', 'p3'])
  })

  test('shared external viewer sees project-visibility rows only', async () => {
    const { db } = await projectFixture()
    await db
      .insertInto('workspaces')
      .values({
        id: 'w2',
        name: 'Other',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u9',
        email: 'guest@partner.example.com',
        name: 'guest',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w2',
        locale: null,
      })
      .execute()
    // p1 を project 可視へ、p2 は private のまま
    await db
      .updateTable('shareables')
      .set({ visibility: 'project' })
      .where('id', '=', 'p1')
      .execute()
    await db
      .insertInto('events')
      .values([
        projectEvent({
          id: 'g1',
          type: 'artifact_viewed',
          shareableId: 'p1',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T10:00:00Z',
        }),
        projectEvent({
          id: 'g2',
          type: 'artifact_viewed',
          shareableId: 'p2',
          actorUserId: 'u2',
          subjectId: null,
          createdAt: '2026-07-01T11:00:00Z',
        }),
      ])
      .execute()
    const guest = {
      id: 'u9',
      workspaceId: 'w2',
      email: 'guest@partner.example.com',
      emailVerified: true,
    }
    const result = await listFeedEvents(db, {
      user: guest,
      timeZone: 'UTC',
      slice: 'project',
      containerId: 'proj1',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows.map((r) => r.shareableId)).toEqual(['p1'])
  })

  test('ranking counts a 30-day window, caps at five rows, and returns empty without views', async () => {
    const { db } = await projectFixture()
    const now = '2026-07-31T15:00:00Z'
    expect(
      await listProjectViewRanking(db, {
        containerId: 'proj1',
        now,
        user: feedUser,
      }),
    ).toEqual([])
    // 6 個の shareable に閲覧を積む (p1 と新規 5 個)。r5 は 31 日前で窓の外。
    const ids = ['p1']
    for (let i = 0; i < 5; i++) {
      const id = `r${i}`
      ids.push(id)
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: `Artifact ${id}`,
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          container_id: 'proj1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
    }
    let seq = 0
    for (const [idx, id] of ids.entries()) {
      // id ごとに件数を変えて順位を作る (p1=7, r0=6, ..., r4=2)
      for (let n = 0; n < 7 - idx; n++) {
        await db
          .insertInto('events')
          .values(
            projectEvent({
              id: `ev${seq++}`,
              type: 'artifact_viewed',
              shareableId: id,
              actorUserId: null,
              subjectId: null,
              createdAt: '2026-07-15T00:00:00Z',
            }),
          )
          .execute()
      }
    }
    // 閾値と同じ日付で閾値より前 (07-01T09 < 07-01T15) の閲覧。書式ずれで
    // 窓が広がる実装ならこの 10 件が数に入り r4 が 1 位になる
    for (let n = 0; n < 10; n++) {
      await db
        .insertInto('events')
        .values(
          projectEvent({
            id: `ev-old${n}`,
            type: 'artifact_viewed',
            shareableId: 'r4',
            actorUserId: null,
            subjectId: null,
            createdAt: '2026-07-01T09:00:00Z',
          }),
        )
        .execute()
    }
    const rows = await listProjectViewRanking(db, {
      containerId: 'proj1',
      now,
      user: feedUser,
    })
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r.shareableId)).toEqual([
      'p1',
      'r0',
      'r1',
      'r2',
      'r3',
    ])
    expect(rows[0]?.viewCount).toBe(7)
  })
})

describe('mine participation feed', () => {
  const feedUser = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    emailVerified: true,
  }

  async function participationFixture() {
    const f = await fixture()
    const { db } = f
    await db
      .insertInto('users')
      .values({
        id: 'u2',
        email: 'u2@example.com',
        name: 'u2',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    for (const id of ['proj-joined', 'proj-other']) {
      await db
        .insertInto('artifact_containers')
        .values({
          id,
          workspace_id: 'w1',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u2',
          name: `Project ${id}`,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
        .execute()
    }
    await db
      .insertInto('project_members')
      .values({
        container_id: 'proj-joined',
        user_id: 'u1',
        joined_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    async function addFile(
      id: string,
      container: string,
      actor: string,
      at: string,
    ) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: actor,
          name: `Artifact ${id}`,
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          container_id: container,
          created_at: at,
          updated_at: at,
        })
        .execute()
      await db
        .insertInto('versions')
        .values({
          id: `v-${id}`,
          shareable_id: id,
          artifact_kind: 'markdown_page',
          status: 'published',
          entrypoint_path: '/index.md',
          r2_key: id,
          size_bytes: 1,
          sha256: id,
          created_by_id: actor,
          created_at: at,
          published_at: at,
        })
        .execute()
      await db
        .insertInto('events')
        .values({
          id: `e-${id}`,
          workspace_id: 'w1',
          type: 'artifact_created',
          shareable_id: id,
          actor_user_id: actor,
          subject_id: `v-${id}`,
          created_at: at,
        })
        .execute()
    }
    return { ...f, addFile }
  }

  test('joined-project additions flow into mine, unjoined and own do not', async () => {
    const { db, addFile } = await participationFixture()
    await addFile('a1', 'proj-joined', 'u2', '2026-07-01T10:00:00Z')
    await addFile('a2', 'proj-other', 'u2', '2026-07-01T11:00:00Z')
    await addFile('a3', 'proj-joined', 'u1', '2026-07-01T12:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows.map((r) => r.shareableId)).toEqual(['a1'])
    expect(result.rows[0]?.addCount ?? null).toBeNull()
  })

  test('same-day additions by one actor bundle into a single fully-counted row', async () => {
    const { db, addFile } = await participationFixture()
    await addFile('b1', 'proj-joined', 'u2', '2026-07-01T10:00:00Z')
    await addFile('b2', 'proj-joined', 'u2', '2026-07-01T11:00:00Z')
    await addFile('b3', 'proj-joined', 'u2', '2026-07-01T12:00:00Z')
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.addCount).toBe(3)
    expect(result.rows[0]?.containerId).toBe('proj-joined')
  })

  test('cursor consumes bundled raw events across pages without duplicates', async () => {
    const { db, addFile } = await participationFixture()
    await addFile('c1', 'proj-joined', 'u2', '2026-07-01T10:00:00Z')
    await addFile('c2', 'proj-joined', 'u2', '2026-07-01T11:00:00Z')
    await addFile('c3', 'proj-joined', 'u2', '2026-07-01T12:00:00Z')
    const page1 = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 1,
      maxRawEvents: 100,
    })
    expect(page1.rows).toHaveLength(1)
    expect(page1.rows[0]?.addCount).toBe(3)
    if (page1.hasMore && page1.nextCursor) {
      const page2 = await listFeedEvents(db, {
        user: feedUser,
        timeZone: 'UTC',
        slice: 'mine',
        cursor: page1.nextCursor,
        targetRows: 10,
        maxRawEvents: 100,
      })
      const merged = mergeFeedRows([page1.rows, page2.rows])
      expect(merged).toHaveLength(1)
      expect(merged[0]?.addCount).toBe(3)
    }
  })

  test('maxRawEvents cap returns a short page with hasMore', async () => {
    const { db, addFile } = await participationFixture()
    for (let i = 0; i < 5; i++) {
      await addFile(`m${i}`, 'proj-joined', 'u2', `2026-07-0${i + 1}T10:00:00Z`)
    }
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 2,
    })
    expect(result.rows.length).toBeLessThanOrEqual(2)
    expect(result.hasMore).toBe(true)
  })

  test('cross-workspace joined project flows with shared visibility only', async () => {
    const { db, addFile } = await participationFixture()
    await db
      .insertInto('workspaces')
      .values({
        id: 'w2',
        name: 'Other',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u9',
        email: 'owner@partner.example.com',
        name: 'owner',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w2',
        locale: null,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'proj-remote',
        workspace_id: 'w2',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u9',
        name: 'Remote project',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('project_members')
      .values({
        container_id: 'proj-remote',
        user_id: 'u1',
        joined_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    for (const [id, visibility] of [
      ['r-vis', 'project'],
      ['r-hidden', 'workspace'],
    ] as const) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w2',
          owner_user_id: 'u9',
          name: `Artifact ${id}`,
          artifact_kind: 'markdown_page',
          visibility,
          container_id: 'proj-remote',
          created_at: '2026-07-01T10:00:00Z',
          updated_at: '2026-07-01T10:00:00Z',
        })
        .execute()
      await db
        .insertInto('versions')
        .values({
          id: `v-${id}`,
          shareable_id: id,
          artifact_kind: 'markdown_page',
          status: 'published',
          entrypoint_path: '/index.md',
          r2_key: id,
          size_bytes: 1,
          sha256: id,
          created_by_id: 'u9',
          created_at: '2026-07-01T10:00:00Z',
          published_at: '2026-07-01T10:00:00Z',
        })
        .execute()
      await db
        .insertInto('events')
        .values({
          id: `e-${id}`,
          workspace_id: 'w2',
          type: 'artifact_created',
          shareable_id: id,
          actor_user_id: 'u9',
          subject_id: `v-${id}`,
          created_at:
            id === 'r-vis' ? '2026-07-02T10:00:00Z' : '2026-07-03T10:00:00Z',
        })
        .execute()
    }
    const result = await listFeedEvents(db, {
      user: feedUser,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 10,
      maxRawEvents: 100,
    })
    expect(result.rows.map((r) => r.shareableId)).toEqual(['r-vis'])
  })
})

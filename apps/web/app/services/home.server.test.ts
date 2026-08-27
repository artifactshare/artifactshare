import type { Kysely } from 'kysely'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'
import { loadCommentThreads, type CommentAccess } from './comments.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  buildHomeView,
  compileRecentArtifactsLimitedQuery,
  compileRecentArtifactsCountQuery,
  countRecentArtifacts,
  listMyArtifacts,
  listMyProjects,
  listUnopenedOwnedArtifactsLimited,
  listRecentArtifactsLimited,
  listRecentArtifactsPage,
  recentHistoryCardinality,
} from './home.server'

const TS = '2026-06-14T00:00:00.000Z'

describe('listMyArtifacts', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns own inbox and project files, not others files, ordered by updated_at desc', async () => {
    const rows = await listMyArtifacts(db, 'u1', 'ws-a')

    expect(rows.rows.map((r) => r.id)).toEqual([
      's-inbox-newer',
      's-project-recent',
      's-inbox-older',
    ])
    expect(rows.rows).not.toContainEqual(
      expect.objectContaining({ id: 's-other-inbox' }),
    )
    expect(rows.rows).not.toContainEqual(
      expect.objectContaining({ id: 's-other-project' }),
    )
  })

  test('includes project_name and project_kind on each row', async () => {
    const rows = await listMyArtifacts(db, 'u1', 'ws-a')
    const inboxRow = rows.rows.find((r) => r.id === 's-inbox-newer')
    const projectRow = rows.rows.find((r) => r.id === 's-project-recent')

    expect(inboxRow?.project_id).toBe('inbox-u1')
    expect(inboxRow?.project_name).toBe('未整理')
    expect(inboxRow?.project_kind).toBe('inbox')

    expect(projectRow?.project_id).toBe('project-u1')
    expect(projectRow?.project_name).toBe('My Project')
    expect(projectRow?.project_kind).toBe('project')
  })
})

describe('listUnopenedOwnedArtifactsLimited', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
    await publishShareables(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns only current users published files without their recency row', async () => {
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's-inbox-older',
        viewer_user_id: 'u1',
        first_viewed_at: TS,
        last_viewed_at: TS,
      })
      .execute()
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: TS })
      .where('id', '=', 'project-u1')
      .execute()

    const result = await listUnopenedOwnedArtifactsLimited(db, 'u1', 'ws-a')

    expect(result.rows.map((row) => row.id)).toEqual(['s-inbox-newer'])
    expect(result.hasMore).toBe(false)
  })

  test('orders by creation time, limits rows, and reports hidden results', async () => {
    await db
      .insertInto('shareables')
      .values(
        Array.from({ length: 6 }, (_, index) => ({
          ...shareable({
            id: `s-unopened-${index}`,
            ownerUserId: 'u1',
            containerId: 'inbox-u1',
            updatedAt: `2026-06-${20 + index}T00:00:00.000Z`,
          }),
          created_at: `2026-06-${20 + index}T00:00:00.000Z`,
        })),
      )
      .execute()
    await publishShareables(
      db,
      Array.from({ length: 6 }, (_, index) => `s-unopened-${index}`),
    )

    const result = await listUnopenedOwnedArtifactsLimited(db, 'u1', 'ws-a')

    expect(result.rows.map((row) => row.id)).toEqual([
      's-unopened-5',
      's-unopened-4',
      's-unopened-3',
      's-unopened-2',
      's-unopened-1',
    ])
    expect(result.hasMore).toBe(true)
  })

  test('does not change when another user has viewed the file', async () => {
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's-inbox-newer',
        viewer_user_id: 'u2',
        first_viewed_at: TS,
        last_viewed_at: TS,
      })
      .execute()

    const result = await listUnopenedOwnedArtifactsLimited(db, 'u1', 'ws-a')

    expect(result.rows.map((row) => row.id)).toContain('s-inbox-newer')
  })

  test('excludes ownership transfers created by another user', async () => {
    await db
      .updateTable('versions')
      .set({ created_by_id: 'u2' })
      .where('shareable_id', '=', 's-inbox-newer')
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'v-transferred-current',
        shareable_id: 's-inbox-newer',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'test/s-inbox-newer/current',
        size_bytes: 1,
        sha256: 'sha-s-inbox-newer-current',
        created_by_id: 'u1',
        created_at: '2026-06-16T00:00:00.000Z',
        published_at: '2026-06-16T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ current_version_id: 'v-transferred-current' })
      .where('id', '=', 's-inbox-newer')
      .execute()

    const result = await listUnopenedOwnedArtifactsLimited(db, 'u1', 'ws-a')

    expect(result.rows.map((row) => row.id)).not.toContain('s-inbox-newer')
  })

  test('excludes published artifact kinds without a working viewer', async () => {
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'workspace_app' })
      .where('id', '=', 's-inbox-newer')
      .execute()

    const result = await listUnopenedOwnedArtifactsLimited(db, 'u1', 'ws-a')

    expect(result.rows.map((row) => row.id)).not.toContain('s-inbox-newer')
  })
})

describe('buildHomeView', () => {
  const file = (
    id: string,
    projectId: string | null,
    modifiedTime: string,
  ) => ({
    id,
    fileName: id,
    derivedTitle: null,
    titleOverride: null,
    renderType: 'html' as const,
    ownerEmail: 'owner@example.com',
    ownerId: 'u1',
    ownerName: 'Owner',
    ownerImage: null,
    ownerInitial: 'O',
    ownerIsExternal: false,
    modifiedTime,
    registeredByMe: true,
    visibility: 'private' as const,
    viewCount: 0,
    commentCount: 0,
    projectId,
    projectName: projectId ? 'Project' : null,
  })

  const project = (id: string, name = id) => ({ id, name })

  test('block fileCount, fileUpdatedAt, and recentFiles come from own files', () => {
    const files = [
      file('p1-a', 'proj-1', '2026-06-15T00:00:00.000Z'),
      file('p1-b', 'proj-1', '2026-06-14T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [project('proj-1', 'Project One')])

    const block = view.projectBlocks[0]
    expect(block.fileCount).toBe(2)
    expect(block.fileUpdatedAt).toBe('2026-06-15T00:00:00.000Z')
    expect(block.recentFiles.map((f) => f.id)).toEqual(['p1-a', 'p1-b'])
  })

  test('puts project files in recentFiles and slices by perProjectLimit', () => {
    const files = [
      file('p1-a', 'proj-1', '2026-06-15T00:00:00.000Z'),
      file('p1-b', 'proj-1', '2026-06-14T00:00:00.000Z'),
      file('p1-c', 'proj-1', '2026-06-13T00:00:00.000Z'),
      file('p1-d', 'proj-1', '2026-06-12T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [project('proj-1')], 3)

    expect(view.projectBlocks[0].recentFiles.map((f) => f.id)).toEqual([
      'p1-a',
      'p1-b',
      'p1-c',
    ])
  })

  test('adds inbox block at the end when inbox files exist', () => {
    const files = [
      file('inbox-new', null, '2026-06-15T00:00:00.000Z'),
      file('proj-file', 'proj-1', '2026-06-14T00:00:00.000Z'),
      file('inbox-old', null, '2026-06-13T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [project('proj-1')])

    expect(view.projectBlocks.map((b) => b.kind)).toEqual(['project', 'inbox'])
    const inbox = view.projectBlocks[1]
    expect(inbox.fileCount).toBe(2)
    expect(inbox.recentFiles.map((f) => f.id)).toEqual([
      'inbox-new',
      'inbox-old',
    ])
    expect(inbox.fileUpdatedAt).toBe('2026-06-15T00:00:00.000Z')
  })

  test('omits inbox block when there are no inbox files', () => {
    const files = [file('proj-file', 'proj-1', '2026-06-14T00:00:00.000Z')]
    const view = buildHomeView(files, [project('proj-1')])

    expect(view.projectBlocks.every((b) => b.kind === 'project')).toBe(true)
  })

  test('omits project block when the user has no files in that project', () => {
    const files = [file('inbox-only', null, '2026-06-14T00:00:00.000Z')]
    const view = buildHomeView(files, [project('empty-proj')])

    expect(view.projectBlocks.map((b) => b.kind)).toEqual(['inbox'])
  })

  test('files in projects the user did not create appear in recent only', () => {
    const files = [
      file('other-proj-file', 'other-proj', '2026-06-15T00:00:00.000Z'),
      file('my-proj-file', 'my-proj', '2026-06-14T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [project('my-proj', 'My Project')])

    expect(view.recent.map((f) => f.id)).toEqual([
      'other-proj-file',
      'my-proj-file',
    ])
    expect(view.projectBlocks).toHaveLength(1)
    expect(view.projectBlocks[0].id).toBe('my-proj')
    expect(view.projectBlocks[0].recentFiles.map((f) => f.id)).toEqual([
      'my-proj-file',
    ])
  })

  test('sorts project blocks by latest file activity desc', () => {
    const files = [
      file('old-proj', 'proj-old', '2026-06-12T00:00:00.000Z'),
      file('new-proj', 'proj-new', '2026-06-15T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [
      project('proj-old'),
      project('proj-new'),
    ])

    expect(view.projectBlocks.map((b) => b.id)).toEqual([
      'proj-new',
      'proj-old',
    ])
  })

  test('preserves input order in recent', () => {
    const files = [
      file('a', null, '2026-06-15T00:00:00.000Z'),
      file('b', 'proj-1', '2026-06-14T00:00:00.000Z'),
      file('c', null, '2026-06-13T00:00:00.000Z'),
    ]
    const view = buildHomeView(files, [])

    expect(view.recent.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('listMyProjects', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns only unarchived projects created by the user', async () => {
    const rows = await listMyProjects(db, 'u1', 'ws-a')

    expect(rows).toEqual([{ id: 'project-u1', name: 'My Project' }])
    expect(rows.map((p) => p.id)).not.toContain('project-u2')
  })

  test('excludes archived projects', async () => {
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-06-16T00:00:00.000Z' })
      .where('id', '=', 'project-u1')
      .execute()

    const rows = await listMyProjects(db, 'u1', 'ws-a')
    expect(rows).toEqual([])
  })

  test('orders by container updated_at desc', async () => {
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-u1-older',
        workspace_id: 'ws-a',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u1',
        name: 'Older Project',
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
      })
      .execute()

    const rows = await listMyProjects(db, 'u1', 'ws-a')

    expect(rows.map((p) => p.id)).toEqual(['project-u1', 'project-u1-older'])
  })
})

describe('listRecentArtifactsLimited unread counts', () => {
  let db: Kysely<DB>
  let sqlite: DatabaseSync

  beforeEach(async () => {
    ;({ db, sqlite } = createMigratedInMemoryDb())
    await seedUnreadFixture(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const viewer = {
    id: 'u-viewer',
    workspaceId: 'ws-a',
    email: 'viewer@example.com',
    emailVerified: true,
    hd: 'example.com',
  }

  test('counts published versions after last_viewed_at as unread', async () => {
    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(1)
  })

  test('returns zero unread versions when all published versions are older', async () => {
    await db
      .updateTable('shareable_viewer_recency')
      .set({
        version_seen_through_at: '2026-06-20T00:00:00.000Z',
        comment_seen_through_at: '2026-06-20T00:00:00.000Z',
      })
      .where('shareable_id', '=', 's-unread')
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(0)
  })

  test('does not count versions from another file as unread', async () => {
    await db
      .insertInto('shareables')
      .values({
        id: 's-other',
        workspace_id: 'ws-a',
        owner_user_id: 'u-owner',
        slug: null,
        name: 'other.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'workspace',
        current_version_id: null,
        container_id: 'inbox-owner',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'v-other-new',
        shareable_id: 's-other',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-other-new',
        size_bytes: 1,
        sha256: 'v-other-new',
        created_by_id: 'u-owner',
        created_at: '2026-06-17T00:00:00.000Z',
        published_at: '2026-06-17T00:00:00.000Z',
      })
      .execute()

    await db
      .updateTable('shareable_viewer_recency')
      .set({
        version_seen_through_at: '2026-06-16T00:00:00.000Z',
        comment_seen_through_at: '2026-06-20T00:00:00.000Z',
      })
      .where('shareable_id', '=', 's-unread')
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(0)
    expect(await countRecentArtifacts(db, viewer, { unread: true })).toBe(0)
  })

  test("does not count the viewer's versions when the seen boundary is null", async () => {
    await db
      .updateTable('shareable_viewer_recency')
      .set({
        version_seen_through_at: null,
        comment_seen_through_at: '2026-06-20T00:00:00.000Z',
      })
      .where('shareable_id', '=', 's-unread')
      .execute()
    await db
      .deleteFrom('versions')
      .where('shareable_id', '=', 's-unread')
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'v-viewer',
        shareable_id: 's-unread',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-viewer',
        size_bytes: 1,
        sha256: 'v-viewer',
        created_by_id: 'u-viewer',
        created_at: '2026-06-17T00:00:00.000Z',
        published_at: '2026-06-17T00:00:00.000Z',
      })
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(0)
    expect(await countRecentArtifacts(db, viewer, { unread: true })).toBe(0)
  })

  test('counts replies in an existing thread from other users', async () => {
    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    const summary = JSON.parse(String(row?.unread_comment_summary))
    expect(summary.count).toBe(1)
    expect(summary).toMatchObject({
      id: 'm-reply',
      body: 'reply',
      author_id: 'u-owner',
    })
  })

  test('falls back to the next visible unread comment after deleting the latest', async () => {
    await db
      .insertInto('comment_messages')
      .values({
        id: 'm-latest',
        thread_id: 'thread-1',
        body: 'latest',
        agent: null,
        created_by_id: 'u-owner',
        created_at: '2026-06-17T00:00:00.000Z',
        updated_at: '2026-06-17T00:00:00.000Z',
      })
      .execute()

    let row = (await listRecentArtifactsLimited(db, viewer, 10))[0]
    expect(JSON.parse(String(row?.unread_comment_summary))).toMatchObject({
      count: 2,
      id: 'm-latest',
    })

    await db
      .deleteFrom('comment_messages')
      .where('id', '=', 'm-latest')
      .execute()
    row = (await listRecentArtifactsLimited(db, viewer, 10))[0]
    expect(JSON.parse(String(row?.unread_comment_summary))).toMatchObject({
      count: 1,
      id: 'm-reply',
    })

    await db
      .deleteFrom('comment_messages')
      .where('id', '=', 'm-reply')
      .execute()
    row = (await listRecentArtifactsLimited(db, viewer, 10))[0]
    expect(row?.unread_comment_summary).toBeNull()
  })

  test('excludes unread comments outside the panel thread window from summary and filter', async () => {
    await db.deleteFrom('comment_messages').execute()
    await db.deleteFrom('comment_threads').execute()
    await db
      .updateTable('shareable_viewer_recency')
      .set({ version_seen_through_at: '2026-06-30T00:00:00.000Z' })
      .where('shareable_id', '=', 's-unread')
      .execute()

    const openThreads = Array.from({ length: 50 }, (_, index) => ({
      id: `window-open-${index}`,
      shareable_id: 's-unread',
      status: 'open' as const,
      created_by_id: 'u-owner',
      resolved_by_id: null,
      resolved_at: null,
      created_at: `2026-06-17T01:${String(index).padStart(2, '0')}:00.000Z`,
      updated_at: `2026-06-17T01:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const commentThreads = [
      ...openThreads,
      {
        id: 'window-resolved-hidden',
        shareable_id: 's-unread',
        status: 'resolved' as const,
        created_by_id: 'u-owner',
        resolved_by_id: 'u-owner',
        resolved_at: '2026-06-19T00:00:00.000Z',
        created_at: '2026-06-19T00:00:00.000Z',
        updated_at: '2026-06-19T00:00:00.000Z',
      },
    ]
    for (let index = 0; index < commentThreads.length; index += 10) {
      await db
        .insertInto('comment_threads')
        .values(commentThreads.slice(index, index + 10))
        .execute()
    }
    const commentMessages = [
      ...openThreads.map((thread, index) => ({
        id: `window-message-${index}`,
        thread_id: thread.id,
        body: `visible ${index}`,
        agent: null,
        created_by_id: 'u-owner',
        created_at: thread.created_at,
        updated_at: thread.created_at,
      })),
      {
        id: 'window-message-hidden',
        thread_id: 'window-resolved-hidden',
        body: 'must stay hidden',
        agent: null,
        created_by_id: 'u-owner',
        created_at: '2026-06-19T00:00:00.000Z',
        updated_at: '2026-06-19T00:00:00.000Z',
      },
    ]
    for (let index = 0; index < commentMessages.length; index += 10) {
      await db
        .insertInto('comment_messages')
        .values(commentMessages.slice(index, index + 10))
        .execute()
    }

    let row = (await listRecentArtifactsLimited(db, viewer, 10))[0]
    const summary = JSON.parse(String(row?.unread_comment_summary))
    const commentViewer: SessionUser = {
      ...viewer,
      name: 'Viewer',
      image: null,
      msTenantId: null,
      kind: 'human' as const,
      locale: null,
    }
    const access: CommentAccess = {
      shareableId: 's-unread',
      workspaceId: 'ws-a',
      ownerUserId: 'u-owner',
      visibility: 'workspace',
      linkExpiresAt: null,
      currentVersionId: null,
      artifactKind: 'html_page',
      entrypointPath: null,
      r2Key: null,
      isTeamWorkspaceAdmin: false,
    }
    const visibleMessageIds = (
      await loadCommentThreads(db, access, commentViewer)
    ).flatMap((thread) => thread.messages.map((message) => message.id))
    expect(visibleMessageIds).toHaveLength(summary.count)
    expect(visibleMessageIds).toContain(summary.id)
    expect(visibleMessageIds).not.toContain('window-message-hidden')
    expect(summary.count).toBe(50)
    expect(summary.id).toBe('window-message-49')
    expect(summary.body).not.toBe('must stay hidden')

    await db
      .updateTable('shareable_viewer_recency')
      .set({ comment_seen_through_at: '2026-06-18T00:00:00.000Z' })
      .where('shareable_id', '=', 's-unread')
      .execute()
    row = (await listRecentArtifactsLimited(db, viewer, 10))[0]
    expect(row?.unread_comment_summary).toBeNull()
    expect(await countRecentArtifacts(db, viewer, { unread: true })).toBe(0)
  })

  test('uses one unread-comment summary scan for 3 and 20 recent candidates', async () => {
    const additional = Array.from({ length: 19 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, '0')
      const id = `s-plan-${suffix}`
      return {
        candidateShareable: {
          id,
          workspace_id: 'ws-a',
          owner_user_id: 'u-owner',
          slug: null,
          name: `${id}.html`,
          derived_title: null,
          title_override: null,
          description: null,
          artifact_kind: 'html_page' as const,
          visibility: 'workspace' as const,
          current_version_id: null,
          container_id: 'inbox-owner',
          created_at: TS,
          updated_at: TS,
          last_accessed_at: null,
        },
        recency: {
          shareable_id: id,
          viewer_user_id: viewer.id,
          first_viewed_at: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          last_viewed_at: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          version_seen_through_at: TS,
          comment_seen_through_at: TS,
        },
      }
    })
    for (let index = 0; index < additional.length; index += 5) {
      const chunk = additional.slice(index, index + 5)
      await db
        .insertInto('shareables')
        .values(chunk.map(({ candidateShareable }) => candidateShareable))
        .execute()
      await db
        .insertInto('shareable_viewer_recency')
        .values(chunk.map(({ recency }) => recency))
        .execute()
    }

    for (const limit of [3, 20]) {
      const compiled = compileRecentArtifactsLimitedQuery(db, viewer, limit)
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
        .all(...(compiled.parameters as never[])) as Array<{ detail: string }>
      const commentMessageScans = plan.filter(({ detail }) =>
        /(?:SCAN|SEARCH) (?:comment_messages|cm)\b/.test(detail),
      )

      expect(await listRecentArtifactsLimited(db, viewer, limit)).toHaveLength(
        limit,
      )
      expect(commentMessageScans).toHaveLength(1)
    }
  })

  test('classifies direct sharing below ownership', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's-unread',
        granted_email: viewer.email,
        granted_at: TS,
        granted_by: 'u-owner',
      })
      .execute()
    expect(
      (await listRecentArtifactsLimited(db, viewer, 10)).find(
        (row) => row.id === 's-unread',
      )?.recent_attribute,
    ).toBe('direct-share')

    await db
      .updateTable('shareables')
      .set({ owner_user_id: viewer.id })
      .where('id', '=', 's-unread')
      .execute()
    expect(
      (await listRecentArtifactsLimited(db, viewer, 10)).find(
        (row) => row.id === 's-unread',
      )?.recent_attribute,
    ).toBe('own')
  })

  test('classifies joined projects and leaves ordinary workspace files unlabelled', async () => {
    expect(
      (await listRecentArtifactsLimited(db, viewer, 10)).find(
        (row) => row.id === 's-unread',
      )?.recent_attribute,
    ).toBeNull()

    await db
      .insertInto('artifact_containers')
      .values({
        id: 'joined-project',
        workspace_id: 'ws-a',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u-owner',
        name: 'Joined project',
        description: null,
        base_visibility: 'private',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'joined-project-default',
        project_container_id: 'joined-project',
        email: viewer.email,
        role: 'viewer',
        display_name: null,
        created_by_id: 'u-owner',
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ container_id: 'joined-project', visibility: 'project' })
      .where('id', '=', 's-unread')
      .execute()

    expect(
      (await listRecentArtifactsLimited(db, viewer, 10)).find(
        (row) => row.id === 's-unread',
      )?.recent_attribute,
    ).toBe('joined-project')
  })

  test('applies relation and unread filters after visibility and keeps max-two cardinality', async () => {
    expect(await countRecentArtifacts(db, viewer)).toBe(1)
    expect(
      await countRecentArtifacts(db, viewer, { relation: 'project' }),
    ).toBe(0)
    expect(await countRecentArtifacts(db, viewer, { unread: true })).toBe(1)
    expect(await recentHistoryCardinality(db, viewer)).toBe(1)

    await db
      .updateTable('shareables')
      .set({ owner_user_id: viewer.id })
      .where('id', '=', 's-unread')
      .execute()
    expect(await countRecentArtifacts(db, viewer, { relation: 'own' })).toBe(1)
    expect(await countRecentArtifacts(db, viewer, { relation: 'shared' })).toBe(
      0,
    )
  })

  test('count SQL uses EXISTS for unread comments without selecting comment details', () => {
    const compiled = compileRecentArtifactsCountQuery(db, viewer, {
      unread: true,
    })
    const sql = compiled.sql.toLowerCase()
    expect(sql).toContain('exists (select 1 from comment_messages')
    expect(sql).toContain('panel_threads.id asc')
    expect(sql).not.toContain("'body'")
    expect(sql).not.toContain('json_object')
    expect(sql).not.toContain('author_name')
    expect(sql).not.toContain('count(comment_messages')
  })

  test('joins a contextual workspace label for a cross-workspace project', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-cross',
        hd: 'cross.example.com',
        name: 'Cross Workspace',
        created_at: TS,
        plan: 'free',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 0,
        storage_updated_at: TS,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'cross-project',
        workspace_id: 'ws-cross',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u-owner',
        name: 'Cross Project',
        description: null,
        base_visibility: 'private',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'cross-default',
        project_container_id: 'cross-project',
        email: viewer.email,
        role: 'viewer',
        display_name: null,
        created_by_id: 'u-owner',
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 's-cross',
        workspace_id: 'ws-cross',
        owner_user_id: 'u-owner',
        slug: null,
        name: 'cross.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'project',
        current_version_id: null,
        container_id: 'cross-project',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's-cross',
        viewer_user_id: viewer.id,
        first_viewed_at: TS,
        last_viewed_at: '2026-06-17T00:00:00.000Z',
        version_seen_through_at: TS,
        comment_seen_through_at: TS,
      })
      .execute()

    const row = (await listRecentArtifactsLimited(db, viewer, 10)).find(
      (candidate) => candidate.id === 's-cross',
    )
    expect(row).toMatchObject({
      project_name: 'Cross Project',
      project_workspace_id: 'ws-cross',
      project_workspace_name: 'Cross Workspace',
    })
  })

  test('keeps restricted history by default and excludes it for active filters', async () => {
    await db
      .insertInto('shareables')
      .values({
        id: 's-inaccessible',
        workspace_id: 'ws-a',
        owner_user_id: 'u-owner',
        slug: null,
        name: 'inaccessible.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: 'inbox-owner',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's-inaccessible',
        viewer_user_id: viewer.id,
        first_viewed_at: '2026-06-21T00:00:00.000Z',
        last_viewed_at: '2026-06-21T00:00:00.000Z',
        version_seen_through_at: '2026-06-21T00:00:00.000Z',
        comment_seen_through_at: '2026-06-21T00:00:00.000Z',
      })
      .execute()

    const unfiltered = await listRecentArtifactsLimited(db, viewer, 1)
    expect(unfiltered).toMatchObject([{ id: 's-inaccessible', visible: 0 }])
    expect(await countRecentArtifacts(db, viewer)).toBe(2)
    expect(await listRecentArtifactsPage(db, viewer, 1)).toHaveLength(2)

    const filtered = await listRecentArtifactsLimited(db, viewer, 1, {
      relation: 'all',
      unread: true,
    })
    expect(filtered.map((row) => row.id)).toEqual(['s-unread'])
    expect(await countRecentArtifacts(db, viewer, { unread: true })).toBe(1)
  })

  test('does not count the viewer own comment messages', async () => {
    await db
      .insertInto('comment_messages')
      .values({
        id: 'm-self',
        thread_id: 'thread-1',
        body: 'mine',
        agent: null,
        created_by_id: 'u-viewer',
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z',
      })
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(JSON.parse(String(row?.unread_comment_summary)).count).toBe(1)
  })

  test('correlates last_viewed_at per row, not globally', async () => {
    // 2 件目は同じ published 版より後に見ているので未読 0。相関が行ごとでないと
    // 1 件目の last_viewed_at を拾って 1 になる
    await db
      .insertInto('shareables')
      .values({
        id: 's-seen',
        workspace_id: 'ws-a',
        owner_user_id: 'u-owner',
        slug: null,
        name: 'seen.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'workspace',
        current_version_id: null,
        container_id: 'inbox-owner',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 's-seen',
        viewer_user_id: 'u-viewer',
        first_viewed_at: '2026-06-20T00:00:00.000Z',
        last_viewed_at: '2026-06-20T00:00:00.000Z',
        version_seen_through_at: '2026-06-20T00:00:00.000Z',
        comment_seen_through_at: '2026-06-20T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'v-seen',
        shareable_id: 's-seen',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-seen',
        size_bytes: 1,
        sha256: 'v-seen',
        created_by_id: 'u-owner',
        created_at: '2026-06-16T00:00:00.000Z',
        published_at: '2026-06-16T00:00:00.000Z',
      })
      .execute()

    await db
      .updateTable('shareable_viewer_recency')
      .set({
        version_seen_through_at: '2026-06-15T00:00:00.000Z',
        comment_seen_through_at: '2026-06-15T00:00:00.000Z',
      })
      .where('shareable_id', '=', 's-unread')
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    expect(
      Number(rows.find((r) => r.id === 's-unread')?.unread_version_count),
    ).toBe(1)
    expect(
      Number(rows.find((r) => r.id === 's-seen')?.unread_version_count),
    ).toBe(0)
  })

  test('does not count versions published by the viewer themselves', async () => {
    await db
      .insertInto('versions')
      .values({
        id: 'v-self',
        shareable_id: 's-unread',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-self',
        size_bytes: 1,
        sha256: 'v-self',
        created_by_id: 'u-viewer',
        created_at: '2026-06-17T00:00:00.000Z',
        published_at: '2026-06-17T00:00:00.000Z',
      })
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    // 他人の v-new だけが数えられる (自分の v-self は除外)
    expect(Number(row?.unread_version_count)).toBe(1)
  })

  test('does not count unpublished versions', async () => {
    await db
      .insertInto('versions')
      .values({
        id: 'v-draft',
        shareable_id: 's-unread',
        artifact_kind: 'html_page',
        status: 'uploading',
        entrypoint_path: '/index.html',
        r2_key: 'v-draft',
        size_bytes: 1,
        sha256: 'v-draft',
        created_by_id: 'u-owner',
        created_at: '2026-06-17T00:00:00.000Z',
        published_at: null,
      })
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(1)
  })

  test('clears unread counts when last_viewed_at advances past activity', async () => {
    await db
      .updateTable('shareable_viewer_recency')
      .set({
        version_seen_through_at: '2026-06-20T00:00:00.000Z',
        comment_seen_through_at: '2026-06-20T00:00:00.000Z',
      })
      .where('shareable_id', '=', 's-unread')
      .execute()

    const rows = await listRecentArtifactsLimited(db, viewer, 10)
    const row = rows.find((r) => r.id === 's-unread')
    expect(Number(row?.unread_version_count)).toBe(0)
    expect(row?.unread_comment_summary).toBeNull()
  })
})

async function seedUnreadFixture(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Example',
      created_at: TS,
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: TS,
    })
    .execute()

  await db
    .insertInto('users')
    .values([
      {
        id: 'u-viewer',
        email: 'viewer@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
      {
        id: 'u-owner',
        email: 'owner@example.com',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
    ])
    .execute()

  await db
    .insertInto('artifact_containers')
    .values({
      id: 'inbox-owner',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'u-owner',
      created_by_id: 'u-owner',
      name: '未整理',
      description: null,
      base_visibility: 'workspace',
      archived_at: null,
      created_at: TS,
      updated_at: TS,
    })
    .execute()

  await db
    .insertInto('shareables')
    .values({
      id: 's-unread',
      workspace_id: 'ws-a',
      owner_user_id: 'u-owner',
      slug: null,
      name: 'unread.html',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'workspace',
      current_version_id: null,
      container_id: 'inbox-owner',
      created_at: TS,
      updated_at: TS,
      last_accessed_at: null,
    })
    .execute()

  await db
    .insertInto('shareable_viewer_recency')
    .values({
      shareable_id: 's-unread',
      viewer_user_id: 'u-viewer',
      first_viewed_at: '2026-06-14T00:00:00.000Z',
      last_viewed_at: '2026-06-15T00:00:00.000Z',
      version_seen_through_at: '2026-06-15T00:00:00.000Z',
      comment_seen_through_at: '2026-06-15T00:00:00.000Z',
    })
    .execute()

  await db
    .insertInto('versions')
    .values([
      {
        id: 'v-old',
        shareable_id: 's-unread',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-old',
        size_bytes: 1,
        sha256: 'v-old',
        created_by_id: 'u-owner',
        created_at: '2026-06-10T00:00:00.000Z',
        published_at: '2026-06-10T00:00:00.000Z',
      },
      {
        id: 'v-new',
        shareable_id: 's-unread',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'v-new',
        size_bytes: 1,
        sha256: 'v-new',
        created_by_id: 'u-owner',
        created_at: '2026-06-16T00:00:00.000Z',
        published_at: '2026-06-16T00:00:00.000Z',
      },
    ])
    .execute()

  await db
    .insertInto('comment_threads')
    .values({
      id: 'thread-1',
      shareable_id: 's-unread',
      status: 'open',
      created_by_id: 'u-owner',
      resolved_by_id: null,
      resolved_at: null,
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
    })
    .execute()

  await db
    .insertInto('comment_messages')
    .values([
      {
        id: 'm-old',
        thread_id: 'thread-1',
        body: 'old',
        agent: null,
        created_by_id: 'u-owner',
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:00:00.000Z',
      },
      {
        id: 'm-reply',
        thread_id: 'thread-1',
        body: 'reply',
        agent: null,
        created_by_id: 'u-owner',
        created_at: '2026-06-16T00:00:00.000Z',
        updated_at: '2026-06-16T00:00:00.000Z',
      },
    ])
    .execute()
}

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Example',
      created_at: TS,
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: TS,
    })
    .execute()

  await db
    .insertInto('users')
    .values([
      {
        id: 'u1',
        email: 'owner@example.com',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
      {
        id: 'u2',
        email: 'other@example.com',
        email_verified: 1,
        name: 'Other',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
    ])
    .execute()

  await db
    .insertInto('artifact_containers')
    .values([
      {
        id: 'inbox-u1',
        workspace_id: 'ws-a',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: '未整理',
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      },
      {
        id: 'inbox-u2',
        workspace_id: 'ws-a',
        kind: 'inbox',
        owner_user_id: 'u2',
        created_by_id: 'u2',
        name: '未整理',
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      },
      {
        id: 'project-u1',
        workspace_id: 'ws-a',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u1',
        name: 'My Project',
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: TS,
      },
      {
        id: 'project-u2',
        workspace_id: 'ws-a',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u2',
        name: 'Other Project',
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      },
    ])
    .execute()

  await db
    .insertInto('shareables')
    .values([
      shareable({
        id: 's-inbox-older',
        ownerUserId: 'u1',
        containerId: 'inbox-u1',
        updatedAt: '2026-06-13T00:00:00.000Z',
      }),
      shareable({
        id: 's-inbox-newer',
        ownerUserId: 'u1',
        containerId: 'inbox-u1',
        updatedAt: '2026-06-15T00:00:00.000Z',
      }),
      shareable({
        id: 's-project-recent',
        ownerUserId: 'u1',
        containerId: 'project-u1',
        updatedAt: '2026-06-14T00:00:00.000Z',
      }),
      shareable({
        id: 's-other-inbox',
        ownerUserId: 'u2',
        containerId: 'inbox-u2',
        updatedAt: '2026-06-16T00:00:00.000Z',
      }),
      shareable({
        id: 's-other-project',
        ownerUserId: 'u2',
        containerId: 'project-u2',
        updatedAt: '2026-06-16T00:00:00.000Z',
      }),
    ])
    .execute()
}

async function publishShareables(db: Kysely<DB>, ids?: string[]) {
  let query = db
    .selectFrom('shareables')
    .select(['id', 'owner_user_id', 'artifact_kind', 'created_at'])

  if (ids) query = query.where('id', 'in', ids)

  const rows = await query.execute()
  if (rows.length === 0) return

  await db
    .insertInto('versions')
    .values(
      rows.map((row) => ({
        id: `v-${row.id}`,
        shareable_id: row.id,
        artifact_kind: row.artifact_kind,
        status: 'published' as const,
        entrypoint_path: '/index.html',
        r2_key: `test/${row.id}`,
        size_bytes: 1,
        sha256: `sha-${row.id}`,
        created_by_id: row.owner_user_id,
        created_at: row.created_at,
        published_at: row.created_at,
      })),
    )
    .execute()

  for (const row of rows) {
    await db
      .updateTable('shareables')
      .set({ current_version_id: `v-${row.id}` })
      .where('id', '=', row.id)
      .execute()
  }
}

function shareable(input: {
  id: string
  ownerUserId: string
  containerId: string
  updatedAt: string
}) {
  return {
    id: input.id,
    workspace_id: 'ws-a',
    owner_user_id: input.ownerUserId,
    slug: null,
    name: input.id,
    derived_title: null,
    title_override: null,
    description: null,
    artifact_kind: 'html_page' as const,
    visibility: 'private' as const,
    current_version_id: null,
    container_id: input.containerId,
    created_at: TS,
    updated_at: input.updatedAt,
    last_accessed_at: null,
  }
}

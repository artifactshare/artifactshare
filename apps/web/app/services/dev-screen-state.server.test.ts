import { vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import type { Kysely } from 'kysely'
import { afterEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  devShareableId,
  ensureDevScreenState,
  isDevScreenStateRequest,
  isScreenScenario,
  seedDevScreenArtifactBodies,
  seedDevScreenState,
} from './dev-screen-state.server'
import {
  listJoinedProjectsForDropdown,
  listProjectsForIndex,
} from './project-membership.server'
import { listSharedProjects } from './projects.server'
import { listRecentArtifactsLimited } from './home.server'
import { listWorkspaceBots } from './bot-members.server'
import { loadViewerRevisitContext } from './viewer-revisit.server'

describe('dev screen state requests', () => {
  test('accepts only allowlisted scenarios', () => {
    expect(isScreenScenario('settings-billing/subscribed')).toBe(true)
    expect(isScreenScenario('unknown/scenario')).toBe(false)
  })

  test('matches the requested scenario header exactly', () => {
    const request = new Request('https://example.com/settings/billing', {
      headers: {
        'X-ArtifactShare-Dev-Screen-State': 'settings-billing/subscribed',
      },
    })

    expect(
      isDevScreenStateRequest(request, 'settings-billing/subscribed'),
    ).toBe(true)
    expect(
      isDevScreenStateRequest(request, 'settings-tokens/created-secret'),
    ).toBe(false)
  })
})

describe('viewer revisit-context dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test('seeds an ordinal version clue and two new messages', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-08-17T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'viewer/revisit-context',
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'viewer@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'viewer/revisit-context',
      workspaceId,
      userId,
      now,
    )
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)

    await expect(
      loadViewerRevisitContext(db, {
        shareableId,
        viewerUserId: userId,
        currentVersionId: `${shareableId}-v2`,
        versions: [
          { id: `${shareableId}-v2`, ordinal: 2 },
          { id: `${shareableId}-v1`, ordinal: 1 },
        ],
      }),
    ).resolves.toEqual({
      entryCurrentVersionId: `${shareableId}-v2`,
      version: { kind: 'ordinal', from: 1, to: 2 },
      commentCount: 2,
    })
  })
})

describe('recent content-rich dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test('stores viewer bodies only for the successful task artifacts', async () => {
    const put = vi.fn().mockResolvedValue(undefined)

    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'recent/content-rich',
      'workspace',
      'viewer',
    )

    expect(put.mock.calls.map(([key]) => key)).toEqual([
      `dev-screen/${devShareableId('workspace-viewer-file-1')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-21')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-21')}-v2`,
    ])
    expect(put.mock.calls[2][1]).toContain('今回の更新')
    expect(put.mock.calls[2][2]).toEqual({
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    put.mockClear()
    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'home/content-rich',
      'workspace',
      'viewer',
    )
    expect(put).not.toHaveBeenCalled()

    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'home/unopened-file',
      'workspace',
      'viewer',
    )
    expect(put.mock.calls.map(([key]) => key)).toEqual([
      `dev-screen/${devShareableId('workspace-viewer-file-1')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-6')}-v1`,
    ])
  })

  test('leaves one current owned file without the owners recency row', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'home/unopened-file',
      now,
      'free',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    await seedDevScreenState(db, 'home/unopened-file', workspaceId, userId, now)

    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    const shareable = await db
      .selectFrom('shareables')
      .select(['owner_user_id', 'current_version_id'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .select('shareable_id')
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirst()

    expect(shareable).toEqual({
      owner_user_id: userId,
      current_version_id: `${shareableId}-v1`,
    })
    expect(recency).toBeUndefined()
  })

  test('distinguishes a working two-version artifact from missing body and source states', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const shareableIds = [19, 20, 21].map((number) =>
      devShareableId(`${workspaceId}-${userId}-file-${number}`),
    )
    const shareables = await db
      .selectFrom('shareables')
      .select(['id', 'current_version_id'])
      .where('id', 'in', shareableIds)
      .orderBy('id')
      .execute()
    const versions = await db
      .selectFrom('versions')
      .select(['id', 'shareable_id', 'published_at'])
      .where('shareable_id', 'in', shareableIds)
      .orderBy('id')
      .execute()

    expect(shareables).toEqual([
      { id: shareableIds[0], current_version_id: null },
      { id: shareableIds[1], current_version_id: `${shareableIds[1]}-v1` },
      { id: shareableIds[2], current_version_id: `${shareableIds[2]}-v2` },
    ])
    expect(versions.map(({ id }) => id)).toEqual([
      `${shareableIds[1]}-v1`,
      `${shareableIds[2]}-v1`,
      `${shareableIds[2]}-v2`,
    ])
    expect(versions.at(-1)?.published_at).toBe('2026-07-31T11:30:00.000Z')
  })

  test('seeds unread comments and resets recency and comment data on reseed', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`

    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    const version = await db
      .selectFrom('versions')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const shareable = await db
      .selectFrom('shareables')
      .select(['current_version_id'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    expect(version).toMatchObject({
      id: `${shareableId}-v1`,
      status: 'published',
      entrypoint_path: '/index.html',
      r2_key: `dev-screen/${shareableId}-v1`,
      sha256: `${shareableId}-v1`,
      created_by_id: userId,
      created_at: '2026-07-31T12:00:00.000Z',
      published_at: '2026-07-31T12:00:00.000Z',
    })
    expect(version.size_bytes).toBeGreaterThan(1)
    expect(shareable.current_version_id).toBe(`${shareableId}-v1`)
    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirstOrThrow()
    const viewerRecencyRows = await db
      .selectFrom('shareable_viewer_recency')
      .select(['viewer_user_id', 'last_viewed_at'])
      .where('shareable_id', '=', shareableId)
      .orderBy('viewer_user_id')
      .execute()
    expect(viewerRecencyRows).toEqual([
      {
        viewer_user_id: `${workspaceId}-commenter`,
        last_viewed_at: '2026-07-31T11:00:00.000Z',
      },
      { viewer_user_id: userId, last_viewed_at: '2026-07-31T10:00:00.000Z' },
      {
        viewer_user_id: `${workspaceId}-viewer-third`,
        last_viewed_at: '2026-07-31T10:00:00.000Z',
      },
    ])
    const membershipRows = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'status'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('user_id')
      .execute()
    expect(membershipRows).toEqual([
      { user_id: `${workspaceId}-commenter`, status: 'active' },
      { user_id: userId, status: 'active' },
      { user_id: `${workspaceId}-viewer-third`, status: 'removed' },
    ])
    const externalGrant = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', shareableId)
      .where(
        'granted_email',
        '=',
        `dev-viewer-third+${workspaceId}@artifactshare.local`,
      )
      .executeTakeFirst()
    expect(externalGrant).toBeDefined()
    const message = await db
      .selectFrom('comment_messages')
      .selectAll()
      .where('thread_id', '=', `${shareableId}-thread`)
      .executeTakeFirstOrThrow()
    expect(recency.last_viewed_at).toBe('2026-07-31T10:00:00.000Z')
    expect(message.created_at).toBe('2026-07-31T11:00:00.000Z')
    expect(Date.parse(message.created_at)).toBeGreaterThan(
      Date.parse(recency.last_viewed_at),
    )

    await db
      .updateTable('shareable_viewer_recency')
      .set({ last_viewed_at: '2026-08-01T00:00:00.000Z' })
      .where('shareable_id', '=', shareableId)
      .execute()
    await db
      .updateTable('users')
      .set({ name: 'Changed' })
      .where('id', '=', `${workspaceId}-commenter`)
      .execute()
    await db
      .updateTable('comment_messages')
      .set({ body: 'Changed', created_at: '2026-08-01T00:00:00.000Z' })
      .where('id', '=', `${shareableId}-message`)
      .execute()
    await db
      .updateTable('comment_threads')
      .set({
        status: 'resolved',
        resolved_by_id: `${workspaceId}-commenter`,
        resolved_at: '2026-08-01T00:00:00.000Z',
      })
      .where('id', '=', `${shareableId}-thread`)
      .execute()

    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const resetVersion = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', `${shareableId}-v1`)
      .executeTakeFirstOrThrow()
    const resetShareable = await db
      .selectFrom('shareables')
      .select(['current_version_id'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    expect(resetVersion).toMatchObject({
      status: 'published',
      created_at: '2026-07-31T12:00:00.000Z',
      published_at: '2026-07-31T12:00:00.000Z',
    })
    expect(resetShareable.current_version_id).toBe(`${shareableId}-v1`)

    const resetRecency = await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirstOrThrow()
    const counts = await Promise.all([
      db
        .selectFrom('users')
        .select('id')
        .where('id', '=', `${workspaceId}-commenter`)
        .execute(),
      db
        .selectFrom('comment_threads')
        .select('id')
        .where('shareable_id', '=', shareableId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('comment_messages')
        .select('id')
        .where('id', 'in', [
          `${shareableId}-message`,
          `${shareableId}-message-latest`,
        ])
        .orderBy('id')
        .execute(),
    ])
    const resetMessage = await db
      .selectFrom('comment_messages')
      .selectAll()
      .where('id', '=', `${shareableId}-message`)
      .executeTakeFirstOrThrow()
    const resetThread = await db
      .selectFrom('comment_threads')
      .select(['status', 'resolved_by_id', 'resolved_at'])
      .where('id', '=', `${shareableId}-thread`)
      .executeTakeFirstOrThrow()
    const commenter = await db
      .selectFrom('users')
      .select('name')
      .where('id', '=', `${workspaceId}-commenter`)
      .executeTakeFirstOrThrow()
    expect(resetRecency.last_viewed_at).toBe('2026-07-31T10:00:00.000Z')
    expect(commenter.name).toBe(
      'Mina Kato from the International Research Team',
    )
    expect(resetMessage.body).toBe(
      '確認しました。次回の見通しも追記できますか？',
    )
    expect(resetMessage.created_at).toBe('2026-07-31T11:00:00.000Z')
    expect(resetThread).toEqual({
      status: 'open',
      resolved_by_id: null,
      resolved_at: null,
    })
    expect(counts.map((rows) => rows)).toEqual([
      [{ id: `${workspaceId}-commenter` }],
      [{ id: `${shareableId}-thread` }, { id: `${shareableId}-thread-latest` }],
      [
        { id: `${shareableId}-message` },
        { id: `${shareableId}-message-latest` },
      ],
    ])
  })

  test('includes a joined project file from another workspace in the project filter', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const viewer = {
      id: userId,
      email: 'dev-user@example.com',
      emailVerified: true,
      workspaceId,
    }
    const joinedRows = await listRecentArtifactsLimited(db, viewer, 100, {
      relation: 'project',
    })
    const joinedFile = joinedRows.find(
      (row) => row.id === `${workspaceId}-recent-joined-workspace-project-file`,
    )
    expect(joinedFile).toMatchObject({
      workspace_id: `${workspaceId}-recent-joined-workspace`,
      project_workspace_id: `${workspaceId}-recent-joined-workspace`,
      recent_attribute: 'joined-project',
    })
    expect(joinedRows).toHaveLength(1)

    const allRows = await listRecentArtifactsLimited(db, viewer, 100)
    expect(allRows).toHaveLength(25)
    expect(
      allRows.some((row) => row.id === `${workspaceId}-recent-restricted-file`),
    ).toBe(true)

    const joinedFileId = `${workspaceId}-recent-joined-workspace-project-file`
    await db
      .updateTable('shareable_viewer_recency')
      .set({
        first_viewed_at: '2026-08-01T00:00:00.000Z',
        last_viewed_at: '2026-08-01T00:00:00.000Z',
      })
      .where('shareable_id', '=', joinedFileId)
      .where('viewer_user_id', '=', userId)
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    expect(
      await db
        .selectFrom('shareable_viewer_recency')
        .select(['first_viewed_at', 'last_viewed_at'])
        .where('shareable_id', '=', joinedFileId)
        .where('viewer_user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      first_viewed_at: '2026-07-31T11:30:00.000Z',
      last_viewed_at: '2026-07-31T11:30:00.000Z',
    })
  })
})

describe('representative feed events', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test.each([
    ['home/content-rich', 'free'],
    ['project-detail/with-files', 'team'],
  ] as const)('%s seeds all four feed event types', async (scenario, plan) => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(db, scenario, now, plan)
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: `dev-user+${scenario.replaceAll('/', '-')}@artifactshare.local`,
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    const { containerId } = await seedDevScreenState(
      db,
      scenario,
      workspaceId,
      userId,
      now,
    )
    const readFeedState = async () => {
      const files = await db
        .selectFrom('shareables')
        .select(['id', 'created_at'])
        .where('container_id', '=', containerId)
        .orderBy('id')
        .execute()
      const fileIds = new Set(files.map((file) => file.id))
      const fileEvents = (
        await db
          .selectFrom('events')
          .select(['type', 'shareable_id', 'subject_id', 'created_at'])
          .where('workspace_id', '=', workspaceId)
          .orderBy('id')
          .execute()
      ).filter((event) => fileIds.has(event.shareable_id))
      const versions = await db
        .selectFrom('versions')
        .select(['id', 'shareable_id', 'created_at', 'published_at'])
        .where(
          'shareable_id',
          'in',
          files.map((file) => file.id),
        )
        .orderBy('id')
        .execute()
      return { files, fileEvents, versions }
    }
    const initialState = await readFeedState()
    await seedDevScreenState(
      db,
      scenario,
      workspaceId,
      userId,
      '2026-08-01T12:00:00.000Z',
    )
    const reseededState = await readFeedState()

    expect(reseededState).toEqual(initialState)
    const { files, fileEvents } = reseededState

    expect(files).toHaveLength(3)
    expect(new Set(fileEvents.map((event) => event.type))).toEqual(
      new Set([
        'artifact_created',
        'artifact_viewed',
        'comment_posted',
        'version_published',
      ]),
    )
    expect(
      files.every((file) =>
        fileEvents.some((event) => event.shareable_id === file.id),
      ),
    ).toBe(true)
    for (const event of fileEvents) {
      const file = files.find(
        (candidate) => candidate.id === event.shareable_id,
      )
      expect(Date.parse(event.created_at)).toBeGreaterThanOrEqual(
        Date.parse(file?.created_at ?? ''),
      )
    }
    expect(
      fileEvents
        .filter((event) => event.shareable_id === files[2]?.id)
        .map((event) => event.type),
    ).toEqual(['artifact_created'])
    const createdEvent = fileEvents.find(
      (event) => event.type === 'artifact_created',
    )
    expect(createdEvent).toMatchObject({
      shareable_id: files[2]?.id,
      created_at: '2026-07-31T11:55:00.000Z',
    })
    const createdVersion = await db
      .selectFrom('versions')
      .select(['shareable_id', 'created_at', 'published_at'])
      .where('id', '=', createdEvent?.subject_id ?? '')
      .executeTakeFirstOrThrow()
    expect(createdVersion).toEqual({
      shareable_id: files[2]?.id,
      created_at: files[2]?.created_at,
      published_at: files[2]?.created_at,
    })
  })
})

describe('home empty-state dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test.each([
    ['home/empty', 0],
    ['home/first-file', 1],
  ] as const)(
    '%s seeds the representative file count',
    async (scenario, count) => {
      ;({ db } = createMigratedInMemoryDb())
      const now = '2026-07-31T12:00:00.000Z'
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'free',
      )
      const userId = `${workspaceId}-user`

      await db
        .insertInto('users')
        .values({
          id: userId,
          email: `dev-user+${scenario.replaceAll('/', '-')}@artifactshare.local`,
          email_verified: 1,
          name: 'Viewer',
          image: null,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
          locale: null,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)

      await db
        .insertInto('shareables')
        .values({
          id: `${workspaceId}-stale-file`,
          workspace_id: workspaceId,
          owner_user_id: userId,
          slug: null,
          name: 'Stale file.html',
          derived_title: 'Stale file',
          title_override: null,
          description: null,
          artifact_kind: 'html_page',
          visibility: 'private',
          current_version_id: null,
          container_id: `${workspaceId}-${userId}-container`,
          created_at: now,
          updated_at: now,
          last_accessed_at: now,
          link_expires_at: null,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)

      const files = await db
        .selectFrom('shareables')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
      const events = await db
        .selectFrom('events')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
      expect(files).toHaveLength(count)
      expect(events).toHaveLength(0)
    },
  )
})

describe('projects stress dev screen state', () => {
  test('seeds deterministic local, archived, and cross-workspace rows', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'projects/stress-states',
      now,
      'free',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-free-owner+projects-stress-states@artifactshare.local',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'projects/stress-states',
      workspaceId,
      userId,
      now,
    )

    const projects = await db
      .selectFrom('artifact_containers')
      .select(['id', 'archived_at'])
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'project')
      .execute()
    expect(projects).toHaveLength(14)
    expect(
      projects.filter((project) => project.archived_at !== null),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('project_share_defaults')
        .select('project_container_id')
        .where(
          'project_container_id',
          '=',
          `${workspaceId}-shared-source-project`,
        )
        .execute(),
    ).toEqual([
      { project_container_id: `${workspaceId}-shared-source-project` },
    ])

    const viewer = {
      id: userId,
      email: 'dev-free-owner+projects-stress-states@artifactshare.local',
      emailVerified: true,
      name: 'Viewer',
      image: null,
      workspaceId,
      hd: null,
      msTenantId: null,
      kind: 'human' as const,
      locale: null,
    }
    const indexRows = await listProjectsForIndex(db, viewer)
    expect(indexRows).toHaveLength(15)
    expect(
      indexRows.filter((row) => row.workspaceId === workspaceId),
    ).toHaveLength(14)
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-joined')),
    ).toMatchObject({
      joined: true,
      newCount: 1,
      name: 'Long project name that wraps to three lines on mobile screens',
      description:
        'A deliberately long description for checking compact project rows and mobile wrapping behavior.',
    })
    expect(await listJoinedProjectsForDropdown(db, viewer, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${workspaceId}-shared-source-project`,
          name: 'Shared measurement platform with a deliberately long name',
          workspaceName: 'Shared source workspace',
        }),
      ]),
    )
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-joinable')),
    ).toMatchObject({
      name: 'Joinable project with a deliberately long name for mobile wrapping',
      description:
        'A deliberately long joinable project description keeps the Join button beside a realistic multi-line row on narrow screens.',
      joined: false,
    })
    expect(indexRows.some((row) => row.id.endsWith('-stress-extra-11'))).toBe(
      true,
    )
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-archived')),
    ).toMatchObject({
      archivedAt: now,
    })

    await db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', `${workspaceId}-stress-joinable`)
      .execute()
    await seedDevScreenState(
      db,
      'projects/stress-states',
      workspaceId,
      userId,
      now,
    )

    const reseededIndexRows = await listProjectsForIndex(db, viewer)
    expect(reseededIndexRows).toHaveLength(15)
    expect(
      reseededIndexRows.find((row) => row.id.endsWith('-stress-joinable')),
    ).toMatchObject({
      baseVisibility: 'workspace',
      joined: false,
    })

    const sharedRows = await listSharedProjects(db, viewer)
    expect(sharedRows.map((row) => row.id)).toEqual([
      `${workspaceId}-shared-source-project`,
    ])
    await db.destroy()
  })
})

describe('settings with-bots dev screen state', () => {
  test('seeds active, expired, used-stopped, and unused-stopped bots', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'settings/with-bots',
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-team-owner+settings-with-bots@artifactshare.local',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(db, 'settings/with-bots', workspaceId, userId, now)
    // Reseed is idempotent.
    await seedDevScreenState(db, 'settings/with-bots', workspaceId, userId, now)

    const bots = await listWorkspaceBots(db, workspaceId, now)
    expect(bots).toHaveLength(4)
    const byId = new Map(bots.map((bot) => [bot.id, bot]))
    const active = byId.get(`${workspaceId}-bot-active`)
    expect(active).toMatchObject({
      name: 'Nightly report bot',
      botStoppedAt: null,
      credentialLive: true,
      projectId: `${workspaceId}-bot-project`,
      projectName: 'Nightly reports',
    })
    const expired = byId.get(`${workspaceId}-bot-expired`)
    expect(expired).toMatchObject({
      botStoppedAt: null,
      credentialLive: false,
    })
    const stopped = byId.get(`${workspaceId}-bot-stopped`)
    expect(stopped?.botStoppedAt).not.toBeNull()
    expect(stopped?.credentialLive).toBe(false)
    expect(stopped?.projectNameSnapshot).toBe('Nightly reports')
    expect(stopped?.cancelable).toBe(false)
    const unusedStopped = byId.get(`${workspaceId}-bot-unused-stopped`)
    expect(unusedStopped?.botStoppedAt).not.toBeNull()
    expect(unusedStopped?.cancelable).toBe(true)
    await db.destroy()
  })
})

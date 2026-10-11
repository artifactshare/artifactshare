import { loadWorkspaceInventoryArtifactsPage } from './team-management.server'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { projectFileRowsQuery } from '~/routes/_protected/+lib/project-subpage.server'
import { toFileRowData } from '~/routes/_home/+components/file-data'
import { versionBadgeLabel } from '~/lib/version-badge'
import { listCliArtifacts } from './cli-artifacts.server'
import { listProjectPins } from './project-pins.server'
import { listMyArtifacts, listRecentArtifactsLimited } from './home.server'
import { listOwnedShareables } from './shareables.server'
import { versionPublishedEventQuery, listFeedEvents } from './events.server'
import { loadViewerRevisitContext } from './viewer-revisit.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))
let fixture: ReturnType<typeof createMigratedInMemoryDb>
const user = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'owner@example.test',
  emailVerified: true,
  hd: null,
  msTenantId: null,
  name: 'Owner',
  image: null,
  locale: 'en',
  kind: 'human' as const,
}
const humanTime = '2026-06-02T00:00:00.000Z'
const machineTime = '2026-06-10T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-01-01');
    INSERT INTO users (id, email, workspace_id, created_at, updated_at) VALUES ('u1', 'owner@example.test', 'ws1', '2026-01-01', '2026-01-01'), ('u2', 'author@example.test', 'ws1', '2026-01-01', '2026-01-01');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('p1', 'ws1', 'project', 'u1', 'u1', 'Reports', '2026-01-01', '2026-01-01');
    INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client1', 'u1', 'ws1', 'Reports', '2026-01-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, container_id, name, artifact_kind, visibility, created_at, updated_at) VALUES ('abc123def4', 'ws1', 'u1', 'p1', 'Report', 'html_page', 'private', '2026-01-01', '${humanTime}'), ('second', 'ws1', 'u1', 'p1', 'Second', 'html_page', 'private', '2026-01-02', '2026-06-05T00:00:00.000Z');
    INSERT INTO project_pins (container_id, shareable_id, pinned_by_user_id, created_at) VALUES ('p1', 'abc123def4', 'u1', '2026-01-01');
    INSERT INTO shareable_viewer_recency (shareable_id, viewer_user_id, first_viewed_at, last_viewed_at, version_seen_through_at) VALUES ('abc123def4', 'u1', '2026-01-01', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})
async function publish(
  id: string,
  number: number,
  publisher: boolean,
  time = machineTime,
) {
  fixture.sqlite
    .prepare(
      `INSERT INTO versions (id, number, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_by_publisher_client_id, created_at, published_at) VALUES (?, ?, 'abc123def4', 'html_page', 'published', '/index.html', ?, 10, 'test', 'u2', ?, ?, ?)`,
    )
    .run(id, number, id, publisher ? 'client1' : null, time, time)
  await fixture.db
    .updateTable('shareables')
    .set({ current_version_id: id, updated_at: time })
    .where('id', '=', 'abc123def4')
    .execute()
  await versionPublishedEventQuery(fixture.db, { versionId: id }).execute()
}
async function pin() {
  return (await listProjectPins(fixture.db, 'p1', sql<boolean>`1 = 1`))[0]!
}
async function file() {
  return toFileRowData(
    await projectFileRowsQuery(fixture.db, 'p1')
      .where('shareables.id', '=', 'abc123def4')
      .executeTakeFirstOrThrow(),
    user.id,
  )
}

test('publisher versions preserve interleaved list order and cursor boundaries while mutation timestamps advance', async () => {
  const before = await listOwnedShareables(fixture.db, user, { limit: 1 })
  expect(before.map((row) => row.id)).toEqual(['second'])
  await publish('machine', 1, true)
  const rest = await listOwnedShareables(fixture.db, user, {
    cursor: { updatedAt: before[0]!.activityAt, id: before[0]!.id },
  })
  expect(rest.map((row) => row.id)).toEqual(['abc123def4'])
  expect(rest[0]).toMatchObject({
    activityAt: humanTime,
    updatedAt: machineTime,
  })
  expect(
    (await listMyArtifacts(fixture.db, 'u1', 'ws1')).rows.map((row) => row.id),
  ).toEqual(['second', 'abc123def4'])
  expect((await file()).modifiedTime).toBe(humanTime)
  const inventory = await loadWorkspaceInventoryArtifactsPage(
    fixture.db,
    'ws1',
    { visibility: 'all', sort: 'updated', page: 1 },
  )
  expect(inventory.artifacts.map((row) => row.id)).toEqual([
    'second',
    'abc123def4',
  ])
  expect(inventory.artifacts[1]?.updatedAt).toBe(humanTime)
  await publish('human', 2, false, '2026-06-11T00:00:00.000Z')
  expect(
    (await listMyArtifacts(fixture.db, 'u1', 'ws1')).rows.map((row) => row.id),
  ).toEqual(['abc123def4', 'second'])
})

test('pins and badges use only non-publisher updates, including equal timestamps and pruned history', async () => {
  await publish('machine1', 1, true)
  expect(await pin()).toMatchObject({
    latestVersionNumber: 0,
    latestPublishedAt: null,
    latestAuthorEmail: null,
  })
  expect(versionBadgeLabel(await file(), machineTime, String)).toBeNull()
  await publish('human2', 2, false, humanTime)
  await publish('machine3', 3, true)
  expect(await pin()).toMatchObject({
    latestVersionNumber: 2,
    latestPublishedAt: humanTime,
    latestAuthorEmail: 'author@example.test',
  })
  expect(await file()).toMatchObject({
    versionCount: 3,
    badgeVersionNumber: 2,
    latestPublishedAt: humanTime,
  })
  expect(versionBadgeLabel(await file(), machineTime, String)).toBeNull()
  expect(
    versionBadgeLabel(await file(), '2026-06-03T00:00:00.000Z', String),
  ).toBe('2')
  await publish('human4', 4, false)
  expect(versionBadgeLabel(await file(), machineTime, String)).toBe('4')
  await publish('machine5', 5, true)
  expect(await pin()).toMatchObject({
    latestVersionNumber: 4,
    latestPublishedAt: machineTime,
  })
  await fixture.db
    .deleteFrom('versions')
    .where('created_by_publisher_client_id', 'is', null)
    .execute()
  expect(await pin()).toMatchObject({
    latestVersionNumber: 0,
    latestPublishedAt: null,
    latestAuthorEmail: null,
  })
  await fixture.db.deleteFrom('versions').where('id', '=', 'machine1').execute()
  expect(await pin()).toMatchObject({
    latestVersionNumber: 0,
    latestPublishedAt: null,
    latestAuthorEmail: null,
  })
  expect(versionBadgeLabel(await file(), machineTime, String)).toBeNull()
})

test('scheduled changes suppress unread and revisit signals and historical feed events, then human changes restore them', async () => {
  await publish('machine1', 1, true)
  expect(await fixture.db.selectFrom('events').selectAll().execute()).toEqual(
    [],
  )
  fixture.sqlite.exec(
    `INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at) VALUES ('legacy', 'ws1', 'version_published', 'abc123def4', 'u2', 'machine1', '${machineTime}')`,
  )
  const feed = () =>
    listFeedEvents(fixture.db, {
      user,
      slice: 'mine',
      timeZone: 'UTC',
      targetRows: 20,
      maxRawEvents: 100,
    })
  expect((await feed()).rows).toEqual([])
  const revisit = () =>
    loadViewerRevisitContext(fixture.db, {
      shareableId: 'abc123def4',
      viewerUserId: 'u1',
      currentVersionId: 'machine1',
      versions: [{ id: 'machine1', ordinal: 1 }],
    })
  expect(await revisit()).toBeNull()
  expect(
    await listRecentArtifactsLimited(fixture.db, user, 10, { unread: true }),
  ).toEqual([])
  const recent = await listRecentArtifactsLimited(fixture.db, user, 10)
  expect(recent[0]).toMatchObject({ unread_version_count: 0 })
  await publish('human2', 2, false)
  expect((await feed()).rows).toHaveLength(1)
  expect((await feed()).rows[0]).toMatchObject({
    versionNumber: 2,
    versionStart: null,
    versionEnd: null,
  })
  expect(
    await listRecentArtifactsLimited(fixture.db, user, 10, { unread: true }),
  ).toHaveLength(1)
  expect((await revisit())?.version).toEqual({ kind: 'fallback' })
  expect(
    (await listRecentArtifactsLimited(fixture.db, user, 10))[0],
  ).toMatchObject({ unread_version_count: 1 })
})

test.each([undefined, 'p1'])(
  'CLI cursor uses activity while returning real mutation time (project: %s)',
  async (projectId) => {
    for (let index = 0; index < 49; index += 1) {
      fixture.sqlite
        .prepare(
          `INSERT INTO shareables (id, workspace_id, owner_user_id, container_id, name, artifact_kind, visibility, created_at, updated_at) VALUES (?, 'ws1', 'u1', 'p1', 'Other', 'html_page', 'private', '2026-01-01', ?)`,
        )
        .run(
          `other-${index}`,
          index === 48 ? '2026-01-01' : '2026-06-06T00:00:00.000Z',
        )
    }
    await publish('machine1', 1, true)
    const first = await listCliArtifacts(fixture.db, user, {
      baseUrl: 'https://example.test',
      projectId,
    })
    if (first.kind !== 'ok') throw new Error(first.kind)
    expect(first.data.artifacts).toHaveLength(50)
    expect(first.data.artifacts.at(-1)).toMatchObject({
      id: 'abc123def4',
      updated_at: machineTime,
    })
    expect(first.data.artifacts.at(-1)).not.toHaveProperty('activity_at')
    await publish('machine2', 2, true, '2026-06-11T00:00:00.000Z')
    const next = await listCliArtifacts(fixture.db, user, {
      baseUrl: 'https://example.test',
      projectId,
      cursor: first.data.next_cursor!,
    })
    if (next.kind !== 'ok') throw new Error(next.kind)
    expect(next.data.artifacts.map((row) => row.id)).toEqual(['other-48'])
    expect(
      new Set(
        [...first.data.artifacts, ...next.data.artifacts].map((row) => row.id),
      ).size,
    ).toBe(51)
  },
)

test('comments remain unread after publisher-only or self-authored version changes', async () => {
  await publish('machine1', 1, true)
  fixture.sqlite.exec(`
    INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at) VALUES ('thread1', 'abc123def4', 'open', 'u2', '${machineTime}', '${machineTime}');
    INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('message1', 'thread1', 'Review this result', 'u2', '${machineTime}', '${machineTime}');
  `)
  const recent = await listRecentArtifactsLimited(fixture.db, user, 10, {
    unread: true,
  })
  expect(recent).toHaveLength(1)
  expect(recent[0]?.unread_version_count).toBe(0)
  expect(JSON.parse(recent[0]!.unread_comment_summary!)).toMatchObject({
    count: 1,
  })
  const revisit = await loadViewerRevisitContext(fixture.db, {
    shareableId: 'abc123def4',
    viewerUserId: 'u1',
    currentVersionId: 'machine1',
    versions: [{ id: 'machine1', ordinal: 1 }],
  })
  expect(revisit).toMatchObject({ version: null, commentCount: 1 })
  await publish('self2', 2, false)
  await fixture.db
    .updateTable('versions')
    .set({ created_by_id: 'u1' })
    .where('id', '=', 'self2')
    .execute()
  expect(
    (await listRecentArtifactsLimited(fixture.db, user, 10))[0]
      ?.unread_version_count,
  ).toBe(0)
})

test('historical publisher rows do not fill a mixed-day version aggregate gap', async () => {
  await publish('human1', 1, false)
  await publish('machine2', 2, true)
  fixture.sqlite.exec(
    `INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at) VALUES ('legacy', 'ws1', 'version_published', 'abc123def4', 'u2', 'machine2', '${machineTime}')`,
  )
  await publish('human3', 3, false)
  const feed = await listFeedEvents(fixture.db, {
    user,
    slice: 'mine',
    timeZone: 'UTC',
    targetRows: 20,
    maxRawEvents: 100,
  })
  expect(feed.rows).toHaveLength(2)
  expect(feed.rows.map((row) => row.versionNumber).sort()).toEqual([1, 3])
  expect(
    feed.rows.every(
      (row) => row.versionStart === null && row.versionEnd === null,
    ),
  ).toBe(true)
})

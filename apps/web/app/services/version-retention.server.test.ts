import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1BatchFixture } from '~/test/d1-batch-mock'
import { loadViewerRevisitContext } from './viewer-revisit.server'
import { versionCountSelect } from './home.server'
import { projectFileRowsQuery } from '~/routes/_protected/+lib/project-subpage.server'
import { loadCommentThreads } from './comments.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  pruneVersions,
  pruneVersionsAfterPublish,
} from './version-retention.server'

const deleteObject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: { delete: deleteObject } },
}))
let db: ReturnType<typeof createMigratedInMemoryDb>['db']
let sqlite: ReturnType<typeof createMigratedInMemoryDb>['sqlite']
const sqliteRef: {
  current: typeof sqlite | null
  beforeNextBatch?: (() => void) | null
} = { current: null }
beforeEach(() => {
  ;({ db, sqlite } = createD1BatchFixture({ sqlite: sqliteRef }))
  sqliteRef.current = sqlite
  seed()
})
afterEach(async () => {
  deleteObject.mockReset().mockResolvedValue(undefined)
  await db.destroy()
  sqliteRef.current = null
  sqliteRef.beforeNextBatch = null
})

function seed() {
  sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES ('ws1', 'Workspace', '2026-09-01', 40);
    INSERT INTO users (id, email, name, created_at, updated_at, workspace_id)
      VALUES ('u1', 'author@example.com', 'Author', '2026-09-01', '2026-09-01', 'ws1');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
      VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id)
      VALUES ('s1', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1');
  `)
  for (let i = 1; i <= 4; i++) {
    sqlite
      .prepare(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', ?, ?)`)
      .run(`v${i}`, `key${i}`, `2026-09-0${i}`, `2026-09-0${i}`)
  }
  sqlite.exec("UPDATE shareables SET current_version_id = 'v4' WHERE id = 's1'")
}

test('retention removes old versions and quota, preserves numbers, and clears to keep all', async () => {
  expect(await pruneVersions(db, 's1')).toBe(0)
  sqlite.exec('UPDATE shareables SET retain_versions = 2')
  expect(await pruneVersions(db, 's1')).toBe(2)
  expect(
    sqlite.prepare('SELECT id, number FROM versions ORDER BY number').all(),
  ).toEqual([
    { id: 'v3', number: 3 },
    { id: 'v4', number: 4 },
  ])
  expect(
    sqlite.prepare('SELECT storage_used_bytes AS bytes FROM workspaces').get(),
  ).toEqual({ bytes: 20 })
  expect(deleteObject.mock.calls.flat()).toEqual(['key1', 'key2'])
  sqlite.exec('UPDATE shareables SET retain_versions = 1')
  expect(await pruneVersions(db, 's1')).toBe(1)
  expect(await pruneVersions(db, 's1')).toBe(0)
  sqlite.exec(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
    VALUES ('v5', 's1', 'html_page', 'published', '/index.html', 'key5', 10, 'hash', 'u1', '2026-09-05', '2026-09-05');
    UPDATE shareables SET current_version_id = 'v5', retain_versions = NULL;
    UPDATE workspaces SET storage_used_bytes = storage_used_bytes + 10;`)
  expect(await pruneVersions(db, 's1')).toBe(0)
  expect(
    sqlite.prepare("SELECT number FROM versions WHERE id = 'v5'").get(),
  ).toEqual({ number: 5 })
  // A current pointer takes precedence even if it points to an older version.
  sqlite.exec(
    "UPDATE shareables SET current_version_id = 'v4', retain_versions = 1",
  )
  deleteObject.mockRejectedValueOnce(new Error('bucket unavailable'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await pruneVersions(db, 's1')).toBe(1)
  expect(log).toHaveBeenCalledWith(
    'r2_orphan_after_version_retention',
    expect.objectContaining({ r2_key: 'key5' }),
  )
  expect(sqlite.prepare('SELECT id, number FROM versions').all()).toEqual([
    { id: 'v4', number: 4 },
  ])
  expect(
    sqlite.prepare('SELECT storage_used_bytes AS bytes FROM workspaces').get(),
  ).toEqual({ bytes: 10 })
  log.mockRestore()
})

test('pruned anchors retain their quoted text and comment messages', async () => {
  sqlite.exec(`
    INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at) VALUES ('t1', 's1', 'open', 'u1', '2026-09-04', '2026-09-04');
    INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('m1', 't1', 'Please correct this', 'u1', '2026-09-04', '2026-09-04');
    INSERT INTO comment_anchors (id, thread_id, version_id, target_path, quoted_text, prefix_text, suffix_text, text_start, text_end, created_at) VALUES ('a1', 't1', 'v1', '/index.html', 'Original data', '', '', 0, 13, '2026-09-04');
    UPDATE shareables SET retain_versions = 1;
  `)
  expect(await pruneVersions(db, 's1')).toBe(3)
  const threads = await loadCommentThreads(
    db,
    {
      shareableId: 's1',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      linkExpiresAt: null,
      currentVersionId: 'v4',
      artifactKind: 'html_page',
      entrypointPath: '/index.html',
      r2Key: 'key4',
      isOwner: true,
      isTeamWorkspaceAdmin: false,
    },
    { id: 'u1' },
  )
  expect(threads).toHaveLength(1)
  expect(threads[0]).toMatchObject({
    subject: { kind: 'text', quotedText: 'Original data', versionId: null },
    messages: [expect.objectContaining({ body: 'Please correct this' })],
  })
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

test('rechecks changed current pointers before deleting objects or releasing quota', async () => {
  sqlite.exec('UPDATE shareables SET retain_versions = 1')
  sqliteRef.beforeNextBatch = () => {
    sqlite.exec("UPDATE shareables SET current_version_id = 'v1'")
  }
  expect(await pruneVersions(db, 's1')).toBe(3)
  expect(sqlite.prepare('SELECT id FROM versions').all()).toEqual([
    { id: 'v1' },
  ])
  expect(deleteObject.mock.calls.flat()).not.toContain('key1')
  expect(
    sqlite.prepare('SELECT storage_used_bytes FROM workspaces').get(),
  ).toEqual({ storage_used_bytes: 10 })
})

test('a concurrent clear prevents both deletion and quota release', async () => {
  sqlite.exec('UPDATE shareables SET retain_versions = 1')
  sqliteRef.beforeNextBatch = () => {
    sqlite.exec('UPDATE shareables SET retain_versions = NULL')
  }
  expect(await pruneVersions(db, 's1')).toBe(0)
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM versions').get()).toEqual({
    n: 4,
  })
  expect(deleteObject).not.toHaveBeenCalled()
  expect(
    sqlite.prepare('SELECT storage_used_bytes FROM workspaces').get(),
  ).toEqual({ storage_used_bytes: 40 })
})

test('protects versions referenced as current by any artifact', async () => {
  sqlite.exec(`INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id, current_version_id)
    VALUES ('s2', 'ws1', 'u1', 'Other', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1', 'v1');
    UPDATE shareables SET retain_versions = 1 WHERE id = 's1';`)
  expect(await pruneVersions(db, 's1')).toBe(2)
  expect(sqlite.prepare('SELECT id FROM versions ORDER BY id').all()).toEqual([
    { id: 'v1' },
    { id: 'v4' },
  ])
  expect(deleteObject.mock.calls.flat()).not.toContain('key1')
})

test('large histories are pruned in bounded batches and quota is released once', async () => {
  const insert =
    sqlite.prepare(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
    VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', '2026-09-05', '2026-09-05')`)
  for (let n = 5; n <= 205; n++) insert.run(`v${n}`, `key${n}`)
  sqlite.exec(
    "UPDATE shareables SET retain_versions = 2, current_version_id = 'v205'; UPDATE workspaces SET storage_used_bytes = 2050",
  )
  let active = 0
  let peak = 0
  deleteObject.mockImplementation(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 0))
    active--
  })
  expect(await pruneVersions(db, 's1')).toBe(203)
  expect(peak).toBeGreaterThan(0)
  expect(peak).toBeLessThanOrEqual(8)
  expect(
    sqlite.prepare('SELECT number FROM versions ORDER BY number').all(),
  ).toEqual([{ number: 204 }, { number: 205 }])
  expect(
    sqlite.prepare('SELECT storage_used_bytes FROM workspaces').get(),
  ).toEqual({ storage_used_bytes: 20 })
  expect(deleteObject).toHaveBeenCalledTimes(203)
})

test('home, project and revisit numbers survive pruning, and a deleted revisit boundary falls back', async () => {
  sqlite.exec(`INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u2', 'viewer@example.com', 'Viewer', '2026-09-01', '2026-09-01', 'ws1');
    INSERT INTO shareable_viewer_recency (shareable_id, viewer_user_id, first_viewed_at, last_viewed_at, version_seen_through_at) VALUES ('s1', 'u2', '2026-09-03', '2026-09-03', '2026-09-03');
    UPDATE shareables SET retain_versions = 2;`)
  await pruneVersions(db, 's1')
  expect(
    await db
      .selectFrom('shareables')
      .select(versionCountSelect)
      .where('id', '=', 's1')
      .executeTakeFirstOrThrow(),
  ).toEqual({ version_count: 4 })
  expect((await projectFileRowsQuery(db, 'c1').execute())[0]).toMatchObject({
    version_count: 4,
  })
  const versions = (
    await db.selectFrom('versions').select(['id', 'number']).execute()
  ).map((row) => ({ id: row.id, ordinal: row.number! }))
  const input = {
    shareableId: 's1',
    viewerUserId: 'u2',
    currentVersionId: 'v4',
    versions,
  }
  expect(await loadViewerRevisitContext(db, input)).toMatchObject({
    version: { kind: 'ordinal', from: 3, to: 4 },
  })
  sqlite.exec('UPDATE shareables SET retain_versions = 1')
  await pruneVersions(db, 's1')
  expect(
    await loadViewerRevisitContext(db, {
      ...input,
      versions: versions.filter((row) => row.id === 'v4'),
    }),
  ).toMatchObject({ version: { kind: 'fallback' } })
})

test('a post-publication lookup failure is logged without rejecting committed success', async () => {
  const error = new Error('transient lookup failure')
  const lookup = vi.spyOn(db, 'selectFrom').mockImplementationOnce(() => {
    throw error
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(pruneVersionsAfterPublish(db, 's1')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('version_retention_after_publish_failed', {
      shareable_id: 's1',
      err: error,
    })
  } finally {
    lookup.mockRestore()
    log.mockRestore()
  }
})

test('shared file and entrypoint references survive pruning and are debited once across batches', async () => {
  sqlite.exec(`
    UPDATE versions SET artifact_kind = 'static_site', r2_key = 'shared-index', size_bytes = 20;
    UPDATE shareables SET artifact_kind = 'static_site', retain_versions = 1;
    UPDATE workspaces SET storage_used_bytes = 50;
  `)
  const insertFile = sqlite.prepare(
    `INSERT INTO version_files (id, version_id, path, r2_key, size_bytes, sha256, mime_type, created_at) VALUES (?, ?, ?, ?, 10, 'hash', 'text/html', '2026-09-01')`,
  )
  for (let i = 1; i <= 4; i++) {
    insertFile.run(`index-${i}`, `v${i}`, '/index.html', 'shared-index')
    insertFile.run(`data-${i}`, `v${i}`, '/data.json', `data-${i}`)
  }
  // More than one pruning batch, all sharing the same physical entrypoint.
  for (let i = 5; i <= 90; i++) {
    sqlite
      .prepare(
        `INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, 's1', 'static_site', 'published', '/index.html', 'shared-index', 10, 'hash', 'u1', '2026-09-01', '2026-09-01')`,
      )
      .run(`v${i}`)
    insertFile.run(`index-${i}`, `v${i}`, '/index.html', 'shared-index')
  }
  expect(await pruneVersions(db, 's1')).toBe(89)
  expect(
    sqlite.prepare('SELECT storage_used_bytes AS bytes FROM workspaces').get(),
  ).toEqual({ bytes: 20 })
  expect(deleteObject.mock.calls.flat().sort()).toEqual([
    'data-1',
    'data-2',
    'data-3',
  ])
  expect(await pruneVersions(db, 's1')).toBe(0)
  expect(
    sqlite
      .prepare(
        'SELECT r2_key FROM version_files WHERE version_id = ? ORDER BY path',
      )
      .all('v4'),
  ).toEqual([{ r2_key: 'data-4' }, { r2_key: 'shared-index' }])
})

test('remaining versions-only references protect objects even without a file row', async () => {
  sqlite.exec(`UPDATE versions SET r2_key = 'shared' WHERE id IN ('v1', 'v4');
    UPDATE workspaces SET storage_used_bytes = 30;
    UPDATE shareables SET retain_versions = 1;`)
  expect(await pruneVersions(db, 's1')).toBe(3)
  expect(deleteObject.mock.calls.flat().sort()).toEqual(['key2', 'key3'])
  expect(
    sqlite.prepare('SELECT storage_used_bytes AS bytes FROM workspaces').get(),
  ).toEqual({ bytes: 10 })
})

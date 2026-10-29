import { beforeEach, afterEach, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { selectArtifactVersion } from './artifact-version-selection.server'
let db: ReturnType<typeof createMigratedInMemoryDb>['db']
let sqlite: ReturnType<typeof createMigratedInMemoryDb>['sqlite']
beforeEach(() => {
  ;({ db, sqlite } = createMigratedInMemoryDb())
  seed()
})
afterEach(async () => {
  await db.destroy()
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
  for (let i = 1; i <= 55; i++) {
    sqlite
      .prepare(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', ?, ?)`)
      .run(
        `v${i}`,
        `key${i}`,
        new Date(Date.UTC(2026, 8, i)).toISOString(),
        new Date(Date.UTC(2026, 8, i)).toISOString(),
      )
  }
  sqlite.exec("UPDATE shareables SET current_version_id = 'v4' WHERE id = 's1'")
}

test('selects any published version beyond the newest 50 and trims ids', async () => {
  expect(await selectArtifactVersion(db, 's1', ' v1 ')).toMatchObject({
    kind: 'ok',
    version: { id: 'v1', r2_key: 'key1', artifact_kind: 'html_page' },
  })
})
test('unknown, foreign, failed, draft and null-publication versions are indistinguishable', async () => {
  expect(await selectArtifactVersion(db, 's2', 'v1')).toEqual({
    kind: 'not-found',
  })
  expect(await selectArtifactVersion(db, 's1', 'unknown')).toEqual({
    kind: 'not-found',
  })
  for (const status of ['draft', 'failed']) {
    sqlite
      .prepare('UPDATE versions SET status = ? WHERE id = ?')
      .run(status, 'v1')
    expect(await selectArtifactVersion(db, 's1', 'v1')).toEqual({
      kind: 'not-found',
    })
  }
  sqlite.exec(
    "UPDATE versions SET status = 'published', published_at = NULL WHERE id = 'v1'",
  )
  expect(await selectArtifactVersion(db, 's1', 'v1')).toEqual({
    kind: 'not-found',
  })
})
test('retention removal is scoped to the artifact', async () => {
  sqlite.exec(
    "INSERT INTO version_retention_tombstones VALUES ('removed', 's1', 100, '2026-09-01')",
  )
  expect(await selectArtifactVersion(db, 's1', 'removed')).toEqual({
    kind: 'version-removed',
  })
  expect(await selectArtifactVersion(db, 's2', 'removed')).toEqual({
    kind: 'not-found',
  })
})

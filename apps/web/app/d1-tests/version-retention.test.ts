import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: { BUCKET: { delete: vi.fn() } } }))
import { createDb } from '../services/db.server'
import { pruneVersions } from '../services/version-retention.server'
import {
  previewRetention,
  saveRetention,
} from '../services/retention-settings.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
})
afterAll(async () => {
  await server.close()
})
beforeEach(async () => {
  await database.batch([
    database.prepare('DELETE FROM shareables'),
    database.prepare('DELETE FROM artifact_containers'),
    database.prepare('DELETE FROM users'),
    database.prepare('DELETE FROM workspaces'),
    database.prepare(
      "INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES ('ws1', 'Workspace', '2026-09-01', 20)",
    ),
    database.prepare(
      "INSERT INTO users (id, email, name, created_at, updated_at, workspace_id, google_sub) VALUES ('u1', 'author@example.com', 'Author', '2026-09-01', '2026-09-01', 'ws1', 'sub-1')",
    ),
    database.prepare(
      "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01')",
    ),
    database.prepare(
      "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id, retain_versions) VALUES ('s1', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1', 1)",
    ),
    ...['v1', 'v2'].map((id) =>
      database
        .prepare(
          "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', '2026-09-01', '2026-09-01')",
        )
        .bind(id, id),
    ),
    database.prepare("UPDATE shareables SET current_version_id = 'v2'"),
  ])
})
function intercept(pattern: RegExp) {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare')
        return (query: string) =>
          target.prepare(
            pattern.test(query)
              ? 'INSERT INTO table_that_does_not_exist VALUES (1)'
              : query,
          )
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
test.each([
  /insert into "version_retention_tombstones"/i,
  /delete from "versions"/i,
])(
  'D1 batch failure rolls back marking, deletion and debit: %s',
  async (pattern) => {
    const db = createDb(intercept(pattern))
    await expect(pruneVersions(db, 's1')).rejects.toThrow()
    expect(
      await database
        .prepare('SELECT * FROM version_retention_tombstones')
        .all(),
    ).toMatchObject({ results: [] })
    expect(
      await database.prepare('SELECT COUNT(*) AS n FROM versions').first(),
    ).toEqual({ n: 2 })
    expect(
      await database
        .prepare('SELECT storage_used_bytes FROM workspaces')
        .first(),
    ).toEqual({ storage_used_bytes: 20 })
  },
)
test('D1 writes minimal tombstones and refuses stale browser snapshots', async () => {
  const db = createDb(database)
  const preview = await previewRetention(db, 's1', 'u1', 1)
  await database
    .prepare("UPDATE shareables SET current_version_id = 'v1'")
    .run()
  expect(await saveRetention(db, 's1', 'u1', 1, preview!.snapshot)).toBeNull()
  expect(await pruneVersions(db, 's1')).toBe(1)
  expect(
    await database.prepare('SELECT * FROM version_retention_tombstones').all(),
  ).toMatchObject({
    results: [
      {
        version_id: 'v2',
        shareable_id: 's1',
        version_number: 2,
        removed_at: expect.any(String),
      },
    ],
  })
})

function beforeFirstBatch(action: () => Promise<unknown>): D1Database {
  let pending = true
  return new Proxy(database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false
            await action()
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test.each([
  "UPDATE shareables SET current_version_id = 'v1'",
  'UPDATE shareables SET retain_versions = NULL',
  "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES ('ws1', 'u1', 'member', 'removed', '2026-09-01', '2026-09-01')",
])(
  'D1 browser write rechecks snapshot and authority inside its batch: %s',
  async (change) => {
    const db = createDb(beforeFirstBatch(() => database.prepare(change).run()))
    const preview = await previewRetention(db, 's1', 'u1', 1)
    expect(await saveRetention(db, 's1', 'u1', 1, preview!.snapshot)).toBeNull()
    expect(
      await database.prepare('SELECT COUNT(*) AS n FROM versions').first(),
    ).toEqual({ n: 2 })
    expect(
      await database
        .prepare('SELECT * FROM version_retention_tombstones')
        .all(),
    ).toMatchObject({ results: [] })
  },
)

test.each([
  ["UPDATE shareables SET current_version_id = 'v1'", 'v2'],
  ['UPDATE shareables SET retain_versions = NULL', null],
] as const)(
  'D1 concurrent policy/current changes only mark actual deletions: %s',
  async (change, deleted) => {
    const db = createDb(beforeFirstBatch(() => database.prepare(change).run()))
    expect(await pruneVersions(db, 's1')).toBe(deleted ? 1 : 0)
    expect(
      await database
        .prepare('SELECT version_id FROM version_retention_tombstones')
        .all(),
    ).toMatchObject({ results: deleted ? [{ version_id: deleted }] : [] })
    expect(
      await database
        .prepare('SELECT storage_used_bytes FROM workspaces')
        .first(),
    ).toEqual({ storage_used_bytes: deleted ? 10 : 20 })
  },
)

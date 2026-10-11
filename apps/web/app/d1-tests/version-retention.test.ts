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
    database.prepare('DELETE FROM cli_refresh_credentials'),
    database.prepare('DELETE FROM cli_family_authorities'),
    database.prepare('DELETE FROM publisher_clients'),
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

async function seedManaged() {
  await database.batch([
    database.prepare(
      "INSERT INTO publisher_clients (id, workspace_id, user_id, name, created_at) VALUES ('client1', 'ws1', 'u1', 'Scheduled reports', '2026-09-01')",
    ),
    database.prepare(
      "UPDATE shareables SET assigned_publisher_client_id = 'client1'",
    ),
    database.prepare(
      "UPDATE versions SET created_by_publisher_client_id = 'client1' WHERE id = 'v2'",
    ),
    ...['v3', 'v4'].map((id) =>
      database
        .prepare(
          "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_by_publisher_client_id, created_at, published_at) VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', ?, '2026-09-01', '2026-09-01')",
        )
        .bind(id, id, id === 'v4' ? 'client1' : null),
    ),
    database.prepare("UPDATE shareables SET current_version_id = 'v4';"),
    database.prepare('UPDATE workspaces SET storage_used_bytes = 40'),
  ])
}

test('D1 managed preview, save and tombstones agree on publisher-only removals', async () => {
  await seedManaged()
  const db = createDb(database)
  const preview = await previewRetention(db, 's1', 'u1', 1)
  expect(preview!.count).toBe(1)
  expect(await saveRetention(db, 's1', 'u1', 1, preview!.snapshot)).toEqual({
    retain_versions: 1,
    deleted_versions: 1,
  })
  expect(
    await database.prepare('SELECT id FROM versions ORDER BY id').all(),
  ).toMatchObject({ results: [{ id: 'v1' }, { id: 'v3' }, { id: 'v4' }] })
  expect(
    await database
      .prepare('SELECT version_id FROM version_retention_tombstones')
      .all(),
  ).toMatchObject({ results: [{ version_id: 'v2' }] })
  expect(
    await database.prepare('SELECT storage_used_bytes FROM workspaces').first(),
  ).toEqual({ storage_used_bytes: 30 })
})

test.each([
  "UPDATE shareables SET created_by_publisher_client_id = 'client1'",
  "UPDATE versions SET created_by_publisher_client_id = 'client1' WHERE id = 'v3'",
])(
  'D1 guarded confirmation rejects changed attribution: %s',
  async (change) => {
    await seedManaged()
    const db = createDb(beforeFirstBatch(() => database.prepare(change).run()))
    const preview = await previewRetention(db, 's1', 'u1', 1)
    expect(await saveRetention(db, 's1', 'u1', 1, preview!.snapshot)).toBeNull()
    expect(
      await database.prepare('SELECT COUNT(*) AS n FROM versions').first(),
    ).toEqual({ n: 4 })
  },
)

test('D1 protects newly human versions between selection and atomic deletion', async () => {
  await seedManaged()
  const db = createDb(
    beforeFirstBatch(() =>
      database
        .prepare(
          "UPDATE versions SET created_by_publisher_client_id = NULL WHERE id = 'v2'",
        )
        .run(),
    ),
  )
  expect(await pruneVersions(db, 's1')).toBe(0)
  expect(
    await database.prepare('SELECT storage_used_bytes FROM workspaces').first(),
  ).toEqual({ storage_used_bytes: 40 })
})

test('D1 managed rollback keeps human and publisher rows and all accounting', async () => {
  await seedManaged()
  await expect(
    pruneVersions(createDb(intercept(/delete from "versions"/i)), 's1'),
  ).rejects.toThrow()
  expect(
    await database.prepare('SELECT COUNT(*) AS n FROM versions').first(),
  ).toEqual({ n: 4 })
  expect(
    await database.prepare('SELECT storage_used_bytes FROM workspaces').first(),
  ).toEqual({ storage_used_bytes: 40 })
  expect(
    await database.prepare('SELECT * FROM version_retention_tombstones').all(),
  ).toMatchObject({ results: [] })
})

test('D1 publisher-guarded managed history spans batches within the binding budget', async () => {
  await seedManaged()
  await database.batch([
    database.prepare(
      "INSERT INTO cli_family_authorities (family_id, user_id, preset, workspace_id, publisher_client_id, status, created_at, updated_at) VALUES ('family1', 'u1', 'publisher', 'ws1', 'client1', 'active', '2026-09-01', '2026-09-01')",
    ),
    database.prepare(
      "INSERT INTO cli_refresh_credentials (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ('credential1', 'u1', 'test-hash', 'family1', '2099-01-01', '2026-09-01')",
    ),
  ])
  for (let n = 5; n <= 115; n++) {
    await database
      .prepare(
        "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_by_publisher_client_id, created_at, published_at) VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', 'client1', '2026-09-01', '2026-09-01')",
      )
      .bind(`v${n}`, `key${n}`)
      .run()
  }
  await database
    .prepare("UPDATE shareables SET current_version_id = 'v115'")
    .run()
  await database
    .prepare('UPDATE workspaces SET storage_used_bytes = 1150')
    .run()
  expect(
    await pruneVersions(createDb(database), 's1', undefined, {
      userId: 'u1',
      authority: {
        kind: 'publisher',
        familyId: 'family1',
        workspaceId: 'ws1',
        publisherClientId: 'client1',
        publisherClientName: 'Scheduled reports',
      },
    }),
  ).toBe(112)
  expect(
    await database.prepare('SELECT id FROM versions ORDER BY number').all(),
  ).toMatchObject({ results: [{ id: 'v1' }, { id: 'v3' }, { id: 'v115' }] })
  expect(
    await database.prepare('SELECT storage_used_bytes FROM workspaces').first(),
  ).toEqual({ storage_used_bytes: 30 })
})

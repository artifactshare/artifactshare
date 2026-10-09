import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  putArtifact: vi.fn().mockResolvedValue(undefined),
  deleteArtifact: vi.fn().mockResolvedValue(undefined),
  deleteArtifactsByPrefix: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('cloudflare:workers', () => ({ env: { BUCKET: {} } }))
vi.mock('~/services/storage.server', () => storage)
import { createDb } from '~/services/db.server'
import { beginStaticSiteBundleVersionUploadSession } from '~/services/shareables.server'
import { physicalVersionBytes } from '~/services/physical-storage.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let binding: D1Database
beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  binding = (await worker.getEnv()).DB
})
afterAll(async () => {
  await server.close()
})

async function seed(id: string) {
  await binding.batch([
    binding
      .prepare(
        "INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES (?, 'Workspace', '2026-09-01', 10)",
      )
      .bind(`ws-${id}`),
    binding
      .prepare(
        "INSERT INTO users (id, email, email_verified, workspace_id, google_sub, created_at, updated_at) VALUES (?, ?, 1, ?, ?, '2026-09-01', '2026-09-01')",
      )
      .bind(`u-${id}`, `${id}@example.com`, `ws-${id}`, `sub-${id}`),
    binding
      .prepare(
        "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'inbox', ?, 'Home', '2026-09-01', '2026-09-01')",
      )
      .bind(`c-${id}`, `ws-${id}`, `u-${id}`),
    binding
      .prepare(
        "INSERT INTO shareables (id, workspace_id, owner_user_id, container_id, name, artifact_kind, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, 'Site', 'static_site', 'private', '2026-09-01', '2026-09-01')",
      )
      .bind(id, `ws-${id}`, `u-${id}`, `c-${id}`),
    binding
      .prepare(
        "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, ?, 'static_site', 'published', '/index.html', ?, 10, 'hash', ?, '2026-09-01', '2026-09-01')",
      )
      .bind(`v-${id}`, id, `${id}/index.html`, `u-${id}`),
    binding
      .prepare(
        "INSERT INTO version_files (id, version_id, path, r2_key, size_bytes, sha256, mime_type, scan_flags, created_at) VALUES (?, ?, '/index.html', ?, 10, 'hash', 'text/html', 'flags', '2026-09-01')",
      )
      .bind(`f-${id}`, `v-${id}`, `${id}/index.html`),
    binding
      .prepare('UPDATE shareables SET current_version_id = ? WHERE id = ?')
      .bind(`v-${id}`, id),
  ])
  return {
    id: `u-${id}`,
    email: `${id}@example.com`,
    emailVerified: true,
    workspaceId: `ws-${id}`,
  }
}

test('real D1 publish inherits via SELECT with large exclusions and physical accounting', async () => {
  const user = await seed('s1')
  const db = createDb(binding)
  try {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      user,
      's1',
      null,
      {
        baseVersionId: 'v-s1',
        deletePaths: Array.from({ length: 150 }, (_, i) => `/absent/${i}.json`),
      },
    )
    if (begun.kind !== 'ok') throw new Error(begun.kind)
    expect((await begun.session.commitVersion()).kind).toBe('ok')
    expect(
      await db
        .selectFrom('version_files')
        .select(['r2_key', 'scan_flags'])
        .where('version_id', '=', begun.session.versionId)
        .execute(),
    ).toEqual([{ r2_key: 's1/index.html', scan_flags: 'flags' }])
    expect(
      await db
        .selectNoFrom(
          physicalVersionBytes(
            db
              .selectFrom('versions')
              .select('id')
              .where('shareable_id', '=', 's1'),
          ).as('bytes'),
        )
        .executeTakeFirstOrThrow(),
    ).toEqual({ bytes: 10 })
  } finally {
    await db.destroy()
  }
})

test('real batch rolls back inherited rows, number and pointer when a later statement fails', async () => {
  const user = await seed('s2')
  const failing = new Proxy(binding, {
    get(target, property) {
      if (property === 'prepare')
        return (query: string) =>
          /update "shareables"/i.test(query)
            ? target.prepare(
                'INSERT INTO missing_inheritance_test_table VALUES (1)',
              )
            : target.prepare(query)
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = createDb(failing)
  try {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      user,
      's2',
      null,
      { baseVersionId: 'v-s2' },
    )
    if (begun.kind !== 'ok') throw new Error(begun.kind)
    await begun.session.addFile(
      new File(['newdata'], '/data.json', { type: 'application/json' }),
    )
    expect((await begun.session.commitVersion()).kind).toBe('storage-failed')
    expect(
      await binding
        .prepare('SELECT storage_used_bytes FROM workspaces WHERE id = ?')
        .bind(user.workspaceId)
        .first(),
    ).toEqual({ storage_used_bytes: 10 })
    expect(storage.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      expect.anything(),
      begun.session.r2Prefix,
    )
    expect(
      await binding
        .prepare('SELECT id FROM versions WHERE shareable_id = ?')
        .bind('s2')
        .all(),
    ).toMatchObject({ results: [{ id: 'v-s2' }] })
    expect(
      await binding
        .prepare(
          'SELECT current_version_id, version_sequence FROM shareables WHERE id = ?',
        )
        .bind('s2')
        .first(),
    ).toEqual({ current_version_id: 'v-s2', version_sequence: 1 })
    expect(
      await binding
        .prepare('SELECT version_id FROM version_files WHERE version_id = ?')
        .bind(begun.session.versionId)
        .all(),
    ).toMatchObject({ results: [] })
  } finally {
    await db.destroy()
  }
})

test('D1 commit rechecks resulting bytes before inserting the version', async () => {
  const user = await seed('s3')
  let pending = true
  const guarded = new Proxy(binding, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false
            await target
              .prepare(
                'UPDATE version_files SET size_bytes = ? WHERE version_id = ?',
              )
              .bind(26 * 1024 * 1024, 'v-s3')
              .run()
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = createDb(guarded)
  try {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      user,
      's3',
      null,
      { baseVersionId: 'v-s3' },
    )
    if (begun.kind !== 'ok') throw new Error(begun.kind)
    expect((await begun.session.commitVersion()).kind).toBe('too-large')
    expect(
      await binding
        .prepare('SELECT current_version_id FROM shareables WHERE id = ?')
        .bind('s3')
        .first(),
    ).toEqual({ current_version_id: 'v-s3' })
  } finally {
    await db.destroy()
  }
})

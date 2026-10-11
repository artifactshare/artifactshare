import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: { BUCKET: {} } }))
vi.mock('~/services/storage.server', () => ({
  putArtifact: vi.fn().mockResolvedValue(undefined),
  deleteArtifact: vi.fn().mockResolvedValue(undefined),
  deleteArtifactsByPrefix: vi.fn().mockResolvedValue(undefined),
  deleteArtifacts: vi.fn().mockResolvedValue(undefined),
}))
import { createDb } from '../services/db.server'
import { adoptPublisherArtifact } from '../services/publisher-adoption.server'
import { saveRetention } from '../services/retention-settings.server'
import {
  beginStaticSiteBundleUploadSession,
  beginStaticSiteBundleVersionUploadSession,
  deleteShareable,
} from '../services/shareables.server'
import { publisherArtifactSql } from '../services/publisher-scope.server'

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

test('D1 enforces publisher provenance, current ownership and revocation at the write boundary', async () => {
  await database.batch([
    database.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('publisher-ws', 'Workspace', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO users (id, google_sub, email, workspace_id, created_at, updated_at) VALUES ('publisher-owner', 'sub-publisher-owner', 'publisher-owner@example.test', 'publisher-ws', '2026-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('publisher-client', 'publisher-owner', 'publisher-ws', 'Reports', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO cli_family_authorities (family_id, user_id, preset, workspace_id, publisher_client_id, status, created_at, updated_at) VALUES ('publisher-family', 'publisher-owner', 'publisher', 'publisher-ws', 'publisher-client', 'active', '2026-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO cli_refresh_credentials (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ('publisher-refresh', 'publisher-owner', 'publisher-hash', 'publisher-family', '2099-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at) VALUES ('publisher-home', 'publisher-ws', 'inbox', 'publisher-owner', 'Home', '2026-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_by_publisher_client_id, created_at, updated_at) VALUES ('abc123def4', 'publisher-ws', 'publisher-owner', 'Report', 'html_page', 'private', 'publisher-home', 'publisher-client', '2026-01-01', '2026-01-01')",
    ),
  ])
  const db = createDb(database)
  try {
    const authority = {
      kind: 'publisher' as const,
      familyId: 'publisher-family',
      workspaceId: 'publisher-ws',
      publisherClientId: 'publisher-client',
      publisherClientName: 'Reports',
    }
    const write = () =>
      db
        .updateTable('shareables')
        .set({ derived_title: 'Updated' })
        .where('id', '=', 'abc123def4')
        .where(publisherArtifactSql('publisher-owner', authority))
        .executeTakeFirst()
    expect(Number((await write()).numUpdatedRows)).toBe(1)
    await database
      .prepare(
        "UPDATE shareables SET visibility = 'workspace', derived_title = 'Human title' WHERE id = 'abc123def4'",
      )
      .run()
    expect(Number((await write()).numUpdatedRows)).toBe(1)
    await database
      .prepare(
        "UPDATE cli_family_authorities SET status = 'revoked' WHERE family_id = 'publisher-family'",
      )
      .run()
    expect(Number((await write()).numUpdatedRows)).toBe(0)
    await database
      .prepare(
        "UPDATE cli_family_authorities SET status = 'active' WHERE family_id = 'publisher-family'",
      )
      .run()
    await database
      .prepare(
        "UPDATE shareables SET created_by_publisher_client_id = NULL WHERE id = 'abc123def4'",
      )
      .run()
    expect(Number((await write()).numUpdatedRows)).toBe(0)
    expect(
      (await database.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([])
  } finally {
    await db.destroy()
  }
})

test('D1 publisher bundle, assignment, guarded retention and delete batches', async () => {
  await database.batch([
    database.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('workspace1', 'Workspace', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO users (id, google_sub, email, workspace_id, created_at, updated_at) VALUES ('owner1', 'sub-owner1', 'owner@example.test', 'workspace1', '2026-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client1', 'owner1', 'workspace1', 'Reports', '2026-01-01'), ('client2', 'owner1', 'workspace1', 'Other', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO cli_family_authorities (family_id, user_id, preset, workspace_id, publisher_client_id, status, created_at, updated_at) VALUES ('family1', 'owner1', 'publisher', 'workspace1', 'client1', 'active', '2026-01-01', '2026-01-01')",
    ),
    database.prepare(
      "INSERT INTO cli_refresh_credentials (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ('credential1', 'owner1', 'hash1', 'family1', '2099-01-01', '2026-01-01')",
    ),
  ])
  let beforeBatch: (() => Promise<void>) | null = null
  const guarded = new Proxy(database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const run = beforeBatch
          beforeBatch = null
          if (run) await run()
          return target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const db = createDb(guarded)
  const user = {
    id: 'owner1',
    workspaceId: 'workspace1',
    email: 'owner@example.test',
    emailVerified: true,
  }
  const authority = {
    kind: 'publisher' as const,
    familyId: 'family1',
    workspaceId: 'workspace1',
    publisherClientId: 'client1',
    publisherClientName: 'Reports',
  }
  try {
    const create = await beginStaticSiteBundleUploadSession(
      db,
      user,
      null,
      null,
      { authority },
    )
    if (create.kind !== 'ok') throw new Error(create.kind)
    await create.session.addFile(
      new File(['<h1>Site</h1>'], 'index.html', { type: 'text/html' }),
    )
    await create.session.addFile(
      new File(['a{}'], 'keep.css', { type: 'text/css' }),
    )
    const result = await create.session.commit('private')
    if (result.kind !== 'ok') throw new Error(result.kind)
    const id = result.id
    const version = await beginStaticSiteBundleVersionUploadSession(
      db,
      user,
      id,
      null,
      { authority, baseVersionId: result.versionId },
    )
    if (version.kind !== 'ok') throw new Error(version.kind)
    await version.session.addFile(
      new File(['<h1>Updated</h1>'], 'index.html', { type: 'text/html' }),
    )
    expect((await version.session.commitVersion()).kind).toBe('ok')
    const inherited = await db
      .selectFrom('version_files')
      .selectAll()
      .where('version_id', '=', version.session.versionId)
      .where('path', '=', '/keep.css')
      .executeTakeFirstOrThrow()
    expect(inherited.r2_key).toContain(result.versionId)
    expect(
      await saveRetention(db, id, user.id, 1, undefined, authority),
    ).toEqual({ retain_versions: 1, deleted_versions: 1 })
    expect(
      await db
        .selectFrom('version_files')
        .select('r2_key')
        .where('r2_key', '=', inherited.r2_key)
        .execute(),
    ).toHaveLength(1)
    const adopt = () =>
      adoptPublisherArtifact(
        db,
        user,
        { kind: 'unrestricted' },
        false,
        id,
        'client2',
      )
    expect(await adopt()).toEqual({ kind: 'ok' })
    expect(await adopt()).toEqual({ kind: 'ok' })
    expect(
      await db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'artifact.publisher_adopted')
        .execute(),
    ).toHaveLength(2)
    expect(
      await saveRetention(db, id, user.id, null, undefined, authority),
    ).toBeNull()
    expect(
      await deleteShareable(db, user, id, { publisherAuthority: authority }),
    ).toEqual({ kind: 'not-found' })
    expect(
      await adoptPublisherArtifact(db, user, null, true, id, 'client1'),
    ).toEqual({ kind: 'ok' })
    const versionsBefore = await db
      .selectFrom('versions')
      .selectAll()
      .where('shareable_id', '=', id)
      .execute()
    const stage = await beginStaticSiteBundleVersionUploadSession(
      db,
      user,
      id,
      null,
      { authority, baseVersionId: version.session.versionId },
    )
    if (stage.kind !== 'ok') throw new Error(stage.kind)
    await stage.session.addFile(
      new File(['denied'], 'index.html', { type: 'text/html' }),
    )
    beforeBatch = async () => {
      await database
        .prepare(
          'UPDATE shareables SET assigned_publisher_client_id = ? WHERE id = ?',
        )
        .bind('client2', id)
        .run()
    }
    expect((await stage.session.commitVersion()).kind).toBe('not-found')
    expect(
      await db
        .selectFrom('versions')
        .selectAll()
        .where('shareable_id', '=', id)
        .execute(),
    ).toEqual(versionsBefore)
    expect(
      await db
        .selectFrom('version_files')
        .selectAll()
        .where('version_id', '=', stage.session.versionId)
        .execute(),
    ).toEqual([])
    await adoptPublisherArtifact(db, user, null, true, id, 'client1')
    beforeBatch = async () => {
      await database
        .prepare(
          "UPDATE cli_family_authorities SET status = 'revoked' WHERE family_id = 'family1'",
        )
        .run()
    }
    expect(
      await saveRetention(db, id, user.id, null, undefined, authority),
    ).toBeNull()
    await database
      .prepare(
        "UPDATE cli_family_authorities SET status = 'active' WHERE family_id = 'family1'",
      )
      .run()
    beforeBatch = async () => {
      await database
        .prepare(
          "UPDATE cli_refresh_credentials SET revoked_at = '2026-01-01' WHERE id = 'credential1'",
        )
        .run()
    }
    expect(
      await deleteShareable(db, user, id, { publisherAuthority: authority }),
    ).toEqual({ kind: 'not-found' })
    await database
      .prepare(
        "UPDATE cli_refresh_credentials SET revoked_at = NULL WHERE id = 'credential1'",
      )
      .run()
    expect(
      await deleteShareable(db, user, id, { publisherAuthority: authority }),
    ).toEqual({ kind: 'ok' })
    expect(
      await db
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', 'workspace1')
        .executeTakeFirst(),
    ).toEqual({ storage_used_bytes: 0 })
    expect(
      (await database.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([])
  } finally {
    await db.destroy()
  }
})

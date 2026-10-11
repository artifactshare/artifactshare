import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
import { createDb } from '../services/db.server'
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
      "INSERT INTO users (id, google_sub, email, workspace_id, created_at, updated_at) VALUES ('publisher-owner', 'sub-publisher-owner', 'owner@example.test', 'publisher-ws', '2026-01-01', '2026-01-01')",
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

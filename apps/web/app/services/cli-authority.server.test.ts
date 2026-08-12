import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1MockFromSqliteRef } from '~/test/sqlite-fixture'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const { resolveCliAuthorityBySessionToken } =
  await import('./cli-authority.server')

describe('CLI authority resolution', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
        ) VALUES ('s1', 'u1', 'ass_test', '2099-01-01T00:00:00.000Z', NULL,
          'artifactshare-cli-device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('keeps a legacy session unrestricted during dual-write rollout', async () => {
    await expect(
      resolveCliAuthorityBySessionToken('ass_test'),
    ).resolves.toEqual({ kind: 'unrestricted' })
  })

  test('resolves an active agent family from its session', async () => {
    seedAgentAuthority(sqlite)

    await expect(
      resolveCliAuthorityBySessionToken('ass_test'),
    ).resolves.toEqual({
      kind: 'agent',
      familyId: 'family-1',
      workspaceId: 'ws1',
      projectId: 'project-1',
      projectNameSnapshot: 'Agent output',
      agentProfileId: 'agent-1',
    })
  })

  test('fails closed for revoked or structurally incomplete authority', async () => {
    seedAgentAuthority(sqlite)
    sqlite
      .prepare(
        "UPDATE cli_family_authorities SET status = 'revoked' WHERE family_id = 'family-1'",
      )
      .run()
    await expect(
      resolveCliAuthorityBySessionToken('ass_test'),
    ).resolves.toBeNull()

    sqlite
      .prepare(
        "UPDATE cli_family_authorities SET status = 'active', project_name_snapshot = NULL WHERE family_id = 'family-1'",
      )
      .run()
    await expect(
      resolveCliAuthorityBySessionToken('ass_test'),
    ).resolves.toBeNull()
  })
})

function seedAgentAuthority(sqlite: DatabaseSync) {
  sqlite
    .prepare(
      `INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at
      ) VALUES ('project-1', 'ws1', 'project', 'u1', 'u1', 'Agent output',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
       VALUES ('agent-1', 'u1', 'ws1', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id, project_name_snapshot,
        agent_profile_id, approved_at, device_name, status, created_at, updated_at
      ) VALUES ('family-1', 'u1', 'agent', 'ws1', 'project-1', 'Agent output',
        'agent-1', '2026-01-01T00:00:00.000Z', 'test', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO cli_session_authorities (
        session_id, family_id, kind, preset, workspace_id, project_id,
        expires_at, bearer_only, created_at
      ) VALUES ('s1', 'family-1', 'family', 'agent', NULL, NULL, NULL, 1,
        '2026-01-01T00:00:00.000Z')`,
    )
    .run()
}

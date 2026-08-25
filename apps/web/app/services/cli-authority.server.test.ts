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

  test('fails closed for an agent authority detached from its project', async () => {
    seedAgentAuthority(sqlite)
    // Project deletion sets project_id to NULL on non-live agent authorities;
    // such an authority must not resolve, so it can perform no operation.
    sqlite
      .prepare(
        "UPDATE cli_family_authorities SET project_id = NULL WHERE family_id = 'family-1'",
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

describe('bot CLI authority resolution', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'admin')
    sqlite
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at,
          workspace_id, kind
        ) VALUES ('bot1', 'bot-abc@bots.artifactshare.invalid', 1, 'Bot',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'ws1', 'bot')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, created_at, updated_at
        ) VALUES ('bs1', 'bot1', 'ass_bot', '2099-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  function seedBotFamily({
    credentialExpiresAt = '2099-01-01T00:00:00.000Z',
  } = {}) {
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, created_by_id, name, created_at, updated_at
        ) VALUES ('project-b', 'ws1', 'project', 'admin', 'Bot output',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
         VALUES ('agent-b', 'bot1', 'ws1', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO cli_family_authorities (
          family_id, user_id, preset, workspace_id, project_id,
          project_name_snapshot, agent_profile_id, approved_at, status,
          created_at, updated_at
        ) VALUES ('family-b', 'bot1', 'agent', 'ws1', 'project-b', 'Bot output',
          'agent-b', '2026-01-01T00:00:00.000Z', 'active',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO cli_refresh_credentials (
          id, user_id, token_hash, expires_at, created_at, family_id
        ) VALUES ('cred-b', 'bot1', 'hash-b', ?, '2026-01-01T00:00:00.000Z',
          'family-b')`,
      )
      .run(credentialExpiresAt)
    sqlite
      .prepare(
        `INSERT INTO cli_session_authorities (
          session_id, family_id, kind, preset, bearer_only, created_at
        ) VALUES ('bs1', 'family-b', 'family', 'agent', 1,
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
  }

  test('a bot session without an authority row is denied, never unrestricted', async () => {
    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toBe(
      'denied',
    )
  })

  test('a bot with an active agent family and live credential resolves', async () => {
    seedBotFamily()
    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toEqual(
      {
        kind: 'agent',
        familyId: 'family-b',
        workspaceId: 'ws1',
        projectId: 'project-b',
        projectNameSnapshot: 'Bot output',
        agentProfileId: 'agent-b',
      },
    )
  })

  test('resolves a bridge family only through its bounded bridge authority', async () => {
    seedBotFamily()
    sqlite
      .prepare(
        `INSERT INTO bridge_authorities (
          id, workspace_id, bot_user_id, agent_profile_id, source_kind,
          source_installation_id, external_workspace_id, fallback_project_id,
          created_at, updated_at
        ) VALUES ('bridge-b', 'ws1', 'bot1', 'agent-b', 'qm', 'install-1',
          'slack-ws-1', 'project-b', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `UPDATE cli_family_authorities
         SET bridge_authority_id = 'bridge-b'
         WHERE family_id = 'family-b'`,
      )
      .run()

    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toEqual(
      {
        kind: 'bridge',
        familyId: 'family-b',
        bridgeAuthorityId: 'bridge-b',
        workspaceId: 'ws1',
        fallbackProjectId: 'project-b',
        agentProfileId: 'agent-b',
        sourceKind: 'qm',
        sourceInstallationId: 'install-1',
        externalWorkspaceId: 'slack-ws-1',
      },
    )
  })

  test('a bot whose credential expired is denied per request even with a live session', async () => {
    // Credential seeded just at the boundary: expired credential with a
    // still-valid session must be rejected on every request.
    seedBotFamily({ credentialExpiresAt: '2020-01-01T00:00:00.000Z' })
    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toBe(
      'denied',
    )
  })

  test('a revoked family or a stopped bot is denied', async () => {
    seedBotFamily()
    sqlite
      .prepare(
        "UPDATE cli_family_authorities SET status = 'revoked' WHERE family_id = 'family-b'",
      )
      .run()
    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toBe(
      'denied',
    )
    sqlite
      .prepare(
        "UPDATE cli_family_authorities SET status = 'active' WHERE family_id = 'family-b'",
      )
      .run()
    sqlite
      .prepare(
        "UPDATE users SET bot_stopped_at = '2026-02-01T00:00:00.000Z' WHERE id = 'bot1'",
      )
      .run()
    await expect(resolveCliAuthorityBySessionToken('ass_bot')).resolves.toBe(
      'denied',
    )
  })
})

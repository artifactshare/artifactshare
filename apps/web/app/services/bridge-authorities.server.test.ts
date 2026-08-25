import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  createBridgeAuthorityForBot,
  readLiveBridgeAuthority,
} from './bridge-authorities.server'

let sqlite: DatabaseSync
let db: Kysely<DB>

beforeEach(() => {
  const fixture = createMigratedInMemoryDb()
  sqlite = fixture.sqlite
  db = fixture.db
  seedWorkspace(sqlite)
  seedUser(sqlite, 'admin')
  sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, role, status, created_at, updated_at
      ) VALUES ('ws1', 'admin', 'owner', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at,
        workspace_id, kind
      ) VALUES ('bot1', 'bot@bots.artifactshare.invalid', 1, 'Bridge bot',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        'ws1', 'bot')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO artifact_containers (
        id, workspace_id, kind, created_by_id, name, base_visibility,
        created_at, updated_at
      ) VALUES ('fallback-1', 'ws1', 'project', 'admin', 'Fallback',
        'workspace', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
       VALUES ('agent-1', 'bot1', 'ws1', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id,
        project_name_snapshot, agent_profile_id, status, created_at, updated_at
      ) VALUES ('family-1', 'bot1', 'agent', 'ws1', 'fallback-1', 'Fallback',
        'agent-1', 'active', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')`,
    )
    .run()
})

afterEach(async () => {
  await db.destroy()
})

describe('bridge authority provisioning', () => {
  test('binds one source namespace to the active bot credential family', async () => {
    const result = await createBridgeAuthorityForBot(
      db,
      { id: 'admin', workspaceId: 'ws1' },
      {
        botUserId: 'bot1',
        fallbackProjectId: 'fallback-1',
        sourceKind: 'qm',
        sourceInstallationId: 'install-1',
        externalWorkspaceId: 'slack-ws-1',
      },
    )
    expect(result).toMatchObject({
      kind: 'ok',
      authority: {
        botUserId: 'bot1',
        fallbackProjectId: 'fallback-1',
        sourceKind: 'qm',
      },
    })
    expect(
      sqlite
        .prepare(
          `SELECT bridge_authority_id FROM cli_family_authorities
           WHERE family_id = 'family-1'`,
        )
        .get(),
    ).toEqual({
      bridge_authority_id:
        result.kind === 'ok' ? result.authority.id : 'unreachable',
    })
  })

  test('fails health when the fallback becomes archived', async () => {
    const created = await createBridgeAuthorityForBot(
      db,
      { id: 'admin', workspaceId: 'ws1' },
      {
        botUserId: 'bot1',
        fallbackProjectId: 'fallback-1',
        sourceKind: 'qm',
        sourceInstallationId: 'install-1',
        externalWorkspaceId: 'slack-ws-1',
      },
    )
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    sqlite
      .prepare(
        `UPDATE artifact_containers
         SET archived_at = '2026-02-01T00:00:00.000Z'
         WHERE id = 'fallback-1'`,
      )
      .run()
    await expect(
      readLiveBridgeAuthority(db, created.authority.id),
    ).resolves.toEqual({ kind: 'fallback-invalid' })
  })
})

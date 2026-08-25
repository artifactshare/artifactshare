import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const {
  attachAgentBootstrapAuthority,
  loadAgentApprovalContext,
  loadDeviceAuthorizationIntent,
  readDeviceAuthorizationIntent,
  selectAgentApprovalProject,
  storeDeviceAuthorizationIntent,
} = await import('./cli-device-authority.server')

describe('CLI device authorization intent', () => {
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
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, created_at, updated_at
        ) VALUES ('project-1', 'ws1', 'project', 'u1', 'u1', 'Agent output',
          'workspace',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO deviceCode (
          id, deviceCode, userCode, userId, expiresAt, status, clientId
        ) VALUES ('dc1', 'device-1', 'ABCD1234', 'u1',
          '2099-01-01T00:00:00.000Z', 'pending', 'artifactshare-cli')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('validates and stores an agent intent', async () => {
    const intent = readDeviceAuthorizationIntent({
      preset: 'agent',
      device_name: ' Codex ',
    })
    expect(intent).toEqual({
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await storeDeviceAuthorizationIntent('device-1', intent!)
    await expect(loadDeviceAuthorizationIntent('device-1')).resolves.toEqual({
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
      selectedProjectId: null,
    })
  })

  test('validates a bounded agent project selector and rejects unrestricted pairing', () => {
    const selector = '界'.repeat(120)
    expect(
      readDeviceAuthorizationIntent({
        preset: 'agent',
        project_selector: `  ${selector}  `,
      }),
    ).toMatchObject({ projectSelector: selector })
    expect(
      readDeviceAuthorizationIntent({
        preset: 'agent',
        project_selector: '界'.repeat(121),
      }),
    ).toBeNull()
    expect(
      readDeviceAuthorizationIntent({
        preset: 'unrestricted',
        project_selector: 'Agent output',
      }),
    ).toBeNull()
  })

  test('resolves a fixed project by name and treats an existing invalid id as terminal', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: 'agent OUTPUT',
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({
      fixedProjectError: false,
      fixedProject: { id: 'project-1', name: 'Agent output' },
    })
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, created_at, updated_at
        ) VALUES ('project-2', 'ws1', 'project', 'u1', 'u1', 'Other',
          'workspace', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        email: 'u1@example.com',
        projectId: 'project-2',
      }),
    ).resolves.toBe(false)

    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, archived_at, created_at, updated_at
        ) VALUES ('Agent output', 'ws1', 'project', 'u1', 'u1', 'Archived',
          'workspace', '2026-01-02T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      .run()
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: 'Agent output',
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({
      fixedProject: null,
      fixedProjectError: true,
    })
  })

  test('binds the selected project and creates a short-lived bootstrap', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'u1',
        workspaceId: 'ws1',
        email: 'user@example.com',
        projectId: 'project-1',
      }),
    ).resolves.toBe(true)
    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) VALUES ('s1', 'u1', 'session-1', '2099-01-01T00:00:00.000Z',
          'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const intent = await loadDeviceAuthorizationIntent('device-1')
    await expect(
      attachAgentBootstrapAuthority('session-1', intent!),
    ).resolves.toBe(true)
    const authority = sqlite
      .prepare(
        `SELECT preset, project_id, agent_profile_id, kind
           FROM cli_session_authorities WHERE session_id = 's1'`,
      )
      .get()
    expect(authority).toMatchObject({
      preset: 'agent',
      project_id: 'project-1',
      kind: 'bootstrap',
    })
    expect(authority?.agent_profile_id).toEqual(expect.any(String))

    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) VALUES ('s2', 'u1', 'session-2', '2099-01-01T00:00:00.000Z',
          'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await expect(
      attachAgentBootstrapAuthority('session-2', intent!),
    ).resolves.toBe(true)
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count,
                  COUNT(DISTINCT agent_profile_id) AS profile_count
             FROM cli_session_authorities`,
        )
        .get(),
    ).toEqual({ count: 2, profile_count: 1 })
  })

  test('shows only publishable projects and binds only for the claiming user', async () => {
    await storeDeviceAuthorizationIntent('device-1', {
      preset: 'agent',
      deviceName: 'Codex',
      projectSelector: null,
    })
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({})
    await expect(
      selectAgentApprovalProject({
        userCode: 'ABCD1234',
        userId: 'other-user',
        workspaceId: 'ws1',
        email: 'u1@example.com',
        projectId: 'project-1',
      }),
    ).resolves.toBe(false)
    sqlite
      .prepare(
        "UPDATE artifact_containers SET base_visibility = 'private' WHERE id = 'project-1'",
      )
      .run()
    await expect(
      loadAgentApprovalContext('ABCD1234', 'u1', 'ws1', 'u1@example.com'),
    ).resolves.toMatchObject({ preset: 'agent' })
  })
})

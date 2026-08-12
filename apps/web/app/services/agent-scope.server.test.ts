import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'
import type { CliAuthority } from './cli-authority.server'
import { listAgentReadableArtifacts } from './cli-artifacts.server'
import { isAgentReadableArtifact } from './agent-scope.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const user: SessionUser = {
  id: 'u1',
  email: 'u1@example.com',
  emailVerified: true,
  name: 'User u1',
  image: null,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  locale: 'en',
}

const authority: Extract<CliAuthority, { kind: 'agent' }> = {
  kind: 'agent',
  familyId: 'family-1',
  workspaceId: 'ws1',
  projectId: 'project-1',
  projectNameSnapshot: 'Approved project',
  agentProfileId: 'agent-1',
}

describe('agent artifact read scope', () => {
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
        ) VALUES
          ('inbox-1', 'ws1', 'inbox', 'u1', 'u1', 'Home',
            'private', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-1', 'ws1', 'project', 'u1', 'u1', 'Approved project',
            'workspace', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-2', 'ws1', 'project', 'u1', 'u1', 'Other project',
            'workspace', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          container_id, created_at, updated_at
        ) VALUES
          ('approved-artifact', 'ws1', 'u1', 'Approved', 'markdown_page',
            'workspace', 'project-1', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('other-artifact', 'ws1', 'u1', 'Other', 'markdown_page',
            'workspace', 'project-2', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('home-artifact', 'ws1', 'u1', 'Home', 'markdown_page',
            'workspace', 'inbox-1', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('allows reads only inside the approved project', async () => {
    await expect(
      isAgentReadableArtifact(db, user, authority, 'approved-artifact'),
    ).resolves.toBe(true)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'other-artifact'),
    ).resolves.toBe(false)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'home-artifact'),
    ).resolves.toBe(false)
  })

  test('lists only artifacts inside the approved project', async () => {
    const result = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts.map((artifact) => artifact.id)).toEqual([
      'approved-artifact',
    ])
  })
})

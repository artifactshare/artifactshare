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

const sqliteRef = vi.hoisted(() => ({ current: null as DatabaseSync | null }))
vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const {
  decodeProjectCandidateCursor,
  listProjectCandidates,
  normalizeProjectCandidateQuery,
} = await import('./project-candidates.server')

const USER: SessionUser = {
  id: 'u1',
  email: 'user@example.com',
  emailVerified: true,
  name: 'User',
  image: null,
  workspaceId: 'ws1',
  hd: null,
  msTenantId: null,
  locale: 'en',
  kind: 'human',
}

describe('project candidate search', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    const insert = sqlite.prepare(`INSERT INTO artifact_containers (
      id, workspace_id, kind, owner_user_id, created_by_id, name,
      base_visibility, created_at, updated_at
    ) VALUES (?, 'ws1', 'project', 'u1', 'u1', ?, ?,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
    for (let i = 0; i < 25; i++) {
      insert.run(
        `project-${String(i).padStart(2, '0')}`,
        `Project ${String(i).padStart(2, '0')}`,
        i === 24 ? 'private' : 'workspace',
      )
    }
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('normalizes safely and treats LIKE metacharacters literally', async () => {
    expect(
      normalizeProjectCandidateQuery(`  ${'😀'.repeat(101)}  `),
    ).toHaveLength(200)
    const page = await listProjectCandidates({
      user: USER,
      purpose: 'bot-destination',
      query: '%',
      cursor: null,
    })
    expect(page.projects).toEqual([])
  })

  test('returns stable pages without loading every project', async () => {
    const first = await listProjectCandidates({
      user: USER,
      purpose: 'bot-destination',
      query: '',
      cursor: null,
    })
    expect(first.projects).toHaveLength(20)
    expect(first.nextCursor).toEqual(expect.any(String))
    const cursor = decodeProjectCandidateCursor(
      first.nextCursor,
      'bot-destination',
      '',
    )
    expect(cursor).not.toBe('invalid')
    const second = await listProjectCandidates({
      user: USER,
      purpose: 'bot-destination',
      query: '',
      cursor: cursor as Exclude<typeof cursor, 'invalid'>,
    })
    expect(second.projects).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
  })

  test('agent candidates exclude an unshared private project', async () => {
    const page = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: 'Project 24',
      cursor: null,
    })
    expect(page.projects).toEqual([])
    sqlite
      .prepare(`INSERT INTO project_share_defaults (
      id, project_container_id, email, role, created_by_id, created_at, updated_at
    ) VALUES ('grant-1', 'project-24', 'USER@example.com', 'contributor', 'u1',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run()
    const shared = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: 'Project 24',
      cursor: null,
    })
    expect(shared.projects.map((project) => project.id)).toEqual(['project-24'])
  })
})

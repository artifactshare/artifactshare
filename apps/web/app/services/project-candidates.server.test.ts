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
  PROJECT_CANDIDATE_PAGE_SIZE,
  PROJECT_CANDIDATE_SEARCH_THRESHOLD,
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
    expect(PROJECT_CANDIDATE_PAGE_SIZE).toBeGreaterThan(
      PROJECT_CANDIDATE_SEARCH_THRESHOLD,
    )
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

  test('accepts cursors created before preferred project metadata existed', () => {
    const legacyCursor = btoa(
      JSON.stringify({
        purpose: 'bot-destination',
        query: '',
        name: 'Project 19',
        id: 'project-19',
      }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')

    expect(
      decodeProjectCandidateCursor(legacyCursor, 'bot-destination', ''),
    ).toEqual({
      purpose: 'bot-destination',
      query: '',
      name: 'Project 19',
      id: 'project-19',
      preferredProjectId: null,
    })
  })

  test('returns stable pages without loading every project', async () => {
    const first = await listProjectCandidates({
      user: USER,
      purpose: 'bot-destination',
      query: '',
      cursor: null,
    })
    expect(first.preferredProject).toBeNull()
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

  test('limits a previous browser bundle to the fixed requested project', async () => {
    sqlite
      .prepare(`INSERT INTO deviceCode (
        id, deviceCode, userCode, userId, expiresAt, status, preset,
        requestedProjectSelector
      ) VALUES (
        'device-1', 'device-token-1', 'ABCD1234', 'u1',
        '2099-01-01T00:00:00.000Z', 'pending', 'agent', 'Project 03'
      )`)
      .run()

    const page = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: '',
      cursor: null,
      userCode: 'ABCD1234',
    })

    expect(page.projects.map((project) => project.id)).toEqual(['project-03'])
    expect(page.preferredProject?.id).toBe('project-03')
    expect(page.nextCursor).toBeNull()
  })

  test('returns the latest eligible agent project in both response shapes', async () => {
    sqlite
      .prepare(`INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
        VALUES ('profile-u1', 'u1', 'ws1', '2026-01-01T00:00:00.000Z')`)
      .run()
    sqlite
      .prepare(`INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id,
        project_name_snapshot, agent_profile_id, approved_at, device_name,
        status, created_at, updated_at
      ) VALUES (
        'family-u1', 'u1', 'agent', 'ws1', 'project-03',
        'Project 03', 'profile-u1', '2026-02-01T00:00:00.000Z', NULL,
        'revoked', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'
      )`)
      .run()

    const page = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: '',
      cursor: null,
    })

    expect(page.preferredProject?.id).toBe('project-03')
    expect(page.projects[0]?.id).toBe('project-03')
    expect(page.projects).toHaveLength(PROJECT_CANDIDATE_PAGE_SIZE)
    const cursor = decodeProjectCandidateCursor(
      page.nextCursor,
      'agent-approval',
      '',
    )
    expect(cursor).not.toBe('invalid')
    const next = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: '',
      cursor: cursor as Exclude<typeof cursor, 'invalid'>,
    })
    expect(next.preferredProject).toBeNull()
    expect(next.projects.map((project) => project.id)).not.toContain(
      'project-03',
    )
    expect(next.nextCursor).toBeNull()
  })

  test('uses the latest successful bot creation as the bot destination preference', async () => {
    sqlite
      .prepare(`INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, locale, kind, bot_stopped_at
      ) VALUES (
        'bot-1', 'bot-1@bots.artifactshare.invalid', 1, 'Bot', NULL,
        '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
        'ws1', NULL, 'bot', NULL
      )`)
      .run()
    sqlite
      .prepare(`INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
        VALUES ('profile-bot-1', 'bot-1', 'ws1', '2026-02-01T00:00:00.000Z')`)
      .run()
    sqlite
      .prepare(`INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id,
        project_name_snapshot, agent_profile_id, approved_at, device_name,
        status, created_at, updated_at
      ) VALUES (
        'family-bot-1', 'bot-1', 'agent', 'ws1', 'project-05',
        'Project 05', 'profile-bot-1', '2026-02-01T00:00:00.000Z', NULL,
        'active', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'
      )`)
      .run()
    sqlite
      .prepare(`INSERT INTO audit_events (
        id, workspace_id, actor_user_id, action, subject_type, subject_id,
        detail, created_at
      ) VALUES (
        'audit-bot-1', 'ws1', 'u1', 'bot.create', 'user', 'bot-1',
        '{"project_id":"project-05"}', '2026-02-01T00:00:00.000Z'
      )`)
      .run()

    sqlite
      .prepare(`INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, locale, kind, bot_stopped_at
      ) VALUES (
        'bot-failed', 'bot-failed@bots.artifactshare.invalid', 1, 'Failed bot', NULL,
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
        'ws1', NULL, 'bot', '2026-03-01T00:00:01.000Z'
      )`)
      .run()
    sqlite
      .prepare(`INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
        VALUES ('profile-bot-failed', 'bot-failed', 'ws1', '2026-03-01T00:00:00.000Z')`)
      .run()
    sqlite
      .prepare(`INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id,
        project_name_snapshot, agent_profile_id, approved_at, device_name,
        status, created_at, updated_at
      ) VALUES (
        'family-bot-failed', 'bot-failed', 'agent', 'ws1', 'project-06',
        'Project 06', 'profile-bot-failed', '2026-03-01T00:00:00.000Z', NULL,
        'revoked', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z'
      )`)
      .run()
    sqlite
      .prepare(`INSERT INTO audit_events (
        id, workspace_id, actor_user_id, action, subject_type, subject_id,
        detail, created_at
      ) VALUES (
        'audit-bot-failed', 'ws1', 'u1', 'bot.create', 'user', 'bot-failed',
        '{"project_id":"project-06"}', '2026-03-01T00:00:00.000Z'
      )`)
      .run()

    const page = await listProjectCandidates({
      user: USER,
      purpose: 'bot-destination',
      query: '',
      cursor: null,
    })

    expect(page.preferredProject?.id).toBe('project-05')
    expect(page.projects[0]?.id).toBe('project-05')
  })

  test('does not fall back when the latest historical project is no longer eligible', async () => {
    sqlite
      .prepare(`INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
        VALUES ('profile-u1', 'u1', 'ws1', '2026-01-01T00:00:00.000Z')`)
      .run()
    const insert = sqlite.prepare(`INSERT INTO cli_family_authorities (
      family_id, user_id, preset, workspace_id, project_id,
      project_name_snapshot, agent_profile_id, approved_at, device_name,
      status, created_at, updated_at
    ) VALUES (?, 'u1', 'agent', 'ws1', ?, ?, 'profile-u1', ?, NULL,
      'revoked', ?, ?)`)
    insert.run(
      'family-older',
      'project-03',
      'Project 03',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    )
    insert.run(
      'family-latest',
      'project-24',
      'Project 24',
      '2026-03-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    )

    const page = await listProjectCandidates({
      user: USER,
      purpose: 'agent-approval',
      query: '',
      cursor: null,
    })

    expect(page.preferredProject).toBeNull()
    expect(page.projects.map((project) => project.id)).toContain('project-03')
  })
})

import { vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { describe, expect, test } from 'vitest'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'
import {
  countProjectParticipants,
  joinProject,
  leaveProject,
  listJoinedProjectsForDropdown,
  listProjectsForIndex,
  touchProjectSeen,
} from './project-membership.server'

type Db = Kysely<DB>

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    emailVerified: true,
    name: 'U1',
    image: null,
    hd: 'example.com',
    ...over,
  } as SessionUser
}

async function fixture() {
  const f = createMigratedInMemoryDb()
  const db = f.db as Db
  for (const [id, hd] of [
    ['w1', 'example.com'],
    ['w2', 'partner.example.com'],
  ] as const) {
    await db
      .insertInto('workspaces')
      .values({
        id,
        name: id,
        hd,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  for (const [id, ws, verified] of [
    ['u1', 'w1', 1],
    ['u2', 'w1', 1],
    ['g1', 'w2', 1],
    ['g2', 'w2', 0],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@${ws === 'w1' ? 'example.com' : 'partner.example.com'}`,
        name: id,
        email_verified: verified,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: ws,
        locale: null,
      })
      .execute()
  }
  async function project(
    id: string,
    {
      visibility = 'workspace' as 'workspace' | 'private',
      createdBy = 'u2',
      archived = false,
    } = {},
  ) {
    await db
      .insertInto('artifact_containers')
      .values({
        id,
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: null,
        created_by_id: createdBy,
        name: `Project ${id}`,
        base_visibility: visibility,
        archived_at: archived ? '2026-06-01T00:00:00Z' : null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  async function grant(containerId: string, email: string) {
    await db
      .insertInto('project_share_defaults')
      .values({
        id: `d-${containerId}-${email}`,
        project_container_id: containerId,
        email,
        role: 'viewer',
        display_name: null,
        created_by_id: 'u2',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  return { db, project, grant }
}

describe('joinProject / leaveProject', () => {
  test('member joins, double join is a no-op, leave then rejoin works', async () => {
    const { db, project } = await fixture()
    await project('p1')
    expect(await joinProject(db, { containerId: 'p1', user: user() })).toBe(
      'joined',
    )
    expect(await joinProject(db, { containerId: 'p1', user: user() })).toBe(
      'joined',
    )
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(1)
    expect(await leaveProject(db, { containerId: 'p1', user: user() })).toBe(
      'left',
    )
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(0)
    expect(await joinProject(db, { containerId: 'p1', user: user() })).toBe(
      'joined',
    )
  })

  test('private project rejects non-stakeholders and accepts granted members', async () => {
    const { db, project, grant } = await fixture()
    await project('p-priv', { visibility: 'private' })
    expect(await joinProject(db, { containerId: 'p-priv', user: user() })).toBe(
      'not-found',
    )
    await grant('p-priv', 'u1@example.com')
    expect(await joinProject(db, { containerId: 'p-priv', user: user() })).toBe(
      'joined',
    )
  })

  test('archived project rejects join', async () => {
    const { db, project } = await fixture()
    await project('p-arch', { archived: true })
    expect(await joinProject(db, { containerId: 'p-arch', user: user() })).toBe(
      'not-found',
    )
  })

  test('cross-workspace guest joins only with a verified granted email', async () => {
    const { db, project, grant } = await fixture()
    await project('p1')
    await grant('p1', 'g1@partner.example.com')
    await grant('p1', 'g2@partner.example.com')
    const g1 = user({
      id: 'g1',
      workspaceId: 'w2',
      email: 'g1@partner.example.com',
    })
    expect(await joinProject(db, { containerId: 'p1', user: g1 })).toBe(
      'joined',
    )
    const g2 = user({
      id: 'g2',
      workspaceId: 'w2',
      email: 'g2@partner.example.com',
      emailVerified: false,
    })
    expect(await joinProject(db, { containerId: 'p1', user: g2 })).toBe(
      'not-found',
    )
    const outsider = user({
      id: 'g1',
      workspaceId: 'w2',
      email: 'other@partner.example.com',
    })
    expect(await joinProject(db, { containerId: 'p1', user: outsider })).toBe(
      'not-found',
    )
  })
})

describe('team admin access', () => {
  test('team workspace owner can see and join a private project without a grant', async () => {
    const { db, project } = await fixture()
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'w1')
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'w1',
        user_id: 'u1',
        role: 'owner',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await project('p-priv', { visibility: 'private' })
    const rows = await listProjectsForIndex(db, user())
    expect(rows.map((r) => r.id)).toContain('p-priv')
    expect(await joinProject(db, { containerId: 'p-priv', user: user() })).toBe(
      'joined',
    )
    expect(await countProjectParticipants(db, 'p-priv')).toBe(1)
  })
})

describe('listProjectsForIndex', () => {
  test('splits joined and joinable, hides private from non-stakeholders', async () => {
    const { db, project, grant } = await fixture()
    await project('p-open')
    await project('p-joined')
    await project('p-priv-in', { visibility: 'private' })
    await project('p-priv-out', { visibility: 'private' })
    await grant('p-priv-in', 'u1@example.com')
    await joinProject(db, { containerId: 'p-joined', user: user() })
    const rows = await listProjectsForIndex(db, user())
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('p-open')
    expect(ids).toContain('p-joined')
    expect(ids).toContain('p-priv-in')
    expect(ids).not.toContain('p-priv-out')
    expect(rows.find((r) => r.id === 'p-joined')?.joined).toBe(true)
    expect(rows.find((r) => r.id === 'p-open')?.joined).toBe(false)
  })

  test('shadow mode compares the facts projection without changing results', async () => {
    const { db, project, grant } = await fixture()
    await project('p-open')
    await project('p-granted', { visibility: 'private' })
    await project('p-hidden', { visibility: 'private' })
    await grant('p-granted', 'u1@example.com')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rows = await listProjectsForIndex(db, user(), {
      APP_ENV: 'development',
      DEV_FLAGS: 'access-resolve=shadow',
    })

    expect(rows.map((row) => row.id).sort()).toEqual(['p-granted', 'p-open'])
    expect(info).toHaveBeenCalledWith('artifactshare_access_resolve_shadow', {
      surface: 'projects_list',
      mode: 'shadow',
      comparedCount: 3,
      legacyAllowedCount: 2,
      factsAllowedCount: 2,
      migrationDiff: 0,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  test('shadow mode logs a migration_diff but keeps the legacy result', async () => {
    const { db, project } = await fixture()
    await project('p-owned-private', {
      visibility: 'private',
      createdBy: 'u1',
    })
    const staleSession = user({ workspaceId: 'w2' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rows = await listProjectsForIndex(db, staleSession, {
      APP_ENV: 'development',
      DEV_FLAGS: 'access-resolve=shadow',
    })

    expect(rows).toEqual([])
    expect(warn).toHaveBeenCalledWith('migration_diff', {
      surface: 'projects_list',
      legacyOnlyCount: 0,
      factsOnlyCount: 1,
    })
  })

  test('shadow mode keeps a legacy-only result and counts the migration_diff', async () => {
    const { db, project } = await fixture()
    await project('p-owned-private', {
      visibility: 'private',
      createdBy: 'u1',
    })
    await db
      .updateTable('users')
      .set({ workspace_id: 'w2' })
      .where('id', '=', 'u1')
      .execute()
    const staleSession = user()
    const legacyRows = await listProjectsForIndex(db, staleSession)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rows = await listProjectsForIndex(db, staleSession, {
      APP_ENV: 'development',
      DEV_FLAGS: 'access-resolve=shadow',
    })

    expect(rows.map((row) => row.id)).toEqual(['p-owned-private'])
    expect(rows).toEqual(legacyRows)
    expect(info).toHaveBeenCalledWith('artifactshare_access_resolve_shadow', {
      surface: 'projects_list',
      mode: 'shadow',
      comparedCount: 1,
      legacyAllowedCount: 1,
      factsAllowedCount: 0,
      migrationDiff: 1,
    })
    expect(warn).toHaveBeenCalledWith('migration_diff', {
      surface: 'projects_list',
      legacyOnlyCount: 1,
      factsOnlyCount: 0,
    })
  })

  test.each([
    { direction: 'legacy-only', dbVerified: 0, sessionVerified: true },
    { direction: 'facts-only', dbVerified: 1, sessionVerified: false },
  ])(
    'shadow records $direction differences with a NULL creator',
    async ({ dbVerified, sessionVerified }) => {
      const { db, project, grant } = await fixture()
      await project('p-null-creator', { visibility: 'private' })
      await db
        .updateTable('artifact_containers')
        .set({ created_by_id: null })
        .where('id', '=', 'p-null-creator')
        .execute()
      await grant('p-null-creator', 'U1@EXAMPLE.COM')
      await db
        .updateTable('users')
        .set({ email_verified: dbVerified })
        .where('id', '=', 'u1')
        .execute()
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      info.mockClear()
      warn.mockClear()

      const rows = await listProjectsForIndex(
        db,
        user({ emailVerified: sessionVerified }),
        { APP_ENV: 'development', DEV_FLAGS: 'access-resolve=shadow' },
      )

      expect(rows.map((row) => row.id)).toEqual(
        sessionVerified ? ['p-null-creator'] : [],
      )
      expect(info).toHaveBeenCalledWith('artifactshare_access_resolve_shadow', {
        surface: 'projects_list',
        mode: 'shadow',
        comparedCount: 1,
        legacyAllowedCount: Number(sessionVerified),
        factsAllowedCount: dbVerified,
        migrationDiff: 1,
      })
      expect(warn).toHaveBeenCalledWith('migration_diff', {
        surface: 'projects_list',
        legacyOnlyCount: Number(sessionVerified),
        factsOnlyCount: dbVerified,
      })
    },
  )

  test.each(['canary', 'on'] as const)(
    'DEV_FLAGS %s without a Flagship binding keeps the legacy/off result',
    async (mode) => {
      const { db, project } = await fixture()
      await project('p-owned-private', {
        visibility: 'private',
        createdBy: 'u1',
      })
      const staleSession = user({ workspaceId: 'w2' })
      const legacyRows = await listProjectsForIndex(db, staleSession, {
        APP_ENV: 'development',
        DEV_FLAGS: 'access-resolve=off',
      })

      const rows = await listProjectsForIndex(db, staleSession, {
        APP_ENV: 'development',
        DEV_FLAGS: `access-resolve=${mode}`,
      })

      expect(legacyRows).toEqual([])
      expect(rows).toEqual(legacyRows)
    },
  )

  test.each(['canary', 'on'] as const)(
    '%s mode returns facts-only rows using the request workspace flag context',
    async (mode) => {
      const { db, project } = await fixture()
      await project('p-owned-private', {
        visibility: 'private',
        createdBy: 'u1',
      })
      const staleSession = user({ workspaceId: 'w2' })
      expect(await listProjectsForIndex(db, staleSession)).toEqual([])
      const getStringValue = vi.fn().mockResolvedValue(mode)
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const rows = await listProjectsForIndex(db, staleSession, {
        FLAGS: { getStringValue },
      })

      expect(getStringValue).toHaveBeenCalledExactlyOnceWith(
        'access-resolve',
        'off',
        { targetingKey: 'w2', workspaceId: 'w2' },
      )
      expect(rows.map((row) => row.id)).toEqual(['p-owned-private'])
      expect(Object.keys(rows[0]).sort()).toEqual(
        [
          'id',
          'name',
          'description',
          'baseVisibility',
          'updatedAt',
          'archivedAt',
          'workspaceId',
          'fileCount',
          'newCount',
          'hasExternal',
          'joined',
        ].sort(),
      )
      expect(info).toHaveBeenCalledWith('artifactshare_access_resolve_shadow', {
        surface: 'projects_list',
        mode,
        comparedCount: 1,
        legacyAllowedCount: 0,
        factsAllowedCount: 1,
        migrationDiff: 1,
      })
      expect(warn).toHaveBeenCalledWith('migration_diff', {
        surface: 'projects_list',
        legacyOnlyCount: 0,
        factsOnlyCount: 1,
      })
    },
  )

  test.each(['canary', 'on'] as const)(
    '%s mode excludes legacy-only rows while retaining comparison evidence',
    async (mode) => {
      const { db, project } = await fixture()
      await project('p-owned-private', {
        visibility: 'private',
        createdBy: 'u1',
      })
      await db
        .updateTable('users')
        .set({ workspace_id: 'w2' })
        .where('id', '=', 'u1')
        .execute()
      const staleSession = user()
      const legacyRows = await listProjectsForIndex(db, staleSession)
      expect(legacyRows.map((row) => row.id)).toEqual(['p-owned-private'])
      const getStringValue = vi.fn().mockResolvedValue(mode)
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const rows = await listProjectsForIndex(db, staleSession, {
        FLAGS: { getStringValue },
      })

      expect(getStringValue).toHaveBeenCalledExactlyOnceWith(
        'access-resolve',
        'off',
        { targetingKey: 'w1', workspaceId: 'w1' },
      )
      expect(rows).toEqual([])
      expect(info).toHaveBeenCalledWith('artifactshare_access_resolve_shadow', {
        surface: 'projects_list',
        mode,
        comparedCount: 1,
        legacyAllowedCount: 1,
        factsAllowedCount: 0,
        migrationDiff: 1,
      })
      expect(warn).toHaveBeenCalledWith('migration_diff', {
        surface: 'projects_list',
        legacyOnlyCount: 1,
        factsOnlyCount: 0,
      })
    },
  )

  test('new count ignores own files and files created before joining', async () => {
    const { db, project } = await fixture()
    await project('p1')
    async function file(id: string, owner: string, createdAt: string) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: owner,
          name: id,
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          container_id: 'p1',
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute()
    }
    await file('s-before', 'u2', '2026-06-01T00:00:00Z')
    await joinProject(db, { containerId: 'p1', user: user() })
    // 参加を過去へ倒し、その後に追加されたファイルだけが新着になることを見る
    await db
      .updateTable('project_members')
      .set({ last_seen_at: '2026-06-02T00:00:00Z' })
      .execute()
    const recent = new Date(Date.now() - 1000).toISOString()
    await file('s-after-mine', 'u1', recent)
    await file('s-after-other', 'u2', recent)
    const rows = await listProjectsForIndex(db, user())
    expect(rows.find((r) => r.id === 'p1')?.newCount).toBe(1)
    await touchProjectSeen(db, { containerId: 'p1', userId: 'u1' })
    const after = await listProjectsForIndex(db, user())
    expect(after.find((r) => r.id === 'p1')?.newCount).toBe(0)
  })

  test.each(['off', 'shadow'] as const)(
    '%s retains a stale shared project row but revokes DB-owned file and new counts',
    async (mode) => {
      const { db, project, grant } = await fixture()
      await project('p-shared', { visibility: 'private' })
      await grant('p-shared', 'G1@PARTNER.EXAMPLE.COM')
      const staleSession = user({
        id: 'g1',
        workspaceId: 'w2',
        email: 'g1@partner.example.com',
        emailVerified: true,
      })
      await db
        .insertInto('project_members')
        .values({
          container_id: 'p-shared',
          user_id: 'g1',
          joined_at: '2026-09-15T00:00:00.000Z',
          last_seen_at: '2026-09-15T00:00:00.000Z',
        })
        .execute()
      await db
        .insertInto('shareables')
        .values({
          id: 'shared-project-file',
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: 'shared-project-file',
          artifact_kind: 'markdown_page',
          visibility: 'project',
          container_id: 'p-shared',
          created_at: '2026-09-15T00:00:01.000Z',
          updated_at: '2026-09-15T00:00:01.000Z',
        })
        .execute()
      const source = {
        APP_ENV: 'development',
        DEV_FLAGS: `access-resolve=${mode}`,
      }
      const before = await listProjectsForIndex(db, staleSession, source)
      expect(before).toHaveLength(1)
      expect(before[0]).toMatchObject({
        id: 'p-shared',
        joined: true,
        fileCount: 1,
        newCount: 1,
      })

      await db
        .updateTable('users')
        .set({ email_verified: 0 })
        .where('id', '=', 'g1')
        .execute()
      const after = await listProjectsForIndex(db, staleSession, source)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({
        id: 'p-shared',
        joined: true,
        fileCount: 0,
        newCount: 0,
      })
    },
  )

  test('uses DB viewer facts and a fixed clock for exact file and new counts', async () => {
    const { db, project } = await fixture()
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 1 })
      .where('id', '=', 'w1')
      .execute()
    await project('p-count')
    await joinProject(db, { containerId: 'p-count', user: user() })
    await db
      .updateTable('project_members')
      .set({ last_seen_at: '2026-09-15T00:00:00.000Z' })
      .where('container_id', '=', 'p-count')
      .where('user_id', '=', 'u1')
      .execute()
    const insert = async (
      id: string,
      visibility: 'workspace' | 'private' | 'link',
      linkExpiresAt: string | null = null,
      suspendedAt: string | null = null,
    ) => {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: id,
          artifact_kind: 'markdown_page',
          visibility,
          container_id: 'p-count',
          link_expires_at: linkExpiresAt,
          link_suspended_at: suspendedAt,
          created_at: '2026-09-15T00:00:01.000Z',
          updated_at: '2026-09-15T00:00:01.000Z',
        })
        .execute()
    }
    await insert('workspace-file', 'workspace')
    await insert('granted-private', 'private')
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'granted-private',
        granted_email: 'U1@EXAMPLE.COM',
        granted_at: '2026-09-15T00:00:00.000Z',
        granted_by: 'u2',
      })
      .execute()
    await insert('active-link', 'link', '2026-09-15T00:00:00.001Z')
    await insert(
      'suspended-link',
      'link',
      '2026-09-15T00:00:00.001Z',
      '2026-09-14T00:00:00.000Z',
    )
    await insert('expired-link', 'link', '2026-09-15T00:00:00.000Z')
    await insert('invalid-expiry-link', 'link', '2026-09-15 01:00:00')

    const staleSession = user({
      email: 'stale@example.test',
      emailVerified: false,
    })
    const enabled = await listProjectsForIndex(
      db,
      staleSession,
      { APP_ENV: 'development', DEV_FLAGS: 'access-resolve=off' },
      '2026-09-15T00:00:00.000Z',
    )
    expect(enabled.find((row) => row.id === 'p-count')).toMatchObject({
      fileCount: 4,
      newCount: 4,
    })

    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', 'w1')
      .execute()
    const disabled = await listProjectsForIndex(
      db,
      staleSession,
      { APP_ENV: 'development', DEV_FLAGS: 'access-resolve=off' },
      '2026-09-15T00:00:00.000Z',
    )
    expect(disabled.find((row) => row.id === 'p-count')).toMatchObject({
      fileCount: 2,
      newCount: 2,
    })
  })

  test('lost-permission membership rows disappear from index and dropdown', async () => {
    const { db, project, grant } = await fixture()
    await project('p-priv', { visibility: 'private' })
    await grant('p-priv', 'u1@example.com')
    await joinProject(db, { containerId: 'p-priv', user: user() })
    await db.deleteFrom('project_share_defaults').execute()
    const rows = await listProjectsForIndex(db, user())
    expect(rows.map((r) => r.id)).not.toContain('p-priv')
    const dd = await listJoinedProjectsForDropdown(db, user(), 5)
    expect(dd.map((r) => r.id)).not.toContain('p-priv')
  })

  test('external chip flags off-domain granted emails only', async () => {
    const { db, project, grant } = await fixture()
    await project('p1')
    await project('p2')
    await grant('p1', 'g1@partner.example.com')
    await grant('p2', 'u2@example.com')
    const rows = await listProjectsForIndex(db, user())
    expect(rows.find((r) => r.id === 'p1')?.hasExternal).toBe(true)
    expect(rows.find((r) => r.id === 'p2')?.hasExternal).toBe(false)
  })
})

describe('dropdown and counts hygiene', () => {
  test('returns workspace context and updated order with the requested limit', async () => {
    const { db, project, grant } = await fixture()
    for (let i = 0; i < 6; i++) {
      await project(`p${i}`)
      await joinProject(db, { containerId: `p${i}`, user: user() })
      await db
        .updateTable('artifact_containers')
        .set({ updated_at: `2026-06-0${i + 1}T00:00:00Z` })
        .where('id', '=', `p${i}`)
        .execute()
    }
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'p-cross',
        workspace_id: 'w2',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'g1',
        name: 'Shared',
        base_visibility: 'private',
        archived_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      })
      .execute()
    await grant('p-cross', 'u1@example.com')
    await joinProject(db, { containerId: 'p-cross', user: user() })
    const rows = await listJoinedProjectsForDropdown(db, user(), 5)
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.id)).toEqual([
      'p-cross',
      'p5',
      'p4',
      'p3',
      'p2',
    ])
    expect(rows.find((row) => row.id === 'p2')).toMatchObject({
      workspaceName: undefined,
    })
    const cross = await listJoinedProjectsForDropdown(db, user(), 10)
    expect(cross.find((row) => row.id === 'p-cross')?.workspaceName).toBe('w2')
  })

  test('archived joined projects stay out of the dropdown', async () => {
    const { db, project } = await fixture()
    await project('p1')
    await joinProject(db, { containerId: 'p1', user: user() })
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-06-01T00:00:00Z' })
      .where('id', '=', 'p1')
      .execute()
    const dd = await listJoinedProjectsForDropdown(db, user(), 5)
    expect(dd.map((r) => r.id)).not.toContain('p1')
  })

  test("file and new counts exclude other users' private files", async () => {
    const { db, project } = await fixture()
    await project('p1')
    await joinProject(db, { containerId: 'p1', user: user() })
    await db
      .updateTable('project_members')
      .set({ last_seen_at: '2026-06-02T00:00:00Z' })
      .execute()
    const recent = new Date(Date.now() - 1000).toISOString()
    for (const [id, visibility] of [
      ['s-vis', 'workspace'],
      ['s-priv', 'private'],
    ] as const) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: id,
          artifact_kind: 'markdown_page',
          visibility,
          container_id: 'p1',
          created_at: recent,
          updated_at: recent,
        })
        .execute()
    }
    const rows = await listProjectsForIndex(db, user())
    const row = rows.find((r) => r.id === 'p1')
    expect(row?.fileCount).toBe(1)
    expect(row?.newCount).toBe(1)
    const dropdown = await listJoinedProjectsForDropdown(db, user(), 5)
    expect(dropdown.find((r) => r.id === 'p1')).toMatchObject({
      fileCount: 1,
      updatedAt: expect.any(String),
    })
  })
})

describe('cross-workspace archived projects', () => {
  test('archived shared projects from another workspace stay hidden', async () => {
    const { db } = await fixture()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'p-remote-arch',
        workspace_id: 'w2',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'g1',
        name: 'Remote archived',
        base_visibility: 'workspace',
        archived_at: '2026-06-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'd-remote',
        project_container_id: 'p-remote-arch',
        email: 'u1@example.com',
        role: 'viewer',
        display_name: null,
        created_by_id: 'g1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    const rows = await listProjectsForIndex(db, user())
    expect(rows.map((r) => r.id)).not.toContain('p-remote-arch')
  })
})

describe('countProjectParticipants', () => {
  test('excludes participants who lost view permission', async () => {
    const { db, project, grant } = await fixture()
    await project('p1')
    await grant('p1', 'g1@partner.example.com')
    await joinProject(db, { containerId: 'p1', user: user() })
    await joinProject(db, {
      containerId: 'p1',
      user: user({
        id: 'g1',
        workspaceId: 'w2',
        email: 'g1@partner.example.com',
      }),
    })
    expect(await countProjectParticipants(db, 'p1')).toBe(2)
    await db.deleteFrom('project_share_defaults').execute()
    expect(await countProjectParticipants(db, 'p1')).toBe(1)
  })
})

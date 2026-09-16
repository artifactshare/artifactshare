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
import {
  isAgentOwnedArtifact,
  isAgentPublishableDestination,
  isAgentReadableArtifact,
} from './agent-scope.server'

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
  kind: 'human' as const,
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
        `INSERT INTO workspaces (
          id, hd, name, created_at, plan, storage_quota_bytes,
          storage_used_bytes, storage_updated_at
        ) VALUES ('ws2', 'other.example', 'Other', '2026-01-01T00:00:00.000Z',
          'free', 53687091200, 0, '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, image, created_at, updated_at,
          workspace_id, locale
        ) VALUES ('u2', 'u2@other.example', 1, 'User u2',
          NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          'ws2', NULL)`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          base_visibility, archived_at, created_at, updated_at
        ) VALUES
          ('inbox-1', 'ws1', 'inbox', 'u1', 'u1', 'Home',
            'private', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-1', 'ws1', 'project', 'u1', 'u1', 'Approved project',
            'workspace', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-2', 'ws1', 'project', 'u1', 'u1', 'Other project',
            'workspace', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-archived', 'ws1', 'project', 'u1', 'u1', 'Archived project',
            'workspace', '2026-01-15T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-granted', 'ws1', 'project', 'u1', 'u1', 'Granted private',
            'private', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-ungranted', 'ws1', 'project', 'u1', 'u1', 'Ungranted private',
            'private', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('project-w2', 'ws2', 'project', 'u2', 'u2', 'Other workspace project',
            'workspace', NULL,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO project_share_defaults (
          id, project_container_id, email, role, created_by_id,
          created_at, updated_at
        ) VALUES ('psd-1', 'project-granted', 'U1@example.com', 'viewer', 'u1',
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
          ('archived-artifact', 'ws1', 'u1', 'Archived', 'markdown_page',
            'workspace', 'project-archived', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('home-artifact', 'ws1', 'u1', 'Home', 'markdown_page',
            'workspace', 'inbox-1', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('granted-artifact', 'ws1', 'u1', 'Granted', 'markdown_page',
            'project', 'project-granted', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('ungranted-artifact', 'ws1', 'u1', 'Ungranted', 'markdown_page',
            'project', 'project-ungranted', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('link-artifact', 'ws1', 'u1', 'Linked', 'markdown_page',
            'link', 'project-2', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'),
          ('w2-artifact', 'ws2', 'u2', 'Foreign', 'markdown_page',
            'workspace', 'project-w2', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `UPDATE shareables SET created_by_agent_profile_id = 'agent-1'
          WHERE id = 'approved-artifact'`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('allows reads across the workspace read contract', async () => {
    // Workspace-visible artifacts in any non-archived project are readable.
    await expect(
      isAgentReadableArtifact(db, user, authority, 'approved-artifact'),
    ).resolves.toBe(true)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'other-artifact'),
    ).resolves.toBe(true)
    // Private project with an audience grant for the approver (viewer role).
    await expect(
      isAgentReadableArtifact(db, user, authority, 'granted-artifact'),
    ).resolves.toBe(true)
  })

  test('keeps archived, home, link, ungranted, and foreign artifacts unreadable', async () => {
    await expect(
      isAgentReadableArtifact(db, user, authority, 'archived-artifact'),
    ).resolves.toBe(false)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'home-artifact'),
    ).resolves.toBe(false)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'link-artifact'),
    ).resolves.toBe(false)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'ungranted-artifact'),
    ).resolves.toBe(false)
    await expect(
      isAgentReadableArtifact(db, user, authority, 'w2-artifact'),
    ).resolves.toBe(false)
  })

  test('unverified email never matches a private-project audience grant', async () => {
    const unverified: SessionUser = { ...user, emailVerified: false }
    // Session verification is stale; the database still authorizes the grant.
    await expect(
      isAgentReadableArtifact(db, unverified, authority, 'other-artifact'),
    ).resolves.toBe(true)
    await expect(
      isAgentReadableArtifact(db, unverified, authority, 'granted-artifact'),
    ).resolves.toBe(true)
    sqlite.prepare(`UPDATE users SET email_verified = 0 WHERE id = 'u1'`).run()
    await expect(
      isAgentReadableArtifact(db, user, authority, 'granted-artifact'),
    ).resolves.toBe(false)
  })

  test('uses the database workspace when session workspace is stale', async () => {
    await expect(
      isAgentReadableArtifact(
        db,
        { ...user, workspaceId: 'ws2' },
        authority,
        'approved-artifact',
      ),
    ).resolves.toBe(true)
    sqlite
      .prepare(`UPDATE users SET workspace_id = 'ws2' WHERE id = 'u1'`)
      .run()
    await expect(
      isAgentReadableArtifact(db, user, authority, 'approved-artifact'),
    ).resolves.toBe(false)
  })

  test('lists exactly the readable artifacts and leaks no other titles', async () => {
    const result = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts.map((artifact) => artifact.id).sort()).toEqual(
      ['approved-artifact', 'granted-artifact', 'other-artifact'],
    )
    const titles = result.data.artifacts.map((artifact) => artifact.title)
    expect(titles).not.toContain('Archived')
    expect(titles).not.toContain('Home')
    expect(titles).not.toContain('Linked')
    expect(titles).not.toContain('Ungranted')
    expect(titles).not.toContain('Foreign')
  })

  test('search does not match titles outside the read scope', async () => {
    const result = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
      query: 'Ungranted',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts).toEqual([])
  })

  test('list filtered by an unreadable project returns nothing', async () => {
    const result = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
      projectId: 'project-ungranted',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts).toEqual([])
  })

  test('list filtered by another readable project returns its artifacts', async () => {
    const result = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
      projectId: 'project-2',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts.map((artifact) => artifact.id)).toEqual([
      'other-artifact',
    ])
  })

  test('list mismatch follows the database workspace, not a stale session workspace', async () => {
    const result = await listAgentReadableArtifacts(
      db,
      { ...user, workspaceId: 'ws2' },
      authority,
      { baseUrl: 'https://artifactshare.test' },
    )

    expect(result.kind).toBe('ok')

    sqlite
      .prepare(`UPDATE users SET workspace_id = 'ws2' WHERE id = 'u1'`)
      .run()
    const mismatched = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
    })
    expect(mismatched.kind).toBe('invalid-project')
  })

  test('reports a missing database viewer separately from authority mismatch', async () => {
    const result = await listAgentReadableArtifacts(
      db,
      { ...user, id: 'missing-viewer' },
      authority,
      { baseUrl: 'https://artifactshare.test' },
    )

    expect(result.kind).toBe('missing-viewer')
  })

  test.each([
    ['missing', undefined, 'missing-viewer'],
    ['missing', 'broken', 'missing-viewer'],
    ['missing', 'mismatched', 'missing-viewer'],
    ['mismatch', undefined, 'invalid-project'],
    ['mismatch', 'broken', 'invalid-project'],
    ['mismatch', 'mismatched', 'invalid-project'],
    ['authorized', 'broken', 'invalid-cursor'],
    ['authorized', 'mismatched', 'invalid-cursor'],
    ['authorized', undefined, 'ok'],
    ['empty', undefined, 'ok'],
  ] as const)(
    'classifies %s viewer with %s cursor using one statement (%s)',
    async (state, cursorKind, expectedKind) => {
      if (state === 'mismatch') {
        sqlite
          .prepare("UPDATE users SET workspace_id = 'ws2' WHERE id = 'u1'")
          .run()
      }
      const cursor =
        cursorKind === 'mismatched'
          ? btoa(
              JSON.stringify({
                updated_at: '2026-01-01',
                id: 'x',
                filter: 'different',
              }),
            )
          : cursorKind
      const prepare = vi.spyOn(sqlite, 'prepare')
      try {
        const result = await listAgentReadableArtifacts(
          db,
          state === 'missing' ? { ...user, id: 'absent' } : user,
          authority,
          {
            baseUrl: 'https://artifactshare.test',
            query: state === 'empty' ? 'no matching title' : undefined,
            cursor,
          },
        )
        expect(result.kind).toBe(expectedKind)
        expect(prepare).toHaveBeenCalledTimes(1)
        if (result.kind === 'ok') {
          expect(result.data.has_more).toBe(false)
          expect(result.data.next_cursor).toBeNull()
          expect(result.data.artifacts).toHaveLength(state === 'empty' ? 0 : 3)
          for (const artifact of result.data.artifacts) {
            expect(artifact.owner_email).toBe('u1@example.com')
          }
        }
      } finally {
        prepare.mockRestore()
      }
    },
  )

  test.each([50, 51])(
    'paginates %i matching rows without a status row consuming a slot',
    async (count) => {
      const insert = sqlite.prepare(
        `INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        container_id, created_at, updated_at
      ) VALUES (?, 'ws1', 'u1', '設計メモ', 'markdown_page', 'workspace',
        'project-1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      const ids = Array.from(
        { length: count },
        (_, i) => `boundary-${String(i).padStart(2, '0')}`,
      ).reverse()
      for (const id of ids) insert.run(id)
      const args = {
        baseUrl: 'https://artifactshare.test',
        projectId: 'project-1',
        query: '設計',
      }
      const first = await listAgentReadableArtifacts(db, user, authority, args)
      expect(first.kind).toBe('ok')
      if (first.kind !== 'ok') return
      expect(first.data.artifacts.map(({ id }) => id)).toEqual(ids.slice(0, 50))
      expect(first.data.has_more).toBe(count > 50)
      if (count === 50) {
        expect(first.data.next_cursor).toBeNull()
        return
      }
      expect(first.data.next_cursor).toEqual(expect.any(String))
      const cursor = first.data.next_cursor!
      const second = await listAgentReadableArtifacts(db, user, authority, {
        ...args,
        cursor,
      })
      expect(second.kind).toBe('ok')
      if (second.kind !== 'ok') return
      expect(second.data.artifacts.map(({ id }) => id)).toEqual(ids.slice(50))
      expect(second.data.has_more).toBe(false)
      expect(second.data.next_cursor).toBeNull()
      for (const changed of [
        { projectId: 'project-2' },
        { query: 'changed' },
      ]) {
        expect(
          await listAgentReadableArtifacts(db, user, authority, {
            ...args,
            ...changed,
            cursor,
          }),
        ).toEqual({ kind: 'invalid-cursor' })
      }
    },
  )

  test('rejects a cursor issued under a different agent authority', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        container_id, created_at, updated_at
      ) VALUES (?, 'ws1', 'u1', ?, 'markdown_page', 'workspace',
        'project-1', '2026-01-01T00:00:00.000Z', ?)`,
    )
    for (let i = 0; i < 51; i += 1) {
      insert.run(
        `paged-${String(i).padStart(2, '0')}`,
        `Paged ${i}`,
        `2026-01-02T00:00:${String(i).padStart(2, '0')}.000Z`,
      )
    }

    const first = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    expect(first.data.next_cursor).toBeTruthy()

    const reused = await listAgentReadableArtifacts(
      db,
      user,
      { ...authority, familyId: 'family-2', projectId: 'project-2' },
      {
        baseUrl: 'https://artifactshare.test',
        cursor: first.data.next_cursor ?? undefined,
      },
    )
    expect(reused.kind).toBe('invalid-cursor')
  })

  test('applies the Agent SQL predicate before limit plus one and cursor pagination', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        container_id, created_at, updated_at
      ) VALUES (?, 'ws1', 'u1', ?, 'markdown_page', ?, ?,
        '2026-01-01T00:00:00.000Z', ?)`,
    )
    for (let i = 0; i < 60; i += 1) {
      insert.run(
        `denied-page-${String(i).padStart(2, '0')}`,
        `Denied ${i}`,
        'private',
        'project-ungranted',
        `2026-02-02T00:00:${String(i).padStart(2, '0')}.000Z`,
      )
    }
    for (let i = 0; i < 51; i += 1) {
      insert.run(
        `allowed-page-${String(i).padStart(2, '0')}`,
        `Allowed ${i}`,
        'workspace',
        'project-1',
        `2026-02-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      )
    }

    const first = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    expect(first.data.artifacts).toHaveLength(50)
    expect(
      first.data.artifacts.every((item) => !item.id.startsWith('denied')),
    ).toBe(true)
    expect(first.data.has_more).toBe(true)

    const second = await listAgentReadableArtifacts(db, user, authority, {
      baseUrl: 'https://artifactshare.test',
      cursor: first.data.next_cursor ?? undefined,
    })
    expect(second.kind).toBe('ok')
    if (second.kind !== 'ok') return
    expect(second.data.artifacts.map((item) => item.id)).toContain(
      'allowed-page-00',
    )
    expect(
      second.data.artifacts.every((item) => !item.id.startsWith('denied')),
    ).toBe(true)
  })

  test('write scope stays pinned to the approved destination project', async () => {
    await expect(
      isAgentPublishableDestination(db, user, authority, 'project-1'),
    ).resolves.toBe(true)
    await expect(
      isAgentPublishableDestination(db, user, authority, 'project-2'),
    ).resolves.toBe(false)
    await expect(
      isAgentPublishableDestination(db, user, authority, 'project-granted'),
    ).resolves.toBe(false)
    await expect(
      isAgentOwnedArtifact(db, user, authority, 'other-artifact'),
    ).resolves.toBe(false)
  })

  test('stops mutations when the approved project is archived', async () => {
    await expect(
      isAgentOwnedArtifact(db, user, authority, 'approved-artifact'),
    ).resolves.toBe(true)

    sqlite
      .prepare(
        `UPDATE artifact_containers
            SET archived_at = '2026-02-01T00:00:00.000Z'
          WHERE id = 'project-1'`,
      )
      .run()

    await expect(
      isAgentOwnedArtifact(db, user, authority, 'approved-artifact'),
    ).resolves.toBe(false)
  })
})

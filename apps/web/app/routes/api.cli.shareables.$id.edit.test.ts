import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  associateD1Database,
  d1DatabaseFor,
} from '~/lib/d1-database-registry.server'
import type { D1BatchSqliteRef } from '~/test/d1-batch-mock'
import { createD1BatchFixture } from '~/test/d1-batch-mock'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development', BUCKET: { delete: vi.fn() } },
}))

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const authorityMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const editShareableSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: authorityMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/shareables.server', () => ({
  editShareableSettings: editShareableSettingsMock,
}))

import { action, middleware } from './api.cli.shareables.$id.edit'

describe('/api/cli/shareables/:id/edit', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    authorityMock.mockReset().mockReturnValue(null)
    requireUserMock.mockReset()
    createDbMock.mockReset()
    editShareableSettingsMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    editShareableSettingsMock.mockResolvedValue({
      kind: 'ok',
      shareable: {
        id: 'abc123def4',
        title: 'Launch plan',
        visibility: 'workspace',
        updatedAt: '2026-06-18T00:00:00Z',
        projectId: 'prj1',
      },
    })
  })

  test('edits title, sharing, and destination for the authenticated owner', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        {
          method: 'POST',
          body: JSON.stringify({
            title: 'Launch plan',
            visibility: 'workspace',
            add_emails: ['viewer@example.com'],
            remove_emails: ['old@example.com'],
            destination: { project_id: ' prj1 ' },
          }),
        },
      ),
    } as never)
    const body = (await response.json()) as {
      artifact: { id: string; url: string }
      title: string
      destination: { type: string; project_id: string }
      share: { visibility: string }
    }

    expect(response.status).toBe(200)
    expect(editShareableSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1', workspaceId: 'ws1' }),
      'abc123def4',
      {
        title: 'Launch plan',
        visibility: 'workspace',
        addEmails: ['viewer@example.com'],
        removeEmails: ['old@example.com'],
        destination: { type: 'project', projectId: 'prj1' },
      },
      null,
    )
    expect(body).toEqual({
      artifact: {
        id: 'abc123def4',
        url: 'https://artifactshare.test/a/abc123def4',
      },
      title: 'Launch plan',
      destination: { type: 'project', project_id: 'prj1' },
      share: { visibility: 'workspace' },
    })
  })

  test('returns home destination for unfiled artifacts', async () => {
    editShareableSettingsMock.mockResolvedValue({
      kind: 'ok',
      shareable: {
        id: 'abc123def4',
        title: 'Backlog',
        visibility: 'private',
        updatedAt: '2026-06-18T00:00:00Z',
        projectId: null,
      },
    })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({ destination: 'home' }) },
      ),
    } as never)
    const body = (await response.json()) as {
      destination: { type: string; project_id: string | null }
    }

    expect(response.status).toBe(200)
    expect(body.destination).toEqual({ type: 'home', project_id: null })
  })

  test('returns not-found without leaking inaccessible shareables', async () => {
    editShareableSettingsMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action({
      context: new Map(),
      params: { id: 'missing' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/missing/edit',
        { method: 'POST', body: JSON.stringify({ title: 'Nope' }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('returns invalid-destination for bad destinations', async () => {
    editShareableSettingsMock.mockResolvedValue({ kind: 'invalid-destination' })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        {
          method: 'POST',
          body: JSON.stringify({ destination: { project_id: 'missing' } }),
        },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-destination')
  })

  test.each([
    {
      kind: 'workspace-unavailable',
      status: 400,
      code: 'workspace-unavailable',
    },
    {
      kind: 'too-many-grants',
      limit: 50,
      status: 400,
      code: 'too-many-grants',
    },
    { kind: 'commit-failed', status: 502, code: 'commit-failed' },
  ])('maps $kind to $status', async (result) => {
    editShareableSettingsMock.mockResolvedValue(result)

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({ visibility: 'workspace' }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(result.status)
    expect(body.error.code).toBe(result.code)
  })

  test('rejects requests with no changes', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation-failed')
    expect(editShareableSettingsMock).not.toHaveBeenCalled()
  })
})

describe('owner version retention API', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb>
  let sqliteRef: D1BatchSqliteRef
  beforeEach(() => {
    sqliteRef = {
      current: null as
        | ReturnType<typeof createMigratedInMemoryDb>['sqlite']
        | null,
    }
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    createDbMock.mockReturnValue(fixture.db)
    authorityMock.mockReturnValue({ kind: 'unrestricted' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: null,
    })
    editShareableSettingsMock.mockReset().mockResolvedValue({
      kind: 'ok',
      shareable: {
        id: 'abc123def4',
        title: 'Report',
        visibility: 'private',
        projectId: null,
      },
    })
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES ('ws1', 'Workspace', '2026-09-01', 30);
      INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u1', 'owner@example.com', 'Owner', '2026-09-01', '2026-09-01', 'ws1');
      INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01');
      INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('abc123def4', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1');
    `)
    for (let n = 1; n <= 3; n++)
      fixture.sqlite
        .prepare(
          `INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES (?, 'abc123def4', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', ?, ?)`,
        )
        .run(`v${n}`, `key${n}`, `2026-09-0${n}`, `2026-09-0${n}`)
    fixture.sqlite.exec("UPDATE shareables SET current_version_id = 'v3'")
  })
  afterEach(async () => {
    await fixture.db.destroy()
  })
  const request = (retain_versions: unknown) =>
    action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({ retain_versions }) },
      ),
    } as never)

  async function useRealEdit() {
    const actual = await vi.importActual<
      typeof import('~/services/shareables.server')
    >('~/services/shareables.server')
    editShareableSettingsMock.mockImplementation(actual.editShareableSettings)
    fixture.sqlite.exec(
      `INSERT INTO artifact_containers (id, workspace_id, kind, created_by_id, name, created_at, updated_at) VALUES ('prj1', 'ws1', 'project', 'u1', 'Project', '2026-09-01', '2026-09-01');`,
    )
    return actual
  }

  function editRequest(body: object) {
    return action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify(body) },
      ),
    } as never)
  }

  function snapshot() {
    const tables = fixture.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as { name: string }[]
    return tables.map(({ name }) => ({
      name,
      rows: fixture.sqlite
        .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .all(),
    }))
  }

  test.each([false, true])(
    'refuses project visibility outside a project without any writes (explicit home: %s)',
    async (home) => {
      await useRealEdit()
      fixture.sqlite.exec(
        "UPDATE shareables SET visibility = 'workspace', retain_versions = 3; INSERT INTO shareable_grants (shareable_id, granted_email, granted_by, granted_at) VALUES ('abc123def4', 'viewer@example.com', 'u1', '2026-09-01');",
      )
      if (home) {
        fixture.sqlite.exec(
          "UPDATE shareables SET container_id = 'prj1'; DELETE FROM artifact_containers WHERE id = 'c1'; INSERT INTO project_pins (container_id, shareable_id, pinned_by_user_id, created_at) VALUES ('prj1', 'abc123def4', 'u1', '2026-09-01');",
        )
      }
      const before = snapshot()
      const response = await editRequest({
        visibility: 'project',
        ...(home ? { destination: 'home' } : {}),
        title: 'Changed',
        add_emails: ['new@example.com'],
        remove_emails: ['viewer@example.com'],
        retain_versions: 1,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(snapshot()).toEqual(before)
    },
  )

  test.each(['workspace', 'project'])(
    'refuses a concurrent move home after the commit read from %s without partial edits',
    async (visibility) => {
      const service = await useRealEdit()
      fixture.sqlite
        .prepare(
          "UPDATE shareables SET container_id = 'prj1', visibility = ?, retain_versions = 3",
        )
        .run(visibility)
      fixture.sqlite.exec(
        "INSERT INTO shareable_grants (shareable_id, granted_email, granted_by, granted_at) VALUES ('abc123def4', 'viewer@example.com', 'u1', '2026-09-01'); INSERT INTO project_pins (container_id, shareable_id, pinned_by_user_id, created_at) VALUES ('prj1', 'abc123def4', 'u1', '2026-09-01');",
      )
      let afterConcurrentMove: ReturnType<typeof snapshot> | undefined
      sqliteRef.beforeNextBatch = async () => {
        expect(
          await service.moveShareableContainer(
            fixture.db,
            { id: 'u1', workspaceId: 'ws1' },
            'abc123def4',
            { type: 'inbox' },
          ),
        ).toMatchObject({ kind: 'ok' })
        afterConcurrentMove = snapshot()
      }
      const response = await editRequest({
        visibility: 'project',
        title: 'Changed',
        add_emails: ['new@example.com'],
        remove_emails: ['viewer@example.com'],
        retain_versions: 1,
      })
      expect(afterConcurrentMove).toBeDefined()
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(snapshot()).toEqual(afterConcurrentMove)
    },
  )

  test('sets project visibility even if a concurrent move resets visibility before the destination move', async () => {
    const service = await useRealEdit()
    fixture.sqlite.exec(
      "UPDATE shareables SET container_id = 'prj1', visibility = 'project'; INSERT INTO artifact_containers (id, workspace_id, kind, created_by_id, name, created_at, updated_at) VALUES ('project-a', 'ws1', 'project', 'u1', 'Destination', '2026-09-01', '2026-09-01');",
    )
    const versions = fixture.sqlite.prepare('SELECT * FROM versions').all()
    let movedHome = false
    sqliteRef.beforeNextBatch = async () => {
      expect(
        await service.moveShareableContainer(
          fixture.db,
          { id: 'u1', workspaceId: 'ws1' },
          'abc123def4',
          { type: 'inbox' },
        ),
      ).toMatchObject({ kind: 'ok', visibility: 'private' })
      movedHome = true
    }
    const response = await editRequest({
      destination: { project_id: 'project-a' },
      visibility: 'project',
      title: 'Changed',
    })
    expect(movedHome).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      destination: { type: 'project', project_id: 'project-a' },
      share: { visibility: 'project' },
    })
    expect(
      fixture.sqlite
        .prepare(
          'SELECT id, container_id, visibility, title_override FROM shareables',
        )
        .get(),
    ).toEqual({
      id: 'abc123def4',
      container_id: 'project-a',
      visibility: 'project',
      title_override: 'Changed',
    })
    expect(fixture.sqlite.prepare('SELECT * FROM versions').all()).toEqual(
      versions,
    )
  })

  test('refuses a destination archived just before the batch without partial edits', async () => {
    await useRealEdit()
    let afterArchive: ReturnType<typeof snapshot> | undefined
    sqliteRef.beforeNextBatch = () => {
      fixture.sqlite.exec(
        "UPDATE artifact_containers SET archived_at = '2026-09-02' WHERE id = 'prj1'",
      )
      afterArchive = snapshot()
    }
    const response = await editRequest({
      destination: { project_id: 'prj1' },
      visibility: 'project',
      title: 'Changed',
      add_emails: ['new@example.com'],
      retain_versions: 1,
    })
    expect(afterArchive).toBeDefined()
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid-destination' },
    })
    expect(snapshot()).toEqual(afterArchive)
  })

  test('refuses project visibility when the commit reads a concurrent move home', async () => {
    await useRealEdit()
    fixture.sqlite.exec(
      "UPDATE shareables SET container_id = 'prj1', visibility = 'workspace', retain_versions = 3; INSERT INTO shareable_grants (shareable_id, granted_email, granted_by, granted_at) VALUES ('abc123def4', 'viewer@example.com', 'u1', '2026-09-01');",
    )
    let commitPlacementReads = 0
    const concurrentDb = fixture.db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        return {
          ...result,
          rows: result.rows.map((row) => {
            // Only the commit's owner/grants lookup has this projection.
            // Earlier placement validation still observes the real project.
            if (
              Object.keys(row).length === 5 &&
              'id' in row &&
              'workspace_id' in row &&
              'visibility' in row &&
              'link_expires_at' in row &&
              'container_kind' in row
            ) {
              commitPlacementReads++
              return { ...row, container_kind: 'inbox' }
            }
            return row
          }),
        }
      },
    })
    const database = d1DatabaseFor(fixture.db)
    if (!database) throw new Error('Expected D1 batch fixture')
    associateD1Database(concurrentDb, database)
    createDbMock.mockReturnValue(concurrentDb)
    const before = snapshot()
    const response = await editRequest({
      visibility: 'project',
      title: 'Changed',
      add_emails: ['new@example.com'],
      remove_emails: ['viewer@example.com'],
      retain_versions: 1,
    })
    expect(commitPlacementReads).toBe(1)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid-visibility' },
    })
    expect(snapshot()).toEqual(before)
  })

  test.each(['private', 'link', 'home'] as const)(
    'sets project visibility from %s while preserving identity and versions',
    async (initial) => {
      await useRealEdit()
      if (initial !== 'home') {
        fixture.sqlite
          .prepare(
            "UPDATE shareables SET container_id = 'prj1', visibility = ?",
          )
          .run(initial)
      }
      const versions = fixture.sqlite.prepare('SELECT * FROM versions').all()
      const response = await editRequest({
        visibility: 'project',
        title: 'Changed',
        ...(initial === 'home' ? { destination: { project_id: 'prj1' } } : {}),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        artifact: {
          id: 'abc123def4',
          url: 'https://artifactshare.test/a/abc123def4',
        },
        destination: { type: 'project', project_id: 'prj1' },
        share: { visibility: 'project' },
      })
      expect(
        fixture.sqlite
          .prepare(
            'SELECT id, container_id, visibility, title_override, current_version_id FROM shareables',
          )
          .get(),
      ).toEqual({
        id: 'abc123def4',
        container_id: 'prj1',
        visibility: 'project',
        current_version_id: 'v3',
        title_override: 'Changed',
      })
      expect(fixture.sqlite.prepare('SELECT * FROM versions').all()).toEqual(
        versions,
      )
    },
  )

  test('sets, lowers and clears retention, reporting only versions actually deleted', async () => {
    for (const [retain, deleted] of [
      [2, 1],
      [1, 1],
      [1, 0],
      [null, 0],
    ] as const) {
      const response = await request(retain)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        retain_versions: retain,
        deleted_versions: deleted,
      })
      expect(
        fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
      ).toEqual({ retain_versions: retain })
    }
    expect(
      fixture.sqlite.prepare('SELECT id, number FROM versions').all(),
    ).toEqual([{ id: 'v3', number: 3 }])
    expect(
      fixture.sqlite.prepare('SELECT storage_used_bytes FROM workspaces').get(),
    ).toEqual({ storage_used_bytes: 10 })
  })
  test.each(['agent', 'bridge', 'bootstrap'])(
    'rejects %s credentials before editing or pruning',
    async (kind) => {
      authorityMock.mockReturnValue({ kind, preset: 'agent' })
      const response = await request(1)
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('unrestricted owner credentials')
      expect(editShareableSettingsMock).not.toHaveBeenCalled()
      expect(
        fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM versions').get(),
      ).toEqual({ n: 3 })
    },
  )
  test('rejects a non-owner', async () => {
    requireUserMock.mockReturnValue({ id: 'other', workspaceId: 'ws1' })
    const response = await request(1)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('Only the artifact owner')
    expect(editShareableSettingsMock).not.toHaveBeenCalled()
  })
  test('does not prune when ownership changes before the setting is written', async () => {
    editShareableSettingsMock.mockImplementationOnce(() => {
      fixture.sqlite.exec(
        `INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u2', 'new-owner@example.com', 'New owner', '2026-09-01', '2026-09-01', 'ws1'); UPDATE shareables SET owner_user_id = 'u2';`,
      )
      return {
        kind: 'ok',
        shareable: {
          id: 'abc123def4',
          title: 'Report',
          visibility: 'private',
          projectId: null,
        },
      }
    })
    expect((await request(1)).status).toBe(403)
    expect(
      fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
    ).toEqual({ retain_versions: null })
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM versions').get(),
    ).toEqual({ n: 3 })
  })

  test.each([0, -1, 1.5, '2', 'all'])(
    'rejects invalid retention %s',
    async (value) => {
      expect((await request(value)).status).toBe(400)
      expect(editShareableSettingsMock).not.toHaveBeenCalled()
    },
  )
})

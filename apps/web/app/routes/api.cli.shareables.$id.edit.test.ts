import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
  beforeEach(() => {
    fixture = createMigratedInMemoryDb()
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

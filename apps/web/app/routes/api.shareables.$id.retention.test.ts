import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createD1BatchFixture,
  type D1BatchSqliteRef,
} from '~/test/d1-batch-mock'
vi.mock('cloudflare:workers', () => ({ env: { BUCKET: { delete: vi.fn() } } }))
const mocks = vi.hoisted(() => ({
  user: { id: 'u1' },
  authority: null as unknown,
  db: null as unknown,
}))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => mocks.user,
  getCliAuthority: () => mocks.authority,
}))
vi.mock('~/services/db.server', () => ({
  withDb: (fn: (db: unknown) => unknown) => fn(mocks.db),
}))
import { action } from './api.shareables.$id.retention'
const sqliteRef: D1BatchSqliteRef = { current: null }
let fixture: ReturnType<typeof createD1BatchFixture>
beforeEach(() => {
  fixture = createD1BatchFixture({ sqlite: sqliteRef })
  sqliteRef.current = fixture.sqlite
  mocks.db = fixture.db
  mocks.user = { id: 'u1' }
  mocks.authority = null
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES ('ws1', 'Workspace', '2026-09-01', 20);
    INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u1', 'author@example.com', 'Author', '2026-09-01', '2026-09-01', 'ws1');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('abc123def4', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1');
    INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES ('v1', 'abc123def4', 'html_page', 'published', '/index.html', 'key1', 10, 'hash', 'u1', '2026-09-01', '2026-09-01'), ('v2', 'abc123def4', 'html_page', 'published', '/index.html', 'key2', 10, 'hash', 'u1', '2026-09-02', '2026-09-02');
    UPDATE shareables SET current_version_id = 'v2';
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
  sqliteRef.current = null
  sqliteRef.beforeNextBatch = null
})
function request(body: unknown) {
  return action({
    context: new Map(),
    params: { id: 'abc123def4' },
    request: new Request(
      'https://example.com/api/shareables/abc123def4/retention',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  } as never)
}
test('requires confirmation for removals; preview and cancel do not write; clear saves directly', async () => {
  const preview = await request({ operation: 'preview', retain_versions: 1 })
  const body = (await preview.json()) as { snapshot: string }
  expect(body).toMatchObject({ kind: 'preview', count: 1, stored: null })
  expect(
    (await request({ operation: 'save', retain_versions: 1 })).status,
  ).toBe(409)
  expect(
    fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
  ).toEqual({ retain_versions: null })
  expect(
    (
      await request({
        operation: 'save',
        retain_versions: 1,
        snapshot: body.snapshot,
      })
    ).status,
  ).toBe(200)
  expect(fixture.sqlite.prepare('SELECT id FROM versions').all()).toEqual([
    { id: 'v2' },
  ])
  expect(
    (await request({ operation: 'save', retain_versions: null })).status,
  ).toBe(200)
  expect(
    fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
  ).toEqual({ retain_versions: null })
})
test.each(['', 0, -1, 1.5, '2', 'invalid', false, {}, []])(
  'rejects invalid retention %j',
  async (value) => {
    expect(
      (await request({ operation: 'save', retain_versions: value })).status,
    ).toBe(400)
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM versions').get(),
    ).toEqual({ n: 2 })
  },
)
test.each(['preview', 'save'])(
  'non-owner and restricted authority cannot %s',
  async (operation) => {
    mocks.user = { id: 'u2' }
    expect((await request({ operation, retain_versions: 1 })).status).toBe(403)
    mocks.user = { id: 'u1' }
    mocks.authority = { kind: 'publisher' }
    expect((await request({ operation, retain_versions: 1 })).status).toBe(403)
  },
)
test('stale or cross-file confirmation cannot commit', async () => {
  const response = await request({ operation: 'preview', retain_versions: 1 })
  const preview = (await response.json()) as { snapshot: string }
  fixture.sqlite.exec("UPDATE shareables SET current_version_id = 'v1'")
  expect(
    (
      await request({
        operation: 'save',
        retain_versions: 1,
        snapshot: preview.snapshot,
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request({
        operation: 'save',
        retain_versions: 1,
        snapshot: preview.snapshot.replace('abc123def4', 'other123ab'),
      })
    ).status,
  ).toBe(409)
  expect(
    fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
  ).toEqual({ retain_versions: null })
})

test.each(['admin', 'collaborator', 'revoked-owner'])(
  'refuses forged previews and saves from %s',
  async (role) => {
    if (role !== 'revoked-owner') {
      fixture.sqlite.exec(
        "INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u2', 'viewer@example.com', 'Viewer', '2026-09-01', '2026-09-01', 'ws1')",
      )
      mocks.user = { id: 'u2' }
    }
    fixture.sqlite
      .prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'ws1',
        mocks.user.id,
        role === 'admin' ? 'admin' : 'member',
        role === 'revoked-owner' ? 'removed' : 'active',
        '2026-09-01',
        '2026-09-01',
      )
    for (const operation of ['preview', 'save'])
      expect((await request({ operation, retain_versions: 1 })).status).toBe(
        403,
      )
    expect(
      fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
    ).toEqual({ retain_versions: null })
    expect(
      fixture.sqlite.prepare('SELECT COUNT(*) AS n FROM versions').get(),
    ).toEqual({ n: 2 })
  },
)

test.each([
  {},
  null,
  [],
  { operation: 'delete', retain_versions: 1 },
  { operation: 'save', retain_versions: 1, unexpected: true },
  { operation: 'save', retain_versions: 1, snapshot: 1 },
])('rejects malformed operations %j', async (body) => {
  expect((await request(body)).status).toBe(400)
})

test('unsupported methods do not mutate', async () => {
  const response = await action({
    context: new Map(),
    params: { id: 'abc123def4' },
    request: new Request(
      'https://example.com/api/shareables/abc123def4/retention',
      { method: 'DELETE' },
    ),
  } as never)
  expect(response.status).toBe(405)
  expect(
    fixture.sqlite.prepare('SELECT retain_versions FROM shareables').get(),
  ).toEqual({ retain_versions: null })
})

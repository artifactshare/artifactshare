import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { loader } from '~/routes/api.cli.artifacts.$id'
const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: 'u1',
  source: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({ env: { APP_ENV: 'development' } }))
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: () => null,
  requireUser: () => ({
    id: state.userId,
    workspaceId: 'ws1',
    email: `${state.userId}@example.com`,
  }),
}))
vi.mock('~/services/db.server', () => ({
  withDb: (callback: (db: unknown) => unknown) => callback(state.db),
}))
vi.mock('~/services/content.server', () => ({
  fetchArtifactSource: state.source,
}))
let db: ReturnType<typeof createMigratedInMemoryDb>['db']
let sqlite: ReturnType<typeof createMigratedInMemoryDb>['sqlite']
beforeEach(() => {
  ;({ db, sqlite } = createMigratedInMemoryDb())
  state.db = db
  state.userId = 'u1'
  seed()
  sqlite.exec(
    "INSERT INTO users (id, email, name, created_at, updated_at, workspace_id) VALUES ('u2', 'viewer@example.com', 'Viewer', '2026-09-01', '2026-09-01', 'ws1'); UPDATE shareables SET visibility = 'workspace'",
  )
  state.source.mockReset().mockImplementation(async (key: string) => ({
    kind: 'ok',
    body: key === 'key1' ? 'old source' : 'current source',
    sizeBytes: 10,
  }))
})
afterEach(async () => {
  await db.destroy()
})
async function read(versionId?: string, offset?: number) {
  const url = new URL('https://example.test/api/cli/artifacts/s1')
  if (versionId !== undefined) url.searchParams.set('version_id', versionId)
  if (offset !== undefined) url.searchParams.set('offset', String(offset))
  return loader({ context: new Map(), params: { id: 's1' }, url } as never)
}
function seed() {
  sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at, storage_used_bytes) VALUES ('ws1', 'Workspace', '2026-09-01', 40);
    INSERT INTO users (id, email, name, created_at, updated_at, workspace_id)
      VALUES ('u1', 'author@example.com', 'Author', '2026-09-01', '2026-09-01', 'ws1');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
      VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id)
      VALUES ('s1', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1');
  `)
  for (let i = 1; i <= 55; i++) {
    sqlite
      .prepare(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 10, 'hash', 'u1', ?, ?)`)
      .run(
        `v${i}`,
        `key${i}`,
        new Date(Date.UTC(2026, 8, i)).toISOString(),
        new Date(Date.UTC(2026, 8, i)).toISOString(),
      )
  }
  sqlite.exec("UPDATE shareables SET current_version_id = 'v4' WHERE id = 's1'")
}

for (const userId of ['u1', 'u2']) {
  for (const [current, historical, format] of [
    ['html_page', 'markdown_page', 'markdown'],
    ['markdown_page', 'html_page', 'html'],
  ]) {
    test(`HTTP historical read beyond 50 rows for ${userId}, format ${format}`, async () => {
      state.userId = userId
      sqlite.prepare('UPDATE shareables SET artifact_kind = ?').run(current)
      sqlite
        .prepare('UPDATE versions SET artifact_kind = ? WHERE id = ?')
        .run(historical, 'v1')
      const response = await read('v1')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        version_id: 'v1',
        content: 'old source',
        format,
      })
      expect(state.source).toHaveBeenCalledWith('key1')
    })
  }
}
test('HTTP misses do not reveal draft, foreign, or null-published versions', async () => {
  sqlite.exec(`
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id)
      VALUES ('s2', 'ws1', 'u1', 'Other report', 'html_page', 'workspace', '2026-09-01', '2026-09-01', 'c1');
    INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES ('foreign', 's2', 'html_page', 'published', '/index.html', 'foreign-key', 10, 'hash', 'u1', '2026-09-01', '2026-09-01');
  `)
  const unknown = await read('unknown')
  const foreign = await read('foreign')
  expect(unknown.status).toBe(404)
  expect(foreign.status).toBe(unknown.status)
  expect(await foreign.json()).toEqual(await unknown.json())
  for (const status of ['uploading', 'failed']) {
    sqlite
      .prepare('UPDATE versions SET status = ? WHERE id = ?')
      .run(status, 'v1')
    expect((await read('v1')).status).toBe(404)
  }
  sqlite.exec(
    "UPDATE versions SET status = 'published', published_at = NULL WHERE id = 'v1'",
  )
  expect((await read('v1')).status).toBe(404)
  expect(state.source).not.toHaveBeenCalled()
})
test('HTTP retention error is 410, and access denial still hides it', async () => {
  sqlite.exec(
    "INSERT INTO version_retention_tombstones VALUES ('removed', 's1', 100, '2026-09-01')",
  )
  const response = await read('removed')
  expect(response.status).toBe(410)
  expect(await response.json()).toMatchObject({
    error: { code: 'version-removed' },
  })
  state.userId = 'u2'
  sqlite.exec("UPDATE shareables SET visibility = 'private'")
  expect((await read('removed')).status).toBe((await read()).status)
  expect((await read('removed')).status).toBe(404)
  expect(state.source).not.toHaveBeenCalled()
})

test('HTTP historical chunks reconstruct source across a surrogate boundary', async () => {
  const content = 'x'.repeat(199999) + '😀tail'
  state.source.mockResolvedValue({
    kind: 'ok',
    body: content,
    sizeBytes: content.length + 2,
  })
  const first = (await (await read('v1')).json()) as {
    content: string
    next_offset: number
    version_id: string
  }
  const second = (await (await read('v1', first.next_offset)).json()) as {
    content: string
    version_id: string
    truncated: boolean
  }
  expect(first.version_id).toBe('v1')
  expect(second.version_id).toBe('v1')
  expect(first.content + second.content).toBe(content)
  expect(first.content.length).toBe(199999)
  expect(second.truncated).toBe(false)
})

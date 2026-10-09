import { RouterContextProvider } from 'react-router'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { seedWorkspace, seedUser } from '~/test/db-seed-fixture'
import { linkDomainContext, userContext } from '~/middleware/context'

const createDbMock = vi.hoisted(() => vi.fn())
vi.mock('~/services/db.server', () => ({ createDb: createDbMock }))
import { action, loader } from './api.shareables.$id.current-version'

let fixture: ReturnType<typeof createMigratedInMemoryDb>
let context: RouterContextProvider
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  createDbMock.mockReturnValue(fixture.db)
  seedWorkspace(fixture.sqlite)
  seedUser(fixture.sqlite, 'u1')
  fixture.sqlite.exec(`
    UPDATE workspaces SET link_sharing_enabled = 1;
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at)
    VALUES ('c1', 'ws1', 'inbox', 'u1', 'Inbox', '2026-01-01', '2026-01-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, current_version_id, created_at, updated_at, container_id)
    VALUES ('abc123def4', 'ws1', 'u1', 'Report', 'html_page', 'link', 'v1', '2026-01-01', '2026-01-01', 'c1');
    INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
    VALUES ('v1', 'abc123def4', 'html_page', 'published', '/index.html', 'test/index.html', 1, 'test', 'u1', '2026-01-01', '2026-01-01'),
           ('v2', 'abc123def4', 'html_page', 'published', '/index.html', 'test/new.html', 1, 'test', 'u1', '2026-01-02', '2026-01-02');
  `)
  context = new RouterContextProvider()
})
afterEach(async () => {
  await fixture.db.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
function lookup(id = 'abc123def4', query = '') {
  return loader({
    context,
    params: { id },
    request: new Request(
      `https://artifactshare.test/api/shareables/${id}/current-version${query}`,
    ),
  } as never)
}
async function denied(response: Response) {
  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    error: { code: 'not-found', message: 'Shareable not found.' },
  })
}

test('returns only the current pointer and re-reads it, ignoring historical queries', async () => {
  const first = await lookup()
  expect(first.status).toBe(200)
  expect(first.headers.get('cache-control')).toBe('private, no-store')
  expect(await first.json()).toEqual({ currentVersionId: 'v1' })
  fixture.sqlite.exec("UPDATE shareables SET current_version_id = 'v2'")
  const second = await lookup('abc123def4', '?version=v1')
  expect(await second.json()).toEqual({ currentVersionId: 'v2' })
})

test.each([
  "UPDATE shareables SET visibility = 'private'",
  "UPDATE shareables SET visibility = 'workspace'",
  "UPDATE shareables SET visibility = 'project'",
  "UPDATE shareables SET link_suspended_at = '2026-01-01', link_suspended_reason = 'test'",
  "UPDATE shareables SET link_expires_at = '2026-01-01T00:00:00.000Z'",
  'UPDATE workspaces SET link_sharing_enabled = 0',
  'UPDATE shareables SET current_version_id = NULL',
  "UPDATE shareables SET current_version_id = 'missing'",
  "UPDATE versions SET r2_key = ''",
])('denies uniformly after eligibility changes: %s', async (sql) => {
  expect((await lookup()).status).toBe(200)
  fixture.sqlite.exec(sql)
  await denied(await lookup())
})

test('expiry at the current timestamp is denied', async () => {
  const now = '2026-10-09T00:00:00.000Z'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(now))
  fixture.sqlite
    .prepare('UPDATE shareables SET link_expires_at = ?')
    .run(new Date().toISOString())
  await denied(await lookup())
})

test.each(['link123abc', 'invalid/id', ''])(
  'denies absent or malformed ID %s',
  async (id) => {
    await denied(await lookup(id))
  },
)

test('accepts the matching link host and ignores credentials on this endpoint', async () => {
  context.set(linkDomainContext, { shareableId: 'abc123def4' })
  context.set(userContext, { id: 'u1' } as never)
  const response = await lookup()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ currentVersionId: 'v1' })
  fixture.sqlite.exec('UPDATE workspaces SET link_sharing_enabled = 0')
  await denied(await lookup())
})

test('guards the link-host artifact even on direct invocation', async () => {
  context.set(linkDomainContext, { shareableId: 'link123abc' })
  await denied(await lookup())
})

test('signed-in callers have no bypass for anonymous restrictions', async () => {
  context.set(userContext, { id: 'u1' } as never)
  fixture.sqlite.exec("UPDATE shareables SET visibility = 'private'")
  await denied(await lookup())
})

test('rejects mutations without a database lookup', async () => {
  createDbMock.mockClear()
  const response = action()
  expect(response.status).toBe(405)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('allow')).toBe('GET, HEAD')
  expect(createDbMock).not.toHaveBeenCalled()
})

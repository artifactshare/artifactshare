import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: undefined }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { dispatchWorkspaceSearch } from './schedule.server'
import { searchIndexName } from './names'
import { searchTextKey, shareableSearchPrefix } from './keys'

test('index names keep the partition and add the one location', () => {
  expect(searchIndexName('ws', 'apac-ne')).toBe('ws:0@apac-ne')
  expect(searchIndexName('ws', 'weur')).toBe('ws:0@weur')
  expect(searchIndexName('ws', null)).toBe('ws:0')
})

test("a placed index's extracted text sits outside the legacy cleanup prefix", async () => {
  const legacy = shareableSearchPrefix('ws', 'file')
  const placed = await searchTextKey(
    'ws',
    'file',
    'v1',
    '/index.html',
    'apac-ne',
  )
  expect(placed.startsWith('search-text/@apac-ne/ws/file/')).toBe(true)
  expect(placed.startsWith(legacy)).toBe(false)
  // An encoded workspace id cannot collide with a location area.
  expect(shareableSearchPrefix('@apac-ne', 'file')).toBe(
    'search-text/%40apac-ne/file/',
  )
})

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-11-18T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES
      ('ws-a','A','${now}'),('ws-b','B','${now}'),('ws-c','C','${now}');
    INSERT INTO search_index_workspaces(workspace_id,dispatched_at,location_hint) VALUES
      ('ws-a','','apac-ne'),('ws-b','',NULL),('ws-c','','mars');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})

function namespace(fail = new Set<string>()) {
  const calls: Array<{
    name: string
    options?: { locationHint?: string }
    args: unknown[]
  }> = []
  return {
    calls,
    binding: {
      getByName: (name: string, options?: { locationHint?: string }) => ({
        sync: (...args: unknown[]) => {
          calls.push({ name, options, args })
          return fail.has(name)
            ? Promise.reject(new Error(`${name} failed`))
            : Promise.resolve()
        },
      }),
    } as never,
  }
}

test('dispatch syncs each workspace index in its one location', async () => {
  const { calls, binding } = namespace()
  await dispatchWorkspaceSearch(fixture.db, { WORKSPACE_SEARCH_INDEX: binding })
  expect(calls.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    {
      name: 'ws-a:0@apac-ne',
      options: { locationHint: 'apac-ne' },
      args: ['ws-a'],
    },
    {
      name: 'ws-b:0@apac-ne',
      options: { locationHint: 'apac-ne' },
      args: ['ws-b'],
    },
    {
      name: 'ws-c:0@apac-ne',
      options: { locationHint: 'apac-ne' },
      args: ['ws-c'],
    },
  ])
})

test('a failing workspace does not stop the others', async () => {
  const { calls, binding } = namespace(new Set(['ws-a:0@apac-ne']))
  await expect(
    dispatchWorkspaceSearch(fixture.db, { WORKSPACE_SEARCH_INDEX: binding }),
  ).rejects.toThrow('workspace_search_dispatch_failed')
  expect(calls.map((call) => call.name).sort()).toEqual([
    'ws-a:0@apac-ne',
    'ws-b:0@apac-ne',
    'ws-c:0@apac-ne',
  ])
})

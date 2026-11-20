import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: undefined }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { dispatchWorkspaceSearch } from './schedule.server'
import { searchIndexName } from './names'
import { searchTextKey, shareableSearchPrefix } from './keys'

test('index names keep the partition and the one location', () => {
  expect(searchIndexName('ws')).toBe('ws:0@apac-ne')
})

test('extracted text sits in the location area, apart from any workspace', async () => {
  const key = await searchTextKey('ws', 'file', 'v1', '/index.html')
  expect(key.startsWith(shareableSearchPrefix('ws', 'file'))).toBe(true)
  expect(key.startsWith('search-text/@apac-ne/ws/file/')).toBe(true)
  // An encoded workspace id cannot collide with a location area.
  expect(shareableSearchPrefix('@apac-ne', 'file')).toBe(
    'search-text/@apac-ne/%40apac-ne/file/',
  )
})

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-11-18T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES
      ('ws-a','A','${now}'),('ws-b','B','${now}'),('ws-c','C','${now}');
    INSERT INTO search_index_workspaces(workspace_id,dispatched_at) VALUES
      ('ws-a',''),('ws-b',''),('ws-c','');
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
      args: ['ws-a', false],
    },
    {
      name: 'ws-b:0@apac-ne',
      options: { locationHint: 'apac-ne' },
      args: ['ws-b', false],
    },
    {
      name: 'ws-c:0@apac-ne',
      options: { locationHint: 'apac-ne' },
      args: ['ws-c', false],
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

test('a failed seed write preserves its cursor, dispatches unrelated ready work and reports the error', async () => {
  fixture.sqlite.exec(`
    INSERT INTO search_index_ready(workspace_id) VALUES('deleted-ready');
    CREATE TRIGGER fail_seed BEFORE INSERT ON search_index_workspace_rebuilds
    BEGIN SELECT RAISE(ABORT,'synthetic seed failure'); END;
  `)
  const { calls, binding } = namespace()
  await expect(
    dispatchWorkspaceSearch(fixture.db, { WORKSPACE_SEARCH_INDEX: binding }),
  ).rejects.toMatchObject({
    message: 'workspace_search_dispatch_failed',
    errors: [
      expect.objectContaining({
        message: expect.stringContaining('synthetic seed failure'),
      }),
    ],
  })
  expect(calls.map((call) => call.args)).toEqual([['deleted-ready', false]])
  expect(
    fixture.sqlite
      .prepare('SELECT phase,cursor FROM search_index_rebuilds')
      .all(),
  ).toEqual([{ phase: 'live', cursor: '' }])
})

test('a retained newer target prevents dispatch even when its seeding is complete', async () => {
  fixture.sqlite.exec(`
    UPDATE search_index_rebuilds SET target=target+1,phase='done';
    INSERT INTO search_index_ready(workspace_id) VALUES('deleted-ready');
  `)
  const { calls, binding } = namespace()
  await dispatchWorkspaceSearch(fixture.db, { WORKSPACE_SEARCH_INDEX: binding })
  expect(calls).toEqual([])
})

test('a newer format arriving during a failed seed page fences fallback dispatch', async () => {
  fixture.sqlite.exec(
    "INSERT INTO search_index_ready(workspace_id) VALUES('deleted-ready')",
  )
  const insert = vi
    .spyOn(fixture.db, 'insertInto')
    .mockImplementationOnce(() => {
      fixture.sqlite.exec(
        'INSERT INTO search_index_rebuilds(target) SELECT max(target)+1 FROM search_index_rebuilds',
      )
      throw new Error('synthetic seed interruption')
    })
  const { calls, binding } = namespace()
  try {
    await expect(
      dispatchWorkspaceSearch(fixture.db, { WORKSPACE_SEARCH_INDEX: binding }),
    ).rejects.toThrow('workspace_search_dispatch_failed')
    expect(calls).toEqual([])
  } finally {
    insert.mockRestore()
  }
})

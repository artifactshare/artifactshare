import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { workspaceSearchIndexes } from './indexes.server'

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-11-18T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES
      ('ready','R','${now}'),('placing','P','${now}'),('legacy','L','${now}'),('odd','O','${now}');
    INSERT INTO search_index_workspaces(workspace_id,dispatched_at,location_hint,ready_at) VALUES
      ('ready','','apac-ne','${now}'),
      ('placing','','apac-ne',NULL),
      ('odd','','mars','${now}');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})

test('searches use the placed index only once it is ready, deciding once per workspace', async () => {
  const opened: Array<{ name: string; hint?: string }> = []
  const namespace = {
    getByName: (name: string, options?: { locationHint?: string }) => {
      opened.push({ name, hint: options?.locationHint })
      return {
        search: () => Promise.resolve({ items: [], nextCursor: null }),
        groupMembers: () => Promise.resolve({ items: [], nextCursor: null }),
        details: () => Promise.resolve([]),
      }
    },
  } as never
  let reads = 0
  const prepare = fixture.sqlite.prepare.bind(fixture.sqlite)
  fixture.sqlite.prepare = (sql: string) => {
    if (sql.includes('from "search_index_workspaces"')) reads++
    return prepare(sql)
  }
  const indexes = workspaceSearchIndexes(fixture.db, namespace)
  for (const workspace of ['ready', 'placing', 'legacy', 'odd']) {
    await indexes(workspace).search({ query: 'a' })
    await indexes(workspace).details({ query: 'a' }, [])
  }
  expect(opened).toEqual([
    { name: 'ready:0@apac-ne', hint: 'apac-ne' },
    { name: 'placing:0', hint: undefined },
    { name: 'legacy:0', hint: undefined },
    { name: 'odd:0', hint: undefined },
  ])
  expect(reads).toBe(4)
})

test('a choice read is retried once, then fails the search without opening the legacy index', async () => {
  const opened: string[] = []
  const namespace = {
    getByName: (name: string) => {
      opened.push(name)
      return {
        search: () => Promise.resolve({ items: [], nextCursor: null }),
        details: () => Promise.resolve([]),
      }
    },
  } as never
  let reads = 0
  let failures = 3
  const flaky = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: () => {
            reads++
            return failures-- > 0
              ? Promise.reject(new Error('d1 unavailable'))
              : Promise.resolve(undefined)
          },
        }),
      }),
    }),
  } as never
  const indexes = workspaceSearchIndexes(flaky, namespace)
  await expect(indexes('ws').search({ query: 'a' })).rejects.toThrow(
    'd1 unavailable',
  )
  expect(reads).toBe(2)
  // A retired legacy index is not recreated by a failed choice.
  expect(opened).toEqual([])
  // The failure is not kept: the next call reads again, and its retry
  // succeeds.
  await indexes('ws').search({ query: 'a' })
  expect(reads).toBe(4)
  expect(opened).toEqual(['ws:0'])
})

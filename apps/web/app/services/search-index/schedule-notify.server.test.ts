import { afterEach, beforeEach, expect, test, vi } from 'vitest'
const workerEnv = vi.hoisted(() => ({}) as Record<string, unknown>)
vi.mock('cloudflare:workers', () => ({ env: workerEnv, waitUntil: undefined }))
const database = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('../db.server', () => ({
  withDb: (run: (db: unknown) => Promise<unknown>) => run(database.current),
}))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { scheduleWorkspaceSearch } from './schedule.server'

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-11-18T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  database.current = fixture.db
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES ('ws-a','A','${now}'),('ws-b','B','${now}');
    INSERT INTO search_index_workspaces(workspace_id,dispatched_at,location_hint) VALUES ('ws-a','','apac-ne');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})

test('a notification reaches the legacy index and, once placed, the placed index', async () => {
  const synced: Array<{ name: string; hint?: string; args: unknown[] }> = []
  workerEnv.WORKSPACE_SEARCH_INDEX = {
    getByName: (name: string, options?: { locationHint?: string }) => ({
      sync: (...args: unknown[]) => {
        synced.push({ name, hint: options?.locationHint, args })
        return Promise.resolve()
      },
    }),
  }
  const pending: Promise<unknown>[] = []
  scheduleWorkspaceSearch('ws-a', (promise) => pending.push(promise))
  scheduleWorkspaceSearch('ws-b', (promise) => pending.push(promise))
  await Promise.all(pending)
  expect(synced.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: 'ws-a:0', hint: undefined, args: ['ws-a'] },
    { name: 'ws-a:0@apac-ne', hint: 'apac-ne', args: ['ws-a', 'apac-ne'] },
    { name: 'ws-b:0', hint: undefined, args: ['ws-b'] },
  ])
})

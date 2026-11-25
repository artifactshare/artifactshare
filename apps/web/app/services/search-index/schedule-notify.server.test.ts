import { expect, test, vi } from 'vitest'
const workerEnv = vi.hoisted(() => ({}) as Record<string, unknown>)
vi.mock('cloudflare:workers', () => ({ env: workerEnv, waitUntil: undefined }))
import { scheduleWorkspaceSearch } from './schedule.server'

test('a notification syncs the workspace index in its one location', async () => {
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
  expect(synced).toEqual([
    { name: 'ws-a:0@apac-ne', hint: 'apac-ne', args: ['ws-a'] },
    { name: 'ws-b:0@apac-ne', hint: 'apac-ne', args: ['ws-b'] },
  ])
})

test('a failed sync is logged without failing the caller', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  workerEnv.WORKSPACE_SEARCH_INDEX = {
    getByName: () => ({
      sync: () => Promise.reject(new Error('index unavailable')),
    }),
  }
  const pending: Promise<unknown>[] = []
  scheduleWorkspaceSearch('ws-a', (promise) => pending.push(promise))
  await expect(Promise.all(pending)).resolves.toHaveLength(1)
  // One marker and nothing else: the rejected value must not reach the log.
  expect(error.mock.calls).toEqual([[expect.any(String)]])
  error.mockRestore()
})

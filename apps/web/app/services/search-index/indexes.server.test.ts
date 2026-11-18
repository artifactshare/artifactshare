import { expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { workspaceSearchIndexes } from './indexes.server'

test('searches use each workspace index in its one location, without reading D1', async () => {
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
  const indexes = workspaceSearchIndexes(namespace)
  await indexes('ws-a').search({ query: 'a' })
  await indexes('ws-b').details({ query: 'a' }, [])
  expect(opened).toEqual([
    { name: 'ws-a:0@apac-ne', hint: 'apac-ne' },
    { name: 'ws-b:0@apac-ne', hint: 'apac-ne' },
  ])
})

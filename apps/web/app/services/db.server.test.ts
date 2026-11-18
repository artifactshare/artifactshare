import { expect, test, vi } from 'vitest'
import { d1Database, d1Statement } from '~/test/typed-fakes/d1'
import { createDb } from './db.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

test('queries that do not wait for each other run at the same time', async () => {
  let inFlight = 0
  let mostInFlight = 0
  const release: Array<() => void> = []
  const result = {
    results: [],
    success: true as const,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
  }
  const all = async () => {
    inFlight++
    mostInFlight = Math.max(mostInFlight, inFlight)
    await new Promise<void>((resolve) => release.push(resolve))
    inFlight--
    return result
  }
  const statement = d1Statement({ all })
  const db = createDb(d1Database({ prepare: () => statement }))
  const reads = Promise.all([
    db.selectFrom('users').select('id').execute(),
    db.selectFrom('workspaces').select('id').execute(),
  ])
  await vi.waitFor(() => expect(release).toHaveLength(2))
  for (const resolve of release) resolve()
  await reads
  expect(mostInFlight).toBe(2)
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const globalBatch = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: {
      prepare: vi.fn(() => {
        throw new Error('global D1 must not prepare injected queries')
      }),
      batch: globalBatch,
    },
  },
}))

import { createDb } from '~/services/db.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { runD1Batch } from './d1-batch.server'

describe('runD1Batch', () => {
  beforeEach(() => {
    globalBatch.mockClear()
  })

  test('uses the D1 binding associated with the query db instead of global env.DB', async () => {
    const prepared: Array<{ sql: string; parameters: unknown[] }> = []
    const injectedBatch = vi.fn(async () => [])
    const injectedD1 = {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const statement = { sql, parameters }
            prepared.push(statement)
            return statement
          },
        }
      },
      batch: injectedBatch,
    } as unknown as D1Database
    const db = createDb(injectedD1)

    try {
      await runD1Batch(
        db,
        db.insertInto('workspaces').values({
          id: 'ws-injected',
          hd: 'injected.example',
          name: 'Injected',
          created_at: '2026-08-19T00:00:00.000Z',
        }),
      )

      expect(injectedBatch).toHaveBeenCalledOnce()
      expect(injectedBatch).toHaveBeenCalledWith(prepared)
      expect(prepared).toHaveLength(1)
      expect(globalBatch).not.toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  test('executes queries sequentially when the db has no D1 binding', async () => {
    const fixture = createMigratedInMemoryDb()

    try {
      await runD1Batch(
        fixture.db,
        fixture.db.insertInto('workspaces').values({
          id: 'ws-fallback',
          hd: 'fallback.example',
          name: 'Fallback',
          created_at: '2026-08-19T00:00:00.000Z',
        }),
        fixture.db
          .updateTable('workspaces')
          .set({ name: 'Fallback updated' })
          .where('id', '=', 'ws-fallback'),
      )

      await expect(
        fixture.db
          .selectFrom('workspaces')
          .select(['id', 'name'])
          .where('id', '=', 'ws-fallback')
          .executeTakeFirst(),
      ).resolves.toEqual({ id: 'ws-fallback', name: 'Fallback updated' })
      expect(globalBatch).not.toHaveBeenCalled()
    } finally {
      await fixture.db.destroy()
    }
  })
})

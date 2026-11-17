import { expect, test } from 'vitest'
import {
  createSearchTimings,
  serverTiming,
  timeD1,
  timeIndexes,
} from './search-timing.server'
import type { SearchIndex } from './search.server'

test('statements and index calls add their counts and durations', async () => {
  const timings = createSearchTimings()
  const statement = {
    bind() {
      return statement
    },
    all: () => Promise.resolve({ results: [], meta: { duration: 3 } }),
  }
  const database = {
    prepare: () => statement,
    dump: () => 'kept',
  } as unknown as D1Database
  const timed = timeD1(database, timings)!
  await timed.prepare('select 1').bind(1).all()
  await timed.prepare('select 2').all()
  expect((timed as unknown as { dump: () => string }).dump()).toBe('kept')
  expect(timings.d1).toMatchObject({ count: 2, sqlMs: 6 })

  const index = {
    search: () =>
      Promise.resolve({ items: [], nextCursor: null, activeDocumentCount: 0 }),
    groupMembers: () =>
      Promise.resolve({ items: [], nextCursor: null, incompleteGroupKeys: [] }),
    details: () => Promise.resolve([]),
  } as unknown as SearchIndex
  const indexes = timeIndexes(() => index, timings)
  await indexes('ws').details({ query: 'a' } as never, ['a'])
  await expect(
    timeIndexes(
      () => ({
        ...index,
        search: () => Promise.reject(new Error('capacity')),
      }),
      timings,
    )('ws').search({ query: 'a' } as never),
  ).rejects.toThrow('capacity')
  expect(timings.index.count).toBe(2)

  expect(serverTiming(timings, 12.4)).toBe(
    `search;dur=12, d1;dur=${Math.round(timings.d1.ms)};desc="2 queries", d1sql;dur=6, index;dur=${Math.round(timings.index.ms)};desc="2 calls"`,
  )
})

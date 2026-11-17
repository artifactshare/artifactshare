import { afterEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import {
  createSearchTimings,
  serverTiming,
  timeD1,
  timeIndexes,
  withSearchTiming,
} from './search-timing.server'
import type { SearchIndex } from './search.server'
import { d1Database, d1Statement } from '~/test/typed-fakes/d1'

let clock = 0
afterEach(() => {
  vi.restoreAllMocks()
})

function d1Result(duration: number) {
  return {
    results: [],
    success: true as const,
    meta: {
      duration,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    },
  }
}

function fakeDatabase() {
  const releases: Array<() => void> = []
  const statement = d1Statement({
    all: () =>
      new Promise((resolve) => releases.push(() => resolve(d1Result(3)))),
  })
  const batch = vi.fn((statements: D1PreparedStatement[]) =>
    Promise.resolve(statements.map(() => d1Result(1))),
  )
  const dumped = new ArrayBuffer(1)
  const database = d1Database({
    prepare: () => statement,
    batch,
    dump: () => Promise.resolve(dumped),
  })
  return { database, statement, batch, releases, dumped }
}

test('overlapping statements count the time any was in flight, plus D1 SQL time', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const timings = createSearchTimings()
  const { database, statement, batch, releases, dumped } = fakeDatabase()
  const timed = timeD1(database, timings)!
  clock = 0
  const first = timed.prepare('select 1').all()
  clock = 10
  const second = timed.prepare('select 2').bind(1).all()
  clock = 30
  releases[0]()
  await first
  clock = 50
  releases[1]()
  await second
  expect(timings.d1).toMatchObject({ count: 2, busyMs: 50, sqlMs: 6 })
  // Methods the timing does not cover still reach the binding.
  expect(await timed.dump()).toBe(dumped)

  // A batch is one round trip of real statements, counted per statement.
  clock = 100
  const pending = timed.batch([
    timed.prepare('select 3'),
    timed.prepare('select 4'),
  ])
  clock = 120
  await pending
  expect(batch.mock.calls[0][0]).toEqual([statement, statement])
  expect(timings.d1).toMatchObject({ count: 4, busyMs: 70, sqlMs: 8 })
})

test('index calls are timed even when they fail, and the header carries totals only', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const timings = createSearchTimings()
  let fail: (error: Error) => void = () => {}
  const index: SearchIndex = {
    search: () =>
      new Promise((_, reject) => {
        fail = reject
      }),
    groupMembers: () => Promise.resolve({ items: [], nextCursor: null }),
    details: () => Promise.resolve([]),
  }
  clock = 200
  const call = timeIndexes(() => index, timings)('ws').search({} as never)
  clock = 260
  fail(new Error('capacity'))
  await expect(call).rejects.toThrow('capacity')
  expect(timings.index).toMatchObject({ count: 1, busyMs: 60 })
  expect(serverTiming(timings, 312.4)).toBe(
    'search;dur=312, d1;dur=0;desc="0 queries", d1sql;dur=0, index;dur=60;desc="1 calls", index-search;dur=60;desc="1 calls, fastest 60ms"',
  )
})

test('a breakdown taken mid-flight includes calls still running', () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const timings = createSearchTimings()
  clock = 300
  void timeD1(fakeDatabase().database, timings)!.prepare('select 1').all()
  clock = 1300
  expect(serverTiming(timings, 1000)).toContain(
    'd1;dur=1000;desc="0 queries, 1 running"',
  )
})

test('an expected outcome keeps its breakdown without a failure log', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const outcome = await withSearchTiming(
    'search',
    () => Promise.reject(new RangeError('capacity')),
    (error) => (error instanceof RangeError ? 'narrow' : undefined),
  )
  expect(outcome.value).toBe('narrow')
  expect(outcome.serverTiming).toContain('search;dur=')
  expect(warn).not.toHaveBeenCalled()
})

test('a failed search logs its breakdown and rethrows', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(
    withSearchTiming('search', () => Promise.reject(new Error('d1 timeout'))),
  ).rejects.toThrow('d1 timeout')
  expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
    event: 'search_timing_failed',
    route: 'search',
    serverTiming: expect.stringContaining('search;dur='),
  })
})

test('each index method reports its fastest and slowest call', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const timings = createSearchTimings()
  const releases: Array<() => void> = []
  const index: SearchIndex = {
    search: () => Promise.resolve({ items: [], nextCursor: null }),
    groupMembers: () => Promise.resolve({ items: [], nextCursor: null }),
    details: () => new Promise((resolve) => releases.push(() => resolve([]))),
  }
  const indexes = timeIndexes(() => index, timings)
  clock = 0
  const slow = indexes('a').details({} as never, ['a'])
  clock = 40
  const fast = indexes('b').details({} as never, ['b'])
  clock = 60
  releases[1]()
  await fast
  clock = 400
  releases[0]()
  await slow
  expect(timings.indexCalls.details).toEqual({
    count: 2,
    minMs: 20,
    maxMs: 400,
  })
  expect(serverTiming(timings, 400)).toContain(
    'index-details;dur=400;desc="2 calls, fastest 20ms"',
  )
})

import type { SearchIndex, SearchIndexes } from './search.server'

/**
 * Where one search request spends its time. Workers clocks advance only
 * across I/O, so wall time is measured around each D1 statement and index
 * call; D1 also reports the SQL time inside the database (meta.duration).
 */
export type SearchTimings = {
  d1: { count: number; ms: number; sqlMs: number }
  index: { count: number; ms: number }
}

export function createSearchTimings(): SearchTimings {
  return { d1: { count: 0, ms: 0, sqlMs: 0 }, index: { count: 0, ms: 0 } }
}

type D1Result = { meta?: { duration?: number } }
const timedMethods = new Set(['all', 'run', 'first', 'raw'])

function timeStatement(
  statement: D1PreparedStatement,
  timings: SearchTimings,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'bind')
        return (...values: unknown[]) =>
          timeStatement(target.bind(...values), timings)
      if (typeof property !== 'string' || !timedMethods.has(property))
        return value.bind(target)
      return async (...args: unknown[]) => {
        const started = performance.now()
        try {
          const result: unknown = await value.apply(target, args)
          const duration = (result as D1Result | null)?.meta?.duration
          if (typeof duration === 'number') timings.d1.sqlMs += duration
          return result
        } finally {
          timings.d1.count++
          timings.d1.ms += performance.now() - started
        }
      }
    },
  })
}

/** Time every statement a search prepares on this binding. */
export function timeD1(
  database: D1Database | undefined,
  timings: SearchTimings,
): D1Database | undefined {
  // Without a binding, withDb falls back to its default database untimed.
  if (!database) return undefined
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (property === 'prepare')
        return (sql: string) => timeStatement(target.prepare(sql), timings)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Time every call a search makes to its workspace indexes. */
export function timeIndexes(
  indexes: SearchIndexes,
  timings: SearchTimings,
): SearchIndexes {
  const timed =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const started = performance.now()
      try {
        return await call(...args)
      } finally {
        timings.index.count++
        timings.index.ms += performance.now() - started
      }
    }
  return (workspaceId) => {
    const index = indexes(workspaceId)
    return {
      search: timed((...args: Parameters<SearchIndex['search']>) =>
        index.search(...args),
      ),
      groupMembers: timed((...args: Parameters<SearchIndex['groupMembers']>) =>
        index.groupMembers(...args),
      ),
      details: timed((...args: Parameters<SearchIndex['details']>) =>
        index.details(...args),
      ),
    }
  }
}

/** Totals only: the header is visible to the signed-in viewer. */
export function serverTiming(timings: SearchTimings, totalMs: number) {
  const ms = (value: number) => Math.round(value)
  return [
    `search;dur=${ms(totalMs)}`,
    `d1;dur=${ms(timings.d1.ms)};desc="${timings.d1.count} queries"`,
    `d1sql;dur=${ms(timings.d1.sqlMs)}`,
    `index;dur=${ms(timings.index.ms)};desc="${timings.index.count} calls"`,
  ].join(', ')
}

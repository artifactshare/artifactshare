import { env } from 'cloudflare:workers'
import { withDb, type Db } from './db.server'
import type { SearchIndex, SearchIndexes } from './search.server'

/**
 * Time one kind of I/O. Searches run calls side by side, so the reported
 * duration is the time at least one call was in flight, not their sum.
 * Workers clocks advance only across I/O, which is what is measured here.
 */
type Lane = { count: number; busyMs: number; inflight: number; since: number }

/**
 * One index method's fastest and slowest single call. A fast call bounds the
 * round trip to the index, so a slow fastest call points at its location and
 * a fast fastest call with a slow slowest call points at the work inside it.
 */
type CallRange = { count: number; minMs: number; maxMs: number }
type IndexMethod = keyof SearchIndex

/** Where one search request spends its time. */
export type SearchTimings = {
  d1: Lane & { sqlMs: number }
  index: Lane
  indexCalls: Partial<Record<IndexMethod, CallRange>>
}

const lane = (): Lane => ({ count: 0, busyMs: 0, inflight: 0, since: 0 })

export function createSearchTimings(): SearchTimings {
  return { d1: { ...lane(), sqlMs: 0 }, index: lane(), indexCalls: {} }
}

async function track<T>(target: Lane, calls: number, run: () => Promise<T>) {
  if (target.inflight++ === 0) target.since = performance.now()
  try {
    return await run()
  } finally {
    target.count += calls
    if (--target.inflight === 0)
      target.busyMs += performance.now() - target.since
  }
}

type D1Result = { meta?: { duration?: number } }
const timedMethods = new Set(['all', 'run', 'first', 'raw'])

/** D1 reports SQL execution time inside the database; first() and raw() do not. */
function addSqlTime(timings: SearchTimings, result: unknown) {
  for (const entry of Array.isArray(result) ? result : [result]) {
    const duration = (entry as D1Result | null)?.meta?.duration
    if (typeof duration === 'number') timings.d1.sqlMs += duration
  }
}

/** D1 batches accept only the binding's own statements, not proxies. */
const bindingStatements = new WeakMap<object, D1PreparedStatement>()

function timeStatement(
  statement: D1PreparedStatement,
  timings: SearchTimings,
): D1PreparedStatement {
  const timed = new Proxy(statement, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property === 'bind')
        return (...values: unknown[]) =>
          timeStatement(target.bind(...values), timings)
      if (typeof property !== 'string' || !timedMethods.has(property))
        return value.bind(target)
      return (...args: unknown[]) =>
        track(timings.d1, 1, async () => {
          const result: unknown = await value.apply(target, args)
          addSqlTime(timings, result)
          return result
        })
    },
  })
  bindingStatements.set(timed, statement)
  return timed
}

/** Time every statement and batch a search runs on this binding. */
export function timeD1(
  database: D1Database | undefined,
  timings: SearchTimings,
): D1Database | undefined {
  // Without a binding, withDb falls back to its default database untimed.
  if (!database) return undefined
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (property === 'prepare' && typeof value === 'function')
        // Forwards the caller's SQL unchanged; the D1 compatibility checks
        // apply where that SQL is written (Kysely or a literal prepare call).
        return (sql: string) =>
          timeStatement(
            Reflect.apply(value, target, [sql]) as D1PreparedStatement,
            timings,
          )
      if (property === 'batch')
        // A batch is one round trip, counted by its statements.
        return (statements: D1PreparedStatement[]) =>
          track(timings.d1, statements.length, async () => {
            const result = await target.batch(
              statements.map((entry) => bindingStatements.get(entry) ?? entry),
            )
            addSqlTime(timings, result)
            return result
          })
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
    <A extends unknown[], R>(
      method: IndexMethod,
      call: (...args: A) => Promise<R>,
    ) =>
    (...args: A) =>
      track(timings.index, 1, async () => {
        const started = performance.now()
        try {
          return await call(...args)
        } finally {
          const ms = performance.now() - started
          const range = timings.indexCalls[method]
          timings.indexCalls[method] = range
            ? {
                count: range.count + 1,
                minMs: Math.min(range.minMs, ms),
                maxMs: Math.max(range.maxMs, ms),
              }
            : { count: 1, minMs: ms, maxMs: ms }
        }
      })
  return (workspaceId) => {
    const index = indexes(workspaceId)
    return {
      search: timed('search', (...args: Parameters<SearchIndex['search']>) =>
        index.search(...args),
      ),
      groupMembers: timed(
        'groupMembers',
        (...args: Parameters<SearchIndex['groupMembers']>) =>
          index.groupMembers(...args),
      ),
      details: timed('details', (...args: Parameters<SearchIndex['details']>) =>
        index.details(...args),
      ),
    }
  }
}

/** Busy time so far, including calls still in flight when a search fails. */
function lanePart(name: string, target: Lane, unit: string, now: number) {
  const busy = target.busyMs + (target.inflight > 0 ? now - target.since : 0)
  const running = target.inflight > 0 ? `, ${target.inflight} running` : ''
  return `${name};dur=${Math.round(busy)};desc="${target.count} ${unit}${running}"`
}

/** Totals only: the header is visible to the signed-in viewer. */
export function serverTiming(timings: SearchTimings, totalMs: number) {
  const now = performance.now()
  return [
    `search;dur=${Math.round(totalMs)}`,
    lanePart('d1', timings.d1, 'queries', now),
    `d1sql;dur=${Math.round(timings.d1.sqlMs)}`,
    lanePart('index', timings.index, 'calls', now),
    ...Object.entries(timings.indexCalls).map(
      ([method, range]) =>
        `index-${method};dur=${Math.round(range.maxMs)};desc="${range.count} calls, fastest ${Math.round(range.minMs)}ms"`,
    ),
  ].join(', ')
}

const workspaceIndexes: SearchIndexes = (workspace) =>
  env.WORKSPACE_SEARCH_INDEX.getByName(`${workspace}:0`)

/**
 * Run one search request with timed D1 and index access. The breakdown is
 * returned for the Server-Timing header. `expected` turns a known outcome,
 * such as a capacity error, into a value that keeps its breakdown; any other
 * error is logged with the breakdown so slow failures still leave a record.
 */
export async function withSearchTiming<T, E = never>(
  route: string,
  run: (db: Db, indexes: SearchIndexes) => Promise<T>,
  expected?: (error: unknown) => E | undefined,
): Promise<{ value: T | E; serverTiming: string }> {
  const timings = createSearchTimings(),
    started = performance.now()
  try {
    const value = await withDb(
      (db) => run(db, timeIndexes(workspaceIndexes, timings)),
      timeD1(env.DB, timings),
    )
    return {
      value,
      serverTiming: serverTiming(timings, performance.now() - started),
    }
  } catch (error) {
    const value = expected?.(error)
    if (value !== undefined)
      return {
        value,
        serverTiming: serverTiming(timings, performance.now() - started),
      }
    console.warn(
      JSON.stringify({
        event: 'search_timing_failed',
        route,
        serverTiming: serverTiming(timings, performance.now() - started),
      }),
    )
    throw error
  }
}

/**
 * Temporary location check: the round trip to two new, empty index objects,
 * one created with the apac-ne location hint and one without a hint. The
 * first call creates each object, so the second call is the one reported.
 */
export async function probeIndexLocations(): Promise<string[]> {
  const ping = async (
    label: string,
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ) => {
    const index = env.WORKSPACE_SEARCH_INDEX.getByName(name, options)
    await index.details({ query: 'probe' }, [])
    const started = performance.now()
    await index.details({ query: 'probe' }, [])
    return `${label};dur=${Math.round(performance.now() - started)}`
  }
  return Promise.all([
    ping('probe-apac-ne', 'location-probe-apac-ne:0', {
      locationHint: 'apac-ne',
    }),
    ping('probe-default', 'location-probe-default:0'),
  ])
}

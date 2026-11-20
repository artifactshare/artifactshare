import { sql } from 'kysely'
import type { Db } from './db.server'
import type { SearchIndexes } from './search.server'

export class SearchDailyLimitError extends Error {
  readonly code = 'search_daily_limit_exceeded'
  readonly retry_at: string
  readonly retry_after_seconds: number
  constructor(now: string) {
    const reset = new Date(now)
    reset.setUTCHours(24, 0, 0, 0)
    super(
      `Daily search limit reached. Wait until ${reset.toISOString()} before searching again.`,
    )
    this.retry_at = reset.toISOString()
    this.retry_after_seconds = Math.max(
      1,
      Math.ceil((reset.getTime() - new Date(now).getTime()) / 1000),
    )
  }
  get error() {
    return {
      code: this.code,
      message: this.message,
      retry_at: this.retry_at,
      details: {
        retry_at: this.retry_at,
        retry_after_seconds: this.retry_after_seconds,
      },
    }
  }
  get headers() {
    return {
      'Cache-Control': 'private, no-store',
      'Retry-After': String(this.retry_after_seconds),
    }
  }
}

/** One atomic indexed write; a storage exception deliberately remains an exception. */
export async function admitSearch(db: Db, actor: string, now: string) {
  const row = await db
    .insertInto('search_actor_daily_usage')
    .values({ actor_id: actor, day: now.slice(0, 10), requests: 1 })
    .onConflict((conflict) =>
      conflict
        .columns(['actor_id', 'day'])
        .doUpdateSet({
          requests: sql<number>`search_actor_daily_usage.requests + 1`,
        })
        .where('search_actor_daily_usage.requests', '<', 1000),
    )
    .returning('requests')
    .executeTakeFirst()
  if (!row) throw new SearchDailyLimitError(now)
}

/** Count actual index invocations, once per workspace, including failed/empty queries. */
export function meterSearchIndexes(
  db: Db,
  indexes: SearchIndexes,
  now: string,
): SearchIndexes {
  const counted = new Map<string, Promise<void>>()
  let diagnosed = false
  async function count(workspace: string) {
    let pending = counted.get(workspace)
    if (!pending) {
      pending = db
        .insertInto('search_workspace_daily_usage')
        .values({ workspace_id: workspace, day: now.slice(0, 10), requests: 1 })
        .onConflict((conflict) =>
          conflict.columns(['workspace_id', 'day']).doUpdateSet({
            requests: sql<number>`search_workspace_daily_usage.requests + 1`,
          }),
        )
        .execute()
        .then(
          () => {},
          () => {
            if (!diagnosed) console.error('search_workspace_usage_write_failed')
            diagnosed = true
          },
        )
      counted.set(workspace, pending)
    }
    await pending
  }
  async function invoke<T>(workspace: string, run: () => Promise<T>) {
    const measured = count(workspace)
    try {
      return await run()
    } finally {
      await measured
      // Include every workspace already invoked before this call settled.
      await Promise.all(counted.values())
    }
  }
  return (workspace) => ({
    search: (input) =>
      invoke(workspace, () => indexes(workspace).search(input)),
    groupMembers: (input, keys) =>
      invoke(workspace, () => indexes(workspace).groupMembers(input, keys)),
    details: (input, ids) =>
      invoke(workspace, () => indexes(workspace).details(input, ids)),
  })
}

export async function pruneSearchUsage(db: Db, cutoff: string, now: string) {
  // Each table has its own indexed, bounded batch. Callers repeat while full.
  const actor = await sql`DELETE FROM search_actor_daily_usage WHERE rowid IN (
    SELECT rowid FROM search_actor_daily_usage WHERE day < ${now.slice(0, 10)} ORDER BY day LIMIT 500
  ) RETURNING actor_id`.execute(db)
  const workspace =
    await sql`DELETE FROM search_workspace_daily_usage WHERE rowid IN (
    SELECT rowid FROM search_workspace_daily_usage WHERE day < ${cutoff.slice(0, 10)} ORDER BY day LIMIT 500
  ) RETURNING workspace_id`.execute(db)
  return Math.max(actor.rows.length, workspace.rows.length)
}

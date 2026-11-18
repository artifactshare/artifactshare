import * as workers from 'cloudflare:workers'
import { env } from 'cloudflare:workers'
import type { Db } from '../db.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import { workspaceSearchIndex } from './names'

export type SearchEnvironment = {
  WORKSPACE_SEARCH_INDEX?: DurableObjectNamespace<WorkspaceSearchIndex>
}

/** A notification contains only identity; D1 supplies all content and metadata. */
export function scheduleWorkspaceSearch(
  workspaceId: string,
  background?: (promise: Promise<unknown>) => void,
): void {
  if (!env.WORKSPACE_SEARCH_INDEX) return
  try {
    const promise = Promise.resolve()
      .then(() =>
        workspaceSearchIndex(env.WORKSPACE_SEARCH_INDEX, workspaceId).sync(
          workspaceId,
        ),
      )
      .catch(() => {
        console.error('workspace_search_notification_failed')
      })
    ;(background ?? workers.waitUntil)(promise)
  } catch {
    console.error('workspace_search_notification_failed')
  }
}

/** Oldest dispatch first is a durable pagination cursor, including deleted workspaces. */
export async function dispatchWorkspaceSearch(
  db: Db,
  bindings: SearchEnvironment,
): Promise<void> {
  if (!bindings.WORKSPACE_SEARCH_INDEX) return
  const live = await db
    .selectFrom('workspaces as w')
    .leftJoin('search_index_workspaces as r', 'r.workspace_id', 'w.id')
    .select('w.id')
    .where('r.workspace_id', 'is', null)
    .orderBy('w.id')
    .limit(50)
    .execute()
  for (const row of live)
    await db
      .insertInto('search_index_workspaces')
      .values({ workspace_id: row.id, dispatched_at: '' })
      .onConflict((oc) => oc.column('workspace_id').doNothing())
      .execute()
  const rows = await db
    .selectFrom('search_index_workspaces')
    .select('workspace_id')
    .orderBy('dispatched_at')
    .orderBy('workspace_id')
    .limit(50)
    .execute()
  const failures: unknown[] = []
  await Promise.all(
    rows.map(async (row) => {
      // Advance even when one workspace is broken, so it cannot starve others.
      try {
        await db
          .updateTable('search_index_workspaces')
          .set({ dispatched_at: new Date().toISOString() })
          .where('workspace_id', '=', row.workspace_id)
          .execute()
        await workspaceSearchIndex(
          bindings.WORKSPACE_SEARCH_INDEX!,
          row.workspace_id,
        ).sync(row.workspace_id)
      } catch (error) {
        failures.push(error)
      }
    }),
  )
  if (failures.length) throw new Error('workspace_search_dispatch_failed')
}

import * as workers from 'cloudflare:workers'
import { env } from 'cloudflare:workers'
import type { Db } from '../db.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import { workspaceSearchIndex } from './names'
import { INDEX_FORMAT_VERSION } from './normalize'

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

/** One bounded seed page per invocation; completed targets remain rollback fences. */
export async function seedSearchRebuild(
  db: Db,
  supported = INDEX_FORMAT_VERSION,
): Promise<boolean> {
  const latest = await db
    .selectFrom('search_index_rebuilds')
    .selectAll()
    .orderBy('target', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!latest) return true
  if (latest.target > supported) return false
  if (latest.phase === 'done') return true
  const rows =
    latest.phase === 'live'
      ? await db
          .selectFrom('workspaces')
          .select('id as workspace_id')
          .where('id', '>', latest.cursor)
          .orderBy('id')
          .limit(50)
          .execute()
      : await db
          .selectFrom('search_index_workspaces')
          .select('workspace_id')
          .where('workspace_id', '>', latest.cursor)
          .orderBy('workspace_id')
          .limit(50)
          .execute()
  for (const row of rows) {
    await db
      .insertInto('search_index_workspace_rebuilds')
      .values({
        workspace_id: row.workspace_id,
        target: latest.target,
        completed: 0,
      })
      .onConflict((oc) =>
        oc
          .column('workspace_id')
          .doUpdateSet({ target: latest.target, completed: 0 })
          .where('search_index_workspace_rebuilds.target', '<', latest.target),
      )
      .execute()
  }
  // Retrying an interrupted page cannot reset a completed workspace target.
  await db
    .updateTable('search_index_rebuilds')
    .set(
      rows.length === 50
        ? { cursor: rows.at(-1)!.workspace_id }
        : { cursor: '', phase: latest.phase === 'live' ? 'legacy' : 'done' },
    )
    .where('target', '=', latest.target)
    .where('phase', '=', latest.phase)
    .where('cursor', '=', latest.cursor)
    .execute()
  return true
}

/** Only durable ready rows are rotated, including deleted workspaces. */
export async function dispatchWorkspaceSearch(
  db: Db,
  bindings: SearchEnvironment,
): Promise<void> {
  if (!bindings.WORKSPACE_SEARCH_INDEX) return
  if (!(await seedSearchRebuild(db))) return
  const rows = await db
    .selectFrom('search_index_ready')
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
          .updateTable('search_index_ready')
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

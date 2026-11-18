import * as workers from 'cloudflare:workers'
import { env } from 'cloudflare:workers'
import { withDb, type Db } from '../db.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import {
  isSearchIndexLocation,
  placedSearchIndex,
  readyPlacedLocation,
  searchIndexName,
  type SearchIndexLocation,
} from './names'
import { readPlacement } from './placement.server'

export type SearchEnvironment = {
  WORKSPACE_SEARCH_INDEX?: DurableObjectNamespace<WorkspaceSearchIndex>
}

/** Where a workspace's searches go: its recorded location, and whether the index there is ready. */
type Placement = { location?: SearchIndexLocation; ready: boolean }

/**
 * Sync a workspace's legacy index until its placed index is ready, then,
 * once its location is known, the index placed there. The placed sync runs
 * after the legacy one so it can reuse the legacy extraction of a new
 * version. Once searches use the placed index, the legacy one is no longer
 * synced and removes itself. Each sync fails on its own.
 */
async function syncWorkspaceIndexes(
  namespace: DurableObjectNamespace<WorkspaceSearchIndex>,
  workspaceId: string,
  placement: Promise<Placement>,
): Promise<void> {
  const { location, ready } = await placement
  const legacy = await Promise.allSettled([
    Promise.resolve().then(() =>
      location && ready
        ? undefined
        : namespace.getByName(searchIndexName(workspaceId)).sync(workspaceId),
    ),
  ])
  // Deliberately after the legacy sync, so a new version's extraction exists.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const placed = await Promise.allSettled([
    location
      ? placedSearchIndex(namespace, workspaceId, location).sync(
          workspaceId,
          location,
        )
      : undefined,
  ])
  const failure = [...legacy, ...placed].find(
    (result) => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

function recordedPlacement(
  row: { location_hint: string | null; ready_at: string | null } | undefined,
): Placement {
  const location = isSearchIndexLocation(row?.location_hint)
    ? row.location_hint
    : undefined
  return { location, ready: Boolean(readyPlacedLocation(row)) }
}

/** A notification contains only identity; D1 supplies all content and metadata. */
export function scheduleWorkspaceSearch(
  workspaceId: string,
  background?: (promise: Promise<unknown>) => void,
): void {
  if (!env.WORKSPACE_SEARCH_INDEX) return
  try {
    const placement = withDb((db) => readPlacement(db, workspaceId)).then(
      recordedPlacement,
      // An unreadable location syncs only the legacy index, as before.
      (): Placement => ({ ready: false }),
    )
    const promise = syncWorkspaceIndexes(
      env.WORKSPACE_SEARCH_INDEX,
      workspaceId,
      placement,
    ).catch(() => {
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
    .select(['workspace_id', 'location_hint', 'ready_at'])
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
        await syncWorkspaceIndexes(
          bindings.WORKSPACE_SEARCH_INDEX!,
          row.workspace_id,
          Promise.resolve(recordedPlacement(row)),
        )
      } catch (error) {
        failures.push(error)
      }
    }),
  )
  if (failures.length) throw new Error('workspace_search_dispatch_failed')
}

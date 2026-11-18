import * as workers from 'cloudflare:workers'
import { env } from 'cloudflare:workers'
import { withDb, type Db } from '../db.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import {
  isSearchIndexLocation,
  placedSearchIndex,
  searchIndexName,
  type SearchIndexLocation,
} from './names'

export type SearchEnvironment = {
  WORKSPACE_SEARCH_INDEX?: DurableObjectNamespace<WorkspaceSearchIndex>
}

/**
 * Sync a workspace's legacy index, then, once its location is known, the
 * index placed there. The placed sync runs after the legacy one so it can
 * reuse the legacy extraction of a new version. Each sync fails on its own.
 */
async function syncWorkspaceIndexes(
  namespace: DurableObjectNamespace<WorkspaceSearchIndex>,
  workspaceId: string,
  location: Promise<SearchIndexLocation | undefined>,
): Promise<void> {
  const legacy = await Promise.allSettled([
    Promise.resolve().then(() =>
      namespace.getByName(searchIndexName(workspaceId)).sync(workspaceId),
    ),
  ])
  // Deliberately after the legacy sync, so a new version's extraction exists.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const placed = await Promise.allSettled([
    location.then((value) =>
      value
        ? placedSearchIndex(namespace, workspaceId, value).sync(
            workspaceId,
            value,
          )
        : undefined,
    ),
  ])
  const failure = [...legacy, ...placed].find(
    (result) => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

function recordedLocation(value: string | null | undefined) {
  return isSearchIndexLocation(value) ? value : undefined
}

/** A notification contains only identity; D1 supplies all content and metadata. */
export function scheduleWorkspaceSearch(
  workspaceId: string,
  background?: (promise: Promise<unknown>) => void,
): void {
  if (!env.WORKSPACE_SEARCH_INDEX) return
  try {
    // The legacy sync does not wait for the location read.
    const location = withDb((db) =>
      db
        .selectFrom('search_index_workspaces')
        .select('location_hint')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst(),
    ).then(
      (row) => recordedLocation(row?.location_hint),
      // An unreadable location syncs only the legacy index, as before.
      () => undefined,
    )
    const promise = syncWorkspaceIndexes(
      env.WORKSPACE_SEARCH_INDEX,
      workspaceId,
      location,
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
    .select(['workspace_id', 'location_hint'])
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
          Promise.resolve(recordedLocation(row.location_hint)),
        )
      } catch (error) {
        failures.push(error)
      }
    }),
  )
  if (failures.length) throw new Error('workspace_search_dispatch_failed')
}

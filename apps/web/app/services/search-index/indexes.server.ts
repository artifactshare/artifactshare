import { env } from 'cloudflare:workers'
import type { Db } from '../db.server'
import type { SearchIndexes } from '../search.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import {
  isSearchIndexLocation,
  placedSearchIndex,
  searchIndexName,
} from './names'

/**
 * The index each workspace's searches use in one request: the placed index
 * once it has recorded that it is ready, the legacy index until then. The
 * choice is read once per workspace per request.
 */
export function workspaceSearchIndexes(
  db: Db,
  namespace: DurableObjectNamespace<WorkspaceSearchIndex> = env.WORKSPACE_SEARCH_INDEX,
): SearchIndexes {
  const chosen = new Map<
    string,
    Promise<DurableObjectStub<WorkspaceSearchIndex>>
  >()
  const choose = (workspaceId: string) => {
    let index = chosen.get(workspaceId)
    if (!index) {
      index = db
        .selectFrom('search_index_workspaces')
        .select(['location_hint', 'ready_at'])
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst()
        .then((row) =>
          row?.ready_at && isSearchIndexLocation(row.location_hint)
            ? placedSearchIndex(namespace, workspaceId, row.location_hint)
            : namespace.getByName(searchIndexName(workspaceId)),
        )
      chosen.set(workspaceId, index)
    }
    return index
  }
  return (workspaceId) => ({
    search: async (...args) => (await choose(workspaceId)).search(...args),
    groupMembers: async (...args) =>
      (await choose(workspaceId)).groupMembers(...args),
    details: async (...args) => (await choose(workspaceId)).details(...args),
  })
}

import { env } from 'cloudflare:workers'
import type { Db } from '../db.server'
import type { SearchIndexes } from '../search.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import {
  placedSearchIndex,
  readyPlacedLocation,
  searchIndexName,
} from './names'
import { readPlacement } from './placement.server'

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
      // A transient read failure is retried once. A failure after that fails
      // the search and is not kept, so a later call reads again. Falling
      // back to the legacy index would recreate one that already retired,
      // and the search's own permission checks need D1 as well.
      const read = () => readPlacement(db, workspaceId)
      index = read()
        .catch(read)
        .then((row) => {
          const location = readyPlacedLocation(row)
          return location
            ? placedSearchIndex(namespace, workspaceId, location)
            : namespace.getByName(searchIndexName(workspaceId))
        })
      index.catch(() => chosen.delete(workspaceId))
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

import { env } from 'cloudflare:workers'
import type { SearchIndexes } from '../search.server'
import type { WorkspaceSearchIndex } from '../../../workers/workspace-search-index'
import { workspaceSearchIndex } from './names'

/** The index each workspace's searches use. */
export function workspaceSearchIndexes(
  namespace: DurableObjectNamespace<WorkspaceSearchIndex> = env.WORKSPACE_SEARCH_INDEX,
): SearchIndexes {
  return (workspaceId) => {
    const index = workspaceSearchIndex(namespace, workspaceId)
    return {
      search: (...args) => index.search(...args),
      groupMembers: (...args) => index.groupMembers(...args),
      details: (...args) => index.details(...args),
    }
  }
}

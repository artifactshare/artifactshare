/** The Durable Object regions a workspace search index was ever created in. */
export const SEARCH_INDEX_LOCATIONS = [
  'wnam',
  'enam',
  'sam',
  'weur',
  'eeur',
  'apac',
  'apac-ne',
  'apac-se',
  'oc',
  'afr',
  'me',
] as const
export type SearchIndexLocation = (typeof SEARCH_INDEX_LOCATIONS)[number]

/** Where every workspace search index runs: Northeast Asia, near most members. */
export const SEARCH_INDEX_LOCATION = 'apac-ne' satisfies SearchIndexLocation

/**
 * An index object name for a workspace. `:0` is the partition, and the
 * suffix is the location the object was created in. With a null location it is
 * the name of an index from before indexes were placed; that index, and any
 * index placed elsewhere, deletes itself.
 */
export function searchIndexName(
  workspaceId: string,
  location: SearchIndexLocation | null,
): string {
  return location ? `${workspaceId}:0@${location}` : `${workspaceId}:0`
}

/** The workspace's search index, created in its location on first use. */
export function workspaceSearchIndex<
  T extends Rpc.DurableObjectBranded | undefined,
>(
  namespace: DurableObjectNamespace<T>,
  workspaceId: string,
): DurableObjectStub<T> {
  return namespace.getByName(
    searchIndexName(workspaceId, SEARCH_INDEX_LOCATION),
    {
      locationHint: SEARCH_INDEX_LOCATION,
    },
  )
}

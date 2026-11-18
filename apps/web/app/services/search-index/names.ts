/** Where every workspace search index runs: Northeast Asia, near most members. */
export const SEARCH_INDEX_LOCATION = 'apac-ne'

/** A workspace's search index name. `:0` is the partition, then its location. */
export function searchIndexName(workspaceId: string): string {
  return `${workspaceId}:0@${SEARCH_INDEX_LOCATION}`
}

/** The workspace's search index, created in its location on first use. */
export function workspaceSearchIndex<
  T extends Rpc.DurableObjectBranded | undefined,
>(
  namespace: DurableObjectNamespace<T>,
  workspaceId: string,
): DurableObjectStub<T> {
  return namespace.getByName(searchIndexName(workspaceId), {
    locationHint: SEARCH_INDEX_LOCATION,
  })
}

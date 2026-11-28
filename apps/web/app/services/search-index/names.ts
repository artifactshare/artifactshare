export const SEARCH_INDEX_LOCATION = 'apac-ne'

export function searchIndexName(workspaceId: string): string {
  return `${workspaceId}:0@${SEARCH_INDEX_LOCATION}`
}

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

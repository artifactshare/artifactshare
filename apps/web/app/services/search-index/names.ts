/** The Durable Object regions a workspace search index can be created in. */
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

export function isSearchIndexLocation(
  value: unknown,
): value is SearchIndexLocation {
  return SEARCH_INDEX_LOCATIONS.includes(value as SearchIndexLocation)
}

/**
 * The index object name for a workspace. `:0` is the partition. A placed
 * index adds its location, so it is a different object from the legacy one
 * and is created in that location.
 */
export function searchIndexName(
  workspaceId: string,
  location?: SearchIndexLocation,
): string {
  return location ? `${workspaceId}:0@${location}` : `${workspaceId}:0`
}

/** The workspace index placed in a location, created there on first use. */
export function placedSearchIndex<
  T extends Rpc.DurableObjectBranded | undefined,
>(
  namespace: DurableObjectNamespace<T>,
  workspaceId: string,
  location: SearchIndexLocation,
): DurableObjectStub<T> {
  return namespace.getByName(searchIndexName(workspaceId, location), {
    locationHint: location,
  })
}

/**
 * The location whose placed index a workspace's searches use: recorded and
 * reported ready. Until then the legacy index is searched and synced.
 */
export function readyPlacedLocation(
  row: { location_hint: string | null; ready_at: string | null } | undefined,
): SearchIndexLocation | undefined {
  return row?.ready_at && isSearchIndexLocation(row.location_hint)
    ? row.location_hint
    : undefined
}

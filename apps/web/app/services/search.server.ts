import { searchVisibilitySources } from './search-visibility.server'
import { admitSearch, meterSearchIndexes } from './search-quota.server'
import { createHash } from 'node:crypto'
import {
  newSearchTokenKey,
  sealSearchToken,
  readSearchToken,
} from './search-logs.server'
import { sql } from 'kysely'
import type { Db } from './db.server'
import type { SessionUser } from '~/lib/user'
import {
  discoverCandidates,
  loadDiscoveryViewer,
  suggestionOwners,
  discoverSuggestionCandidates,
  enumerateSuggestionIds,
  type DiscoveryFilters,
  type DiscoveryViewer,
} from './search-discovery.server'
import {
  groupKey,
  prepareQuery,
  tierOrder,
  type IndexHit,
  type IndexPage,
  type IndexSearchResult,
  SearchCapacityError,
  type IndexSearchInput,
} from './search-index/query'
import { searchHistoryParams, searchApiParams } from '~/lib/search-query'
import {
  parseSearchInput,
  canonicalSearch,
  type SearchInput,
} from './search-input'
import { suggestProjects } from './project-membership.server'
export type SearchIndex = {
  search(input: IndexSearchInput): Promise<IndexSearchResult>
  groupMembers(
    input: IndexSearchInput,
    keys: string[],
  ): Promise<IndexSearchResult>
  details(
    input: IndexSearchInput,
    ids: string[],
  ): Promise<
    Array<{
      id: string
      path: string
      excerpt: string
      hasBody?: boolean
      matchedKeywords?: string[]
    }>
  >
}
async function indexPage(
  index: SearchIndex,
  input: IndexSearchInput,
): Promise<IndexPage> {
  const result = await index.search(input)
  if (
    'error' in result ||
    (input.visibility && result.visibilityProtocol !== 1)
  )
    throw new SearchCapacityError()
  return result
}
export type SearchIndexes = (workspaceId: string) => SearchIndex
export const cappedTotal = (
  value: number,
  incomplete = false,
): { value: number; relation: 'eq' | 'gte' } => ({
  value: Math.min(value, 1000),
  relation: value > 1000 || incomplete ? 'gte' : 'eq',
})
type Hit = IndexHit & { workspaceId: string }
export type Metadata = {
  id: string
  title: string
  ownerId: string
  ownerName: string
  project: { id: string; name: string } | null
  visibility: import('~/lib/shareable-types').Visibility
  updatedAt: string
  lastViewedAt: string | null
  artifactKind: import('~/lib/shareable-types').ArtifactKind
  hasBody?: boolean
}
export function mergeSearchHits(hits: Hit[], newest: boolean) {
  const positions = new Map<string, number>()
  const rounds = new Map<string, number>()
  for (const row of [...hits].sort(
    (a, b) => a.rank - b.rank || a.id.localeCompare(b.id),
  )) {
    const stream = `${row.workspaceId}:${row.tier}`
    const position = positions.get(stream) ?? 0
    rounds.set(row.id, position)
    positions.set(stream, position + 1)
  }
  return hits.sort(
    (a, b) =>
      (newest
        ? b.activityAt.localeCompare(a.activityAt)
        : tierOrder[a.tier] - tierOrder[b.tier] ||
          rounds.get(a.id)! - rounds.get(b.id)!) ||
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.id.localeCompare(b.id),
  )
}
export function groupSearchHits<T extends { id: string; title: string }>(
  rows: T[],
) {
  const groups = new Map<string, T & { groupSize: number }>()
  for (const row of rows) {
    const key = groupKey(row.title),
      previous = groups.get(key)
    if (previous) previous.groupSize++
    else groups.set(key, { ...row, groupSize: 1 })
  }
  return [...groups.values()]
}
async function metadata(
  db: Db,
  ids: string[],
  actor: string,
): Promise<Metadata[]> {
  if (!ids.length) return []
  const rows = await db
    .selectFrom('shareables as s')
    .innerJoin('users as u', 'u.id', 's.owner_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .leftJoin('shareable_viewer_recency as r', (join) =>
      join
        .onRef('r.shareable_id', '=', 's.id')
        .on('r.viewer_user_id', '=', actor),
    )
    .select([
      's.id',
      's.visibility',
      's.artifact_kind as artifactKind',
      's.activity_at as updatedAt',
      'r.last_viewed_at as lastViewedAt',
      'c.kind as containerKind',
      'c.id as containerId',
      'c.name as containerName',
      sql<string>`coalesce(nullif(s.title_override,''),nullif(s.derived_title,''),s.name)`.as(
        'title',
      ),
      's.owner_user_id as ownerId',
      sql<string>`coalesce(u.name,'')`.as('ownerName'),
    ])
    .where(
      sql<boolean>`s.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
    )
    .execute()
  return rows.map(
    ({ containerKind, containerId, containerName, artifactKind, ...row }) => ({
      ...row,
      artifactKind,
      hasBody: artifactKind !== 'video' && artifactKind !== 'pdf',
      project:
        containerKind === 'project' && containerId
          ? { id: containerId, name: containerName ?? '' }
          : null,
    }),
  )
}
/** The searching user, with the live viewer row read once per operation. */
type SearchActor = { id: string; viewer?: DiscoveryViewer }
async function loadSearchActor(db: Db, id: string): Promise<SearchActor> {
  return { id, viewer: await loadDiscoveryViewer(db, id) }
}
const asViewer = (actor: SearchActor) => ({
  viewerUserId: actor.id,
  viewer: actor.viewer,
})
function indexInput(input: SearchInput, any: boolean): IndexSearchInput {
  let containerIds: string[] | undefined
  if (input.filters.containerId) containerIds = [input.filters.containerId]
  else if (input.filters.location?.kind === 'project')
    containerIds = [input.filters.location.id]
  return {
    query: input.query,
    sort: input.sort,
    ownerUserIds: input.filters.ownerUserId
      ? [input.filters.ownerUserId]
      : input.filters.ownerUserIds
        ? [...input.filters.ownerUserIds]
        : undefined,
    containerIds,
    updated:
      input.filters.date?.field === 'updated'
        ? {
            from: input.filters.date.from?.toISOString(),
            to: input.filters.date.to?.toISOString(),
          }
        : undefined,
    any,
  }
}
async function accepted<T extends Hit>(
  db: Db,
  actor: SearchActor,
  filters: DiscoveryFilters,
  now: string,
  hits: T[],
) {
  if (!hits.length) return []
  const rows = await discoverCandidates(db, {
    ...filters,
    ...asViewer(actor),
    workspaceId: hits[0].workspaceId,
    candidateIds: hits.map((row) => row.id),
    now,
  })
  const ids = new Set(rows.map((row) => row.id))
  return hits.filter((row) => ids.has(row.id))
}
async function collect(
  db: Db,
  indexes: SearchIndexes,
  actor: SearchActor,
  input: SearchInput,
  now: string,
  any = false,
  includeActiveDocumentCount = false,
) {
  const sources = await searchVisibilitySources(
    db,
    actor.id,
    input.filters,
    now,
    actor.viewer,
  )
  const hits: Hit[] = []
  const metas = new Map<string, Metadata>()
  let incomplete = false
  let activeDocumentCount: number | null = null
  const method = 'candidates' as const
  // Metadata is read alongside the live discovery check and kept only for
  // the rows that check accepts.
  const check = async (rows: Hit[]) => {
    const [visible, rowsMetadata] = await Promise.all([
      accepted(db, actor, input.filters, now, rows),
      metadata(
        db,
        rows.map((hit) => hit.id),
        actor.id,
      ),
    ])
    return { visible, rowsMetadata }
  }
  const keep = ({
    visible,
    rowsMetadata,
  }: Awaited<ReturnType<typeof check>>) => {
    hits.push(...visible)
    const ids = new Set(visible.map((row) => row.id))
    for (const row of rowsMetadata) if (ids.has(row.id)) metas.set(row.id, row)
    return visible
  }
  const checked = await Promise.all(
    sources.map(async (source) => {
      const pages: Array<Awaited<ReturnType<typeof check>>> = []
      const request = indexInput(input, any)
      let cursor: number | undefined
      let exhausted = false
      const keys = new Set<string>()
      for (let fetch = 0; fetch < 5; fetch++) {
        const page = await indexPage(indexes(source.workspaceId), {
          ...request,
          visibility: source.visibility,
          workspaceId: source.workspaceId,
          cursor,
          includeActiveDocumentCount:
            includeActiveDocumentCount &&
            fetch === 0 &&
            actor.viewer?.member_status === 'active' &&
            source.workspaceId === actor.viewer.workspace_id,
        })
        if (
          actor.viewer?.member_status === 'active' &&
          source.workspaceId === actor.viewer.workspace_id
        )
          activeDocumentCount ??= page.activeDocumentCount ?? null
        const checkedPage = await check(
          page.items.map((row) => ({
            ...row,
            workspaceId: source.workspaceId,
          })),
        )
        pages.push(checkedPage)
        const ids = new Set(checkedPage.visible.map((row) => row.id))
        for (const row of checkedPage.rowsMetadata)
          if (ids.has(row.id)) keys.add(groupKey(row.title))
        exhausted = page.nextCursor === null && !page.incomplete
        if (exhausted || keys.size >= Math.max(1001, input.pageSize)) break
        if (page.nextCursor === null) break
        cursor = page.nextCursor ?? undefined
      }
      return { pages, exhausted }
    }),
  )
  for (const source of checked) {
    incomplete ||= !source.exhausted
    for (const page of source.pages) keep(page)
  }
  const merged = mergeSearchHits(
    [...new Map(hits.map((row) => [row.id, row])).values()],
    input.sort === 'newest' || !input.query.trim(),
  )
  const rows = merged.flatMap((hit) => {
    const meta = metas.get(hit.id)
    return meta ? [{ ...hit, ...meta }] : []
  })
  return {
    groups: groupSearchHits(rows),
    knownHits: rows,
    incomplete,
    method,
    activeDocumentCount,
    discoverableCount: rows.length,
    candidateSources: sources,
    workspaces: sources.map((source) => source.workspaceId),
  }
}

async function completePageGroups(
  db: Db,
  indexes: SearchIndexes,
  actor: SearchActor,
  input: SearchInput,
  now: string,
  any: boolean,
  workspaces: string[],
  keys: string[],
  candidateSources: Awaited<ReturnType<typeof searchVisibilitySources>>,
  knownHits: Array<Hit & Metadata>,
) {
  const members = new Map(keys.map((key) => [key, new Set<string>()]))
  const incomplete = new Set<string>()
  const workspaceById = new Map(
    knownHits.map((row) => [row.id, row.workspaceId]),
  )
  for (const row of knownHits) members.get(groupKey(row.title))?.add(row.id)
  const visibilityByWorkspace = new Map(
    candidateSources.map((source) => [source.workspaceId, source.visibility]),
  )
  for (const workspace of workspaces) {
    const request = indexInput(input, any)
    const visibility = visibilityByWorkspace.get(workspace)
    for (const key of keys)
      if (members.get(key)!.size >= 1000) incomplete.add(key)
    let pending = keys.filter((key) => members.get(key)!.size < 1000)
    let cursor = 0
    for (let fetch = 0; fetch < 5 && pending.length; fetch++) {
      const page = await indexes(workspace).groupMembers(
        { ...request, visibility, workspaceId: workspace, cursor },
        pending,
      )
      if ('error' in page || page.visibilityProtocol !== 1)
        throw new SearchCapacityError()
      if (page.incomplete) for (const key of pending) incomplete.add(key)
      for (let offset = 0; offset < page.items.length; offset += 2000) {
        const rows = page.items
          .slice(offset, offset + 2000)
          .map((row) => ({ ...row, workspaceId: workspace }))
        // Metadata is read alongside the live check; only accepted rows count.
        const [visible, rowsMetadata] = await Promise.all([
          accepted(db, actor, input.filters, now, rows),
          metadata(
            db,
            rows.map((row) => row.id),
            actor.id,
          ),
        ])
        const ids = new Set(visible.map((row) => row.id))
        for (const row of visible) workspaceById.set(row.id, workspace)
        for (const row of rowsMetadata)
          if (ids.has(row.id)) members.get(groupKey(row.title))?.add(row.id)
      }
      const remaining = new Set(page.incompleteGroupKeys ?? [])
      pending = pending.filter((key) => {
        if (members.get(key)!.size >= 1000) {
          incomplete.add(key)
          return false
        }
        return remaining.has(key)
      })
      cursor += 2000
    }
    for (const key of pending) incomplete.add(key)
  }
  return { members, incomplete, workspaceById }
}

/** One final ID-leading check after all index awaits, including details. */
async function finalVisibleIds(
  db: Db,
  actor: SearchActor,
  filters: DiscoveryFilters,
  now: string,
  workspaceById: Map<string, string>,
) {
  const workspaces = new Map<string, string[]>()
  for (const [id, workspace] of workspaceById) {
    const ids = workspaces.get(workspace) ?? []
    ids.push(id)
    workspaces.set(workspace, ids)
  }
  const visible = await Promise.all(
    [...workspaces].map(async ([workspaceId, ids]) => {
      const acceptedIds: string[] = []
      for (let offset = 0; offset < ids.length; offset += 2000) {
        // Bound response memory and outstanding D1 work to one candidate batch per workspace.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const rows = await discoverCandidates(db, {
          ...filters,
          ...asViewer(actor),
          now,
          workspaceId,
          candidateIds: ids.slice(offset, offset + 2000),
        })
        acceptedIds.push(...rows.map((row) => row.id))
      }
      return acceptedIds
    }),
  )
  return new Set(visible.flat())
}
function selectionWitnesses(
  db: Db,
  indexes: SearchIndexes,
  actor: SearchActor,
  input: SearchInput,
  now: string,
) {
  const selections = [
    ...(input.filters.ownerUserIds ?? []).map((id) => ({
      kind: 'owner' as const,
      id,
    })),
    ...(input.filters.location?.kind === 'project'
      ? [{ kind: 'project' as const, id: input.filters.location.id }]
      : []),
  ]
  return Promise.all(
    selections.map(async (selection) => {
      const filters: DiscoveryFilters = {
        includeArchived: true,
        credentialScope: input.filters.credentialScope,
        ...(selection.kind === 'owner'
          ? { ownerUserId: selection.id }
          : { containerId: selection.id }),
      }
      const witnessInput: SearchInput = {
        query: '',
        filters,
        sort: 'newest',
        pageSize: 1,
      }
      const sources = await searchVisibilitySources(
        db,
        actor.id,
        filters,
        now,
        actor.viewer,
      )
      for (const source of sources) {
        let cursor: number | undefined
        for (let fetch = 0; fetch < 5; fetch++) {
          const page = await indexPage(indexes(source.workspaceId), {
            ...indexInput(witnessInput, false),
            visibility: source.visibility,
            workspaceId: source.workspaceId,
            cursor,
          })
          const candidates = await accepted(
            db,
            actor,
            filters,
            now,
            page.items.map((row) => ({
              ...row,
              workspaceId: source.workspaceId,
            })),
          )
          for (const candidate of candidates) {
            const rows = await metadata(db, [candidate.id], actor.id)
            const live = await finalVisibleIds(
              db,
              actor,
              filters,
              now,
              new Map([[candidate.id, source.workspaceId]]),
            )
            if (rows[0] && live.has(candidate.id))
              return {
                selection,
                filters,
                rows: [{ ...candidate, ...rows[0] }],
              }
          }
          if (page.nextCursor === null) break
          cursor = page.nextCursor
        }
      }
      return { selection, filters, rows: [] }
    }),
  )
}

const invalidCursor = {
  error: { code: 'invalid_cursor', hint: 'Restart the search.' },
}
export async function search(
  db: Db,
  indexes: SearchIndexes,
  actor: string,
  input: SearchInput,
  source: 'screen' | 'mcp' | 'cli' = 'screen',
  clock = () => new Date(),
) {
  const started = performance.now(),
    now = clock().toISOString(),
    canonical = canonicalSearch(input)
  let tokenKey = newSearchTokenKey()
  let anchor = new Date(now)
  let position = 0,
    searchLogId: string | undefined
  const [searchActor, cursor] = await Promise.all([
    loadSearchActor(db, actor),
    input.cursor
      ? readSearchToken(db, actor, input.cursor, 'cursor', now)
      : undefined,
    // Authentication and deterministic parsing are complete at the boundary.
    // A continuation must first authenticate its token below.
    input.cursor ? undefined : admitSearch(db, actor, now),
  ])
  if (input.cursor) {
    if (
      !cursor ||
      cursor.log.filters_json !== canonical ||
      cursor.log.source !== source
    )
      return invalidCursor
    anchor = new Date(cursor.log.created_at)
    position = cursor.payload.rank
    searchLogId = cursor.log.id
    tokenKey = cursor.log.token_key
  }
  if (input.cursor) await admitSearch(db, actor, now)
  indexes = meterSearchIndexes(db, indexes, now)
  if (input.relativeDays && input.filters.date) {
    input = {
      ...input,
      filters: {
        ...input.filters,
        date: {
          field: input.filters.date.field,
          from: new Date(anchor.getTime() - input.relativeDays * 86400000),
          to: anchor,
        },
      },
    }
  }
  let result = await collect(db, indexes, searchActor, input, now, false, true)
  let any = false
  const relaxedWitnesses: Array<{
    filter: string
    filters: DiscoveryFilters
    found: Awaited<ReturnType<typeof collect>>
  }> = []
  const relaxations: Array<{
    filter: string
    total: ReturnType<typeof cappedTotal>
  }> = []
  if (!result.incomplete && !result.groups.length) {
    if (prepareQuery(input.query).terms.length >= 2) {
      any = true
      result = await collect(db, indexes, searchActor, input, now, true)
    }
    const filters = input.filters
    const dimensions = [
      filters.ownerUserIds?.length ? 'owners' : '',
      filters.location ? 'location' : '',
      !filters.includeArchived ? 'archive' : '',
      filters.date ? 'date' : '',
    ].filter((dimension) => Boolean(dimension) && !input.cursor)
    // Each relaxed search is independent of the others.
    const relaxedResults = await Promise.all(
      dimensions.map((dimension) => {
        const relaxed = { ...filters }
        if (dimension === 'owners') delete relaxed.ownerUserIds
        if (dimension === 'location') delete relaxed.location
        if (dimension === 'archive') relaxed.includeArchived = true
        if (dimension === 'date') delete relaxed.date
        return collect(
          db,
          indexes,
          searchActor,
          { ...input, filters: relaxed },
          now,
          false,
        )
      }),
    )
    dimensions.forEach((dimension, index) => {
      const found = relaxedResults[index]
      const relaxed = { ...input.filters }
      if (dimension === 'owners') delete relaxed.ownerUserIds
      if (dimension === 'location') delete relaxed.location
      if (dimension === 'archive') relaxed.includeArchived = true
      if (dimension === 'date') delete relaxed.date
      relaxedWitnesses.push({ filter: dimension, filters: relaxed, found })
    })
  }
  let total = cappedTotal(result.groups.length, result.incomplete)
  let tier = any ? 'any' : (result.groups[0]?.tier ?? 'all')
  let selected = result.groups.slice(
    position,
    Math.min(1000, position + input.pageSize),
  )
  // Group sizes and the page's details do not depend on each other.
  const complete = () =>
    selected.length
      ? completePageGroups(
          db,
          indexes,
          searchActor,
          input,
          now,
          any,
          result.workspaces,
          selected.map((row) => groupKey(row.title)),
          result.candidateSources,
          result.knownHits,
        )
      : Promise.resolve({
          members: new Map<string, Set<string>>(),
          incomplete: new Set<string>(),
          workspaceById: new Map<string, string>(),
        })
  const items: Array<
    Metadata & {
      path: string
      excerpt: string
      hasBody?: boolean
      matchedKeywords?: string[]
      tier: IndexHit['tier']
      rank: number
      groupSize: number
      groupSizeRelation: 'eq' | 'gte'
      receipt: string
    }
  > = []
  const displayedRanks = new Map(
    selected.map((row, index) => [row.id, position + index + 1]),
  )
  const materialize = () =>
    Promise.all(
      [...new Set(selected.map((row) => row.workspaceId))].map(
        async (workspace) => {
          const visible = selected.filter(
            (row) => row.workspaceId === workspace,
          )
          const ids = visible.map((row) => row.id)
          const [details, current] = await Promise.all([
            indexes(workspace).details(indexInput(input, any), ids),
            metadata(db, ids, actor),
          ])
          return {
            workspace,
            visible,
            details: new Map(details.map((row) => [row.id, row])),
            current: new Map(current.map((row) => [row.id, row])),
          }
        },
      ),
    )
  let [completion, pages, witnesses] = await Promise.all([
    complete(),
    materialize(),
    input.cursor
      ? []
      : selectionWitnesses(db, indexes, searchActor, input, now),
  ])
  const finalDomain = new Map(
    result.knownHits.map((row) => [row.id, row.workspaceId]),
  )
  for (const [id, workspace] of completion.workspaceById)
    finalDomain.set(id, workspace)
  const reauthorize = () =>
    Promise.all([
      finalVisibleIds(db, searchActor, input.filters, now, finalDomain),
      Promise.all(
        witnesses.map(async (witness) => {
          const ids = await finalVisibleIds(
            db,
            searchActor,
            witness.filters,
            now,
            new Map(witness.rows.map((r) => [r.id, r.workspaceId])),
          )
          return { ...witness, row: witness.rows.find((r) => ids.has(r.id)) }
        }),
      ),
      ...relaxedWitnesses.map(async (witness) => {
        const ids = await finalVisibleIds(
          db,
          searchActor,
          witness.filters,
          now,
          new Map(witness.found.knownHits.map((r) => [r.id, r.workspaceId])),
        )
        witness.found.knownHits = witness.found.knownHits.filter((r) =>
          ids.has(r.id),
        )
        witness.found.groups = groupSearchHits(witness.found.knownHits)
      }),
    ])
  let [finalIds, selectedRows] = await reauthorize()
  // Retry only this page. Each promotion needs details and group completion,
  // followed by another live check after those awaits. Unchanged pages do no extra work.
  let finalSelected = selected
  const discarded = new Set<string>()
  for (let attempt = 0; ; attempt++) {
    const missing = pages.flatMap(
      ({ workspace, visible, details, current }) => {
        const ids = visible
          .filter(
            (row) =>
              finalIds.has(row.id) &&
              (!details.has(row.id) || !current.has(row.id)),
          )
          .map((row) => row.id)
        return ids.length ? [{ workspace, ids }] : []
      },
    )
    if (missing.length) {
      // A transient details omission must not shift the next cursor. Remove
      // an ID only after the current index also stops returning it as a match.
      await Promise.all(
        missing.map(async ({ workspace, ids }) => {
          const page = await indexPage(indexes(workspace), {
            ...indexInput(input, any),
            allowedIds: ids,
          })
          const matching = new Set(page.items.map((row) => row.id))
          for (const id of ids) if (!matching.has(id)) discarded.add(id)
        }),
      )
      ;[finalIds, selectedRows] = await reauthorize()
    }
    for (const id of discarded) finalIds.delete(id)
    result.knownHits = result.knownHits.filter((row) => finalIds.has(row.id))
    result.groups = groupSearchHits(result.knownHits)
    finalSelected = result.groups.slice(
      position,
      Math.min(1000, position + input.pageSize),
    )
    const ready = new Set(
      pages.flatMap(({ details, current }) =>
        [...details.keys()].filter((id) => current.has(id)),
      ),
    )
    if (
      finalSelected.every(
        (row) =>
          ready.has(row.id) && completion.members.has(groupKey(row.title)),
      )
    )
      break
    // A moving page or missing details must never consume an unseen cursor slot.
    if (attempt >= 2) throw new SearchCapacityError()
    selected = finalSelected
    ;[completion, pages] = await Promise.all([complete(), materialize()])
    for (const [id, workspace] of completion.workspaceById)
      finalDomain.set(id, workspace)
    ;[finalIds, selectedRows] = await reauthorize()
  }
  tier = any ? 'any' : (result.groups[0]?.tier ?? 'all')
  displayedRanks.clear()
  finalSelected.forEach((row, index) =>
    displayedRanks.set(row.id, position + index + 1),
  )
  result.discoverableCount = result.knownHits.length
  total = cappedTotal(result.groups.length, result.incomplete)
  for (const witness of relaxedWitnesses)
    if (witness.found.groups.length)
      relaxations.push({
        filter: witness.filter,
        total: cappedTotal(
          witness.found.groups.length,
          witness.found.incomplete,
        ),
      })
  const selectedScope = input.cursor
    ? undefined
    : {
        owners: selectedRows.flatMap(({ selection, row }) =>
          selection.kind === 'owner' && row
            ? [{ id: selection.id, name: row.ownerName }]
            : [],
        ),
        projects: selectedRows.flatMap(({ selection, row }) =>
          selection.kind === 'project' && row?.project ? [row.project] : [],
        ),
      }
  const sizes = new Map(
    [...completion.members].map(([key, ids]) => [
      key,
      cappedTotal(
        [...ids].filter((id) => finalIds.has(id)).length,
        completion.incomplete.has(key),
      ),
    ]),
  )
  for (const { visible, details, current } of pages) {
    for (const row of visible) {
      if (!finalIds.has(row.id) || !displayedRanks.has(row.id)) continue
      const detail = details.get(row.id),
        meta = current.get(row.id)
      if (detail && meta) {
        const size = sizes.get(groupKey(meta.title)) ?? cappedTotal(1)
        items.push({
          ...meta,
          ...detail,
          hasBody: meta.hasBody !== false && detail.hasBody !== false,
          tier: row.tier,
          rank: displayedRanks.get(row.id)!,
          groupSize: Math.max(1, size.value),
          groupSizeRelation: size.relation,
          receipt: '',
        })
      }
    }
  }
  items.sort((a, b) => a.rank - b.rank)
  // Candidate work is live-accepted files, not an enumerated inventory.
  // active_document_count remains diagnostic and never supplies UI counts.
  let logged: Promise<unknown> = Promise.resolve()
  if (!searchLogId) {
    searchLogId = crypto.randomUUID()
    logged = db
      .insertInto('search_logs')
      .values({
        id: searchLogId,
        token_key: tokenKey,
        actor_id: actor,
        created_at: now,
        query: input.query,
        filters_json: canonical,
        result_count: total.value,
        count_relation: total.relation,
        tier,
        duration_ms: performance.now() - started,
        discoverable_count: result.discoverableCount,
        search_method: result.method,
        active_document_count: result.activeDocumentCount,
        source,
      })
      .execute()
  }
  for (const item of items)
    item.receipt = sealSearchToken(searchLogId, tokenKey, {
      kind: 'open',
      file: item.id,
      rank: item.rank,
    })
  let nextCursor: string | null = null
  if (position + finalSelected.length < Math.min(1000, result.groups.length)) {
    nextCursor = sealSearchToken(searchLogId, tokenKey, {
      kind: 'cursor',
      rank: position + finalSelected.length,
    })
  }

  const facets = input.cursor
    ? undefined
    : searchFacets(result.knownHits, actor, total.relation === 'eq')
  await logged

  return {
    items,
    total,
    tier,
    relaxations,
    nextCursor,
    searchLogId,
    facets,
    ...(selectedScope ? { selectedScope } : {}),
  }
}
export async function searchSuggestions(
  db: Db,
  indexes: SearchIndexes,
  user: Pick<SessionUser, 'id'>,
  input: SearchInput,
  now = new Date().toISOString(),
) {
  if (input.query.trim()) {
    await admitSearch(db, user.id, now)
    indexes = meterSearchIndexes(db, indexes, now)
  }
  // Project names do not depend on the viewer row, so read them alongside it.
  const [viewer, projects] = await Promise.all([
    loadDiscoveryViewer(db, user.id),
    input.query.trim()
      ? suggestProjects(db, user.id, input.query, input.filters.includeArchived)
      : [],
  ])
  const discoveryInput = {
    ...input.filters,
    viewerUserId: user.id,
    viewer,
    now,
  }
  // An empty query shows only recently opened files, so skip the index and
  // name lookups whose results the palette would discard.
  if (!input.query.trim())
    return {
      files: [],
      owners: [],
      projects: [],
      recent: (await recentSuggestions(db, user.id, discoveryInput)).map(
        ownedBy(user.id),
      ),
    }
  const byId = new Map<string, Metadata>()
  const [hits, owners] = await Promise.all([
    enumerateSuggestionIds(db, discoveryInput).then(async (sources) =>
      (
        await Promise.all(
          sources.map(async ({ workspaceId, ids }) => {
            const request = indexInput(input, false)
            const page = await indexPage(indexes(workspaceId), {
              ...request,
              allowedIds: ids,
              limit: 6,
              maxResults: 7,
            })
            const candidateIds = page.items.map((row) => row.id)
            // Metadata is read alongside the live check and used only for the
            // rows that check allows.
            const [discovered, rowsMetadata] = await Promise.all([
              discoverSuggestionCandidates(db, {
                ...discoveryInput,
                workspaceId,
                candidateIds,
              }),
              metadata(db, candidateIds, user.id),
            ])
            const allowed = new Set(discovered.map((row) => row.id))
            for (const row of rowsMetadata)
              if (allowed.has(row.id)) byId.set(row.id, row)
            return page.items
              .filter((row) => allowed.has(row.id))
              .map((row) => ({ ...row, workspaceId }))
          }),
        )
      ).flat(),
    ),
    suggestionOwners(db, discoveryInput, input.query),
  ])
  const selected = mergeSearchHits(hits, input.sort === 'newest').slice(0, 6)
  const details = new Map(
    (
      await Promise.all(
        [...new Set(selected.map((hit) => hit.workspaceId))].map(
          (workspaceId) =>
            indexes(workspaceId).details(
              indexInput(input, false),
              selected
                .filter((hit) => hit.workspaceId === workspaceId)
                .map((hit) => hit.id),
            ),
        ),
      )
    )
      .flat()
      .map((detail) => [detail.id, detail]),
  )
  const files = selected.flatMap((hit) => {
    const item = byId.get(hit.id)
    const detail = details.get(hit.id)
    return item && detail
      ? [
          {
            ...item,
            ...detail,
            hasBody: item.hasBody !== false && detail.hasBody !== false,
          },
        ]
      : []
  })
  return { files: files.map(ownedBy(user.id)), owners, projects, recent: [] }
}

// The palette has no session; mark the viewer's own files so it can say
// "Me" like the results page.
const ownedBy =
  (viewerId: string) =>
  <T extends { ownerId: string }>(row: T) => ({
    ...row,
    ownedByViewer: row.ownerId === viewerId,
  })

/** The six most recently opened files the viewer can still discover. */
async function recentSuggestions(
  db: Db,
  viewerId: string,
  discoveryInput: Omit<
    Parameters<typeof discoverCandidates>[1],
    'workspaceId' | 'candidateIds'
  >,
) {
  const recent: Metadata[] = []
  // Bound history reads while filling the six currently discoverable slots.
  for (let offset = 0; offset < 500 && recent.length < 6; offset += 50) {
    const candidates = await db
      .selectFrom('shareable_viewer_recency as r')
      .innerJoin('shareables as s', 's.id', 'r.shareable_id')
      .select(['s.id', 's.workspace_id as workspaceId', 'r.last_viewed_at'])
      .where('r.viewer_user_id', '=', viewerId)
      .orderBy('r.last_viewed_at', 'desc')
      .orderBy('s.id')
      .limit(50)
      .offset(offset)
      .execute()
    const allowed = new Set<string>()
    for (const workspaceId of new Set(
      candidates.map((row) => row.workspaceId),
    )) {
      for (const row of await discoverCandidates(db, {
        ...discoveryInput,
        workspaceId,
        candidateIds: candidates
          .filter((candidate) => candidate.workspaceId === workspaceId)
          .map((candidate) => candidate.id),
      }))
        allowed.add(row.id)
    }
    const visible = candidates.filter((row) => allowed.has(row.id))
    const metas = new Map(
      (
        await metadata(
          db,
          visible.map((row) => row.id),
          viewerId,
        )
      ).map((row) => [row.id, row]),
    )
    for (const row of visible) {
      const meta = metas.get(row.id)
      if (meta) recent.push(meta)
      if (recent.length === 6) break
    }
    if (candidates.length < 50) break
  }
  return recent
}

function searchFacets(rows: Metadata[], actor: string, exact: boolean) {
  const owners = new Map<string, { id: string; name: string; count: number }>()
  const projects = new Map<
    string,
    { id: string; name: string; count: number }
  >()
  for (const row of rows) {
    const owner = owners.get(row.ownerId) ?? {
      id: row.ownerId,
      name: row.ownerName,
      count: 0,
    }
    owner.count++
    owners.set(owner.id, owner)
    const project = projects.get(row.project?.id ?? 'home') ?? {
      id: row.project?.id ?? 'home',
      name: row.project?.name ?? '',
      count: 0,
    }
    project.count++
    projects.set(project.id, project)
  }
  const order = (
    a: { id: string; count: number },
    b: { id: string; count: number },
  ) => b.count - a.count || a.id.localeCompare(b.id)
  const present = ({
    count,
    ...row
  }: {
    id: string
    name: string
    count: number
  }) => ({
    ...row,
    ...(exact ? { count } : {}),
  })
  return {
    owners: [...owners.values()]
      .sort(
        (a, b) =>
          Number(b.id === actor) - Number(a.id === actor) || order(a, b),
      )
      .slice(0, 20)
      .map(present),
    projects: [...projects.values()].sort(order).slice(0, 20).map(present),
  }
}

export async function searchGroup(
  db: Db,
  indexes: SearchIndexes,
  actor: string,
  receipt: string,
  cursor?: string,
  now = new Date().toISOString(),
) {
  const [searchActor, handle] = await Promise.all([
    loadSearchActor(db, actor),
    readSearchToken(db, actor, receipt, 'open', now),
  ])
  if (!handle?.payload.file) return invalidCursor
  const continuation = cursor
    ? await readSearchToken(db, actor, cursor, 'group-cursor', now)
    : null
  if (
    cursor &&
    (!continuation ||
      continuation.log.id !== handle.log.id ||
      continuation.payload.file !== handle.payload.file)
  )
    return invalidCursor
  const input = parseSearchInput(
    searchApiParams(searchHistoryParams(handle.log.filters_json)),
    new Date(handle.log.created_at),
  )
  if ('error' in input) return input
  const representative = await db
    .selectFrom('shareables')
    .select(['id', 'workspace_id'])
    .where('id', '=', handle.payload.file)
    .executeTakeFirst()
  if (!representative) return invalidCursor
  const visible = await discoverCandidates(db, {
    ...input.filters,
    ...asViewer(searchActor),
    now,
    workspaceId: representative.workspace_id,
    candidateIds: [representative.id],
  })
  if (!visible.length) return invalidCursor
  const [meta] = await metadata(db, [representative.id], actor)
  const key = groupKey(meta.title)
  const digest = createHash('sha256').update(key).digest('base64url')
  if (continuation && continuation.payload.group !== digest)
    return invalidCursor
  await admitSearch(db, actor, now)
  indexes = meterSearchIndexes(db, indexes, now)
  const [sources, collected] = await Promise.all([
    searchVisibilitySources(db, actor, input.filters, now, searchActor.viewer),
    collect(db, indexes, searchActor, input, now, handle.log.tier === 'any'),
  ])
  const members = new Map<string, Metadata>(
    collected.knownHits
      .filter((row) => groupKey(row.title) === key)
      .map((row) => [row.id, row]),
  )
  let incomplete = false
  const workspaceById = new Map(
    collected.knownHits.map((row) => [row.id, row.workspaceId]),
  )
  workspaceById.set(representative.id, representative.workspace_id)
  for (const source of sources) {
    const request = indexInput(input, handle.log.tier === 'any')
    for (let offset = 0; offset < 10000; offset += 2000) {
      const page = await indexes(source.workspaceId).groupMembers(
        {
          ...request,
          visibility: source.visibility,
          workspaceId: source.workspaceId,
          cursor: offset,
        },
        [key],
      )
      if ('error' in page || page.visibilityProtocol !== 1)
        throw new SearchCapacityError()
      incomplete ||= Boolean(page.incomplete)
      const acceptedRows = await accepted(
        db,
        searchActor,
        input.filters,
        now,
        page.items.map((row) => ({ ...row, workspaceId: source.workspaceId })),
      )
      for (const row of acceptedRows)
        workspaceById.set(row.id, source.workspaceId)
      for (const row of await metadata(
        db,
        acceptedRows.map((candidate) => candidate.id),
        actor,
      ))
        if (groupKey(row.title) === key) members.set(row.id, row)
      if (!page.incompleteGroupKeys?.includes(key)) break
      if (offset === 8000) incomplete = true
    }
  }
  const finalIds = await finalVisibleIds(
    db,
    searchActor,
    input.filters,
    now,
    workspaceById,
  )
  if (!finalIds.has(representative.id)) return invalidCursor
  const rows = [...members.values()]
    .filter((row) => row.id !== representative.id && finalIds.has(row.id))
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
  const position = continuation?.payload.rank ?? 0
  const items = rows.slice(position, position + 20).map((row) => ({
    ...row,
    receipt: sealSearchToken(handle.log.id, handle.log.token_key, {
      kind: 'open',
      file: row.id,
      rank: handle.payload.rank,
    }),
  }))
  return {
    items,
    total: cappedTotal(rows.length + 1, incomplete),
    searchLogId: handle.log.id,
    nextCursor:
      position + items.length < rows.length
        ? sealSearchToken(handle.log.id, handle.log.token_key, {
            kind: 'group-cursor',
            group: digest,
            file: representative.id,
            rank: position + items.length,
          })
        : null,
  }
}

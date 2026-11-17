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
  enumerateDiscoverableIds,
  enumerateMemberDiscoverableIds,
  loadDiscoveryViewer,
  suggestionOwners,
  resolveSearchSelections,
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
  if ('error' in result) throw new SearchCapacityError()
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
/** The searching user's live identity and own-workspace membership. */
type SearchActor = {
  id: string
  viewer?: DiscoveryViewer
  memberStatus?: string | null
}
/** One read per search operation; discovery checks reuse it. */
async function loadSearchActor(db: Db, id: string): Promise<SearchActor> {
  const row = await db
    .selectFrom('users as u')
    .leftJoin('workspace_members as m', (join) =>
      join
        .onRef('m.workspace_id', '=', 'u.workspace_id')
        .onRef('m.user_id', '=', 'u.id'),
    )
    .select([
      'u.id',
      'u.workspace_id',
      'u.email',
      'u.email_verified',
      'm.status as member_status',
    ])
    .where('u.id', '=', id)
    .executeTakeFirst()
  if (!row) return { id }
  const { member_status: memberStatus, ...viewer } = row
  return { id, viewer, memberStatus }
}
const asViewer = (actor: SearchActor) => ({
  viewerUserId: actor.id,
  viewer: actor.viewer,
})
async function universe(
  db: Db,
  actor: SearchActor,
  filters: DiscoveryFilters,
  now: string,
) {
  const [sparse, member] = await Promise.all([
    enumerateDiscoverableIds(db, { ...filters, ...asViewer(actor), now }),
    enumerateMemberDiscoverableIds(db, {
      ...filters,
      ...asViewer(actor),
      now,
    }),
  ])
  const groups = new Map<string, Set<string>>()
  for (const { workspaceId, ids } of sparse)
    groups.set(workspaceId, new Set(ids))
  for (const row of member) {
    const ids = groups.get(row.workspaceId) ?? new Set<string>()
    ids.add(row.id)
    groups.set(row.workspaceId, ids)
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workspaceId, ids]) => ({ workspaceId, ids: [...ids] }))
}
async function indexInput(
  db: Db,
  input: SearchInput,
  workspaceId: string,
  any: boolean,
): Promise<IndexSearchInput> {
  let containerIds: string[] | undefined
  if (input.filters.location?.kind === 'project')
    containerIds = [input.filters.location.id]
  else if (input.filters.location?.kind === 'home')
    containerIds = (
      await db
        .selectFrom('artifact_containers')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', 'inbox')
        .execute()
    ).map((row) => row.id)
  return {
    query: input.query,
    sort: input.sort,
    ownerUserIds: input.filters.ownerUserIds
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
  const ownWorkspace =
    !any && actor.memberStatus === 'active'
      ? actor.viewer?.workspace_id
      : undefined
  const sources = ownWorkspace
    ? await enumerateDiscoverableIds(db, {
        ...input.filters,
        ...asViewer(actor),
        now,
        excludeWorkspaceId: ownWorkspace,
      })
    : await universe(db, actor, input.filters, now)
  const hits: Hit[] = []
  const metas = new Map<string, Metadata>()
  let incomplete = false,
    passedCount = 0,
    activeDocumentCount: number | null = null
  let method: 'candidates' | 'allowed' = ownWorkspace ? 'candidates' : 'allowed'
  let discoverableCount = sources.reduce(
    (sum, source) => sum + source.ids.length,
    0,
  )
  // Metadata is read alongside the live discovery check and kept only for
  // the rows that check accepts.
  const remember = async (rows: Hit[]) => {
    const [visible, rowsMetadata] = await Promise.all([
      accepted(db, actor, input.filters, now, rows),
      metadata(
        db,
        rows.map((hit) => hit.id),
        actor.id,
      ),
    ])
    hits.push(...visible)
    const ids = new Set(visible.map((row) => row.id))
    for (const row of rowsMetadata) if (ids.has(row.id)) metas.set(row.id, row)
    return visible
  }
  if (ownWorkspace) {
    const stub = indexes(ownWorkspace)
    const request = await indexInput(db, input, ownWorkspace, any)
    const keys = new Set<string>()
    const rememberPage = async (page: IndexPage) => {
      activeDocumentCount ??= page.activeDocumentCount ?? null
      const visible = await remember(
        page.items.map((row) => ({ ...row, workspaceId: ownWorkspace })),
      )
      passedCount += visible.length
      for (const row of visible) {
        const meta = metas.get(row.id)
        if (meta) keys.add(groupKey(meta.title))
      }
      return visible.length
    }
    let cursor: number | undefined
    let exhausted = false
    for (
      let fetch = 0;
      fetch < 5 && !exhausted && keys.size < Math.max(1001, input.pageSize);
      fetch++
    ) {
      const page = await indexPage(stub, {
        ...request,
        cursor,
        includeActiveDocumentCount: includeActiveDocumentCount && fetch === 0,
      })
      const passed = await rememberPage(page)
      if (
        fetch === 0 &&
        page.items.length &&
        passed / page.items.length < 0.2
      ) {
        const ids = (
          await enumerateMemberDiscoverableIds(db, {
            ...input.filters,
            ...asViewer(actor),
            now,
          })
        ).map((row) => row.id)
        sources.push({ workspaceId: ownWorkspace, ids })
        discoverableCount += ids.length
        // Allowed mode reranks the full live set; candidate ranks are no longer used.
        hits.length = 0
        metas.clear()
        method = 'allowed'
        exhausted = true
        break
      }
      exhausted = page.nextCursor === null
      cursor = page.nextCursor ?? undefined
    }
    incomplete = !exhausted
  }

  for (const source of sources) {
    const request = await indexInput(db, input, source.workspaceId, any)
    let cursor: number | undefined
    do {
      const page = await indexPage(indexes(source.workspaceId), {
        ...request,
        allowedIds: source.ids,
        cursor,
      })
      await remember(
        page.items.map((row) => ({
          ...row,
          workspaceId: source.workspaceId,
        })),
      )
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
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
    discoverableCount:
      method === 'candidates'
        ? passedCount + discoverableCount
        : discoverableCount,
    allowedSources: sources,
    workspaces: [
      ...new Set([
        ...(ownWorkspace ? [ownWorkspace] : []),
        ...sources.map((source) => source.workspaceId),
      ]),
    ],
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
  allowedSources: Array<{ workspaceId: string; ids: string[] }>,
  knownHits: Array<Hit & Metadata>,
) {
  const members = new Map(keys.map((key) => [key, new Set<string>()]))
  const incomplete = new Set<string>()
  for (const row of knownHits) members.get(groupKey(row.title))?.add(row.id)
  for (const workspace of workspaces) {
    const request = await indexInput(db, input, workspace, any)
    // Allowed streams were drained completely and checked with discovery already.
    if (allowedSources.some((source) => source.workspaceId === workspace))
      continue
    for (const key of keys)
      if (members.get(key)!.size >= 1000) incomplete.add(key)
    let pending = keys.filter((key) => members.get(key)!.size < 1000)
    let cursor = 0
    for (let fetch = 0; fetch < 5 && pending.length; fetch++) {
      const page = await indexes(workspace).groupMembers(
        { ...request, cursor },
        pending,
      )
      if ('error' in page) throw new SearchCapacityError()
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
  return new Map(
    [...members].map(([key, ids]) => [
      key,
      cappedTotal(ids.size, incomplete.has(key)),
    ]),
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
      if (found.groups.length)
        relaxations.push({
          filter: dimension,
          total: cappedTotal(found.groups.length, found.incomplete),
        })
    })
  }
  const total = cappedTotal(result.groups.length, result.incomplete)
  const tier = any ? 'any' : (result.groups[0]?.tier ?? 'all')
  const selected = result.groups.slice(
    position,
    Math.min(1000, position + input.pageSize),
  )
  // Group sizes and the page's details do not depend on each other.
  const sizesPending = selected.length
    ? completePageGroups(
        db,
        indexes,
        searchActor,
        input,
        now,
        any,
        result.workspaces,
        selected.map((row) => groupKey(row.title)),
        result.allowedSources,
        result.knownHits,
      )
    : Promise.resolve(new Map<string, ReturnType<typeof cappedTotal>>())
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
  const pagesPending = Promise.all(
    [...new Set(selected.map((row) => row.workspaceId))].map(
      async (workspace) => {
        const visible = await accepted(
          db,
          searchActor,
          input.filters,
          now,
          selected.filter((row) => row.workspaceId === workspace),
        )
        const ids = visible.map((row) => row.id)
        const [details, current] = await Promise.all([
          indexInput(db, input, workspace, any).then((request) =>
            indexes(workspace).details(request, ids),
          ),
          metadata(db, ids, actor),
        ])
        return {
          visible,
          details: new Map(details.map((row) => [row.id, row])),
          current: new Map(current.map((row) => [row.id, row])),
        }
      },
    ),
  )
  const [sizes, pages] = await Promise.all([sizesPending, pagesPending])
  for (const { visible, details, current } of pages) {
    for (const row of visible) {
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
  // The log row and the selected names are independent reads and writes.
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
  if (position + selected.length < Math.min(1000, result.groups.length)) {
    nextCursor = sealSearchToken(searchLogId, tokenKey, {
      kind: 'cursor',
      rank: position + selected.length,
    })
  }

  const facets = input.cursor
    ? undefined
    : searchFacets(result.knownHits, actor, total.relation === 'eq')
  const [, selectedScope] = await Promise.all([
    logged,
    input.cursor
      ? undefined
      : resolveSearchSelections(
          db,
          actor,
          [...(input.filters.ownerUserIds ?? [])],
          input.filters.location?.kind === 'project'
            ? [input.filters.location.id]
            : [],
          input.filters.credentialScope,
          searchActor.viewer,
        ),
  ])
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
  const viewer = await loadDiscoveryViewer(db, user.id)
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
  const [hits, projects, owners] = await Promise.all([
    enumerateSuggestionIds(db, discoveryInput).then(async (sources) =>
      (
        await Promise.all(
          sources.map(async ({ workspaceId, ids }) => {
            const request = await indexInput(db, input, workspaceId, false)
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
    suggestProjects(db, user.id, input.query, input.filters.includeArchived),
    suggestionOwners(db, discoveryInput, input.query),
  ])
  const selected = mergeSearchHits(hits, input.sort === 'newest').slice(0, 6)
  const details = new Map(
    (
      await Promise.all(
        [...new Set(selected.map((hit) => hit.workspaceId))].map(
          async (workspaceId) =>
            indexes(workspaceId).details(
              await indexInput(db, input, workspaceId, false),
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
  }) => ({ ...row, ...(exact ? { count } : {}) })
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
  const [sources, collected] = await Promise.all([
    universe(db, searchActor, input.filters, now),
    collect(db, indexes, searchActor, input, now, handle.log.tier === 'any'),
  ])
  const members = new Map<string, Metadata>(
    collected.knownHits
      .filter((row) => groupKey(row.title) === key)
      .map((row) => [row.id, row]),
  )
  let incomplete = false
  for (const source of sources) {
    const request = await indexInput(
      db,
      input,
      source.workspaceId,
      handle.log.tier === 'any',
    )
    for (let offset = 0; offset < 10000; offset += 2000) {
      const page = await indexes(source.workspaceId).groupMembers(
        { ...request, allowedIds: source.ids, cursor: offset },
        [key],
      )
      if ('error' in page) throw new SearchCapacityError()
      const acceptedRows = await accepted(
        db,
        searchActor,
        input.filters,
        now,
        page.items.map((row) => ({ ...row, workspaceId: source.workspaceId })),
      )
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
  const rows = [...members.values()]
    .filter((row) => row.id !== representative.id)
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

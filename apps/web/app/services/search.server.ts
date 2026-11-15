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
  discoverSuggestionCandidates,
  type DiscoveryFilters,
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
import { canonicalSearch, type SearchInput } from './search-input'
import { suggestProjects } from './project-membership.server'
export type SearchIndex = {
  search(input: IndexSearchInput): Promise<IndexSearchResult>
  details(
    input: IndexSearchInput,
    ids: string[],
  ): Promise<Array<{ id: string; path: string; excerpt: string }>>
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
): { value: number; relation: 'eq' | 'gte' } => ({
  value: Math.min(value, 1000),
  relation: value > 1000 ? 'gte' : 'eq',
})
type Hit = IndexHit & { workspaceId: string }
type Metadata = {
  id: string
  title: string
  ownerId: string
  ownerName: string
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
async function metadata(db: Db, ids: string[]): Promise<Metadata[]> {
  if (!ids.length) return []
  return await db
    .selectFrom('shareables as s')
    .innerJoin('users as u', 'u.id', 's.owner_user_id')
    .select([
      's.id',
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
}
async function universe(
  db: Db,
  actor: string,
  filters: DiscoveryFilters,
  now: string,
) {
  const [sparse, member] = await Promise.all([
    enumerateDiscoverableIds(db, { ...filters, viewerUserId: actor, now }),
    enumerateMemberDiscoverableIds(db, {
      ...filters,
      viewerUserId: actor,
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
  actor: string,
  filters: DiscoveryFilters,
  now: string,
  hits: T[],
) {
  if (!hits.length) return []
  const rows = await discoverCandidates(db, {
    ...filters,
    viewerUserId: actor,
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
  actor: string,
  input: SearchInput,
  now: string,
  any = false,
  candidateMode = true,
) {
  const [sources, viewer] = await Promise.all([
    universe(db, actor, input.filters, now),
    loadDiscoveryViewer(db, actor),
  ])
  const member = viewer
    ? await db
        .selectFrom('workspace_members')
        .select('status')
        .where('workspace_id', '=', viewer.workspace_id)
        .where('user_id', '=', actor)
        .executeTakeFirst()
    : undefined
  const hits: Hit[] = []
  for (const source of sources) {
    const stub = indexes(source.workspaceId)
    const request = await indexInput(db, input, source.workspaceId, any)
    let exhausted = false
    const candidateHits: Hit[] = []
    const candidateGroups = new Set<string>()
    if (
      candidateMode &&
      !any &&
      member?.status === 'active' &&
      source.workspaceId === viewer?.workspace_id
    ) {
      let cursor: number | undefined
      for (let fetch = 0; fetch < 5; fetch++) {
        const page = await indexPage(stub, { ...request, cursor })
        const visible = await accepted(
          db,
          actor,
          input.filters,
          now,
          page.items.map((row) => ({
            ...row,
            workspaceId: source.workspaceId,
          })),
        )
        candidateHits.push(...visible)
        if (
          fetch === 0 &&
          page.items.length &&
          visible.length / page.items.length < 0.2
        )
          break
        if (page.nextCursor === null) {
          exhausted = true
          break
        }
        // This is only a ranking witness; full group completion below is independent.
        for (const row of await metadata(
          db,
          visible.map((hit) => hit.id),
        ))
          candidateGroups.add(groupKey(row.title))
        if (candidateGroups.size >= 1001) break
        cursor = page.nextCursor
      }
    }
    if (exhausted) hits.push(...candidateHits)
    else {
      // One complete allowed set yields comparable local ranks. The DO binds it
      // to SQLite in bounded JSON chunks and recomputes ranking on each page.
      let cursor: number | undefined
      do {
        const page = await indexPage(stub, {
          ...request,
          allowedIds: source.ids,
          cursor,
        })
        hits.push(
          ...(await accepted(
            db,
            actor,
            input.filters,
            now,
            page.items.map((row) => ({
              ...row,
              workspaceId: source.workspaceId,
            })),
          )),
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
    }
  }
  const merged = mergeSearchHits(
    [...new Map(hits.map((row) => [row.id, row])).values()],
    input.sort === 'newest' || !input.query.trim(),
  )
  const ordered = merged
  const rows: Array<Hit & Metadata> = []
  for (let offset = 0; offset < ordered.length; offset += 2000) {
    const batch = ordered.slice(offset, offset + 2000)
    const meta = new Map(
      (
        await metadata(
          db,
          batch.map((row) => row.id),
        )
      ).map((row) => [row.id, row]),
    )
    for (const hit of batch) {
      const row = meta.get(hit.id)
      if (row) rows.push({ ...hit, ...row })
    }
  }
  return {
    groups: groupSearchHits(rows),
    discoverableCount: sources.reduce((sum, row) => sum + row.ids.length, 0),
  }
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
  if (input.cursor) {
    const cursor = await readSearchToken(db, actor, input.cursor, 'cursor', now)
    if (!cursor || cursor.log.filters_json !== canonical) return invalidCursor
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
  let result = await collect(db, indexes, actor, input, now)
  let any = false
  const relaxations: Array<{
    filter: string
    total: ReturnType<typeof cappedTotal>
  }> = []
  if (!result.groups.length && prepareQuery(input.query).terms.length >= 2) {
    any = true
    result = await collect(db, indexes, actor, input, now, true)
    const filters = input.filters
    const dimensions = [
      filters.ownerUserIds?.length ? 'owners' : '',
      filters.location ? 'location' : '',
      !filters.includeArchived ? 'archive' : '',
      filters.date ? 'date' : '',
    ].filter(Boolean)
    for (const dimension of dimensions) {
      const relaxed = { ...filters }
      if (dimension === 'owners') delete relaxed.ownerUserIds
      if (dimension === 'location') delete relaxed.location
      if (dimension === 'archive') relaxed.includeArchived = true
      if (dimension === 'date') delete relaxed.date
      const found = await collect(
        db,
        indexes,
        actor,
        { ...input, filters: relaxed },
        now,
        false,
        false,
      )
      if (found.groups.length)
        relaxations.push({
          filter: dimension,
          total: cappedTotal(found.groups.length),
        })
    }
  }
  const total = cappedTotal(result.groups.length)
  const tier = any ? 'any' : (result.groups[0]?.tier ?? 'all')
  const selected = result.groups.slice(position, position + input.pageSize)
  const items: Array<
    Metadata & {
      path: string
      excerpt: string
      tier: IndexHit['tier']
      rank: number
      groupSize: number
      receipt: string
    }
  > = []
  const displayedRanks = new Map(
    selected.map((row, index) => [row.id, position + index + 1]),
  )
  for (const workspace of new Set(selected.map((row) => row.workspaceId))) {
    const visible = await accepted(
      db,
      actor,
      input.filters,
      now,
      selected.filter((row) => row.workspaceId === workspace),
    )
    const details = new Map(
      (
        await indexes(workspace).details(
          await indexInput(db, input, workspace, any),
          visible.map((row) => row.id),
        )
      ).map((row) => [row.id, row]),
    )
    const current = new Map(
      (
        await metadata(
          db,
          visible.map((row) => row.id),
        )
      ).map((row) => [row.id, row]),
    )
    for (const row of visible) {
      const detail = details.get(row.id),
        meta = current.get(row.id)
      if (detail && meta)
        items.push({
          ...meta,
          ...detail,
          tier: row.tier,
          rank: displayedRanks.get(row.id)!,
          groupSize: row.groupSize,
          receipt: '',
        })
    }
  }
  items.sort((a, b) => a.rank - b.rank)
  if (!searchLogId) {
    searchLogId = crypto.randomUUID()
    await db
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
  const nextCursor =
    position + input.pageSize < result.groups.length
      ? sealSearchToken(searchLogId, tokenKey, {
          kind: 'cursor',
          rank: position + input.pageSize,
        })
      : null
  return { items, total, tier, relaxations, nextCursor, searchLogId }
}
export async function searchSuggestions(
  db: Db,
  indexes: SearchIndexes,
  user: SessionUser,
  input: SearchInput,
  now = new Date().toISOString(),
) {
  const [domain, owners, projects] = await Promise.all([
    enumerateDiscoverableIds(db, {
      ...input.filters,
      viewerUserId: user.id,
      now,
    }),
    suggestionOwners(
      db,
      { ...input.filters, viewerUserId: user.id, now },
      input.query,
    ),
    suggestProjects(db, user.id, input.query, input.filters.includeArchived),
  ])
  const hits: Hit[] = []
  // Restrict the owned/viewed/shared domain before the SQL ranking limit.
  for (const { workspaceId, ids } of domain) {
    const request = await indexInput(db, input, workspaceId, false)
    const page = await indexPage(indexes(workspaceId), {
      ...request,
      allowedIds: ids,
      limit: 6,
      maxResults: 6,
    })
    const allowed = new Set(
      (
        await discoverSuggestionCandidates(db, {
          ...input.filters,
          viewerUserId: user.id,
          workspaceId,
          candidateIds: page.items.map((row) => row.id),
          now,
        })
      ).map((row) => row.id),
    )
    hits.push(
      ...page.items
        .filter((row) => allowed.has(row.id))
        .map((row) => ({ ...row, workspaceId })),
    )
  }
  const selected = mergeSearchHits(
    hits,
    input.sort === 'newest' || !input.query.trim(),
  ).slice(0, 6)
  const byId = new Map(
    (
      await metadata(
        db,
        selected.map((row) => row.id),
      )
    ).map((row) => [row.id, row]),
  )
  const files = selected.flatMap((row) => {
    const item = byId.get(row.id)
    return item ? [item] : []
  })
  return {
    files,
    owners,
    projects,
  }
}

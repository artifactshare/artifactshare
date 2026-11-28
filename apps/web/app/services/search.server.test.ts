import * as discovery from './search-discovery.server'
import * as query from './search-index/query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  search,
  searchSuggestions,
  groupSearchHits,
  cappedTotal,
  type SearchIndex,
} from './search.server'
import {
  readSearchLogs,
  recordSearchOpen,
  pruneSearchLogs,
} from './search-logs.server'
import type { SearchInput } from './search-input'

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-09-15T00:00:00.000Z'
const input: SearchInput = {
  query: 'alpha',
  filters: {},
  sort: 'relevance',
  pageSize: 1,
}
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES('ws','Workspace','${now}');
    INSERT INTO users(id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES ('viewer','viewer@example.com',1,'Viewer','ws','${now}','${now}'),('owner','owner@example.com',1,'Secret Owner','ws','${now}','${now}');
    INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','viewer','admin','active','${now}','${now}');
    INSERT INTO artifact_containers(id,workspace_id,kind,name,owner_user_id,created_by_id,created_at,updated_at) VALUES('home','ws','inbox','Home','viewer','viewer','${now}','${now}');
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at) VALUES
    ('a','ws','viewer','Alpha 1','html_page','private','home','${now}','${now}','${now}'),
    ('b','ws','viewer','Beta','html_page','private','home','${now}','${now}','${now}'),
    ('c','ws','viewer','Alpha 2','html_page','private','home','${now}','${now}','${now}'),
    ('denied','ws','owner','Denied Title','html_page','private','home','${now}','${now}','${now}');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})
const ids = ['a', 'denied', 'b', 'c']
function index(): SearchIndex {
  return {
    search: vi.fn<SearchIndex['search']>(async (request) => ({
      items: ids
        .filter((id) => !request.allowedIds || request.allowedIds.includes(id))
        .map((id) => ({
          id,
          tier: 'all',
          rank: ids.indexOf(id) + 1,
          activityAt: now,
        })),
      visibilityProtocol: 1,
      nextCursor: null,
      activeDocumentCount: 4,
    })),
    groupMembers: vi.fn<SearchIndex['groupMembers']>(async (request, keys) => {
      const rows = (
        await fixture.db
          .selectFrom('shareables')
          .select(['id', 'name'])
          .execute()
      )
        .filter((row) => keys.includes(query.groupKey(row.name)))
        .map((row, i) => ({
          title: row.name,
          id: row.id,
          tier: 'all' as const,
          rank: i + 1,
          activityAt: now,
        }))
      const groups = new Map(
        keys.map((key) => [
          key,
          rows.filter((row) => {
            return query.groupKey(row.title) === key
          }),
        ]),
      )
      return {
        items: [...groups.values()].flatMap((group) =>
          group.slice(request.cursor ?? 0, (request.cursor ?? 0) + 2000),
        ),
        visibilityProtocol: 1,
        nextCursor: null,
        incompleteGroupKeys: [...groups]
          .filter(([, group]) => group.length > (request.cursor ?? 0) + 2000)
          .map(([key]) => key),
      }
    }),
    details: vi.fn<SearchIndex['details']>(async (_input, selected) =>
      selected.map((id) => ({
        id,
        path: 'index.html',
        excerpt: id === 'denied' ? 'Secret Snippet' : 'Healthy excerpt',
      })),
    ),
  }
}
test('authorized groups, metadata and snippets exclude denied rows; cursors and receipts remain actor-bound', async () => {
  fixture.sqlite.exec(
    `UPDATE workspace_members SET role='member' WHERE user_id='viewer'; INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','owner','admin','active','${now}','${now}')`,
  )
  const stub = index()
  const first = await search(fixture.db, () => stub, 'viewer', input)
  expect(first).not.toHaveProperty('error')
  if ('error' in first) throw new Error('unexpected search failure')
  expect(first.total).toEqual({ value: 2, relation: 'eq' })
  expect(first.items[0]).toMatchObject({
    id: 'a',
    title: 'Alpha 1',
    groupSize: 2,
    excerpt: 'Healthy excerpt',
    rank: 1,
  })
  expect(JSON.stringify(first)).not.toMatch(
    /Denied Title|Secret Owner|Secret Snippet/,
  )
  expect(stub.details).toHaveBeenCalledWith(expect.anything(), ['a'])
  expect(
    await recordSearchOpen(
      fixture.db,
      'owner',
      first.searchLogId,
      first.items[0].receipt,
    ),
  ).toBe(false)
  expect(
    await recordSearchOpen(
      fixture.db,
      'viewer',
      first.searchLogId,
      first.items[0].receipt,
    ),
  ).toBe(true)
  expect(await readSearchLogs(fixture.db, 'owner')).toEqual([])
  expect(await readSearchLogs(fixture.db, 'viewer')).toMatchObject([
    {
      search_method: 'candidates',
      active_document_count: 4,
      discoverable_count: 3,
    },
  ])
  const next = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    cursor: first.nextCursor!,
  })
  expect(next).toMatchObject({ items: [{ id: 'b', rank: 2 }] })
  expect(await readSearchLogs(fixture.db, 'viewer')).toHaveLength(1)
  expect(
    await search(fixture.db, () => stub, 'owner', {
      ...input,
      cursor: first.nextCursor!,
    }),
  ).toHaveProperty('error.code', 'invalid_cursor')
  expect(
    await search(fixture.db, () => stub, 'viewer', {
      ...input,
      query: 'changed',
      cursor: first.nextCursor!,
    }),
  ).toHaveProperty('error.code', 'invalid_cursor')
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='owner' WHERE id='b'",
  )
  const revoked = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    cursor: first.nextCursor!,
  })
  expect(revoked).toMatchObject({ items: [] })
})
test.each(['old title', ''])(
  'group completion includes collected IDs when indexed keys lag (%s)',
  async (staleKey) => {
    const stub = index()
    vi.mocked(stub.groupMembers).mockImplementation(async (_request, keys) => ({
      items: keys.includes(staleKey)
        ? ['a', 'c'].map((id, i) => ({
            id,
            rank: i + 1,
            tier: 'all' as const,
            activityAt: now,
          }))
        : [],
      visibilityProtocol: 1,
      nextCursor: null,
    }))
    const result = await search(fixture.db, () => stub, 'viewer', input)
    expect(result).toMatchObject({
      items: [{ id: 'a', groupSize: 2 }],
      total: { value: 2, relation: 'eq' },
    })
    if ('error' in result) throw new Error('search failed')
    const { searchGroup } = await import('./search.server')
    expect(
      await searchGroup(
        fixture.db,
        () => stub,
        'viewer',
        result.items[0].receipt,
      ),
    ).toMatchObject({
      items: [{ id: 'c', title: 'Alpha 2' }],
      total: { value: 2, relation: 'eq' },
    })
    // The current-key control must not double-count the collected representatives.
    vi.mocked(stub.groupMembers).mockResolvedValue({
      items: ['a', 'c'].map((id, i) => ({
        id,
        rank: i + 1,
        tier: 'all',
        activityAt: now,
      })),
      visibilityProtocol: 1,
      nextCursor: null,
    })
    expect(await search(fixture.db, () => stub, 'viewer', input)).toMatchObject(
      { items: [{ id: 'a', groupSize: 2 }] },
    )
  },
)

test('numeric-only titles form an ordinary group and totals cap after grouping', () => {
  const rows = [
    { id: 'a', title: '1' },
    { id: 'b', title: '2' },
  ]
  expect(groupSearchHits(rows)).toEqual([{ id: 'a', title: '1', groupSize: 2 }])
  expect(cappedTotal(groupSearchHits(rows).length)).toEqual({
    value: 1,
    relation: 'eq',
  })
  expect(
    groupSearchHits([
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ]),
  ).toHaveLength(2)
  for (const size of [0, 1, 1000, 1001])
    expect(cappedTotal(size)).toEqual({
      value: Math.min(size, 1000),
      relation: size > 1000 ? 'gte' : 'eq',
    })
})
test('retention keeps the exact cutoff and cascades opens', async () => {
  const first = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in first) throw new Error('unexpected search failure')
  await recordSearchOpen(
    fixture.db,
    'viewer',
    first.searchLogId,
    first.items[0].receipt,
  )
  fixture.sqlite.exec(`UPDATE search_logs SET created_at='${now}'`)
  expect(await pruneSearchLogs(fixture.db, now)).toBe(0)
  expect(await pruneSearchLogs(fixture.db, '2026-09-15T00:00:00.001Z')).toBe(1)
  expect(
    await fixture.db.selectFrom('search_opens').selectAll().execute(),
  ).toEqual([])
})

test.each([399, 400])(
  'first-batch acceptance of %i/2000 stays bounded without enumeration',
  async (count) => {
    fixture.sqlite
      .prepare(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1999)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'threshold-'||x,'ws',CASE WHEN x < ? THEN 'viewer' ELSE 'owner' END,'Alpha '||x,'html_page','private','home',?,?,? FROM n`)
      .run(count, now, now, now)
    const candidate = Array.from({ length: 2000 }, (_, i) => ({
      id: `threshold-${i}`,
      tier: 'all' as const,
      rank: i + 1,
      activityAt: now,
    }))
    const stub: SearchIndex = {
      groupMembers: async () => ({
        items: candidate,
        visibilityProtocol: 1,
        nextCursor: null,
      }),
      search: vi.fn<SearchIndex['search']>(async (request) => ({
        items: request.allowedIds
          ? candidate.filter((row) => request.allowedIds!.includes(row.id))
          : request.cursor
            ? []
            : candidate,
        visibilityProtocol: 1,
        nextCursor: request.allowedIds || request.cursor ? null : 2000,
      })),
      details: vi.fn<SearchIndex['details']>(async (_request, selected) =>
        selected.map((id) => ({ id, path: 'index.html', excerpt: 'alpha' })),
      ),
    }
    const result = await search(fixture.db, () => stub, 'viewer', input)
    expect(result).toMatchObject({
      total: { value: 1, relation: 'eq' },
      items: [{ groupSize: count }],
    })
    const requests = vi
      .mocked(stub.search)
      .mock.calls.map(([request]) => request)
    expect(requests.filter((request) => !request.allowedIds)).toHaveLength(2)
    expect(requests.some((request) => request.allowedIds)).toBe(false)
    expect(
      requests.every((request) => request.visibility?.protocol === 1),
    ).toBe(true)
  },
)

test('five-fetch windows replay deterministically alongside an external workspace', async () => {
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'tail-'||x,'ws','viewer',CASE WHEN x=9999 THEN 'Beta' WHEN x=10000 THEN 'Outside window' ELSE 'Alpha '||x END,'html_page','private','home','${now}','${now}','${now}' FROM n;
    INSERT INTO workspaces(id,name,created_at) VALUES('zz','External','${now}');
    INSERT INTO artifact_containers(id,workspace_id,kind,name,owner_user_id,created_by_id,created_at,updated_at) VALUES('external-home','zz','inbox','Home','viewer','viewer','${now}','${now}');
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    VALUES('external','zz','viewer','Charlie','html_page','private','external-home','${now}','${now}','${now}');`)
  const candidates = Array.from({ length: 10001 }, (_, i) => ({
    id: `tail-${i}`,
    tier: 'all' as const,
    rank: i + 1,
    activityAt: now,
  }))
  const own = index()
  vi.mocked(own.search).mockImplementation(async (request) => {
    const offset = request.cursor ?? 0
    return {
      items: candidates.slice(offset, offset + 2000),
      visibilityProtocol: 1,
      nextCursor: offset + 2000 < candidates.length ? offset + 2000 : null,
      ...(request.includeActiveDocumentCount
        ? { activeDocumentCount: 10001 }
        : {}),
    }
  })
  const external = index()
  vi.mocked(external.search).mockResolvedValue({
    items: [{ id: 'external', tier: 'all', rank: 1, activityAt: now }],
    visibilityProtocol: 1,
    nextCursor: null,
  })
  const indexes = (workspace: string) => (workspace === 'ws' ? own : external)
  const request = { ...input, pageSize: 2 }
  const first = await search(fixture.db, indexes, 'viewer', request)
  if ('error' in first || !first.nextCursor)
    throw new Error('missing continuation')
  expect(first.items.map((row) => row.id)).toEqual(['tail-0', 'external'])
  expect(first.items[0]).toMatchObject({
    groupSize: 1000,
    groupSizeRelation: 'gte',
  })
  expect(own.search).toHaveBeenCalledTimes(5)
  expect(
    vi
      .mocked(own.search)
      .mock.calls.map(([call]) => call.includeActiveDocumentCount),
  ).toEqual([true, false, false, false, false])
  expect(await readSearchLogs(fixture.db, 'viewer')).toMatchObject([
    { active_document_count: 10001, discoverable_count: 10001 },
  ])
  expect(
    fixture.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='search_candidate_pages'",
      )
      .all(),
  ).toEqual([])
  vi.mocked(own.search).mockClear()
  const next = await search(fixture.db, indexes, 'viewer', {
    ...request,
    cursor: first.nextCursor,
  })
  expect(next).toMatchObject({
    items: [
      { id: 'tail-9999', rank: 3, groupSize: 2, groupSizeRelation: 'eq' },
    ],
    nextCursor: null,
    total: { value: 3, relation: 'gte' },
  })
  expect(own.search).toHaveBeenCalledTimes(5)
  expect(
    vi.mocked(own.search).mock.calls.map(([call]) => call.cursor ?? 0),
  ).toEqual([0, 2000, 4000, 6000, 8000])
  expect(await readSearchLogs(fixture.db, 'viewer')).toHaveLength(1)
  // A continuation that advances beyond the original window loses the pending group.
  vi.mocked(own.search).mockResolvedValue({
    items: candidates.slice(10000),
    visibilityProtocol: 1,
    nextCursor: null,
  })
  const faulty = await search(fixture.db, indexes, 'viewer', {
    ...request,
    cursor: first.nextCursor,
  })
  expect(faulty).not.toHaveProperty('error')
  expect(() =>
    expect(faulty).toMatchObject({ items: [{ id: 'tail-9999', rank: 3 }] }),
  ).toThrowError()
})

test('single-keyword empty results offer only relaxations with authorized matches', async () => {
  const stub = index()
  const filtered = { ...input, filters: { ownerUserIds: ['owner'] } }
  const result = await search(fixture.db, () => stub, 'viewer', filtered)
  expect(result).toMatchObject({
    items: [],
    total: { value: 0, relation: 'eq' },
    relaxations: [{ filter: 'owners', total: { value: 2, relation: 'eq' } }],
  })
  expect(JSON.stringify(result)).not.toMatch(
    /Denied Title|Secret Snippet|Secret Owner/,
  )

  vi.mocked(stub.search).mockResolvedValue({
    items: [],
    visibilityProtocol: 1,
    nextCursor: null,
  })
  const missing = await search(fixture.db, () => stub, 'viewer', filtered)
  expect(missing).toMatchObject({ items: [], relaxations: [] })
})

test('hidden all-term matches cannot suppress visible any-term results and date relaxation', async () => {
  fixture.sqlite.exec(
    "UPDATE shareables SET activity_at='2026-09-01T00:00:00.000Z' WHERE id='b'; UPDATE shareables SET name='Gamma' WHERE id='c'",
  )
  const stub: SearchIndex = {
    groupMembers: index().groupMembers,
    search: vi.fn<SearchIndex['search']>(async (request) => ({
      items: (request.any ? ['a', 'c'] : ['denied', 'b'])
        .filter((id) => !request.allowedIds || request.allowedIds.includes(id))
        .map((id, i) => ({
          id,
          tier: request.any ? 'any' : 'all',
          rank: i + 1,
          activityAt: now,
        })),
      visibilityProtocol: 1,
      nextCursor: null,
    })),
    details: vi.fn<SearchIndex['details']>(async (_request, selected) =>
      selected.map((id) => ({
        id,
        path: 'index.html',
        excerpt: 'Healthy excerpt',
      })),
    ),
  }
  const result = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    query: 'alpha beta',
    filters: { date: { field: 'updated', from: new Date(now) } },
  })
  expect(result).toMatchObject({
    tier: 'any',
    total: { value: 2, relation: 'eq' },
    items: [{ id: 'a' }],
    relaxations: [{ filter: 'date', total: { value: 1, relation: 'eq' } }],
  })
  expect(
    vi
      .mocked(stub.search)
      .mock.calls.some(
        ([request]) =>
          !request.any &&
          request.updated === undefined &&
          request.allowedIds === undefined,
      ),
  ).toBe(true)
  expect(stub.details).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ any: true }),
    ['a'],
  )
  if ('error' in result || !result.nextCursor)
    throw new Error('Expected continuation')
  vi.mocked(stub.search).mockClear()
  const next = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    query: 'alpha beta',
    filters: { date: { field: 'updated', from: new Date(now) } },
    cursor: result.nextCursor,
  })
  expect(next).toMatchObject({
    tier: 'any',
    items: [{ id: 'c' }],
    relaxations: [],
  })
  expect(
    vi
      .mocked(stub.search)
      .mock.calls.every(([request]) => request.updated?.from === now),
  ).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(
    /Denied Title|Secret Owner|Secret Snippet/,
  )
  expect(stub.details).toHaveBeenCalledTimes(2)
  expect(stub.details).toHaveBeenLastCalledWith(
    expect.objectContaining({ any: true }),
    ['c'],
  )
})

test('relative date windows remain bound to the first page and expire safely', async () => {
  const { parseSearchInput } = await import('./search-input')
  const start = new Date('2026-09-16T00:00:00.000Z')
  const params = new URLSearchParams({
    q: 'alpha',
    dateField: 'updated',
    days: '7',
    pageSize: '1',
  })
  const firstInput = parseSearchInput(params, new Date(start.getTime() - 50))
  if ('error' in firstInput) throw new Error('invalid fixture')
  const stub = index()
  const first = await search(
    fixture.db,
    () => stub,
    'viewer',
    firstInput,
    'screen',
    () => start,
  )
  if ('error' in first) throw new Error('unexpected cursor error')
  expect(stub.search).toHaveBeenCalledWith(
    expect.objectContaining({
      updated: { from: '2026-09-09T00:00:00.000Z', to: start.toISOString() },
    }),
  )
  vi.mocked(stub.search).mockClear()
  vi.mocked(stub.groupMembers).mockClear()
  params.set('cursor', first.nextCursor!)
  const later = new Date(start.getTime() + 1000)
  const secondInput = parseSearchInput(params, later)
  if ('error' in secondInput) throw new Error('invalid fixture')
  expect(
    await search(
      fixture.db,
      () => stub,
      'viewer',
      secondInput,
      'screen',
      () => later,
    ),
  ).toMatchObject({ items: [{ id: 'b' }] })
  expect(stub.search).toHaveBeenCalledOnce()
  expect(stub.groupMembers).toHaveBeenCalledWith(
    expect.objectContaining({
      updated: { from: '2026-09-09T00:00:00.000Z', to: start.toISOString() },
    }),
    ['beta'],
  )
  expect(
    await search(
      fixture.db,
      () => stub,
      'viewer',
      secondInput,
      'screen',
      () => new Date(start.getTime() + 31 * 60000),
    ),
  ).toHaveProperty('error.code', 'invalid_cursor')
})

test('workspace interleaving alternates authorized local ranks within each tier', async () => {
  const { mergeSearchHits } = await import('./search.server')
  const rows = [
    {
      id: 'a1',
      workspaceId: 'a',
      tier: 'title' as const,
      rank: 1,
      activityAt: now,
    },
    {
      id: 'a2',
      workspaceId: 'a',
      tier: 'title' as const,
      rank: 100,
      activityAt: now,
    },
    {
      id: 'b1',
      workspaceId: 'b',
      tier: 'title' as const,
      rank: 30,
      activityAt: now,
    },
    {
      id: 'b2',
      workspaceId: 'b',
      tier: 'title' as const,
      rank: 31,
      activityAt: now,
    },
    {
      id: 'phrase',
      workspaceId: 'a',
      tier: 'phrase' as const,
      rank: 101,
      activityAt: now,
    },
  ]
  expect(mergeSearchHits(rows, false).map((row) => row.id)).toEqual([
    'a1',
    'b1',
    'a2',
    'b2',
    'phrase',
  ])
})

test('returned groups include duplicates after the count witness and beyond candidate 10000', async () => {
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<10003)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'witness-'||x,'ws',CASE WHEN x=10003 THEN 'owner' ELSE 'viewer' END,
      CASE WHEN x IN (0,3000,10001,10003) THEN 'Shared title' ELSE char(65+x%26)||char(65+(x/26)%26)||char(65+(x/676)%26) END,
      'html_page','private','home','${now}','${now}','${now}' FROM n`)
  const candidates = Array.from({ length: 10004 }, (_, i) => ({
    id: `witness-${i}`,
    tier: 'all' as const,
    rank: i + 1,
    activityAt: now,
  }))
  const stub: SearchIndex = {
    groupMembers: index().groupMembers,
    search: vi.fn<SearchIndex['search']>(async (request) => {
      const rows = request.allowedIds
        ? candidates.filter((row) => request.allowedIds!.includes(row.id))
        : candidates
      const offset = request.cursor ?? 0
      return {
        items: rows.slice(offset, offset + 2000),
        visibilityProtocol: 1,
        nextCursor: offset + 2000 < rows.length ? offset + 2000 : null,
      }
    }),
    details: vi.fn<SearchIndex['details']>(async (_request, selected) =>
      selected.map((id) => ({
        id,
        path: 'index.html',
        excerpt: 'Healthy excerpt',
      })),
    ),
  }
  const checked = vi.spyOn(discovery, 'discoverCandidates')
  const enumeration = vi.spyOn(discovery, 'enumerateMemberDiscoverableIds')
  const sparse = vi.spyOn(discovery, 'enumerateDiscoverableIds')
  const result = await search(fixture.db, () => stub, 'viewer', input)
  expect(enumeration).not.toHaveBeenCalled()
  expect(sparse).not.toHaveBeenCalled()
  sparse.mockRestore()
  expect(
    vi.mocked(stub.search).mock.calls.some(([request]) => request.allowedIds),
  ).toBe(false)
  expect(
    checked.mock.calls.flatMap(([, request]) => request.candidateIds),
  ).toEqual(
    expect.arrayContaining(['witness-3000', 'witness-10001', 'witness-10003']),
  )
  checked.mockRestore()
  enumeration.mockRestore()
  expect(result).toMatchObject({
    total: { value: 1000, relation: 'gte' },
    items: [{ id: 'witness-0', groupSize: 3 }],
  })
  expect(
    vi
      .mocked(stub.search)
      .mock.calls.filter(([request]) => !request.allowedIds),
  ).toHaveLength(1)
  expect(stub.details).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
    'witness-0',
  ])
  // A completion adapter that stops at the ranking witness loses both tail duplicates.
  vi.mocked(stub.groupMembers).mockResolvedValue({
    items: [candidates[0]],
    visibilityProtocol: 1,
    nextCursor: null,
  })
  const faulty = await search(fixture.db, () => stub, 'viewer', input)
  expect(faulty).not.toHaveProperty('error')
  expect(() =>
    expect(faulty).toMatchObject({
      items: [{ id: 'witness-0', groupSize: 3 }],
    }),
  ).toThrowError()
})

test('revocation while candidate retrieval is pending excludes the row before details and counts', async () => {
  let markReached!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    markReached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const stub = index()
  vi.mocked(stub.search).mockImplementation(async () => {
    markReached()
    await released
    return {
      items: [{ id: 'a', tier: 'all', rank: 1, activityAt: now }],
      visibilityProtocol: 1,
      nextCursor: null,
    }
  })
  const pending = search(fixture.db, () => stub, 'viewer', input)
  await reached
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='owner' WHERE id='a'",
  )
  release()
  const result = await pending
  expect(result).toMatchObject({
    total: { value: 0, relation: 'eq' },
    items: [],
  })
  expect(stub.details).not.toHaveBeenCalled()
})

test('authorization and empty-key grouping assertions reject their intended fault adapters', async () => {
  const request = { ...input, pageSize: 20 }
  const healthy = await search(fixture.db, () => index(), 'viewer', request)
  expect(JSON.stringify(healthy)).not.toMatch(
    /Denied Title|Secret Owner|Secret Snippet/,
  )
  const bypass = vi
    .spyOn(discovery, 'discoverCandidates')
    .mockImplementation(async (_db, selection) =>
      selection.candidateIds.map((id) => ({
        id,
        workspaceId: selection.workspaceId,
      })),
    )
  try {
    const faulty = await search(fixture.db, () => index(), 'viewer', request)
    expect(faulty).not.toHaveProperty('error')
    expect(() =>
      expect(JSON.stringify(faulty)).not.toMatch(
        /Denied Title|Secret Owner|Secret Snippet/,
      ),
    ).toThrowError()
  } finally {
    bypass.mockRestore()
  }
  const rows = [
    { id: 'a', title: '1' },
    { id: 'b', title: '2' },
  ]
  const expected = [{ id: 'a', title: '1', groupSize: 2 }]
  expect(groupSearchHits(rows)).toEqual(expected)
  const realKey = query.groupKey
  const exemptEmpty = vi
    .spyOn(query, 'groupKey')
    .mockImplementation((title) => realKey(title) || title)
  try {
    expect(() => expect(groupSearchHits(rows)).toEqual(expected)).toThrowError()
  } finally {
    exemptEmpty.mockRestore()
  }
})

test('cursor expiry is measured from the first search and all returned opens survive log-page reads', async () => {
  const first = await search(
    fixture.db,
    () => index(),
    'viewer',
    input,
    'screen',
    () => new Date(now),
  )
  if ('error' in first) throw new Error('unexpected search error')
  const whole = await search(
    fixture.db,
    () => index(),
    'viewer',
    { ...input, pageSize: 50 },
    'screen',
    () => new Date(now),
  )
  const next = await search(
    fixture.db,
    () => index(),
    'viewer',
    { ...input, cursor: first.nextCursor! },
    'screen',
    () => new Date(now),
  )
  if ('error' in next || 'error' in whole)
    throw new Error('unexpected continuation error')
  expect([...first.items, ...next.items].map((row) => row.id)).toEqual(
    whole.items.map((row) => row.id),
  )
  expect(
    await search(
      fixture.db,
      () => index(),
      'viewer',
      { ...input, cursor: first.nextCursor! },
      'screen',
      () => new Date(new Date(now).getTime() + 30 * 60000),
    ),
  ).toHaveProperty('error.code', 'invalid_cursor')
  for (let i = 0; i < 251; i++)
    await fixture.db
      .insertInto('search_opens')
      .values({
        id: `open-${i}`,
        search_id: first.searchLogId,
        shareable_id: 'a',
        rank: 1,
        opened_at: now,
      })
      .execute()
  expect(
    (await readSearchLogs(fixture.db, 'viewer')).find(
      (row) => row.id === first.searchLogId,
    )?.opens,
  ).toHaveLength(251)
  expect(
    JSON.stringify(await readSearchLogs(fixture.db, 'viewer')),
  ).not.toContain('token_key')
})

test('log reads bound latest opens and authorize distinct files in bounded batches', async () => {
  const result = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in result) throw new Error('unexpected search failure')
  fixture.sqlite.exec(`
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<500)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'opened-'||i,'ws',CASE WHEN i=500 THEN 'owner' ELSE 'viewer' END,'File','html_page','private','home','${now}','${now}','${now}' FROM n;
  `)
  const insert = fixture.sqlite.prepare(
    'INSERT INTO search_opens(id,search_id,shareable_id,rank,opened_at) VALUES(?,?,?,?,?)',
  )
  for (let i = 0; i <= 500; i++)
    insert.run(
      `open-${i}`,
      result.searchLogId,
      `opened-${i}`,
      i + 1,
      new Date(new Date(now).getTime() + i * 1000).toISOString(),
    )
  const other = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in other) throw new Error('unexpected search failure')
  insert.run('other-open', other.searchLogId, 'a', 1, now)
  const discover = vi.spyOn(discovery, 'discoverCandidates')
  try {
    const logs = await readSearchLogs(fixture.db, 'viewer')
    const primary = logs.find((log) => log.id === result.searchLogId)!
    expect(
      logs.find((log) => log.id === other.searchLogId)?.opens,
    ).toHaveLength(1)
    expect(primary.opens).toHaveLength(499)
    expect(primary.opens[0]).toMatchObject({
      shareableId: 'opened-499',
      rank: 500,
    })
    expect(primary.opens.at(-1)).toMatchObject({
      shareableId: 'opened-1',
      rank: 2,
    })
    expect(JSON.stringify(logs)).not.toContain('opened-500')
    expect(discover).toHaveBeenCalledTimes(6)
    for (const [, request] of discover.mock.calls)
      expect(request.candidateIds.length).toBeLessThanOrEqual(100)
  } finally {
    discover.mockRestore()
  }
})

test('log reads cap opens across the entire request while keeping each log bounded', async () => {
  const result = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in result) throw new Error('unexpected search failure')
  const log = await fixture.db
    .selectFrom('search_logs')
    .selectAll()
    .where('id', '=', result.searchLogId)
    .executeTakeFirstOrThrow()
  const insert = fixture.sqlite.prepare(
    'INSERT INTO search_opens(id,search_id,shareable_id,rank,opened_at) VALUES(?,?,?,?,?)',
  )
  for (let group = 0; group < 3; group++) {
    const id = `bounded-log-${group}`
    await fixture.db
      .insertInto('search_logs')
      .values({ ...log, id })
      .execute()
    for (let i = 0; i < 501; i++)
      insert.run(
        `${id}-${i}`,
        id,
        'a',
        i + 1,
        new Date(
          new Date(now).getTime() + (group * 1000 + i) * 1000,
        ).toISOString(),
      )
  }
  const logs = await readSearchLogs(fixture.db, 'viewer')
  expect(logs.reduce((sum, row) => sum + row.opens.length, 0)).toBe(1000)
  expect(logs.find((row) => row.id === 'bounded-log-2')?.opens).toHaveLength(
    500,
  )
  expect(logs.find((row) => row.id === 'bounded-log-1')?.opens).toHaveLength(
    500,
  )
  expect(logs.find((row) => row.id === 'bounded-log-0')?.opens).toEqual([])
})

test.each(['member', 'without membership'] as const)(
  'denied same-title rows cannot change group-size relation in %s mode',
  async (mode) => {
    const stub = index()
    fixture.sqlite.exec("UPDATE shareables SET name='Other' WHERE id='c'")
    if (mode === 'without membership')
      fixture.sqlite.exec(
        "DELETE FROM workspace_members WHERE user_id='viewer'",
      )
    const check = async () => {
      const result = await search(fixture.db, () => stub, 'viewer', input)
      expect(result).toMatchObject({
        items: [{ id: 'a', groupSize: 1, groupSizeRelation: 'eq' }],
      })
    }
    await check()
    fixture.sqlite
      .exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
     INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
     SELECT 'duplicate-'||x,'ws','owner','Alpha '||x,'html_page','private','home','${now}','${now}','${now}' FROM n`)
    await check()
    // Continue beyond two index batches without making denied rows a lower-bound witness.
    fixture.sqlite
      .exec(`WITH RECURSIVE n(x) AS (SELECT 1001 UNION ALL SELECT x+1 FROM n WHERE x<4001)
      INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      SELECT 'duplicate-'||x,'ws','owner','Alpha '||x,'html_page','private','home','${now}','${now}','${now}' FROM n`)
    await check()
    expect(stub.groupMembers).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 4000 }),
      ['alpha '],
    )
    {
      const bypass = vi
        .spyOn(discovery, 'discoverCandidates')
        .mockImplementation(async (_db, request) =>
          request.candidateIds.map((id) => ({
            id,
            workspaceId: request.workspaceId,
          })),
        )
      try {
        await expect(check()).rejects.toThrow('to match object')
      } finally {
        bypass.mockRestore()
      }
    }
  },
)

test('presentation and first-page facets count authorized files rather than title groups', async () => {
  const result = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in result) throw new Error('search failed')
  expect(result.items[0]).toMatchObject({
    project: null,
    visibility: 'private',
    updatedAt: now,
    lastViewedAt: null,
  })
  expect(result.facets).toEqual({
    owners: [{ id: 'viewer', name: 'Viewer', count: 3 }],
    projects: [{ id: 'home', name: '', count: 3 }],
  })
  expect(JSON.stringify(result)).not.toMatch(
    /Denied Title|Secret Owner|Secret Snippet/,
  )
  const next = await search(fixture.db, () => index(), 'viewer', {
    ...input,
    cursor: result.nextCursor!,
  })
  expect(next).not.toHaveProperty('facets.owners')
})

test('group expansion rechecks permission and binds cursors to actor and representative', async () => {
  const { searchGroup } = await import('./search.server')
  const result = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in result) throw new Error('search failed')
  const group = await searchGroup(
    fixture.db,
    () => index(),
    'viewer',
    result.items[0].receipt,
  )
  expect(group).toMatchObject({
    items: [{ id: 'c', title: 'Alpha 2' }],
    total: { value: 2, relation: 'eq' },
  })
  expect(
    await searchGroup(
      fixture.db,
      () => index(),
      'owner',
      result.items[0].receipt,
    ),
  ).toHaveProperty('error')
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='owner' WHERE id='c'",
  )
  const revoked = await searchGroup(
    fixture.db,
    () => index(),
    'viewer',
    result.items[0].receipt,
  )
  expect(revoked).toMatchObject({
    items: [],
    total: { value: 1, relation: 'eq' },
  })
  expect(JSON.stringify(revoked)).not.toContain('Alpha 2')
})

test('top-level cursors stop at 1000 while exact and lower-bound totals remain distinct', async () => {
  const { sealSearchToken } = await import('./search-logs.server')
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<1000)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'cap-'||x,'ws','viewer',char(65+x%26)||char(65+(x/26)%26)||char(65+(x/676)%26),'html_page','private','home','${now}','${now}','${now}' FROM n`)
  const stub = index()
  stub.search = async () => ({
    items: Array.from({ length: 1001 }, (_, i) => ({
      id: `cap-${i}`,
      tier: 'all',
      rank: i + 1,
      activityAt: now,
    })),
    visibilityProtocol: 1,
    nextCursor: null,
  })
  const first = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    pageSize: 50,
  })
  if ('error' in first) throw new Error('search failed')
  expect(first.total).toEqual({ value: 1000, relation: 'gte' })
  expect(first.facets?.owners[0]).not.toHaveProperty('count')
  const log = await fixture.db
    .selectFrom('search_logs')
    .selectAll()
    .where('id', '=', first.searchLogId)
    .executeTakeFirstOrThrow()
  const cursor = sealSearchToken(log.id, log.token_key, {
    kind: 'cursor',
    rank: 950,
  })
  const last = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    pageSize: 50,
    cursor,
  })
  expect(last).toMatchObject({ nextCursor: null })
  if ('error' in last) throw new Error('last page failed')
  expect(last.items).toHaveLength(50)
  expect(last.items.at(-1)?.rank).toBe(1000)
  fixture.sqlite.exec("DELETE FROM shareables WHERE id='cap-1000'")
  const exact = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    pageSize: 50,
  })
  expect(exact).toMatchObject({ total: { value: 1000, relation: 'eq' } })
})

test('same-title pages are ordered and their cursor rejects a renamed representative', async () => {
  const { searchGroup } = await import('./search.server')
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<25)
 INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
 SELECT 'member-'||x,'ws','viewer','Alpha '||x,'html_page','private','home','${now}','${now}','2026-08-01T00:00:00.000Z' FROM n`)
  const first = await search(fixture.db, () => index(), 'viewer', input)
  if ('error' in first) throw new Error('search failed')
  const group = await searchGroup(
    fixture.db,
    () => index(),
    'viewer',
    first.items[0].receipt,
  )
  if ('error' in group) throw new Error('group failed')
  expect(group.items).toHaveLength(20)
  expect(group.items[0].id).toBe('c')
  expect(group.total).toEqual({ value: 27, relation: 'eq' })
  const tail = await searchGroup(
    fixture.db,
    () => index(),
    'viewer',
    first.items[0].receipt,
    group.nextCursor!,
  )
  if ('error' in tail) throw new Error('group continuation failed')
  expect(tail.items).toHaveLength(6)
  expect(tail.nextCursor).toBeNull()
  expect(
    new Set([...group.items, ...tail.items].map((row) => row.id)).size,
  ).toBe(26)
  fixture.sqlite.exec(
    "UPDATE shareables SET name='Different title' WHERE id='a'",
  )
  expect(
    await searchGroup(
      fixture.db,
      () => index(),
      'viewer',
      first.items[0].receipt,
      group.nextCursor!,
    ),
  ).toHaveProperty('error.code', 'invalid_cursor')
})

test('video and PDF descriptions stay searchable without claiming indexed body content', async () => {
  const stub = index()
  stub.details = async (_input, selected) =>
    selected.map((id) => ({
      id,
      path: 'index.html',
      excerpt: 'description alpha',
      hasBody: true,
    }))
  const healthy = await search(fixture.db, () => stub, 'viewer', input)
  expect(healthy).toHaveProperty('items.0.hasBody', true)
  for (const kind of ['video', 'pdf'] as const) {
    await fixture.db
      .updateTable('shareables')
      .set({ artifact_kind: kind })
      .where('id', '=', 'a')
      .execute()
    const bodyless = await search(fixture.db, () => stub, 'viewer', input)
    expect(bodyless).toHaveProperty('items.0.hasBody', false)
    expect(bodyless).toHaveProperty('items.0.excerpt', 'description alpha')
  }
})

test('zero results and history resolve selected scope only from currently discoverable files', async () => {
  const stub = index()
  const originalSearch = stub.search
  stub.search = async (request) =>
    request.query
      ? { items: [], visibilityProtocol: 1, nextCursor: null }
      : originalSearch(request)
  const result = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    filters: { ownerUserIds: ['viewer', 'owner'] },
  })
  expect(result).toHaveProperty('selectedScope.owners', [
    { id: 'viewer', name: 'Viewer' },
  ])
  expect(JSON.stringify(result)).not.toContain('Secret Owner')
  const logs = await readSearchLogs(fixture.db, 'viewer')
  expect(logs[0].selectedScope.owners).toEqual([
    { id: 'viewer', name: 'Viewer' },
  ])
  fixture.sqlite.exec(
    "UPDATE workspace_members SET status='removed' WHERE user_id='viewer'",
  )
  const revoked = await readSearchLogs(fixture.db, 'viewer')
  expect(revoked[0].selectedScope.owners).toEqual([])
})

test('suggestions batch authorized detail IDs and fill recent history after discovery', async () => {
  const stub = index()
  const found = await searchSuggestions(
    fixture.db,
    () => stub,
    { id: 'viewer' },
    input,
    now,
  )
  expect(found.files.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  // The palette has no session, so the server marks the viewer's own files.
  for (const row of found.files)
    expect(row.ownedByViewer).toBe(row.ownerId === 'viewer')
  expect(stub.details).toHaveBeenCalledTimes(1)
  expect(stub.details).toHaveBeenCalledWith(expect.anything(), ['a', 'b', 'c'])
  expect(JSON.stringify(found)).not.toMatch(
    /Denied Title|Secret Snippet|Secret Owner/,
  )
  fixture.sqlite.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'recent-'||x,'ws','viewer','Recent '||x,'html_page','private','home','${now}','${now}','${now}' FROM n;
    INSERT INTO shareable_viewer_recency(shareable_id,viewer_user_id,first_viewed_at,last_viewed_at)
    SELECT id,'viewer','${now}','2026-09-0'||substr(id,8)||'T00:00:00.000Z' FROM shareables WHERE id LIKE 'recent-%';
  `)
  const recent = () =>
    searchSuggestions(
      fixture.db,
      () => stub,
      { id: 'viewer' },
      { ...input, query: '' },
      now,
    )
  expect((await recent()).recent.map((row) => row.id)).toEqual([
    'recent-8',
    'recent-7',
    'recent-6',
    'recent-5',
    'recent-4',
    'recent-3',
  ])
  // An empty palette needs only recent views, so it skips the search index
  // and the name lookups.
  const enumerate = vi.spyOn(discovery, 'enumerateSuggestionIds')
  const owners = vi.spyOn(discovery, 'suggestionOwners')
  try {
    const withoutIndex = await searchSuggestions(
      fixture.db,
      () => {
        throw new Error('index read for an empty query')
      },
      { id: 'viewer' },
      { ...input, query: '' },
      now,
    )
    expect(withoutIndex).toMatchObject({ files: [], owners: [], projects: [] })
    expect(withoutIndex.recent).toHaveLength(6)
    expect(enumerate).not.toHaveBeenCalled()
    expect(owners).not.toHaveBeenCalled()
  } finally {
    enumerate.mockRestore()
    owners.mockRestore()
  }
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='owner' WHERE id='recent-8'",
  )
  fixture.sqlite.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'denied-recent-'||x,'ws','owner','Denied recent '||x,'html_page','private','home','${now}','${now}','${now}' FROM n;
    INSERT INTO shareable_viewer_recency(shareable_id,viewer_user_id,first_viewed_at,last_viewed_at)
    SELECT id,'viewer','${now}','${now}' FROM shareables WHERE id LIKE 'denied-recent-%';
  `)
  const revoked = await recent()
  expect(revoked.recent.map((row) => row.id)).toEqual([
    'recent-7',
    'recent-6',
    'recent-5',
    'recent-4',
    'recent-3',
    'recent-2',
  ])
  expect(JSON.stringify(revoked.recent)).not.toMatch(/Recent 8|Denied recent/)
})

test('recent views fill the same batch in recency order when metadata disappears', async () => {
  fixture.sqlite.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'recent-'||x,'ws','viewer','Recent '||x,'html_page','private','home','${now}','${now}','${now}' FROM n;
    INSERT INTO shareable_viewer_recency(shareable_id,viewer_user_id,first_viewed_at,last_viewed_at)
    SELECT id,'viewer','${now}','2026-09-0'||substr(id,8)||'T00:00:00.000Z' FROM shareables WHERE id LIKE 'recent-%';
  `)
  const recent = () =>
    searchSuggestions(
      fixture.db,
      () => index(),
      { id: 'viewer' },
      { ...input, query: '' },
      now,
    )
  expect((await recent()).recent.map((row) => row.id)).toEqual([
    'recent-8',
    'recent-7',
    'recent-6',
    'recent-5',
    'recent-4',
    'recent-3',
  ])
  const discover = discovery.discoverCandidates
  const pendingRead = vi
    .spyOn(discovery, 'discoverCandidates')
    .mockImplementation(async (db, request) => {
      const rows = await discover(db, request)
      if (request.candidateIds.includes('recent-7')) {
        fixture.sqlite.exec("DELETE FROM shareables WHERE id='recent-7'")
      }
      return rows
    })
  try {
    expect((await recent()).recent.map((row) => row.id)).toEqual([
      'recent-8',
      'recent-6',
      'recent-5',
      'recent-4',
      'recent-3',
      'recent-2',
    ])
  } finally {
    pendingRead.mockRestore()
  }
})

test.each(['project', 'owners'] as const)(
  'recent views skip newer history outside selected %s and fill six in scope',
  async (scope) => {
    fixture.sqlite.exec(`
      INSERT INTO artifact_containers(id,workspace_id,kind,name,owner_user_id,created_by_id,created_at,updated_at)
      VALUES('project','ws','project','Project','viewer','viewer','${now}','${now}');
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<58)
      INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      SELECT printf('history-%02d',x),'ws',
        CASE WHEN x>8 AND '${scope}'='owners' THEN 'owner' ELSE 'viewer' END,
        'History '||x,'html_page','workspace',
        CASE WHEN x<=8 THEN 'project' ELSE 'home' END,
        '${now}','${now}','${now}' FROM n;
      INSERT INTO shareable_viewer_recency(shareable_id,viewer_user_id,first_viewed_at,last_viewed_at)
      SELECT id,'viewer','${now}',strftime('%Y-%m-%dT%H:%M:%fZ','2026-09-01','+'||substr(id,9)||' minutes')
      FROM shareables WHERE id LIKE 'history-%';
    `)
    const request: SearchInput = { ...input, query: '' }
    const healthy = await searchSuggestions(
      fixture.db,
      () => index(),
      { id: 'viewer' },
      request,
      now,
    )
    expect(healthy.recent.map((row) => row.id)).toEqual([
      'history-58',
      'history-57',
      'history-56',
      'history-55',
      'history-54',
      'history-53',
    ])
    request.filters =
      scope === 'project'
        ? { location: { kind: 'project', id: 'project' } }
        : { ownerUserIds: ['viewer'] }
    const filtered = await searchSuggestions(
      fixture.db,
      () => index(),
      { id: 'viewer' },
      request,
      now,
    )
    expect(filtered.recent.map((row) => row.id)).toEqual([
      'history-08',
      'history-07',
      'history-06',
      'history-05',
      'history-04',
      'history-03',
    ])
  },
)

test('credential discovery intersection excludes home and forbidden siblings before grouping and details', async () => {
  fixture.sqlite.exec(`
    INSERT INTO artifact_containers(id,workspace_id,kind,name,created_by_id,created_at,updated_at)
      VALUES('project','ws','project','Project','viewer','${now}','${now}');
    UPDATE shareables SET name='Same title' WHERE id IN ('a','b');
    UPDATE shareables SET container_id='project', visibility='workspace' WHERE id='b';
    UPDATE shareables SET updated_at='2026-09-01T00:00:00.000Z' WHERE id='a';
  `)
  const authority = {
    kind: 'agent' as const,
    familyId: 'family',
    workspaceId: 'ws',
    projectId: 'project',
    projectNameSnapshot: 'Project',
    agentProfileId: 'profile',
  }
  const human = await search(
    fixture.db,
    () => index(),
    'viewer',
    { ...input, pageSize: 50 },
    'cli',
  )
  if ('error' in human) throw new Error('healthy search failed')
  expect(human.items.find((row) => row.title === 'Same title')?.groupSize).toBe(
    2,
  )
  expect(human.total.value).toBe(2)
  for (const ordinaryBot of [false, true]) {
    if (ordinaryBot) {
      fixture.sqlite.exec(`
      INSERT INTO users(id,email,email_verified,name,workspace_id,kind,created_at,updated_at) VALUES('bot','bot@example.com',1,'Bot','ws','bot','${now}','${now}');
      INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','bot','member','active','${now}','${now}');
      UPDATE shareables SET owner_user_id='bot' WHERE id IN ('a','denied');
    `)
      // Both the same-title sibling and a separate private group are discoverable
      // by this bot, but neither is within its credential's project read range.
      const botDiscovery = await search(
        fixture.db,
        () => index(),
        'bot',
        { ...input, pageSize: 50 },
        'cli',
      )
      if ('error' in botDiscovery)
        throw new Error('bot discovery control failed')
      expect(botDiscovery.items).toEqual([
        expect.objectContaining({ id: 'a', groupSize: 2 }),
        expect.objectContaining({ id: 'denied', excerpt: 'Secret Snippet' }),
      ])
      expect(botDiscovery.total).toEqual({ value: 2, relation: 'eq' })
    }
    const scopedIndex = index()
    const scoped = await search(
      fixture.db,
      () => scopedIndex,
      ordinaryBot ? 'bot' : 'viewer',
      {
        ...input,
        pageSize: 50,
        filters: { credentialScope: { ...authority, ordinaryBot } },
      },
      'cli',
    )
    if ('error' in scoped) throw new Error('scoped search failed')
    expect(scoped.items.map((row) => row.id)).toEqual(['b'])
    expect(scoped.items[0].groupSize).toBe(1)
    expect(scoped.total).toEqual({ value: 1, relation: 'eq' })
    expect(JSON.stringify(scoped)).not.toContain('Secret')
    expect(scopedIndex.details).toHaveBeenCalledWith(expect.anything(), ['b'])
    const log = await fixture.db
      .selectFrom('search_logs')
      .selectAll()
      .where('id', '=', scoped.searchLogId)
      .executeTakeFirstOrThrow()
    expect(log.source).toBe('cli')
    expect(log.result_count).toBe(1)
  }
})

test('continuations bind source, credential family and live access', async () => {
  fixture.sqlite.exec(`
    INSERT INTO artifact_containers(id,workspace_id,kind,name,created_by_id,created_at,updated_at)
      VALUES('project','ws','project','Project','viewer','${now}','${now}');
    UPDATE shareables SET container_id='project', visibility='workspace' WHERE id IN ('a','b','c');
  `)
  const authority = {
    kind: 'agent' as const,
    familyId: 'family',
    workspaceId: 'ws',
    projectId: 'project',
    projectNameSnapshot: 'Project',
    agentProfileId: 'profile',
  }
  const criteria = { ...input, filters: { credentialScope: authority } }
  const first = await search(
    fixture.db,
    () => index(),
    'viewer',
    criteria,
    'cli',
  )
  if ('error' in first || !first.nextCursor)
    throw new Error('missing continuation')
  const continuation = { ...criteria, cursor: first.nextCursor }
  expect(
    await search(fixture.db, () => index(), 'viewer', continuation, 'mcp'),
  ).toHaveProperty('error.code', 'invalid_cursor')
  expect(
    await search(
      fixture.db,
      () => index(),
      'viewer',
      {
        ...continuation,
        filters: { credentialScope: { ...authority, familyId: 'other' } },
      },
      'cli',
    ),
  ).toHaveProperty('error.code', 'invalid_cursor')
  const next = await search(
    fixture.db,
    () => index(),
    'viewer',
    {
      ...continuation,
      filters: {
        credentialScope: { ...authority, projectNameSnapshot: 'Renamed label' },
      },
    },
    'cli',
  )
  if ('error' in next) throw new Error('healthy continuation failed')
  expect(next.items[0].id).not.toBe(first.items[0].id)
  fixture.sqlite.exec(
    `UPDATE artifact_containers SET archived_at='${now}' WHERE id='project'`,
  )
  const revoked = await search(
    fixture.db,
    () => index(),
    'viewer',
    continuation,
    'cli',
  )
  expect(revoked).toMatchObject({
    items: [],
    total: { value: 0, relation: 'eq' },
  })
})

test('list adapter combines owner, home/project and updated/viewed periods without exposing restricted summaries', async () => {
  const { searchCliArtifacts } = await import('./cli-artifacts.server')
  fixture.sqlite.exec(`
    INSERT INTO artifact_containers(id,workspace_id,kind,name,created_by_id,created_at,updated_at)
      VALUES('project','ws','project','Project','viewer','${now}','${now}');
    UPDATE shareables SET container_id='project', visibility='workspace' WHERE id='b';
    UPDATE shareables SET updated_at='2026-09-01T00:00:00.000Z' WHERE id='a';
    INSERT INTO shareable_viewer_recency(shareable_id,viewer_user_id,first_viewed_at,last_viewed_at) VALUES('b','viewer','2026-09-16T12:00:00.000Z','2026-09-16T12:00:00.000Z');
  `)
  const args = {
    baseUrl: 'https://example.test',
    source: 'cli' as const,
    q: 'body',
    includeVersionSummaries: true,
  }
  const human = await searchCliArtifacts(
    fixture.db,
    () => index(),
    { id: 'viewer' },
    args,
  )
  if (human.kind !== 'ok') throw new Error('healthy adapter search failed')
  expect(human.data.artifacts).toHaveLength(2)
  expect(human.data.artifacts[0]).toMatchObject({
    excerpt: 'Healthy excerpt',
    owner_user_id: 'viewer',
    updated_at: '2026-09-01T00:00:00.000Z',
    retain_versions: null,
    version_count: 0,
    total_size_bytes: 0,
  })
  const combined = await searchCliArtifacts(
    fixture.db,
    () => index(),
    { id: 'viewer' },
    {
      ...args,
      owner_user_ids: ['viewer'],
      project_id: 'project',
      date_field: 'viewed',
      from: '2026-09-16',
      to: '2026-09-16',
    },
  )
  expect(combined).toMatchObject({
    kind: 'ok',
    data: {
      artifacts: [{ id: 'b', owner_email: 'viewer@example.com' }],
      total: { value: 1, relation: 'eq' },
    },
  })
  for (const filter of [
    { owner_user_ids: ['owner'] },
    { date_field: 'updated' as const, from: '2026-09-16' },
    { date_field: 'viewed' as const, to: '2026-09-15' },
  ]) {
    const empty = await searchCliArtifacts(
      fixture.db,
      () => index(),
      { id: 'viewer' },
      { ...args, ...filter },
    )
    expect(empty).toMatchObject({
      kind: 'ok',
      data: {
        artifacts: [],
        total: { value: 0, relation: 'eq' },
        search_hint:
          'Rephrase the query and search again before concluding that nothing exists.',
      },
    })
  }
  const home = await searchCliArtifacts(
    fixture.db,
    () => index(),
    { id: 'viewer' },
    { ...args, project_id: '' },
  )
  if (home.kind !== 'ok') throw new Error('home search failed')
  expect(home.data.artifacts.map((row) => row.id)).toEqual(['a'])
  expect(home.data.artifacts[0].group_size).toBe(2)
  const restricted = await searchCliArtifacts(
    fixture.db,
    () => index(),
    { id: 'viewer' },
    {
      ...args,
      authority: {
        kind: 'agent',
        familyId: 'family',
        workspaceId: 'ws',
        projectId: 'project',
        projectNameSnapshot: 'Project',
        agentProfileId: 'profile',
      },
    },
  )
  if (restricted.kind !== 'ok') throw new Error('restricted search failed')
  expect(restricted.data.artifacts.map((row) => row.id)).toEqual(['b'])
  for (const key of ['retain_versions', 'version_count', 'total_size_bytes'])
    expect(JSON.stringify(restricted.data)).not.toContain(key)
})

test('list adapter leaves out a stored kind this build cannot read', async () => {
  const { searchCliArtifacts } = await import('./cli-artifacts.server')
  const { ArtifactsListEntrySchema } = await import('@artifactshare/contract')
  // shareables.artifact_kind is plain TEXT with no CHECK constraint, so a row
  // written by a newer build reaches this one as a string it does not know.
  fixture.sqlite.exec(
    `UPDATE shareables SET artifact_kind='from_the_future' WHERE id='a'`,
  )
  const result = await searchCliArtifacts(
    fixture.db,
    () => index(),
    { id: 'viewer' },
    { baseUrl: 'https://example.test', source: 'cli', q: 'body' },
  )
  if (result.kind !== 'ok') throw new Error('search failed')
  const byId = new Map(result.data.artifacts.map((row) => [row.id, row]))
  expect(byId.get('a')!.artifact_kind).toBeUndefined()
  expect(byId.get('b')!.artifact_kind).toBe('html_page')
  // The route answers with ArtifactsListResponseSchema.parse(result.data), so
  // this field has to drop out of the one entry rather than fail the page.
  const kind = ArtifactsListEntrySchema.shape.artifact_kind
  for (const row of result.data.artifacts)
    expect(kind.safeParse(row.artifact_kind).success).toBe(true)
})

test('list adapter labels any-term fallback and distinguishes capacity from empty success', async () => {
  const { searchCliArtifacts } = await import('./cli-artifacts.server')
  const stub = index()
  const healthySearch = stub.search
  stub.search = vi.fn(async (request) =>
    request.any
      ? healthySearch(request)
      : {
          items: [],
          visibilityProtocol: 1,
          nextCursor: null,
          activeDocumentCount: 4,
        },
  )
  const args = {
    baseUrl: 'https://example.test',
    source: 'cli' as const,
    q: 'quarterly revenue forecast',
  }
  const fallback = await searchCliArtifacts(
    fixture.db,
    () => stub,
    { id: 'viewer' },
    args,
  )
  expect(fallback).toMatchObject({
    kind: 'ok',
    data: {
      total: { value: 2, relation: 'eq' },
      search_hint:
        'No documents matched all query terms. These results match any of the terms. Rephrase the query and search again.',
    },
  })
  stub.search = vi.fn<SearchIndex['search']>(async () => ({
    error: { code: 'search_capacity_exceeded' },
  }))
  expect(
    await searchCliArtifacts(fixture.db, () => stub, { id: 'viewer' }, args),
  ).toEqual({ kind: 'capacity-exceeded' })
})

test('a search waits on few sequential round trips and reads the viewer once', async () => {
  // Calls started before the previous wave settles share that wave, so the
  // wave count is the number of round trips a remote D1 and index would add
  // one after another.
  let waves = 0,
    open: Promise<void> | undefined
  const roundTrip = () =>
    (open ??= new Promise<void>((resolve) => {
      waves++
      setTimeout(() => {
        open = undefined
        resolve()
      }, 0)
    }))
  // Count viewer reads in the SQL SQLite receives, not in Kysely's nodes.
  // Membership comes with the viewer row, never as a query of its own.
  let viewerReads = 0,
    membershipReads = 0
  const prepare = fixture.sqlite.prepare.bind(fixture.sqlite)
  fixture.sqlite.prepare = (sql: string) => {
    if (/^select [^()]*"email_verified"[^()]* from "users"/.test(sql))
      viewerReads++
    if (/^select [^()]* from "workspace_members"/.test(sql)) membershipReads++
    return prepare(sql)
  }
  const db = fixture.db.withPlugin({
    transformQuery: ({ node }) => node,
    transformResult: async ({ result }) => {
      await roundTrip()
      return result
    },
  })
  const stub = index()
  const remote: SearchIndex = {
    search: async (...args) => (await roundTrip(), stub.search(...args)),
    groupMembers: async (...args) => (
      await roundTrip(),
      stub.groupMembers(...args)
    ),
    details: async (...args) => (await roundTrip(), stub.details(...args)),
  }
  const result = await search(db, () => remote, 'viewer', {
    ...input,
    pageSize: 20,
  })
  expect(result).not.toHaveProperty('error')
  expect(viewerReads).toBe(1)
  expect(waves).toBeLessThanOrEqual(8)
  waves = 0
  viewerReads = 0
  await searchSuggestions(db, () => remote, { id: 'viewer' }, input, now)
  expect(viewerReads).toBe(1)
  expect(waves).toBeLessThanOrEqual(8)
  // A search with no matches retries with each filter relaxed; those retries
  // run side by side.
  waves = 0
  viewerReads = 0
  const none = await search(db, () => remote, 'viewer', {
    ...input,
    pageSize: 20,
    filters: { ownerUserIds: ['nobody'], date: { field: 'updated' } },
  })
  if ('error' in none) throw new Error('unexpected search failure')
  expect(none.items).toEqual([])
  expect(none.relaxations.map((entry) => entry.filter)).toContain('owners')
  expect(waves).toBeLessThanOrEqual(12)
  expect(viewerReads).toBe(1)
  expect(membershipReads).toBe(0)
})

test('other workspaces are searched side by side and keep their order', async () => {
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES('xa','A','${now}'),('xb','B','${now}');
    INSERT INTO artifact_containers(id,workspace_id,kind,name,owner_user_id,created_by_id,created_at,updated_at) VALUES
      ('xa-home','xa','inbox','Home','viewer','viewer','${now}','${now}'),
      ('xb-home','xb','inbox','Home','viewer','viewer','${now}','${now}');
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at) VALUES
      ('in-a','xa','viewer','Alpha A','html_page','private','xa-home','${now}','${now}','${now}'),
      ('in-b','xb','viewer','Alpha B','html_page','private','xb-home','${now}','${now}','${now}');
  `)
  const started: string[] = []
  const release = new Map<string, () => void>()
  const external = (workspace: string, id: string): SearchIndex => ({
    ...index(),
    search: () => {
      started.push(workspace)
      return new Promise((resolve) =>
        release.set(workspace, () =>
          resolve({
            items: [{ id, tier: 'all', rank: 1, activityAt: now }],
            visibilityProtocol: 1,
            nextCursor: null,
          }),
        ),
      )
    },
  })
  const indexes = {
    ws: index(),
    xa: external('xa', 'in-a'),
    xb: external('xb', 'in-b'),
  }
  const pending = search(
    fixture.db,
    (workspace) => indexes[workspace as keyof typeof indexes],
    'viewer',
    { ...input, pageSize: 20 },
  )
  await vi.waitFor(() => expect(started.sort()).toEqual(['xa', 'xb']))
  // Answer in reverse; the result order still follows the workspaces.
  release.get('xb')!()
  release.get('xa')!()
  const result = await pending
  if ('error' in result) throw new Error('unexpected search failure')
  expect(result.items.map((row) => row.id)).toEqual(
    expect.arrayContaining(['in-a', 'in-b']),
  )
  expect(
    await fixture.db
      .selectFrom('search_workspace_daily_usage')
      .select(['workspace_id', 'requests'])
      .orderBy('workspace_id')
      .execute(),
  ).toEqual([
    { workspace_id: 'ws', requests: 1 },
    { workspace_id: 'xa', requests: 1 },
    { workspace_id: 'xb', requests: 1 },
  ])
  indexes.xa.search = async () => ({
    items: [],
    visibilityProtocol: 1,
    nextCursor: null,
  })
  indexes.xb.search = async () => {
    throw new Error('synthetic fan-out failure')
  }
  await expect(
    search(
      fixture.db,
      (workspace) => indexes[workspace as keyof typeof indexes],
      'viewer',
      input,
    ),
  ).rejects.toThrow('synthetic fan-out failure')
  expect(
    await fixture.db
      .selectFrom('search_workspace_daily_usage')
      .select(['workspace_id', 'requests'])
      .orderBy('workspace_id')
      .execute(),
  ).toEqual([
    { workspace_id: 'ws', requests: 2 },
    { workspace_id: 'xa', requests: 2 },
    { workspace_id: 'xb', requests: 2 },
  ])
})

test('all search entry points share atomic daily admission and preserve invalid tokens', async () => {
  const { searchGroup } = await import('./search.server')
  const { SearchDailyLimitError } = await import('./search-quota.server')
  const stub = index()
  const day = new Date().toISOString().slice(0, 10)
  fixture.sqlite
    .prepare('INSERT INTO search_actor_daily_usage VALUES (?, ?, 998)')
    .run('viewer', day)
  const outcomes = await Promise.allSettled([
    search(fixture.db, () => stub, 'viewer', input, 'screen'),
    search(fixture.db, () => stub, 'viewer', input, 'cli'),
    search(fixture.db, () => stub, 'viewer', input, 'mcp'),
    searchSuggestions(fixture.db, () => stub, { id: 'viewer' }, input),
  ])
  expect(
    outcomes.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(2)
  const denied = outcomes.filter((result) => result.status === 'rejected')
  expect(denied).toHaveLength(2)
  for (const result of denied)
    expect(result.reason).toBeInstanceOf(SearchDailyLimitError)
  expect(
    fixture.sqlite
      .prepare(
        'SELECT requests FROM search_actor_daily_usage WHERE actor_id = ?',
      )
      .get('viewer'),
  ).toEqual({ requests: 1000 })
  vi.mocked(stub.search).mockClear()
  await expect(
    search(fixture.db, () => stub, 'viewer', { ...input, cursor: 'invalid' }),
  ).resolves.toMatchObject({ error: { code: 'invalid_cursor' } })
  await expect(
    searchGroup(fixture.db, () => stub, 'viewer', 'invalid'),
  ).resolves.toMatchObject({ error: { code: 'invalid_cursor' } })
  await expect(
    searchSuggestions(
      fixture.db,
      () => stub,
      { id: 'viewer' },
      { ...input, query: '' },
    ),
  ).resolves.toMatchObject({ files: [], owners: [], projects: [] })
  expect(stub.search).not.toHaveBeenCalled()
  await expect(
    search(fixture.db, () => stub, 'owner', input),
  ).resolves.not.toHaveProperty('error')
  const next = new Date(`${day}T00:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  await expect(
    search(
      fixture.db,
      () => stub,
      'viewer',
      input,
      'screen',
      () => next,
    ),
  ).resolves.not.toHaveProperty('error')
})

test('denied suggestions skip discovery and name queries; storage failures fail closed', async () => {
  const day = new Date().toISOString().slice(0, 10)
  fixture.sqlite
    .prepare('INSERT INTO search_actor_daily_usage VALUES (?, ?, 1000)')
    .run('viewer', day)
  const discover = vi.spyOn(discovery, 'enumerateSuggestionIds')
  const names = vi.spyOn(discovery, 'suggestionOwners')
  const stub = index()
  await expect(
    searchSuggestions(fixture.db, () => stub, { id: 'viewer' }, input),
  ).rejects.toMatchObject({ code: 'search_daily_limit_exceeded' })
  expect(discover).not.toHaveBeenCalled()
  expect(names).not.toHaveBeenCalled()
  fixture.sqlite.exec('DROP TABLE search_actor_daily_usage')
  await expect(search(fixture.db, () => stub, 'viewer', input)).rejects.toThrow(
    'no such table',
  )
  expect(stub.search).not.toHaveBeenCalled()
  discover.mockRestore()
  names.mockRestore()
})

test('workspace measurement counts zero hits and failures once despite relaxation', async () => {
  const stub = index()
  vi.mocked(stub.search).mockResolvedValue({
    items: [],
    visibilityProtocol: 1,
    nextCursor: null,
  })
  await search(fixture.db, () => stub, 'viewer', input)
  expect(
    fixture.sqlite
      .prepare(
        'SELECT workspace_id, requests FROM search_workspace_daily_usage',
      )
      .all(),
  ).toEqual([{ workspace_id: 'ws', requests: 1 }])
  vi.mocked(stub.search).mockRejectedValue(new Error('synthetic index failure'))
  await expect(search(fixture.db, () => stub, 'viewer', input)).rejects.toThrow(
    'synthetic index failure',
  )
  expect(
    fixture.sqlite
      .prepare('SELECT requests FROM search_workspace_daily_usage')
      .get(),
  ).toEqual({ requests: 2 })
  expect(
    fixture.sqlite
      .prepare('SELECT requests FROM search_actor_daily_usage')
      .get(),
  ).toEqual({ requests: 2 })
})

test('usage cleanup uses bounded batches and distinct retention windows', async () => {
  const { pruneSearchUsage } = await import('./search-quota.server')
  const { admitSearch, SearchDailyLimitError } =
    await import('./search-quota.server')
  const nearMidnight = '2026-11-20T23:59:59.500Z'
  fixture.sqlite.exec(
    "INSERT INTO search_actor_daily_usage VALUES ('viewer', '2026-11-20', 1000), ('owner', '2026-11-19', 1); INSERT INTO search_workspace_daily_usage VALUES ('ws', '2026-08-01', 3), ('ws', '2026-11-19', 4)",
  )
  await expect(
    admitSearch(fixture.db, 'viewer', nearMidnight),
  ).rejects.toMatchObject({
    retry_at: '2026-11-21T00:00:00.000Z',
    retry_after_seconds: 1,
  })
  expect(new SearchDailyLimitError(nearMidnight).headers).toEqual({
    'Cache-Control': 'private, no-store',
    'Retry-After': '1',
  })
  expect(
    await pruneSearchUsage(
      fixture.db,
      '2026-08-22T00:00:00.000Z',
      nearMidnight,
    ),
  ).toBe(1)
  expect(
    fixture.sqlite
      .prepare('SELECT actor_id FROM search_actor_daily_usage')
      .all(),
  ).toEqual([{ actor_id: 'viewer' }])
  expect(
    fixture.sqlite
      .prepare('SELECT day FROM search_workspace_daily_usage')
      .all(),
  ).toEqual([{ day: '2026-11-19' }])
})

test('valid group receipts consume admission while invalid representatives retain their contract', async () => {
  const { searchGroup } = await import('./search.server')
  const stub = index()
  const result = await search(fixture.db, () => stub, 'viewer', input)
  if ('error' in result) throw new Error('Expected results')
  const receipt = result.items[0].receipt
  await fixture.db
    .updateTable('search_actor_daily_usage')
    .set({ requests: 1000 })
    .where('actor_id', '=', 'viewer')
    .execute()
  vi.mocked(stub.search).mockClear()
  await expect(
    searchGroup(fixture.db, () => stub, 'viewer', receipt),
  ).rejects.toMatchObject({ code: 'search_daily_limit_exceeded' })
  expect(stub.search).not.toHaveBeenCalled()
  await fixture.db
    .deleteFrom('shareables')
    .where('id', '=', result.items[0].id)
    .execute()
  await expect(
    searchGroup(fixture.db, () => stub, 'viewer', receipt),
  ).resolves.toMatchObject({ error: { code: 'invalid_cursor' } })
})

test('measurement failure fails search and reports once per operation', async () => {
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fixture.sqlite.exec('DROP TABLE search_workspace_daily_usage')
    await expect(
      search(fixture.db, () => index(), 'viewer', input),
    ).rejects.toThrow('Search usage storage failed')
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      'search_workspace_usage_write_failed',
    )
    expect(
      fixture.sqlite
        .prepare('SELECT requests FROM search_actor_daily_usage')
        .get(),
    ).toEqual({ requests: 1 })
  } finally {
    diagnostic.mockRestore()
  }
})

test.each([false, true])(
  'measurement failure is handled while the index is pending (index fails: %s)',
  async (indexFails) => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const indexError = new Error('synthetic index failure')
    const stub = index()
    vi.mocked(stub.search).mockImplementation(async () => {
      await gate
      if (indexFails) throw indexError
      return { items: [], visibilityProtocol: 1, nextCursor: null }
    })
    try {
      fixture.sqlite.exec('DROP TABLE search_workspace_daily_usage')
      const pending = search(fixture.db, () => stub, 'viewer', input)
      const checked = indexFails
        ? expect(pending).rejects.toBe(indexError)
        : expect(pending).rejects.toThrow('Search usage storage failed')
      await vi.waitFor(() => {
        expect(stub.search).toHaveBeenCalledTimes(1)
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          'search_workspace_usage_write_failed',
        )
      })
      release()
      await checked
      expect(
        fixture.sqlite
          .prepare('SELECT requests FROM search_actor_daily_usage')
          .get(),
      ).toEqual({ requests: 1 })
    } finally {
      release()
      diagnostic.mockRestore()
    }
  },
)

test.each(['search', 'groupMembers', 'details'] as const)(
  'stale verified email after %s cannot leak a granted sentinel or counts',
  async (phase) => {
    fixture.sqlite.exec(
      `INSERT INTO shareable_grants VALUES('denied','VIEWER@example.com','${now}','owner')`,
    )
    const stub = index()
    const original = stub[phase]
    let changed = false
    // Each hook returns a formerly valid candidate snapshot after revoking its email ground.
    if (phase === 'details')
      stub.details = async (...args) => {
        const rows = await (original as SearchIndex['details'])(...args)
        fixture.sqlite.exec(
          "UPDATE users SET email='new@example.test' WHERE id='viewer'",
        )
        return rows
      }
    else if (phase === 'search')
      stub.search = async (...args) => {
        const rows = await (original as SearchIndex['search'])(...args)
        fixture.sqlite.exec(
          "UPDATE users SET email_verified=0 WHERE id='viewer'",
        )
        return rows
      }
    else
      stub.groupMembers = async (...args) => {
        const rows = await (original as SearchIndex['groupMembers'])(...args)
        if (!changed)
          fixture.sqlite.exec(
            "UPDATE users SET email='new@example.test' WHERE id='viewer'",
          )
        changed = true
        return rows
      }
    const result = await search(fixture.db, () => stub, 'viewer', {
      ...input,
      pageSize: 20,
    })
    expect(result).toMatchObject({
      total: { value: 2, relation: 'eq' },
      items: [
        { id: 'a', rank: 1, groupSize: 2 },
        { id: 'b', rank: 2, groupSize: 1 },
      ],
    })
    expect(JSON.stringify(result)).not.toMatch(
      /Denied Title|Secret Owner|Secret Snippet|"denied"/,
    )
    expect(
      await fixture.db
        .selectFrom('search_logs')
        .select(['discoverable_count', 'search_method', 'result_count'])
        .executeTakeFirst(),
    ).toEqual({
      discoverable_count: 3,
      search_method: 'candidates',
      result_count: 2,
    })
  },
)

test('unsupported candidate reader fails with capacity; unfinished cutover never reports exact zero', async () => {
  const stub = index()
  stub.search = async () => ({ items: [], nextCursor: null })
  await expect(search(fixture.db, () => stub, 'viewer', input)).rejects.toThrow(
    'search_capacity_exceeded',
  )
  stub.search = async () => ({
    items: [],
    nextCursor: null,
    visibilityProtocol: 1,
    incomplete: true,
  })
  const result = await search(fixture.db, () => stub, 'viewer', input)
  expect(result).toMatchObject({
    total: { value: 0, relation: 'gte' },
    items: [],
  })
})

test('a revoked first representative refills page one without losing a cursor slot', async () => {
  fixture.sqlite.exec(`
    UPDATE shareables SET owner_user_id='owner', name='First' WHERE id='a';
    INSERT INTO shareable_grants VALUES('a','viewer@example.com','${now}','owner');
  `)
  const stub = index()
  const details = stub.details
  let first = true
  stub.details = async (...args) => {
    const rows = await details(...args)
    if (first) {
      first = false
      fixture.sqlite.exec("DELETE FROM shareable_grants WHERE shareable_id='a'")
    }
    return rows
  }
  const result = await search(fixture.db, () => stub, 'viewer', input)
  if ('error' in result) throw new Error('Expected results')
  expect(result.items).toMatchObject([{ id: 'b', rank: 1, groupSize: 1 }])
  expect(result.total).toEqual({ value: 2, relation: 'eq' })
  expect(result.nextCursor).not.toBeNull()
  const { readSearchToken } = await import('./search-logs.server')
  expect(
    (
      await readSearchToken(
        fixture.db,
        'viewer',
        result.items[0].receipt,
        'open',
        new Date().toISOString(),
      )
    )?.payload,
  ).toMatchObject({ file: 'b', rank: 1 })
  const next = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    cursor: result.nextCursor!,
  })
  expect(next).toMatchObject({
    items: [{ id: 'c', rank: 2 }],
    nextCursor: null,
  })
})

test('a changed index match is replaced without repeating a result on the next page', async () => {
  fixture.sqlite.exec("UPDATE shareables SET name='First' WHERE id='a'")
  const stub = index()
  const originalSearch = stub.search
  const details = stub.details
  let replaced = false
  stub.details = async (...args) => {
    replaced = true
    return (await details(...args)).filter((row) => row.id !== 'a')
  }
  stub.search = async (request) => {
    const page = await originalSearch(request)
    if ('error' in page || !replaced) return page
    return { ...page, items: page.items.filter((row) => row.id !== 'a') }
  }

  const result = await search(fixture.db, () => stub, 'viewer', input)
  if ('error' in result) throw new Error('Expected results')
  expect(result.items).toMatchObject([{ id: 'b', rank: 1 }])
  expect(result.total).toEqual({ value: 2, relation: 'eq' })
  expect(result.nextCursor).not.toBeNull()
  const next = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    cursor: result.nextCursor!,
  })
  expect(next).toMatchObject({
    items: [{ id: 'c', rank: 2 }],
    total: { value: 2, relation: 'eq' },
    nextCursor: null,
  })
})

test('a vanished representative is excluded from the replacement group size', async () => {
  const stub = index()
  const details = stub.details
  const originalSearch = stub.search
  stub.details = async (...args) =>
    (await details(...args)).filter((row) => row.id !== 'a')
  stub.search = async (request) => {
    const page = await originalSearch(request)
    if ('error' in page) return page
    const items = request.allowedIds
      ? page.items.filter((row) => row.id !== 'a')
      : page.items.map((row) => (row.id === 'c' ? { ...row, rank: 2 } : row))
    return { ...page, items }
  }
  const result = await search(fixture.db, () => stub, 'viewer', input)
  expect(result).toMatchObject({
    items: [{ id: 'c', rank: 1, groupSize: 1, groupSizeRelation: 'eq' }],
    total: { value: 2, relation: 'eq' },
  })
})

test('unstable detail materialization has a bounded safe outcome', async () => {
  const stub = index()
  vi.mocked(stub.details).mockResolvedValue([])
  await expect(
    search(fixture.db, () => stub, 'viewer', input),
  ).rejects.toBeInstanceOf(query.SearchCapacityError)
  expect(stub.details).toHaveBeenCalledTimes(3)
})

test('selected owner label stops after its first live witness page', async () => {
  const stub = index()
  const original = stub.search
  const witnessRequests: Array<number | undefined> = []
  stub.search = async (request) => {
    const page = await original(request)
    if (request.query === '' && request.ownerUserIds?.includes('viewer')) {
      witnessRequests.push(request.cursor)
      return { ...page, nextCursor: 2000 }
    }
    return page
  }
  const result = await search(fixture.db, () => stub, 'viewer', {
    ...input,
    filters: { ownerUserIds: ['viewer'] },
  })
  expect(result).toMatchObject({
    selectedScope: { owners: [{ id: 'viewer', name: 'Viewer' }] },
  })
  expect(witnessRequests).toEqual([undefined])
})

test('returning to a screen search reuses its log and daily count, rechecks access, and falls back to a new search otherwise', async () => {
  fixture.sqlite.exec(
    `UPDATE workspace_members SET role='member' WHERE user_id='viewer'; INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','owner','admin','active','${now}','${now}')`,
  )
  const stub = index()
  // Open receipts are checked against the real clock, so the search uses it too.
  const clock = () => new Date()
  const later = () => new Date(Date.now() + 31 * 60_000)
  // The count of the UTC day the search runs in: `later` can fall on the next
  // day when the test runs shortly before midnight UTC.
  const daily = async (actor: string, at: () => Date = clock) =>
    (
      await fixture.db
        .selectFrom('search_actor_daily_usage')
        .select('requests')
        .where('actor_id', '=', actor)
        .where('day', '=', at().toISOString().slice(0, 10))
        .executeTakeFirst()
    )?.requests ?? 0
  const first = await search(
    fixture.db,
    () => stub,
    'viewer',
    input,
    'screen',
    clock,
  )
  if ('error' in first || !first.resume) throw new Error('no resume token')
  expect(await daily('viewer')).toBe(1)
  // Going Back to the results: same log, facets, no new count.
  const back = await search(
    fixture.db,
    () => stub,
    'viewer',
    { ...input, resume: first.resume },
    'screen',
    clock,
  )
  if ('error' in back) throw new Error('resume failed')
  expect(back.searchLogId).toBe(first.searchLogId)
  expect(back.facets).toEqual(first.facets)
  expect(back.items.map((item) => item.id)).toEqual(['a'])
  expect(await readSearchLogs(fixture.db, 'viewer')).toHaveLength(1)
  expect(await daily('viewer')).toBe(1)
  // A file opened after going Back is recorded on the original search.
  expect(
    await recordSearchOpen(
      fixture.db,
      'viewer',
      first.searchLogId,
      back.items[0].receipt,
    ),
  ).toBe(true)
  // Access removed in between is rechecked.
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='owner' WHERE id='a'",
  )
  const revoked = await search(
    fixture.db,
    () => stub,
    'viewer',
    { ...input, resume: first.resume },
    'screen',
    clock,
  )
  if ('error' in revoked) throw new Error('resume failed')
  expect(revoked.searchLogId).toBe(first.searchLogId)
  expect(revoked.items.map((item) => item.id)).not.toContain('a')
  fixture.sqlite.exec(
    "UPDATE shareables SET owner_user_id='viewer' WHERE id='a'",
  )
  // Returning adds nothing, but is refused once the day's limit is reached.
  fixture.sqlite.exec(
    "UPDATE search_actor_daily_usage SET requests=1000 WHERE actor_id='viewer'",
  )
  await expect(
    search(
      fixture.db,
      () => stub,
      'viewer',
      { ...input, resume: first.resume },
      'screen',
      clock,
    ),
  ).rejects.toHaveProperty('code', 'search_daily_limit_exceeded')
  fixture.sqlite.exec(
    "UPDATE search_actor_daily_usage SET requests=1 WHERE actor_id='viewer'",
  )
  // Another viewer, changed conditions, another source and an expired token
  // each make a new search with its own log and count.
  for (const [actor, changed, source, at] of [
    ['owner', input, 'screen', clock],
    ['viewer', { ...input, sort: 'newest' as const }, 'screen', clock],
    ['viewer', input, 'mcp', clock],
    ['viewer', input, 'screen', later],
  ] as const) {
    const before = await daily(actor, at)
    const logs = (await readSearchLogs(fixture.db, actor)).length
    const result = await search(
      fixture.db,
      () => stub,
      actor,
      { ...changed, resume: first.resume },
      source,
      at,
    )
    if ('error' in result) throw new Error('fallback failed')
    expect(result.searchLogId).not.toBe(first.searchLogId)
    expect(await daily(actor, at)).toBe(before + 1)
    expect((await readSearchLogs(fixture.db, actor)).length).toBe(logs + 1)
    if (source !== 'screen') expect(result).not.toHaveProperty('resume')
  }
})

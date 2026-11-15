import * as discovery from './search-discovery.server'
import * as query from './search-index/query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  search,
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
      nextCursor: null,
    })),
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
  expect(await readSearchLogs(fixture.db, 'viewer')).toHaveLength(1)
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
  'first-batch acceptance of %i/2000 selects the correct retrieval mode',
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
      search: vi.fn<SearchIndex['search']>(async (request) => ({
        items: request.allowedIds
          ? candidate.filter((row) => request.allowedIds!.includes(row.id))
          : request.cursor
            ? []
            : candidate,
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
    expect(requests.filter((request) => !request.allowedIds)).toHaveLength(
      count === 399 ? 1 : 2,
    )
    expect(requests.some((request) => request.allowedIds)).toBe(count === 399)
  },
)

test('five candidate fetches finish with allowed IDs and exact duplicate tails beyond 10000', async () => {
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<10002)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'tail-'||x,'ws',CASE WHEN x=10002 THEN 'owner' ELSE 'viewer' END,CASE WHEN x=10001 THEN 'Other' ELSE 'Same '||x END,'html_page','private','home','${now}','${now}','${now}' FROM n`)
  const candidates = Array.from({ length: 10003 }, (_, i) => ({
    id: `tail-${i}`,
    tier: 'all' as const,
    rank: i + 1,
    activityAt: now,
  }))
  const stub: SearchIndex = {
    search: vi.fn<SearchIndex['search']>(async (request) => {
      const rows = request.allowedIds
        ? candidates.filter((row) => request.allowedIds!.includes(row.id))
        : candidates
      const offset = request.cursor ?? 0
      return {
        items: rows.slice(offset, offset + 2000),
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
  const result = await search(fixture.db, () => stub, 'viewer', input)
  expect(result).toMatchObject({
    total: { value: 2, relation: 'eq' },
    items: [{ id: 'tail-0', groupSize: 10001 }],
  })
  expect(
    vi
      .mocked(stub.search)
      .mock.calls.filter(([request]) => !request.allowedIds),
  ).toHaveLength(5)
  expect(stub.details).toHaveBeenCalledExactlyOnceWith(expect.anything(), [
    'tail-0',
  ])
})

test('hidden all-term matches cannot suppress visible any-term results and date relaxation', async () => {
  fixture.sqlite.exec(
    "UPDATE shareables SET activity_at='2026-09-01T00:00:00.000Z' WHERE id='b'",
  )
  const stub: SearchIndex = {
    search: vi.fn<SearchIndex['search']>(async (request) => ({
      items: (request.any ? ['a'] : ['denied', 'b'])
        .filter((id) => !request.allowedIds || request.allowedIds.includes(id))
        .map((id, i) => ({
          id,
          tier: request.any ? 'any' : 'all',
          rank: i + 1,
          activityAt: now,
        })),
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
    total: { value: 1, relation: 'eq' },
    items: [{ id: 'a' }],
    relaxations: [{ filter: 'date', total: { value: 1, relation: 'eq' } }],
  })
  expect(JSON.stringify(result)).not.toMatch(
    /Denied Title|Secret Owner|Secret Snippet/,
  )
  expect(stub.details).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ any: true }),
    ['a'],
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
  expect(stub.search).toHaveBeenCalledWith(
    expect.objectContaining({
      updated: { from: '2026-09-09T00:00:00.000Z', to: start.toISOString() },
    }),
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
    search: vi.fn<SearchIndex['search']>(async (request) => {
      const rows = request.allowedIds
        ? candidates.filter((row) => request.allowedIds!.includes(row.id))
        : candidates
      const offset = request.cursor ?? 0
      return {
        items: rows.slice(offset, offset + 2000),
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
  const result = await search(fixture.db, () => stub, 'viewer', input)
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
  vi.mocked(stub.search).mockImplementation(async (request) => ({
    items: candidates
      .slice(0, 2000)
      .filter(
        (row) => !request.allowedIds || request.allowedIds.includes(row.id),
      ),
    nextCursor: null,
  }))
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
  const discover = vi.spyOn(discovery, 'discoverCandidates')
  try {
    const logs = await readSearchLogs(fixture.db, 'viewer')
    expect(logs[0].opens).toHaveLength(499)
    expect(logs[0].opens[0]).toMatchObject({
      shareableId: 'opened-499',
      rank: 500,
    })
    expect(logs[0].opens.at(-1)).toMatchObject({
      shareableId: 'opened-1',
      rank: 2,
    })
    expect(JSON.stringify(logs)).not.toContain('opened-500')
    expect(discover).toHaveBeenCalledTimes(5)
    for (const [, request] of discover.mock.calls)
      expect(request.candidateIds.length).toBeLessThanOrEqual(100)
  } finally {
    discover.mockRestore()
  }
})

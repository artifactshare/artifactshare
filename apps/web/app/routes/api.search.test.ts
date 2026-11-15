import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { RouterContextProvider } from 'react-router'
import { userContext } from '~/middleware/context'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { Db } from '~/services/db.server'
import type {
  SearchIndex,
  search,
  searchSuggestions,
} from '~/services/search.server'
const rpc = vi.hoisted(() => ({
  search: vi.fn<SearchIndex['search']>(),
  details: vi.fn<SearchIndex['details']>(),
}))
vi.mock('cloudflare:workers', () => ({
  env: { WORKSPACE_SEARCH_INDEX: { getByName: () => rpc } },
}))
vi.mock('~/services/db.server', () => ({
  withDb: (callback: (db: Db) => Promise<unknown>) => callback(fixture.db),
}))
import { loader, middleware } from './api.search'
import { loader as suggestions } from './api.search-suggestions'
import { loader as logs } from './api.search-logs'
import { action as open } from './api.search-logs.$id.opens'
let fixture: ReturnType<typeof createMigratedInMemoryDb>
const context = new RouterContextProvider()
const now = '2026-09-15T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  context.set(userContext, {
    id: 'viewer',
    name: 'Viewer',
    email: 'viewer@example.com',
    emailVerified: true,
    workspaceId: 'ws',
    image: null,
    hd: null,
    msTenantId: null,
    locale: null,
    kind: 'human',
  })
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES('ws','Workspace','${now}');
    INSERT INTO users(id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES('viewer','viewer@example.com',1,'Viewer','ws','${now}','${now}');
    INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','viewer','member','active','${now}','${now}');
    INSERT INTO artifact_containers(id,workspace_id,kind,owner_user_id,name,created_by_id,created_at,updated_at) VALUES('home','ws','inbox','viewer','Home','viewer','${now}','${now}');
  `)
  for (let i = 0; i < 8; i++) {
    fixture.sqlite
      .prepare(
        'INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        `file-${i}`,
        'ws',
        'viewer',
        `alpha ${String.fromCharCode(97 + i)}`,
        'html_page',
        'private',
        'home',
        now,
        now,
        now,
      )
  }
  for (let i = 0; i < 4; i++) {
    fixture.sqlite
      .prepare(
        'INSERT INTO artifact_containers(id,workspace_id,kind,name,created_by_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(`project-${i}`, 'ws', 'project', `alpha ${i}`, 'viewer', now, now)
    fixture.sqlite
      .prepare(
        'INSERT INTO project_members(container_id,user_id,joined_at,last_seen_at) VALUES(?,?,?,?)',
      )
      .run(`project-${i}`, 'viewer', now, now)
    fixture.sqlite
      .prepare(
        'INSERT INTO users(id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES(?,?,1,?,?,?,?)',
      )
      .run(
        `owner-${i}`,
        `owner-${i}@example.com`,
        `alpha Owner ${i}`,
        'ws',
        now,
        now,
      )
    fixture.sqlite
      .prepare('UPDATE shareables SET owner_user_id=? WHERE id=?')
      .run(`owner-${i}`, `file-${i}`)
    fixture.sqlite
      .prepare(
        'INSERT INTO shareable_grants(shareable_id,granted_email,granted_at,granted_by) VALUES(?,?,?,?)',
      )
      .run(`file-${i}`, 'viewer@example.com', now, 'viewer')
  }
  rpc.search.mockImplementation(async (request) => ({
    items: Array.from({ length: 8 }, (_, i) => ({
      id: `file-${i}`,
      tier: 'all' as const,
      rank: i + 1,
      activityAt: now,
    }))
      .filter(
        (row) => !request.allowedIds || request.allowedIds.includes(row.id),
      )
      .slice(0, request.limit ?? 2000),
    nextCursor: null,
  }))
  rpc.details.mockImplementation(async (_request, ids) =>
    ids.map((id) => ({ id, path: 'index.html', excerpt: 'alpha body' })),
  )
})
afterEach(async () => {
  await fixture.db.destroy()
  vi.clearAllMocks()
})

test('result API validates inputs, paginates opaquely, logs once and accepts only real click receipts', async () => {
  const url = new URL('https://example.com/api/search?q=alpha&pageSize=2')
  const args = {
    request: new Request(url),
    url,
    pattern: '/api/search',
    params: {},
    context,
  }
  const response = await loader(args)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await response.json<Awaited<ReturnType<typeof search>>>()
  if ('error' in body) throw new Error('unexpected search error')
  expect(body.items).toHaveLength(2)
  expect(body.items[0]).toMatchObject({ id: 'file-0', rank: 1, groupSize: 1 })
  expect(body.nextCursor).toMatch(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]+$/)
  if (!body.nextCursor) throw new Error('expected continuation')
  url.searchParams.set('cursor', body.nextCursor)
  const next = await loader({ ...args, url })
  expect(await next.json()).toMatchObject({
    items: [
      { id: 'file-2', rank: 3 },
      { id: 'file-3', rank: 4 },
    ],
  })
  expect(await (await logs(args)).json()).toHaveProperty('searches.length', 1)
  const openUrl = new URL(
    `https://example.com/api/search-logs/${body.searchLogId}/opens`,
  )
  const opened = await open({
    ...args,
    url: openUrl,
    params: { id: body.searchLogId },
    request: new Request(openUrl, {
      method: 'POST',
      headers: { Origin: openUrl.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt: body.items[0].receipt,
        rank: 999,
        shareableId: 'other',
      }),
    }),
  })
  expect(opened.status).toBe(204)
  expect(
    await fixture.db
      .selectFrom('search_opens')
      .select(['rank', 'shareable_id'])
      .execute(),
  ).toEqual([{ rank: 1, shareable_id: 'file-0' }])
  url.searchParams.set('cursor', 'tampered')
  expect((await loader({ ...args, url })).status).toBe(400)
  url.searchParams.delete('cursor')
  url.searchParams.set('dateField', 'updated')
  url.searchParams.set('from', '2026-02-30')
  expect(await (await loader({ ...args, url })).json()).toMatchObject({
    error: { code: 'validation_error' },
  })
})

test('suggestions cap files, eligible owners and accessible projects without excerpts or logs', async () => {
  const url = new URL('https://example.com/api/search-suggestions?q=alpha')
  const response = await suggestions({
    request: new Request(url),
    url,
    pattern: '/api/search-suggestions',
    params: {},
    context,
  })
  const body =
    await response.json<Awaited<ReturnType<typeof searchSuggestions>>>()
  expect(body.files).toHaveLength(6)
  expect(body.owners).toHaveLength(3)
  expect(body.projects).toHaveLength(3)
  expect(JSON.stringify(body)).not.toContain('@example.com')
  expect(rpc.details).not.toHaveBeenCalled()
  expect(
    await fixture.db.selectFrom('search_logs').selectAll().execute(),
  ).toEqual([])
})

test('cookie authentication errors are also private and non-cacheable', async () => {
  context.set(userContext, null)
  const url = new URL('https://example.com/api/search')
  const args = {
    request: new Request(url),
    url,
    pattern: '/api/search',
    params: {},
    context,
  }
  try {
    await middleware[0](args, async () => {
      await middleware[1](args, async () => new Response())
      return new Response()
    })
    throw new Error('authentication unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(Response)
    if (!(error instanceof Response)) throw error
    expect(error.status).toBe(401)
    expect(error.headers.get('Cache-Control')).toBe('private, no-store')
  }
})

test('suggestion work does not grow with multi-batch owned files or absent owner matches', async () => {
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6000)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'extra-'||x,'ws','viewer','Extra '||x,'html_page','private','home','${now}','${now}','${now}' FROM n`)
  const url = new URL('https://example.com/api/search-suggestions?q=bodyword')
  const response = await suggestions({
    request: new Request(url),
    url,
    pattern: '/api/search-suggestions',
    params: {},
    context,
  })
  const body =
    await response.json<Awaited<ReturnType<typeof searchSuggestions>>>()
  expect(body.files).toHaveLength(6)
  expect(body.owners).toEqual([])
  expect(rpc.search).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ limit: 6 }),
  )
  expect(rpc.search.mock.calls[0][0].allowedIds).toContain('extra-6000')
  expect(rpc.details).not.toHaveBeenCalled()
})

test('same-workspace administrators cannot read or open a member search log', async () => {
  const url = new URL('https://example.com/api/search?q=alpha')
  const args = {
    request: new Request(url),
    url,
    pattern: '/api/search',
    params: {},
    context,
  }
  const body = await (
    await loader(args)
  ).json<Awaited<ReturnType<typeof search>>>()
  if ('error' in body) throw new Error('unexpected search error')
  expect(await (await logs(args)).json()).toHaveProperty('searches.length', 1)
  fixture.sqlite.exec(
    `INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES('ws','owner-0','admin','active','${now}','${now}')`,
  )
  const member = context.get(userContext)
  if (!member) throw new Error('missing member')
  context.set(userContext, {
    ...member,
    id: 'owner-0',
    email: 'owner-0@example.com',
  })
  expect(await (await logs(args)).json()).toEqual({ searches: [] })
  const openUrl = new URL(
    `https://example.com/api/search-logs/${body.searchLogId}/opens`,
  )
  expect(
    (
      await open({
        ...args,
        url: openUrl,
        params: { id: body.searchLogId },
        request: new Request(openUrl, {
          method: 'POST',
          headers: {
            Origin: openUrl.origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ receipt: body.items[0].receipt }),
        }),
      })
    ).status,
  ).toBe(404)
})

test('suggestions rank within the eligible domain so denied and unseen prefixes cannot hide a tail match', async () => {
  fixture.sqlite
    .exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<321)
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    SELECT 'prefix-'||x,'ws','owner-0','alpha prefix','html_page',CASE WHEN x%2=0 THEN 'private' ELSE 'workspace' END,'home','${now}','${now}','${now}' FROM n`)
  const ranked = [
    ...Array.from({ length: 321 }, (_, i) => `prefix-${i + 1}`),
    'file-7',
  ]
  rpc.search.mockImplementation(async (request) => ({
    items: ranked
      .filter((id) => !request.allowedIds || request.allowedIds.includes(id))
      .slice(0, request.maxResults ?? 320)
      .map((id, i) => ({ id, rank: i + 1, tier: 'all', activityAt: now })),
    nextCursor: null,
  }))
  const url = new URL('https://example.com/api/search-suggestions?q=alpha')
  const body = await (
    await suggestions({
      request: new Request(url),
      url,
      pattern: '/api/search-suggestions',
      params: {},
      context,
    })
  ).json<Awaited<ReturnType<typeof searchSuggestions>>>()
  expect(body.files.map((row) => row.id)).toEqual(['file-7'])
  expect(rpc.search).toHaveBeenCalledTimes(1)
  expect(rpc.details).not.toHaveBeenCalled()
})

test('index capacity errors return a private failure instead of a partial search', async () => {
  const url = new URL('https://example.com/api/search?q=bodyword')
  const args = {
    request: new Request(url),
    url,
    pattern: '/api/search',
    params: {},
    context,
  }
  const healthy = await middleware[0](args, () => loader(args))
  if (!(healthy instanceof Response)) throw new Error('Expected a response')
  expect(healthy.status).toBe(200)
  rpc.search.mockResolvedValue({ error: { code: 'search_capacity_exceeded' } })
  const response = await middleware[0](args, () => loader(args))
  if (!(response instanceof Response)) throw new Error('Expected a response')
  expect(response.status).toBe(503)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({
    error: { code: 'search_capacity_exceeded' },
  })
})

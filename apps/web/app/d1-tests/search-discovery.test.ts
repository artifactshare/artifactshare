import { fileURLToPath } from 'node:url'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { d1CompatibilityPlugin } from '~/lib/d1-compatibility.server'
import type { DB } from '~/types/db'
import {
  buildCandidateDiscoveryQuery,
  buildSuggestionSourceQueries,
  buildSuggestionOwnersQuery,
  SUGGESTION_SOURCE_LIMIT,
  buildSparseDiscoveryQuery,
  buildMemberDiscoveryQuery,
  loadDiscoveryViewer,
} from '~/services/search-discovery.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))
const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let binding: D1Database
let db: Kysely<DB>
const now = '2026-09-15T00:00:00.000Z'
const ids = Array.from({ length: 2000 }, (_, i) => `candidate-${i + 1}`)
const input = {
  viewerUserId: 'viewer',
  workspaceId: 'source',
  candidateIds: ids,
  now,
}

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  binding = (await worker.getEnv()).DB
  db = new Kysely<DB>({
    dialect: new D1Dialect({ database: binding }),
    plugins: [d1CompatibilityPlugin],
  })
  await binding.batch([
    binding.prepare(
      "INSERT INTO workspaces (id,name,link_sharing_enabled,created_at) VALUES ('source','Source',1,'2026-01-01')",
    ),
    binding.prepare(
      "INSERT INTO users (id,email,email_verified,name,workspace_id,google_sub,created_at,updated_at) VALUES ('viewer','viewer@example.com',1,'Viewer','source','discovery-viewer','2026-01-01','2026-01-01'), ('owner','owner@example.com',1,'Owner','source','discovery-owner','2026-01-01','2026-01-01')",
    ),
    binding.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES ('project','source','project','Project','private','owner','2026-01-01','2026-01-01')",
    ),
    binding.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      SELECT 'candidate-'||x,'source','viewer','File','html_page','private','project','${now}','${now}','${now}' FROM n`),
  ])
})
afterAll(async () => {
  await db?.destroy()
  await server.close()
})

it('uses ID lookups with all filters and five indexed sparse sources', async () => {
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  for (const filters of [
    {},
    { ownerUserId: 'viewer' },
    { ownerUserIds: ['viewer', 'owner'] },
    { location: { kind: 'home' as const } },
    {
      ownerUserIds: ['viewer'],
      location: { kind: 'project' as const, id: 'project' },
    },
    { containerId: 'project' },
    { date: { field: 'updated' as const, from: new Date(now) } },
    { date: { field: 'viewed' as const, to: new Date(now) } },
    { ownerUserId: 'viewer', containerId: 'project', includeArchived: true },
  ]) {
    const query = buildCandidateDiscoveryQuery(
      db,
      viewer,
      { ...input, ...filters },
      now,
    ).compile()
    expect(query.parameters.length).toBeLessThanOrEqual(100)
    expect(
      query.parameters.filter((value) => value === JSON.stringify(ids)),
    ).toHaveLength(1)
    const plan = await binding
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.parameters)
      .all<{ detail: string }>()
    const access = plan.results
      .filter((row) => /(?:SEARCH|SCAN) s\b/.test(row.detail))
      .map((row) => row.detail)
    expect(access).toHaveLength(1)
    expect(access[0]).toMatch(
      /SEARCH s USING INDEX sqlite_autoindex_shareables_1 \(id=\?\)/,
    )
    expect(access[0]).not.toMatch(/SCAN|workspace/)
  }
  const sparse = buildSparseDiscoveryQuery(db, viewer, {}, now).compile()
  expect(sparse.sql.match(/\bunion\b/gi)).toHaveLength(4)
  expect(sparse.parameters.length).toBeLessThanOrEqual(100)
  const plan = await binding
    .prepare(`EXPLAIN QUERY PLAN ${sparse.sql}`)
    .bind(...sparse.parameters)
    .all<{ detail: string }>()
  const details = plan.results.map((row) => row.detail).join('\n')
  for (const index of [
    'shareables_owner_user_id',
    'shareable_grants_lower_email_shareable',
    'project_members_user',
    'project_share_defaults_lower_email_container',
    'shareable_viewer_recency_viewer_time',
  ]) {
    expect(details).toContain(index)
  }
  expect(
    await buildSparseDiscoveryQuery(db, viewer, {}, now).execute(),
  ).toHaveLength(2000)
})

it('bounds real D1 reads for 2000 ownership, direct/project, link and denied candidates despite unrelated rows', async () => {
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  const query = buildCandidateDiscoveryQuery(db, viewer, input, now).compile()
  const baseline = await binding
    .prepare(query.sql)
    .bind(...query.parameters)
    .all()
  expect(baseline.results).toHaveLength(2000)
  await binding
    .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<12000)
    INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
    SELECT 'unrelated-'||x,'source','owner','Unrelated','html_page','private','project','${now}','${now}' FROM n`)
    .run()
  const identity = await binding
    .prepare(
      "SELECT id,workspace_id,email,email_verified FROM users WHERE id='viewer'",
    )
    .all()
  for (const workload of [
    'ownership',
    'direct',
    'project',
    'member',
    'base',
    'link',
    'denied',
  ]) {
    if (workload === 'direct') {
      await binding.batch([
        binding.prepare(
          "UPDATE shareables SET owner_user_id='owner' WHERE id LIKE 'candidate-%'",
        ),
        binding.prepare(
          `INSERT INTO shareable_grants SELECT id,'VIEWER@example.com','${now}','owner' FROM shareables WHERE id LIKE 'candidate-%'`,
        ),
      ])
    } else if (workload === 'project') {
      await binding.batch([
        binding.prepare('DELETE FROM shareable_grants'),
        binding.prepare(
          "UPDATE shareables SET visibility='project' WHERE id LIKE 'candidate-%'",
        ),
        binding.prepare(
          `INSERT INTO project_share_defaults (id,project_container_id,email,created_at,updated_at) VALUES ('grant','project','VIEWER@example.com','${now}','${now}')`,
        ),
      ])
    } else if (workload === 'member') {
      await binding.batch([
        binding.prepare('DELETE FROM project_share_defaults'),
        binding.prepare(
          "UPDATE artifact_containers SET created_by_id='viewer'",
        ),
        binding.prepare(
          `INSERT INTO project_members VALUES ('project','viewer','${now}','${now}')`,
        ),
      ])
    } else if (workload === 'base') {
      await binding.batch([
        binding.prepare('DELETE FROM project_members'),
        binding.prepare(
          "UPDATE artifact_containers SET created_by_id='owner',base_visibility='workspace'",
        ),
      ])
    } else if (workload === 'link') {
      await binding.batch([
        binding.prepare('DELETE FROM project_share_defaults'),
        binding.prepare(
          "UPDATE shareables SET visibility='link' WHERE id LIKE 'candidate-%'",
        ),
        binding.prepare(
          `INSERT INTO shareable_viewer_recency (shareable_id,viewer_user_id,first_viewed_at,last_viewed_at) SELECT id,'viewer','${now}','${now}' FROM shareables WHERE id LIKE 'candidate-%'`,
        ),
      ])
    } else if (workload === 'denied') {
      await binding.prepare('DELETE FROM shareable_viewer_recency').run()
    }
    const result = await binding
      .prepare(query.sql)
      .bind(...query.parameters)
      .all<{ id: string }>()
    expect(result.results.map((row) => row.id).sort()).toEqual(
      workload === 'denied' ? [] : [...ids].sort(),
    )
    const reads = result.meta.rows_read + identity.meta.rows_read
    expect(Number.isFinite(reads)).toBe(true)
    expect(reads, workload).toBeLessThanOrEqual(20000)
    if (workload === 'ownership')
      expect(result.meta.rows_read).toBe(baseline.meta.rows_read)
  }
  // An executable workspace-first fault must fail the same ID-plan witness.
  const faultySql = query.sql
    .replace(
      '"shareables" as "s"',
      '"shareables" as "s" INDEXED BY shareables_workspace_visibility',
    )
    .replace('+s.workspace_id', 's.workspace_id')
  const faultPlan = await binding
    .prepare(`EXPLAIN QUERY PLAN ${faultySql}`)
    .bind(...query.parameters)
    .all<{ detail: string }>()
  const faultAccess = faultPlan.results.find((row) =>
    /SEARCH s\b/.test(row.detail),
  )!.detail
  expect(() =>
    expect(faultAccess).toMatch(
      /SEARCH s USING INDEX sqlite_autoindex_shareables_1 \(id=\?\)/,
    ),
  ).toThrow()
  const fault = await binding
    .prepare(faultySql)
    .bind(...query.parameters)
    .all()
  expect(fault.results).toEqual([])
})

it('complete member enumeration uses the same eligibility without sparse-source omissions', async () => {
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  await binding
    .prepare(
      "UPDATE shareables SET visibility='workspace',owner_user_id='owner' WHERE id='candidate-1'",
    )
    .run()
  const query = buildMemberDiscoveryQuery(
    db,
    viewer,
    { ownerUserIds: ['owner'], location: { kind: 'project', id: 'project' } },
    now,
  )
  expect((await query.execute()).map((row) => row.id)).toContain('candidate-1')
  const compiled = query.compile()
  expect(compiled.parameters.length).toBeLessThanOrEqual(100)
  const plan = await binding
    .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .bind(...compiled.parameters)
    .all<{ detail: string }>()
  expect(
    plan.results.some((row) =>
      /SEARCH s USING INDEX .*workspace/.test(row.detail),
    ),
  ).toBe(true)
})

it('retains cutoff logs and cascades more than one bounded deletion batch', async () => {
  const { pruneSearchLogs } = await import('~/services/search-logs.server')
  await binding
    .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<501)
    INSERT INTO search_logs(id,actor_id,created_at,query,filters_json,result_count,count_relation,tier,duration_ms,discoverable_count,source)
    SELECT 'expired-'||x,'viewer','2026-06-16T23:59:59.999Z','alpha','{}',0,'eq','all',1,0,'screen' FROM n`)
    .run()
  await binding
    .prepare(
      "INSERT INTO search_logs(id,actor_id,created_at,query,filters_json,result_count,count_relation,tier,duration_ms,discoverable_count,source) VALUES('cutoff','viewer','2026-06-17T00:00:00.000Z','alpha','{}',0,'eq','all',1,0,'screen')",
    )
    .run()
  await binding
    .prepare(
      "INSERT INTO search_opens(id,search_id,shareable_id,rank,opened_at) VALUES('open','expired-1','candidate-1',1,'2026-06-16T23:59:59.999Z')",
    )
    .run()
  expect(await pruneSearchLogs(db, '2026-06-17T00:00:00.000Z')).toBe(500)
  expect(await pruneSearchLogs(db, '2026-06-17T00:00:00.000Z')).toBe(1)
  expect(await db.selectFrom('search_logs').select('id').execute()).toEqual([
    { id: 'cutoff' },
  ])
  expect(await db.selectFrom('search_opens').selectAll().execute()).toEqual([])
})

it('bounds typeahead source reads before ranking as the discoverable domain grows', async () => {
  // Real D1 read counts witness source retrieval; six returned suggestions alone
  // would not detect an unbounded discovery scan.
  await binding.batch([
    binding.prepare(
      "UPDATE shareables SET owner_user_id='viewer',visibility='project'",
    ),
    binding.prepare(
      `INSERT OR IGNORE INTO project_members VALUES ('project','viewer','${now}','${now}')`,
    ),
    binding.prepare(
      `INSERT OR IGNORE INTO project_share_defaults (id,project_container_id,email,created_at,updated_at) VALUES ('suggest-default','project','viewer@example.com','${now}','${now}')`,
    ),
    binding.prepare(
      `INSERT OR IGNORE INTO shareable_grants SELECT id,'viewer@example.com','${now}','viewer' FROM shareables`,
    ),
    binding.prepare(
      `INSERT OR IGNORE INTO shareable_viewer_recency (shareable_id,viewer_user_id,first_viewed_at,last_viewed_at) SELECT id,'viewer','${now}','${now}' FROM shareables`,
    ),
  ])
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  const queries = buildSuggestionSourceQueries(db, viewer)
  const before: number[] = []
  for (const query of queries) {
    const compiled = query.compile()
    const result = await binding
      .prepare(compiled.sql)
      .bind(...compiled.parameters)
      .all()
    before.push(result.meta.rows_read)
  }
  await binding.batch([
    binding.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8000)
      INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      SELECT 'suggest-growth-'||x,'source','viewer','File','html_page','project','project','${now}','${now}','${now}' FROM n`),
    binding.prepare(
      `INSERT OR IGNORE INTO shareable_grants SELECT id,'viewer@example.com','${now}','viewer' FROM shareables`,
    ),
    binding.prepare(
      `INSERT OR IGNORE INTO shareable_viewer_recency (shareable_id,viewer_user_id,first_viewed_at,last_viewed_at) SELECT id,'viewer','${now}','${now}' FROM shareables`,
    ),
  ])
  for (const [i, query] of queries.entries()) {
    const compiled = query.compile()
    const result = await binding
      .prepare(compiled.sql)
      .bind(...compiled.parameters)
      .all()
    expect(result.results).toHaveLength(SUGGESTION_SOURCE_LIMIT)
    expect(result.meta.rows_read).toBe(before[i])
    // Removing the source bound must fail the same work assertion, even when
    // downstream ranking would still return six files.
    // Project sources also bound each project's merge input; remove both levels.
    const unbounded = query.clearLimit().compile()
    const fault = await binding
      .prepare(unbounded.sql.replaceAll('limit ?', 'limit -1'))
      .bind(
        ...unbounded.parameters.filter(
          (value) => value !== SUGGESTION_SOURCE_LIMIT,
        ),
      )
      .all()
    expect(() => expect(fault.meta.rows_read).toBe(before[i])).toThrow()
  }
})

it('denied index growth does not expand typeahead source reads', async () => {
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  await binding
    .prepare(
      "INSERT INTO artifact_containers(id,workspace_id,kind,name,owner_user_id,created_by_id,created_at,updated_at) VALUES('denied-home','source','inbox','Home','owner','owner','2026-01-01','2026-01-01')",
    )
    .run()
  const queries = buildSuggestionSourceQueries(db, viewer, {}, now).map(
    (query) => query.compile(),
  )
  const before = []
  for (const query of queries)
    before.push(
      await binding
        .prepare(query.sql)
        .bind(...query.parameters)
        .all(),
    )
  await binding
    .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<30000)
     INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
     SELECT 'denied-growth-'||x,'source','owner','File','html_page','private','denied-home','${now}','${now}','${now}' FROM n`)
    .run()
  for (const [i, query] of queries.entries()) {
    const after = await binding
      .prepare(query.sql)
      .bind(...query.parameters)
      .all()
    expect(after.results).toEqual(before[i].results)
    expect(after.meta.rows_read).toBe(before[i].meta.rows_read)
    expect(after.results.length).toBeLessThanOrEqual(2000)
  }
})

it('owner-name suggestions stop after three findable owners without sorting all matches', async () => {
  const viewer = (await loadDiscoveryViewer(db, 'viewer'))!
  const query = buildSuggestionOwnersQuery(
    db,
    viewer,
    { viewerUserId: 'viewer', now },
    'Owner',
  ).compile()
  const seed = async (from: number, to: number) => {
    await binding.batch([
      binding.prepare(`WITH RECURSIVE n(x) AS (SELECT ${from} UNION ALL SELECT x+1 FROM n WHERE x<${to})
        INSERT INTO users(id,email,name,workspace_id,google_sub,created_at,updated_at)
        SELECT 'z-owner-'||x,'owner-'||x||'@example.com','Owner '||x,'source','z-owner-'||x,'${now}','${now}' FROM n`),
      binding.prepare(`INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
        SELECT id,'source',id,'File','html_page','private','project','${now}','${now}' FROM users WHERE id LIKE 'z-owner-%' AND id NOT IN (SELECT id FROM shareables)`),
      binding.prepare(
        `INSERT OR IGNORE INTO shareable_grants SELECT id,'viewer@example.com','${now}','viewer' FROM shareables WHERE id LIKE 'z-owner-%'`,
      ),
    ])
  }
  await seed(100, 103)
  const before = await binding
    .prepare(query.sql)
    .bind(...query.parameters)
    .all()
  expect(before.results).toHaveLength(3)
  await seed(2000, 3000)
  const after = await binding
    .prepare(query.sql)
    .bind(...query.parameters)
    .all()
  expect(after.results).toEqual(before.results)
  expect(after.meta.rows_read).toBe(before.meta.rows_read)
  const fault = await binding
    .prepare(
      query.sql.replace(
        'order by "owner"."id"',
        'order by "name", "owner"."id"',
      ),
    )
    .bind(...query.parameters)
    .all()
  expect(() =>
    expect(fault.meta.rows_read).toBe(before.meta.rows_read),
  ).toThrow()
})

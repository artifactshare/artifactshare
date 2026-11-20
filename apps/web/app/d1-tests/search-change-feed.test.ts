import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  mkdir,
  copyFile,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { d1CompatibilityPlugin } from '~/lib/d1-compatibility.server'
import type { DurableObjectNamespace as TestNamespace } from '@cloudflare/workers-types'
import type { DB } from '~/types/db'
import {
  dispatchWorkspaceSearch,
  seedSearchRebuild,
} from '~/services/search-index/schedule.server'
import { INDEX_FORMAT_VERSION } from '~/services/search-index/normalize'
vi.mock('cloudflare:workers', () => ({ env: {} }))

const directory = await mkdtemp(join(tmpdir(), 'search-feed-'))
const root = fileURLToPath(new URL('../..', import.meta.url))
const configPath = join(directory, 'wrangler.json')
const beforeFeedMigrations = join(directory, 'migrations')
await mkdir(beforeFeedMigrations)
for (const name of await readdir(join(root, 'db/migrations'))) {
  if (name.endsWith('.sql') && name < '0130_')
    await copyFile(
      join(root, 'db/migrations', name),
      join(beforeFeedMigrations, name),
    )
}
const config = {
  name: 'search-feed-test',
  main: join(root, 'app/test/search-feed-worker.ts'),
  compatibility_date: '2026-09-01',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'feed',
      database_id: '00000000-0000-0000-0000-000000000001',
      migrations_dir: beforeFeedMigrations,
    },
  ],
  r2_buckets: [{ binding: 'BUCKET', bucket_name: 'feed-test' }],
  durable_objects: {
    bindings: [
      { name: 'WORKSPACE_SEARCH_INDEX', class_name: 'WorkspaceSearchIndex' },
    ],
  },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['WorkspaceSearchIndex'] }],
}
await writeFile(configPath, JSON.stringify(config))
const server = createTestHarness({ root, workers: [{ configPath }] })
const worker = server.getWorker<{
  DB: D1Database
  BUCKET: R2Bucket
  WORKSPACE_SEARCH_INDEX: TestNamespace
}>()
let binding: D1Database
let db: Kysely<DB>
const now = '2026-01-01'
const run = (sql: string) => binding.prepare(sql).run()
const rows = async (sql: string) => (await binding.prepare(sql).all()).results
const invoke = async (workspace: string, action = 'sync', query?: string) => {
  const response = await worker.fetch('http://example.test/', {
    method: 'POST',
    body: JSON.stringify({ workspace, action, query }),
  })
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<{ items: Array<{ id: string }> }>
}
async function seed(workspace: string, count = 1) {
  await run(
    `INSERT INTO workspaces(id,name,created_at) VALUES('${workspace}','Fixture','${now}')`,
  )
  await run(
    `INSERT INTO users(id,email,name,workspace_id,created_at,updated_at,google_sub) VALUES('${workspace}-user','${workspace}@example.test','Fixture','${workspace}','${now}','${now}','${workspace}-google')`,
  )
  await run(
    `INSERT INTO artifact_containers(id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES('${workspace}-inbox','${workspace}','inbox','${workspace}-user','${workspace}-user','Inbox','${now}','${now}')`,
  )
  for (let n = 0; n < count; n++) {
    const id = `${workspace}-${String(n).padStart(3, '0')}`
    await binding.batch([
      binding.prepare(
        `INSERT INTO shareables(id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES('${id}','${workspace}','${workspace}-user','Original','${workspace}-inbox','html_page','private','${id}-v','${now}','${now}')`,
      ),
      binding.prepare(
        `INSERT INTO versions(id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES('${id}-v','${id}','html_page','published','/index.html','${id}',10,'sha','${workspace}-user','${now}')`,
      ),
    ])
    await (await worker.getEnv()).BUCKET.put(id, '<p>syntheticneedle</p>')
  }
}
const storage = (workspace: string) =>
  worker.getDurableObjectStorage('WORKSPACE_SEARCH_INDEX', {
    name: `${workspace}:0@apac-ne`,
  })
async function settle(workspace: string) {
  for (let i = 0; i < 80; i++) {
    await invoke(workspace, 'alarm')
    if ((await invoke(workspace, 'nextAlarm')) === null) return
  }
  throw new Error('feed did not settle')
}
beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  binding = (await worker.getEnv()).DB
  db = new Kysely<DB>({
    dialect: new D1Dialect({ database: binding }),
    plugins: [d1CompatibilityPlugin],
  })
  await seed('preexisting')
  await invoke('predeleted', 'legacy')
  await (
    await worker.getEnv()
  ).BUCKET.put(
    'search-text/@apac-ne/predeleted/predeleted-000/legacy/index.html',
    'legacyneedle',
  )
  await run(
    "INSERT INTO search_index_workspaces(workspace_id,dispatched_at) VALUES('predeleted','old')",
  )
  // Apply the exact new migration to populated, old-format D1 and DO storage.
  const migration = await readFile(
    join(root, 'db/migrations/0130_search_index_change_feed.sql'),
    'utf8',
  )
  await binding.batch(
    unstable_splitSqlQuery(migration).map((sql) => binding.prepare(sql)),
  )
})
afterAll(async () => {
  await db?.destroy()
  await server.close()
  await rm(directory, { recursive: true, force: true })
})

test('migration-first cutover preserves the old registry and bootstraps pre-feed live and deleted indexed data once', async () => {
  expect(
    await rows('SELECT target,phase,cursor FROM search_index_rebuilds'),
  ).toEqual([{ target: INDEX_FORMAT_VERSION, phase: 'live', cursor: '' }])
  expect(await rows('SELECT * FROM search_index_changes')).toEqual([])
  expect(
    (await invoke('predeleted', 'search', 'legacyneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['predeleted-000'])
  await run(
    "UPDATE search_index_workspaces SET dispatched_at='old-worker-still-runs' WHERE workspace_id='predeleted'",
  )
  const bindings = {
    WORKSPACE_SEARCH_INDEX: {
      getByName: () => ({
        sync: async (workspace: string) => {
          await invoke(workspace)
        },
      }),
    } as never,
  }
  await dispatchWorkspaceSearch(db, bindings)
  await dispatchWorkspaceSearch(db, bindings)
  await settle('preexisting')
  await settle('predeleted')
  expect(
    (await invoke('preexisting', 'search', 'syntheticneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['preexisting-000'])
  expect((await invoke('predeleted', 'search', 'legacyneedle')).items).toEqual(
    [],
  )
  expect(
    (
      await (
        await worker.getEnv()
      ).BUCKET.list({ prefix: 'search-text/@apac-ne/predeleted/' })
    ).objects,
  ).toEqual([])
  expect(await invoke('predeleted', 'nextAlarm')).toBeNull()
})

test('real D1 coalesces with new acknowledgement identities without resetting dispatch, ignores unrelated writes and rolls back atomically', async () => {
  await seed('triggers')
  await run(
    "UPDATE search_index_ready SET dispatched_at='keep' WHERE workspace_id='triggers'",
  )
  await run(
    "UPDATE search_index_changes SET recorded_at='2000-01-01T00:00:00.000Z' WHERE workspace_id='triggers'",
  )
  const old = (
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='triggers'",
    )
  )[0].id
  await run("UPDATE shareables SET name='Renamed' WHERE id='triggers-000'")
  const { id: fresh, recorded_at: recordedAt } = (
    await rows(
      "SELECT id, recorded_at FROM search_index_changes WHERE workspace_id='triggers'",
    )
  )[0]
  expect(fresh).toBe(Number(old) + 1)
  expect(recordedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect(recordedAt).not.toBe('2000-01-01T00:00:00.000Z')
  expect(
    await rows(
      "SELECT dispatched_at FROM search_index_ready WHERE workspace_id='triggers'",
    ),
  ).toEqual([{ dispatched_at: 'keep' }])
  await run(`DELETE FROM search_index_changes WHERE id=${old}`)
  await run(
    "UPDATE shareables SET name=name, view_count=view_count+1 WHERE id='triggers-000'",
  )
  expect(
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='triggers'",
    ),
  ).toEqual([{ id: fresh }])
  await expect(
    binding.batch([
      binding.prepare(
        "UPDATE shareables SET name='rollback' WHERE id='triggers-000'",
      ),
      binding.prepare(
        "INSERT INTO workspaces(id,name,created_at) VALUES('triggers','duplicate','x')",
      ),
    ]),
  ).rejects.toThrow()
  expect(
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='triggers'",
    ),
  ).toEqual([{ id: fresh }])
  await run("UPDATE versions SET sha256='changed' WHERE id='triggers-000-v'")
  expect(
    (
      await rows(
        "SELECT id FROM search_index_changes WHERE workspace_id='triggers'",
      )
    )[0].id,
  ).toBeGreaterThan(fresh as number)
  await run("DELETE FROM search_index_changes WHERE workspace_id='triggers'")
  await run("DELETE FROM versions WHERE id='triggers-000-v'")
  expect(
    await rows(
      "SELECT shareable_id FROM search_index_changes WHERE workspace_id='triggers'",
    ),
  ).toEqual([{ shareable_id: 'triggers-000' }])
})

test('lost notification, timestamp-free fallback rename, move and deletion converge with text cleanup and no periodic alarm', async () => {
  await seed('runtime')
  await seed('destination', 0)
  const syncs: string[] = []
  const bindings = {
    WORKSPACE_SEARCH_INDEX: {
      getByName: (name: string) => ({
        sync: async (workspace: string) => {
          syncs.push(name)
          await invoke(workspace)
        },
      }),
    } as never,
  }
  await dispatchWorkspaceSearch(db, bindings)
  await settle('runtime')
  expect(
    (await invoke('runtime', 'search', 'syntheticneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['runtime-000'])
  await run(
    "UPDATE shareables SET name='fallbackneedle' WHERE id='runtime-000'",
  )
  await dispatchWorkspaceSearch(db, bindings)
  expect(
    (await invoke('runtime', 'search', 'fallbackneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['runtime-000'])
  await run(
    "UPDATE shareables SET workspace_id='destination' WHERE id='runtime-000'",
  )
  await dispatchWorkspaceSearch(db, bindings)
  await settle('runtime')
  await settle('destination')
  expect((await invoke('runtime', 'search', 'syntheticneedle')).items).toEqual(
    [],
  )
  expect(
    (await invoke('destination', 'search', 'syntheticneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['runtime-000'])
  expect(
    (
      await (
        await worker.getEnv()
      ).BUCKET.list({ prefix: 'search-text/@apac-ne/runtime/' })
    ).objects,
  ).toEqual([])
  await run(
    "UPDATE users SET workspace_id='runtime' WHERE id='destination-user'",
  )
  await run("DELETE FROM workspaces WHERE id='destination'")
  expect(
    await rows(
      "SELECT shareable_id FROM search_index_changes WHERE workspace_id='destination'",
    ),
  ).toEqual([{ shareable_id: 'runtime-000' }])
  await dispatchWorkspaceSearch(db, bindings)
  await settle('destination')
  expect(
    (await invoke('destination', 'search', 'syntheticneedle')).items,
  ).toEqual([])
  expect(
    (
      await (
        await worker.getEnv()
      ).BUCKET.list({ prefix: 'search-text/@apac-ne/destination/' })
    ).objects,
  ).toEqual([])
  await dispatchWorkspaceSearch(db, bindings)
  syncs.length = 0
  await dispatchWorkspaceSearch(db, bindings)
  expect(syncs).toEqual([])
  expect(await invoke('runtime', 'nextAlarm')).toBeNull()
})

test('ack failure preserves the durable handoff and concurrent replacement cannot acknowledge the new edit', async () => {
  await seed('handoff')
  await invoke('handoff', 'failAck')
  await expect(invoke('handoff')).rejects.toThrow(
    'synthetic acknowledgement failure',
  )
  expect(
    await (await storage('handoff')).exec('SELECT id FROM pending'),
  ).toEqual([{ id: 'handoff-000' }])
  expect(await invoke('handoff', 'nextAlarm')).not.toBeNull()
  const old = (
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='handoff'",
    )
  )[0].id
  await invoke('handoff', 'pauseAck')
  const running = invoke('handoff', 'alarm')
  try {
    await vi.waitFor(async () =>
      expect(await invoke('handoff', 'reachedAck')).toBe(true),
    )
    await run(
      "UPDATE shareables SET name='concurrentneedle' WHERE id='handoff-000'",
    )
  } finally {
    await invoke('handoff', 'releaseAck')
  }
  await running
  const fresh = (
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='handoff'",
    )
  )[0].id
  expect(fresh).toBeGreaterThan(old as number)
  await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
    name: 'handoff:0@apac-ne',
  })
  await settle('handoff')
  expect(
    (await invoke('handoff', 'search', 'concurrentneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['handoff-000'])
  await run("DELETE FROM shareables WHERE id='handoff-000'")
  await invoke('handoff')
  await settle('handoff')
  expect((await invoke('handoff', 'search', 'concurrentneedle')).items).toEqual(
    [],
  )
  expect(
    (
      await (
        await worker.getEnv()
      ).BUCKET.list({ prefix: 'search-text/@apac-ne/handoff/' })
    ).objects,
  ).toEqual([])
})

test('deleting a different version creator emits a tombstone for the surviving shareable', async () => {
  await seed('creator')
  await run(
    "INSERT INTO users(id,email,name,workspace_id,created_at,updated_at,google_sub) VALUES('other-creator','other@example.test','Other','creator','x','x','other-google')",
  )
  await run(
    "UPDATE versions SET created_by_id='other-creator' WHERE id='creator-000-v'",
  )
  await invoke('creator')
  await run("DELETE FROM users WHERE id='other-creator'")
  expect(
    await rows("SELECT id FROM shareables WHERE id='creator-000'"),
  ).toHaveLength(1)
  expect(
    await rows(
      "SELECT shareable_id FROM search_index_changes WHERE workspace_id='creator'",
    ),
  ).toEqual([{ shareable_id: 'creator-000' }])
  await invoke('creator')
  await settle('creator')
  expect((await invoke('creator', 'search', 'syntheticneedle')).items).toEqual(
    [],
  )
})

test('one-shot rebuild resumes stored cursors and cleans indexed sources deleted before cutover', async () => {
  await seed('rebuild', 61)
  await invoke('rebuild')
  await settle('rebuild')
  const index = await storage('rebuild')
  await run(
    "INSERT INTO search_index_workspaces(workspace_id,dispatched_at) VALUES('rebuild','old')",
  )
  await run("DELETE FROM shareables WHERE id='rebuild-000'")
  // Simulate pre-feed deletion: the old searchable ID and text are the only evidence.
  await run("DELETE FROM search_index_changes WHERE workspace_id='rebuild'")
  await run(
    `INSERT INTO search_index_workspace_rebuilds(workspace_id,target) VALUES('rebuild',${INDEX_FORMAT_VERSION})`,
  )
  await index.exec('UPDATE active SET format=0')
  // Fail after a bounded page has been durably queued, then evict mid-rebuild.
  await index.exec(
    "CREATE TRIGGER fail_rebuild BEFORE INSERT ON staging BEGIN SELECT RAISE(ABORT,'synthetic rebuild interruption'); END",
  )
  await invoke('rebuild')
  const checkpoint = await index.exec('SELECT cursor,scanned FROM rebuild')
  expect(checkpoint).toEqual([{ cursor: 'rebuild-050', scanned: 0 }])
  await index.exec('DROP TRIGGER fail_rebuild')
  await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
    name: 'rebuild:0@apac-ne',
  })
  await invoke('rebuild')
  await settle('rebuild')
  expect(await index.exec('SELECT count(*) AS n FROM active')).toEqual([
    { n: 60 },
  ])
  expect(
    await rows(
      "SELECT completed FROM search_index_workspace_rebuilds WHERE workspace_id='rebuild'",
    ),
  ).toEqual([{ completed: 1 }])
  expect(
    (
      await (
        await worker.getEnv()
      ).BUCKET.list({ prefix: 'search-text/@apac-ne/rebuild/rebuild-000/' })
    ).objects,
  ).toEqual([])
  const final = await index.exec('SELECT * FROM rebuild')
  await invoke('rebuild')
  expect(await index.exec('SELECT * FROM rebuild')).toEqual(final)
  expect(await invoke('rebuild', 'nextAlarm')).toBeNull()
})

test('activation cleanup retries without rebuilding and previously queued cleanup remains durable', async () => {
  await seed('cleanup')
  const bucket = (await worker.getEnv()).BUCKET
  const stale = 'search-text/@apac-ne/cleanup/cleanup-000/stale/index.html'
  await bucket.put(stale, 'stale')
  await invoke('cleanup', 'failCleanup')
  await expect(invoke('cleanup')).rejects.toThrow('synthetic cleanup failure')
  const index = await storage('cleanup')
  const generation = await index.exec('SELECT generation FROM active')
  expect(generation).toHaveLength(1)
  expect(await index.exec('SELECT id FROM pending')).toEqual([
    { id: 'cleanup-000' },
  ])
  expect(await invoke('cleanup', 'nextAlarm')).toBeGreaterThan(
    Date.now() + 60_000,
  )
  expect(await bucket.head(stale)).not.toBeNull()
  // Alarm continuation alone retries; a notification is not needed for correctness.
  await index.exec('UPDATE pending SET retry_at=0')
  await settle('cleanup')
  expect(await index.exec('SELECT generation FROM active')).toEqual(generation)
  expect(await bucket.head(stale)).toBeNull()
  await bucket.put(stale, 'old queued write')
  await index.exec(
    "INSERT INTO intentions(key,shareable) VALUES(?,'cleanup-000')",
    stale,
  )
  await index.exec("INSERT INTO reclaims(id) VALUES('cleanup-000')")
  await settle('cleanup')
  expect(await bucket.head(stale)).toBeNull()
  expect(await index.exec('SELECT * FROM intentions')).toEqual([])
  expect(await index.exec('SELECT * FROM reclaims')).toEqual([])
})

test('one persistently failing item cannot monopolize healthy changes or create an idle retry loop', async () => {
  await seed('failure', 8)
  const bucket = (await worker.getEnv()).BUCKET
  await bucket.delete('failure-000')
  await invoke('failure')
  for (let i = 0; i < 5; i++) await invoke('failure', 'alarm')
  const index = await storage('failure')
  expect(await index.exec('SELECT count(*) AS n FROM active')).toEqual([
    { n: 7 },
  ])
  expect(await index.exec('SELECT id FROM pending')).toEqual([
    { id: 'failure-000' },
  ])
  expect(await invoke('failure', 'nextAlarm')).toBeGreaterThan(
    Date.now() + 60_000,
  )
  expect(
    await rows("SELECT * FROM search_index_ready WHERE workspace_id='failure'"),
  ).toEqual([])
  await bucket.put('failure-000', '<p>recoveredneedle</p>')
  await index.exec('UPDATE pending SET retry_at=0')
  await settle('failure')
  expect(
    (await invoke('failure', 'search', 'recoveredneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['failure-000'])
})

test('D1 dispatch uses the ready index, bounds and rotates failed work, and never revisits settled inventory', async () => {
  await run("UPDATE search_index_rebuilds SET phase='done',cursor=''")
  await run('DELETE FROM search_index_ready')
  await run(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<105) INSERT INTO search_index_ready(workspace_id) SELECT 'dispatch-'||printf('%03d',x) FROM n",
  )
  const calls: string[] = []
  const bindings = {
    WORKSPACE_SEARCH_INDEX: {
      getByName: () => ({
        sync: async (workspace: string) => {
          calls.push(workspace)
          throw new Error('synthetic dispatch failure')
        },
      }),
    } as never,
  }
  await expect(dispatchWorkspaceSearch(db, bindings)).rejects.toThrow(
    'workspace_search_dispatch_failed',
  )
  expect(calls).toHaveLength(50)
  const first = new Set(calls)
  calls.length = 0
  await expect(dispatchWorkspaceSearch(db, bindings)).rejects.toThrow(
    'workspace_search_dispatch_failed',
  )
  expect(calls).toHaveLength(50)
  expect(calls.some((id) => first.has(id))).toBe(false)
  const readyPlan = await rows(
    'EXPLAIN QUERY PLAN SELECT workspace_id FROM search_index_ready ORDER BY dispatched_at,workspace_id LIMIT 50',
  )
  expect(readyPlan.map((row) => row.detail).join(' ')).toContain(
    'search_index_ready_dispatch',
  )
  expect(readyPlan.map((row) => row.detail).join(' ')).not.toContain(
    'TEMP B-TREE',
  )
  const changePlan = await rows(
    "EXPLAIN QUERY PLAN SELECT id,shareable_id FROM search_index_changes WHERE workspace_id='rebuild' ORDER BY id LIMIT 25",
  )
  expect(changePlan.map((row) => row.detail).join(' ')).toContain(
    'search_index_changes_workspace',
  )
  const versionPlan = await rows(
    "EXPLAIN QUERY PLAN SELECT workspace_id,id FROM shareables WHERE current_version_id='v'",
  )
  expect(versionPlan.map((row) => row.detail).join(' ')).toContain(
    'shareables_current_version_id',
  )
  await run('DELETE FROM search_index_ready')
  calls.length = 0
  await dispatchWorkspaceSearch(db, bindings)
  expect(calls).toEqual([])
})

test('bounded migration-first seeding resumes interrupted pages, includes deleted legacy IDs and fences a future format', async () => {
  await run('DELETE FROM search_index_ready')
  await run('DELETE FROM search_index_workspace_rebuilds')
  await run("UPDATE search_index_rebuilds SET phase='live',cursor=''")
  await run(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<105) INSERT INTO workspaces(id,name,created_at) SELECT 'seed-'||printf('%03d',x),'Seed','x' FROM n",
  )
  // Old deployed code can continue to register IDs after the additive migration.
  await run(
    "INSERT INTO search_index_workspaces(workspace_id,dispatched_at) VALUES('deleted-legacy','old')",
  )
  await seedSearchRebuild(db)
  expect(
    await rows('SELECT count(*) AS n FROM search_index_workspace_rebuilds'),
  ).toEqual([{ n: 50 }])
  const checkpoint = (await rows('SELECT cursor FROM search_index_rebuilds'))[0]
    .cursor
  await run(
    "UPDATE search_index_workspace_rebuilds SET completed=1 WHERE workspace_id='seed-001'",
  )
  // Crash after durable workspace writes but before advancing the cursor.
  await run("UPDATE search_index_rebuilds SET cursor=''")
  await seedSearchRebuild(db)
  expect(
    (await rows('SELECT cursor FROM search_index_rebuilds'))[0].cursor,
  ).toBe(checkpoint)
  expect(
    await rows(
      "SELECT completed FROM search_index_workspace_rebuilds WHERE workspace_id='seed-001'",
    ),
  ).toEqual([{ completed: 1 }])
  for (let i = 0; i < 5; i++) await seedSearchRebuild(db)
  expect(
    await rows(
      "SELECT target FROM search_index_workspace_rebuilds WHERE workspace_id='deleted-legacy'",
    ),
  ).toEqual([{ target: INDEX_FORMAT_VERSION }])
  expect(await rows('SELECT phase FROM search_index_rebuilds')).toEqual([
    { phase: 'done' },
  ])
  await run('DELETE FROM search_index_ready')
  await seedSearchRebuild(db)
  expect(await rows('SELECT * FROM search_index_ready')).toEqual([])
  await run(
    `INSERT INTO search_index_rebuilds(target) VALUES(${INDEX_FORMAT_VERSION + 1})`,
  )
  expect(await seedSearchRebuild(db)).toBe(false)
  await invoke('runtime')
  expect(await invoke('runtime', 'nextAlarm')).toBeNull()
  expect(
    await rows(
      `SELECT phase,cursor FROM search_index_rebuilds WHERE target=${INDEX_FORMAT_VERSION + 1}`,
    ),
  ).toEqual([{ phase: 'live', cursor: '' }])
  expect(await seedSearchRebuild(db, INDEX_FORMAT_VERSION + 1)).toBe(true)
  expect(
    await rows(
      `SELECT count(*) AS n FROM search_index_workspace_rebuilds WHERE target=${INDEX_FORMAT_VERSION + 1}`,
    ),
  ).toEqual([{ n: 50 }])
})

test('a next-format Worker resumes the migration target and rollback leaves newer obligations untouched', async () => {
  const require = createRequire(import.meta.url)
  const { build } = require(
    require.resolve('esbuild', { paths: [require.resolve('wrangler')] }),
  ) as { build(options: Record<string, unknown>): Promise<unknown> }
  const nextMain = join(directory, 'next-format.mjs')
  // Compile the actual implementation with precisely the format increment a future change ships.
  await build({
    entryPoints: [config.main],
    outfile: nextMain,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    tsconfig: join(root, 'tsconfig.json'),
    external: ['cloudflare:workers'],
    plugins: [
      {
        name: 'next-index-format',
        setup(builder: {
          onLoad(
            options: { filter: RegExp },
            callback: (args: {
              path: string
            }) => Promise<{ contents: string; loader: 'ts' }>,
          ): void
        }) {
          builder.onLoad(
            { filter: /search-index\/normalize\.ts$/ },
            async ({ path }) => ({
              contents: (await readFile(path, 'utf8')).replace(
                `INDEX_FORMAT_VERSION = ${INDEX_FORMAT_VERSION}`,
                `INDEX_FORMAT_VERSION = ${INDEX_FORMAT_VERSION + 1}`,
              ),
              loader: 'ts',
            }),
          )
        },
      },
    ],
  })
  const reload = async (main: string) => {
    await db.destroy()
    await writeFile(configPath, JSON.stringify({ ...config, main }))
    await server.update({ root, workers: [{ configPath }] })
    binding = (await worker.getEnv()).DB
    db = new Kysely<DB>({
      dialect: new D1Dialect({ database: binding }),
      plugins: [d1CompatibilityPlugin],
    })
  }
  await reload(nextMain)
  for (let i = 0; i < 5; i++)
    await seedSearchRebuild(db, INDEX_FORMAT_VERSION + 1)
  await invoke('rebuild')
  const index = await storage('rebuild')
  expect((await index.exec('SELECT target FROM rebuild'))[0].target).toBe(
    INDEX_FORMAT_VERSION + 1,
  )
  await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
    name: 'rebuild:0@apac-ne',
  })
  await settle('rebuild')
  expect(await index.exec('SELECT DISTINCT format FROM active')).toEqual([
    { format: INDEX_FORMAT_VERSION + 1 },
  ])
  expect(
    await rows(
      "SELECT target,completed FROM search_index_workspace_rebuilds WHERE workspace_id='rebuild'",
    ),
  ).toEqual([{ target: INDEX_FORMAT_VERSION + 1, completed: 1 }])
  await run(
    "UPDATE shareables SET name='rollbackneedle' WHERE id='rebuild-001'",
  )
  const pending = await rows(
    "SELECT id FROM search_index_changes WHERE workspace_id='rebuild'",
  )
  await reload(config.main)
  await invoke('rebuild')
  expect(
    await rows(
      "SELECT id FROM search_index_changes WHERE workspace_id='rebuild'",
    ),
  ).toEqual(pending)
  expect(await invoke('rebuild', 'nextAlarm')).toBeNull()
  expect(await seedSearchRebuild(db)).toBe(false)
  await reload(nextMain)
  await invoke('rebuild')
  await settle('rebuild')
  expect(
    (await invoke('rebuild', 'search', 'rollbackneedle')).items.map(
      (row) => row.id,
    ),
  ).toEqual(['rebuild-001'])
})

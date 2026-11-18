import type { SearchProbeDocument } from './search-index-probe'
import type {
  IndexSearchInput,
  IndexPage,
  IndexSearchResult,
} from '../app/services/search-index/query'
import { searchTextKey } from '../app/services/search-index/keys'
import {
  normalizeSearchText,
  INDEX_FORMAT_VERSION,
  BM25_WEIGHTS,
  COLUMN_BYTES,
} from '../app/services/search-index/normalize'
import { integrationWorkerConfig } from '../app/test/integration-worker-config'
import { http, HttpResponse } from 'msw/http'
import { passthrough } from 'msw/utils/passthrough'
import { integrationUnhandledFrame } from '../app/test/worker-network-policy'
import { setupServer } from 'msw/node'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { LINK_ABUSE_TEXT_LIMIT } from '../app/services/link-abuse-judgment/extract'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import Stripe from 'stripe'
import {
  partitionMigrationNames,
  rebuildBaselineUrl,
} from '../db/rebuild-baseline.mjs'

mkdirSync(new URL('../../.wrangler/integration-logs', import.meta.url), {
  recursive: true,
})
process.env.WRANGLER_LOG_PATH = new URL(
  '../../.wrangler/integration-logs',
  import.meta.url,
).pathname
const { createTestHarness, unstable_readConfig, unstable_splitSqlQuery } =
  await import('wrangler')

const BETTER_AUTH_SECRET = 'integration-test-only-'.repeat(3)
const STRIPE_SECRET_KEY = ['sk', 'test', 'integration'].join('_')
const STRIPE_WEBHOOK_SECRET = ['whsec', 'integration'].join('_')
const productionConfigUrl = new URL(
  '../build/server/wrangler.json',
  import.meta.url,
)
const integrationConfigUrl = new URL(
  '../build/server/wrangler.integration.json',
  import.meta.url,
)
const productionConfig = JSON.parse(
  await readFile(productionConfigUrl, 'utf8'),
) as Record<string, unknown> & {
  send_email?: Array<Record<string, unknown>>
}
if (!productionConfig.send_email?.length) {
  throw new Error('Production Worker config is missing the EMAIL binding')
}
const publicIntegration = process.env.PUBLIC_INTEGRATION === '1'
const runtimeConfig = unstable_readConfig(
  {
    config: new URL(
      publicIntegration ? '../wrangler.jsonc' : '../wrangler.production.jsonc',
      import.meta.url,
    ).pathname,
  },
  { hideWarnings: true },
)
const integrationConfig = integrationWorkerConfig(productionConfig, {
  ...runtimeConfig,
})
// Only the test bundle substitutes a subclass with deterministic storage gates.
// It extends the compiled production class, so every assertion exercises the deployed code.
const require = createRequire(import.meta.url)
const { build } = require(
  require.resolve('esbuild', { paths: [require.resolve('wrangler')] }),
) as typeof import('esbuild')
await build({
  entryPoints: [new URL('./search-index-probe.ts', import.meta.url).pathname],
  outfile: new URL('../build/server/search-index-probe.js', import.meta.url)
    .pathname,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'node',
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  external: ['cloudflare:workers'],
  plugins: [
    {
      name: 'production-search-class',
      setup(builder) {
        builder.onResolve(
          { filter: /workers\/(workspace-search-index|app)$/ },
          () => ({ path: './index.js', external: true }),
        )
      },
    },
  ],
})
await writeFile(
  new URL('../build/server/search-index-entry.js', import.meta.url),
  `export * from './index.js'; export { default, WorkspaceSearchIndex } from './search-index-probe.js';`,
)
integrationConfig.main = 'search-index-entry.js'
await writeFile(integrationConfigUrl, JSON.stringify(integrationConfig))
const sandboxName = unstable_readConfig(
  {
    config: new URL('../wrangler.sandbox.jsonc', import.meta.url).pathname,
    ...(publicIntegration ? {} : { env: 'production' }),
  },
  { hideWarnings: true },
).name
if (!sandboxName) throw new Error('Sandbox Worker config is missing its name')
const harness = createTestHarness({
  root: new URL('..', import.meta.url).pathname,
  workers: [
    {
      configPath: 'build/server/wrangler.integration.json',
      vars: {
        APP_ENV: 'development',
        INTEGRATION_TEST: 'true',
        BETTER_AUTH_URL: 'http://localhost',
        DEFAULT_LOCALE: 'en',
        D1_BACKUP_ACCOUNT_ID: 'test-account',
        D1_BACKUP_DATABASE_ID: 'test-database',
      },
      secrets: {
        BETTER_AUTH_SECRET,
        D1_REST_API_TOKEN: 'test-token',
        STRIPE_SECRET_KEY,
        STRIPE_WEBHOOK_SECRET,
      },
    },
    {
      configPath: 'wrangler.og-image.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
    },
    {
      configPath: 'wrangler.alerts.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
    },
    {
      configPath: 'wrangler.sandbox.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
      vars: { APP_ENV: 'development' },
      secrets: { BETTER_AUTH_SECRET },
    },
  ],
})
const network = setupServer()
if (typeof integrationConfig.name !== 'string')
  throw new Error('Main Worker config is missing its name')
const worker = harness.getWorker(integrationConfig.name)
const sandboxWorker = harness.getWorker(sandboxName)

function searchProbe(workspace: string) {
  const call = async (
    action: string,
    point?: string,
    after?: number,
    now?: number,
    payload?: {
      input?: IndexSearchInput
      ids?: string[]
      documents?: SearchProbeDocument[]
    },
  ) => {
    const response = await worker.fetch('/__test/search-index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace,
        action,
        point,
        after,
        now,
        ...payload,
      }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }
  return {
    queryState: (): Promise<{ changes: number; constructorChanges: number }> =>
      call('queryState'),
    seedDocuments: (documents: SearchProbeDocument[]) =>
      call('seedDocuments', undefined, undefined, undefined, { documents }),
    searchResult: (input: IndexSearchInput): Promise<IndexSearchResult> =>
      call('search', undefined, undefined, undefined, { input }),
    search: async (input: IndexSearchInput): Promise<IndexPage> => {
      const result: IndexSearchResult = await call(
        'search',
        undefined,
        undefined,
        undefined,
        { input },
      )
      if ('error' in result) throw new Error(result.error.code)
      return result
    },
    groupMembers: (
      input: IndexSearchInput,
      ids: string[],
    ): Promise<IndexPage> =>
      call('groupMembers', undefined, undefined, undefined, { input, ids }),
    details: (
      input: IndexSearchInput,
      ids: string[],
    ): Promise<
      Array<{
        id: string
        path: string
        excerpt: string
        hasBody: boolean
        matchedKeywords: string[]
      }>
    > => call('details', undefined, undefined, undefined, { input, ids }),
    detailsSearches: (
      input: IndexSearchInput,
      ids: string[],
    ): Promise<{ rows: unknown[]; searches: number }> =>
      call('detailsSearches', undefined, undefined, undefined, { input, ids }),
    sync: (_workspace?: string) => call('sync'),
    attemptSync: (_workspace?: string) => call('attemptSync'),
    resume: () => call('resume'),
    pause: (point: string) => call('pause', point),
    reached: (point: string) => call('reached', point),
    release: (point: string) => call('release', point),
    fail: (point: string, after?: number) => call('fail', point, after),
    resumeAt: (now: number) => call('resumeAt', undefined, undefined, now),
    nextAlarm: () => call('nextAlarm'),
    listCount: () => call('listCount'),
  }
}

function sessionCookie(token: string): string {
  const signature = createHmac('sha256', BETTER_AUTH_SECRET)
    .update(token)
    .digest('base64')
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

function cachedSessionCookies(args: {
  token: string
  userId: string
  email: string
  name: string
  workspaceId: string
}): string {
  const session = {
    session: {
      id: `session-${args.userId}`,
      token: args.token,
      userId: args.userId,
      expiresAt: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
    },
    user: {
      id: args.userId,
      email: args.email,
      emailVerified: true,
      name: args.name,
      image: null,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      workspaceId: args.workspaceId,
      locale: null,
    },
    updatedAt: Date.parse('2026-07-30T00:00:00.000Z'),
    version: '1',
  }
  const expiresAt = Date.now() + 5 * 60_000
  const signature = createHmac('sha256', BETTER_AUTH_SECRET)
    .update(JSON.stringify({ ...session, expiresAt }))
    .digest('base64url')
  const data = Buffer.from(
    JSON.stringify({ session, expiresAt, signature }),
  ).toString('base64url')
  return `${sessionCookie(args.token)}; better-auth.session_data=${data}`
}

async function seedRuntimeUser(args: {
  workspaceId: string
  userId: string
  email: string
  name: string
  sessionToken: string
}) {
  const env = await worker.getEnv()
  const now = '2026-07-30T00:00:00.000Z'
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        self_upload_enabled, storage_used_bytes, storage_updated_at
      ) VALUES (?, NULL, ?, ?, 'free', 104857600, 1, 0, ?)`,
    ).bind(args.workspaceId, `${args.name} workspace`, now, now),
    env.DB.prepare(
      `INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at, workspace_id
      ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(args.userId, args.email, args.name, now, now, args.workspaceId),
    env.DB.prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, 'owner', 'active', ?, ?)`,
    ).bind(args.workspaceId, args.userId, now, now),
    env.DB.prepare(
      `INSERT INTO sessions (
        id, user_id, token, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(`session-${args.userId}`, args.userId, args.sessionToken, now, now),
  ])
}

async function applyProductionD1Schema() {
  const env = await worker.getEnv()
  const baseline = await readFile(rebuildBaselineUrl, 'utf8')
  await env.DB.batch(
    unstable_splitSqlQuery(baseline).map((sql) => env.DB.prepare(sql)),
  )
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,
  ).run()
  const { baselineAndEarlier: migrationNames } = partitionMigrationNames(
    await readdir(new URL('../db/migrations', import.meta.url)),
  )
  await env.DB.batch(
    migrationNames.map((name) =>
      env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name),
    ),
  )
  await worker.applyD1Migrations('DB')
}

function sandboxUrlFromHtml(html: string, shareableId: string): URL {
  const escaped = new RegExp(
    `https://a-${shareableId}--v-[a-f0-9]+\\.usercontent\\.localhost:5174/(?:\\\\.|[^"'\\s<])*`,
  ).exec(html)?.[0]
  if (!escaped) throw new Error('Viewer response did not include sandbox URL')
  const decoded = JSON.parse(`"${escaped.replaceAll('&amp;', '&')}"`) as string
  return new URL(decoded)
}

function waitForPresence(
  socket: WebSocket,
  expectedUserIds: string[],
): Promise<void> {
  const expected = [...expectedUserIds].sort().join(',')
  return waitForLiveMessage(socket, (message) => {
    const users = message.users as Array<{ id: string }> | undefined
    return (
      message.type === 'presence' &&
      users
        ?.map((user) => user.id)
        .sort()
        .join(',') === expected
    )
  }).then(() => undefined)
}

function waitForLiveMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (!predicate(message)) return
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      resolve(message)
    }
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error('Timed out waiting for live message'))
    }, timeoutMs)
    socket.addEventListener('message', onMessage)
  })
}

function installTailHandler() {
  network.use(
    http.get(
      'https://tail.developers.workers.dev/:id',
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get(/\/cdn-cgi\/platform-proxy$/, () => passthrough()),
  )
}

beforeAll(async () => {
  network.listen({
    onUnhandledFrame: integrationUnhandledFrame,
  })
  await harness.listen()
})

beforeEach(async () => {
  installTailHandler()
  await applyProductionD1Schema()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    await harness.debug()
    console.error(JSON.stringify(harness.getLogs(), null, 2))
  }
  await harness.reset()
  network.resetHandlers()
})

afterAll(async () => {
  network.close()
  await harness.close()
})

describe('Worker integration harness', () => {
  test('CLI search adapter uses the production body index and excludes forbidden matching siblings', async () => {
    await seedRuntimeUser({
      workspaceId: 'ws-search-list',
      userId: 'search-reader',
      email: 'reader@example.test',
      name: 'Reader',
      sessionToken: 'search-session',
    })
    const env = await worker.getEnv()
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifact_containers(id,workspace_id,kind,name,created_by_id,created_at,updated_at) VALUES('search-project','ws-search-list','project','Project','search-reader',?,?)",
      ).bind(now, now),
      ...['search0001', 'search0002', 'search0003'].map((id, index) =>
        env.DB.prepare(
          "INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at) VALUES(?,'ws-search-list','search-reader','Report','html_page',?,'search-project',?,?,?)",
        ).bind(id, index === 2 ? 'private' : 'workspace', now, now, now),
      ),
    ])
    await searchProbe('ws-search-list').seedDocuments(
      ['search0001', 'search0002', 'search0003'].map((id) => ({
        id,
        title: 'Report',
        chunks: [{ body: 'bodyneedle appears only in the document body' }],
        activityAt: now,
      })),
    )
    const response = await worker.fetch('/__test/search-index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'listSearch',
        workspace: 'ws-search-list',
      }),
    })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      kind: 'ok',
      data: {
        artifacts: [
          {
            excerpt: expect.stringContaining('bodyneedle'),
            group_size: 2,
            group_size_relation: 'eq',
          },
        ],
        total: { value: 1, relation: 'eq' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('search0003')
  })

  test('workspace search indexes external posting in the project workspace within one minute', async () => {
    const poster = {
      workspaceId: 'ws-poster',
      userId: 'poster-user',
      email: 'poster@example.test',
      name: 'Poster',
      sessionToken: 'poster-session',
    }
    const owner = {
      workspaceId: 'ws-project',
      userId: 'project-user',
      email: 'project@example.test',
      name: 'Project',
      sessionToken: 'project-session',
    }
    await seedRuntimeUser(poster)
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workspaces SET plan='plus', external_posting_enabled=1 WHERE id='ws-project'",
      ),
      env.DB.prepare(
        "INSERT INTO artifact_containers (id,workspace_id,kind,created_by_id,name,created_at,updated_at) VALUES ('external-project','ws-project','project','project-user','Project',?,?)",
      ).bind(now, now),
      env.DB.prepare(
        "INSERT INTO project_share_defaults (id,project_container_id,email,role,created_at,updated_at) VALUES ('external-grant','external-project','poster@example.test','contributor',?,?)",
      ).bind(now, now),
    ])
    const boundary = 'external-posting'
    const form = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="external.html"',
      'Content-Type: text/html',
      '',
      '<p>externalindexedbody</p>',
      `--${boundary}`,
      'Content-Disposition: form-data; name="container_id"',
      '',
      'external-project',
      `--${boundary}`,
      'Content-Disposition: form-data; name="visibility"',
      '',
      'private',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const started = Date.now()
    const response = await worker.fetch('/api/shareables/uploads', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(poster.sessionToken),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: form,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = (await response.json()) as { id: string; versionId: string }
    const destination = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-project:0' },
    )
    await vi.waitFor(
      async () => {
        expect(
          await destination.exec(
            "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : externalindexedbody' AND c.shareable=?",
            result.id,
          ),
        ).toEqual([{ version: result.versionId }])
      },
      { timeout: 55_000, interval: 100 },
    )
    expect(Date.now() - started).toBeLessThan(60_000)
    const source = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-poster:0' },
    )
    expect(await source.exec('SELECT * FROM active')).toEqual([])
  }, 60_000)

  test.each(['registry', 'idle'] as const)(
    'workspace search preserves a signal received during the %s await',
    async (point) => {
      const owner = {
        workspaceId: 'ws-signal',
        userId: 'signal-user',
        email: 'signal@example.test',
        name: 'Signal',
        sessionToken: 'signal-session',
      }
      await seedRuntimeUser(owner)
      const env = await worker.getEnv()
      const stub = searchProbe('ws-signal')
      await stub.sync('ws-signal')
      expect(await stub.nextAlarm()).toBeGreaterThan(Date.now() + 60_000)
      // The registry is written when a full pass starts, so make one due.
      if (point === 'registry')
        await (
          await worker.getDurableObjectStorage('WORKSPACE_SEARCH_INDEX', {
            name: 'ws-signal:0',
          })
        ).exec('UPDATE state SET scanned_at=0')
      await stub.pause(point)
      const running = stub.resume()
      try {
        await vi.waitFor(
          async () => expect(await stub.reached(point)).toBe(true),
          { timeout: 5000, interval: 20 },
        )
        const now = new Date().toISOString()
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('signal-inbox','ws-signal','inbox','signal-user','signal-user','Inbox',?,?)",
          ).bind(now, now),
          env.DB.prepare(
            "INSERT INTO shareables (id,workspace_id,owner_user_id,name,description,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES ('signal-file','ws-signal','signal-user','Signal','signalbody','signal-inbox','pdf','private','signal-version',?,?)",
          ).bind(now, now),
          env.DB.prepare(
            "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES ('signal-version','signal-file','pdf','published','/file.pdf','artifacts/signal',1,'sha','signal-user',?)",
          ).bind(now),
        ])
        await stub.sync('ws-signal')
      } finally {
        await stub.release(point)
        await running
      }
      expect(await stub.nextAlarm()).toBeLessThan(Date.now() + 60_000)
      const index = await worker.getDurableObjectStorage(
        'WORKSPACE_SEARCH_INDEX',
        { name: 'ws-signal:0' },
      )
      await vi.waitFor(
        async () => {
          expect(
            await index.exec(
              "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'signalbody'",
            ),
          ).toEqual([{ version: 'signal-version' }])
        },
        { timeout: 55_000, interval: 100 },
      )
    },
    60_000,
  )

  test.each(['delete', 'move'] as const)(
    'workspace search does not resurrect text after %s during an R2 write and retries failed cleanup after eviction',
    async (operation) => {
      const owner = {
        workspaceId: 'ws-race',
        userId: 'race-user',
        email: 'race@example.test',
        name: 'Race',
        sessionToken: 'race-session',
      }
      const destination = {
        workspaceId: 'ws-race-destination',
        userId: 'destination-user',
        email: 'destination@example.test',
        name: 'Destination',
        sessionToken: 'destination-session',
      }
      await seedRuntimeUser(owner)
      await seedRuntimeUser(destination)
      const env = await worker.getEnv()
      const now = new Date().toISOString()
      await env.DB.prepare(
        "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('race-inbox','ws-race','inbox','race-user','race-user','Inbox',?,?)",
      )
        .bind(now, now)
        .run()
      for (const id of ['changing', 'healthy']) {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,'ws-race','race-user',?,'race-inbox','html_page','private',?,?,?)",
          ).bind(id, id, `v-${id}`, now, now),
          env.DB.prepare(
            "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'html_page','published','/index.html',?,100,'sha','race-user',?)",
          ).bind(`v-${id}`, id, `artifacts/race/${id}`, now),
        ])
        await env.BUCKET.put(`artifacts/race/${id}`, `<p>${id}control</p>`)
      }
      const stub = searchProbe('ws-race')
      await stub.sync('ws-race')
      const index = await worker.getDurableObjectStorage(
        'WORKSPACE_SEARCH_INDEX',
        { name: 'ws-race:0' },
      )
      expect(await index.exec('SELECT count(*) AS count FROM active')).toEqual([
        { count: 2 },
      ])
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES ('race-next','changing','html_page','published','/index.html','artifacts/race/next',100,'next','race-user',?)",
        ).bind(now),
        env.DB.prepare(
          "UPDATE shareables SET current_version_id='race-next' WHERE id='changing'",
        ),
      ])
      await env.BUCKET.put('artifacts/race/next', '<p>interruptedbody</p>')
      // Force more than one cleanup page, including superseded and abandoned keys.
      for (let i = 0; i < 105; i++)
        await env.BUCKET.put(
          `search-text/ws-race/changing/abandoned-${i}/index.html`,
          'staged',
        )
      await stub.pause('put')
      const running = stub.attemptSync('ws-race')
      let removedAt = 0
      try {
        await vi.waitFor(
          async () => expect(await stub.reached('put')).toBe(true),
          { timeout: 5000, interval: 20 },
        )
        expect(
          await index.exec(
            "SELECT DISTINCT version FROM serving_chunks WHERE shareable='changing'",
          ),
        ).toEqual([{ version: 'v-changing' }])
        removedAt = Date.now()
        if (operation === 'delete')
          await env.DB.prepare(
            "DELETE FROM shareables WHERE id='changing'",
          ).run()
        else
          await env.DB.prepare(
            "UPDATE shareables SET workspace_id='ws-race-destination' WHERE id='changing'",
          ).run()
        // Keep the failed prefix durable until the explicit eviction below.
        await stub.fail('cleanup', 1)
      } finally {
        await stub.release('put')
        await running
      }
      expect(await running).toEqual({ error: 'injected_cleanup_failure' })
      expect(
        await index.exec("SELECT id FROM cleanup WHERE id='changing'"),
      ).toEqual([{ id: 'changing' }])
      expect(
        await index.exec(
          "SELECT * FROM serving_chunks WHERE shareable='changing'",
        ),
      ).toEqual([])
      expect(
        await index.exec("SELECT cursor FROM cleanup WHERE id='changing'"),
      ).toEqual([{ cursor: expect.any(String) }])
      await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
        name: 'ws-race:0',
      })
      const recoveredAt = removedAt + 23 * 60 * 60_000
      await stub.resumeAt(recoveredAt)
      await vi.waitFor(
        async () => {
          expect(
            await index.exec(
              "SELECT * FROM documents WHERE shareable='changing'",
            ),
          ).toEqual([])
          let cursor: string | undefined
          const keys: string[] = []
          do {
            const page = await env.BUCKET.list({
              prefix: 'search-text/ws-race/changing/',
              limit: 25,
              cursor,
            })
            keys.push(
              ...page.objects.map((object: { key: string }) => object.key),
            )
            cursor = page.truncated ? page.cursor : undefined
          } while (cursor)
          expect(keys).toEqual([])
        },
        { timeout: 5000, interval: 50 },
      )
      expect(recoveredAt - removedAt).toBeLessThan(24 * 60 * 60_000)
      expect(
        await index.exec(
          "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'healthycontrol'",
        ),
      ).toEqual([{ shareable: 'healthy' }])
      expect(await env.BUCKET.head('artifacts/race/next')).not.toBeNull()
      expect(await env.BUCKET.head('artifacts/race/changing')).not.toBeNull()
      if (operation === 'move') {
        await env.WORKSPACE_SEARCH_INDEX.getByName(
          'ws-race-destination:0',
        ).sync('ws-race-destination')
        const moved = await worker.getDurableObjectStorage(
          'WORKSPACE_SEARCH_INDEX',
          { name: 'ws-race-destination:0' },
        )
        expect(
          await moved.exec(
            "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'interruptedbody'",
          ),
        ).toEqual([{ version: 'race-next' }])
        expect(
          await env.BUCKET.head(
            await searchTextKey(
              'ws-race-destination',
              'changing',
              'race-next',
              '/index.html',
            ),
          ),
        ).not.toBeNull()
      }
    },
    60_000,
  )

  test('a recorded location adds a placed index that reuses extracted text', async () => {
    const owner = {
      workspaceId: 'ws-placed',
      userId: 'user-placed',
      email: 'placed@example.test',
      name: 'Placed',
      sessionToken: 'placed-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('placed-inbox',?,'inbox',?,?,'Inbox',?,?)",
      ).bind(owner.workspaceId, owner.userId, owner.userId, now, now),
      env.DB.prepare(
        "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES ('placed-page',?,?,'Placed','placed-inbox','html_page','private','v-placed-page',?,?)",
      ).bind(owner.workspaceId, owner.userId, now, now),
      env.DB.prepare(
        "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES ('v-placed-page','placed-page','html_page','published','/index.html','artifacts/placed/page',100,'sha',?,?)",
      ).bind(owner.userId, now),
    ])
    await env.BUCKET.put('artifacts/placed/page', '<p>placedneedle</p>')
    // Without a location only the legacy index is synced.
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    const legacy = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-placed:0' },
    )
    expect(await legacy.exec('SELECT count(*) AS count FROM active')).toEqual([
      { count: 1 },
    ])
    // The placed index must take the text the legacy index extracted: the
    // source is gone, so extracting again would fail.
    await env.BUCKET.delete('artifacts/placed/page')
    await env.DB.prepare(
      "UPDATE search_index_workspaces SET location_hint='apac-ne', dispatched_at='' WHERE workspace_id=?",
    )
      .bind(owner.workspaceId)
      .run()
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    const placed = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-placed:0@apac-ne' },
    )
    expect(
      await placed.exec(
        'SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
        'placedneedle',
      ),
    ).toEqual([{ shareable: 'placed-page' }])
    // The placed index keeps its own copy, apart from the legacy area.
    expect(
      (await env.BUCKET.list({ prefix: 'search-text/@apac-ne/ws-placed/' }))
        .objects.length,
    ).toBe(1)
    expect(
      (await env.BUCKET.list({ prefix: 'search-text/ws-placed/' })).objects
        .length,
    ).toBe(1)
    // The name check accepts only this workspace's own names.
    const syncNamed = async (name: string, location?: string) => {
      const response = await worker.fetch('/__test/search-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: 'ws-placed',
          action: 'syncNamed',
          name,
          location,
        }),
      })
      return response.json()
    }
    expect(await syncNamed('ws-placed:0@apac-ne', 'apac-ne')).toBe('ok')
    expect(await syncNamed('ws-placed:0@apac-ne', 'weur')).toBe(
      'search_partition_mismatch',
    )
    expect(await syncNamed('ws-placed:0@apac-ne')).toBe(
      'search_partition_mismatch',
    )
    expect(await syncNamed('ws-placed:0@apac-ne', 'mars')).toBe(
      'search_partition_mismatch',
    )
  }, 60_000)

  test('a placed index reports ready after its first pass, past items that keep failing', async () => {
    const owner = {
      workspaceId: 'ws-ready',
      userId: 'user-ready',
      email: 'ready@example.test',
      name: 'Ready',
      sessionToken: 'ready-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('ready-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    for (const id of ['ready-good', 'ready-missing'])
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'ready-inbox','html_page','private',?,?,?)",
        ).bind(id, owner.workspaceId, owner.userId, id, `v-${id}`, now, now),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'html_page','published','/index.html',?,100,'sha',?,?)",
        ).bind(`v-${id}`, id, `artifacts/ready/${id}`, owner.userId, now),
      ])
    // Only the good page has a source; the other fails on every attempt.
    await env.BUCKET.put('artifacts/ready/ready-good', '<p>readyneedle</p>')
    await env.DB.prepare(
      "INSERT INTO search_index_workspaces(workspace_id,dispatched_at,location_hint) VALUES(?,'','apac-ne')",
    )
      .bind(owner.workspaceId)
      .run()
    const readyAt = async () =>
      (
        await env.DB.prepare(
          'SELECT ready_at FROM search_index_workspaces WHERE workspace_id=?',
        )
          .bind(owner.workspaceId)
          .first<{ ready_at: string | null }>()
      )?.ready_at ?? null
    const placed = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-ready:0@apac-ne' },
    )
    const failures = async () =>
      (
        await placed.exec(
          "SELECT failures FROM pending WHERE id='ready-missing'",
        )
      )[0]?.failures
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(await failures()).toBe(1)
    // A retry within five minutes of the last counted failure is not counted.
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(await failures()).toBe(1)
    expect(await readyAt()).toBeNull()
    // Make the last failure older than the spacing before each later run.
    const age = () =>
      placed.exec(
        "UPDATE pending SET failed_at=0, first_failed_at=1 WHERE id='ready-missing'",
      )
    await age()
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(await failures()).toBe(2)
    expect(await readyAt()).toBeNull()
    await age()
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(await failures()).toBe(3)
    expect(await readyAt()).not.toBeNull()
    // The legacy index never reports readiness.
    const legacy = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-ready:0' },
    )
    expect(
      await legacy.exec('SELECT count(*) AS count FROM placement'),
    ).toEqual([{ count: 0 }])
    // A later sync keeps the report.
    const first = await readyAt()
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(await readyAt()).toBe(first)
  }, 60_000)

  test('a placed index is not reported ready while failures are under an hour old', async () => {
    const owner = {
      workspaceId: 'ws-unready',
      userId: 'user-unready',
      email: 'unready@example.test',
      name: 'Unready',
      sessionToken: 'unready-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('unready-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    // One page indexes; three fail, as during an outage.
    const ids = ['unready-good', 'unready-a', 'unready-b', 'unready-c']
    for (const id of ids)
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'unready-inbox','html_page','private',?,?,?)",
        ).bind(id, owner.workspaceId, owner.userId, id, `v-${id}`, now, now),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'html_page','published','/index.html',?,100,'sha',?,?)",
        ).bind(`v-${id}`, id, `artifacts/unready/${id}`, owner.userId, now),
      ])
    await env.BUCKET.put('artifacts/unready/unready-good', '<p>good</p>')
    await env.DB.prepare(
      "INSERT INTO search_index_workspaces(workspace_id,dispatched_at,location_hint) VALUES(?,'','apac-ne')",
    )
      .bind(owner.workspaceId)
      .run()
    const placed = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-unready:0@apac-ne' },
    )
    // Three counted failures, but the first was less than an hour ago.
    for (let run = 0; run < 3; run++) {
      await placed.exec('UPDATE pending SET failed_at=0')
      await worker.scheduled({ cron: '*/5 * * * *' })
    }
    expect(
      await placed.exec(
        'SELECT count(*) AS count FROM pending WHERE failures >= 3',
      ),
    ).toEqual([{ count: 3 }])
    expect(
      await env.DB.prepare(
        'SELECT ready_at FROM search_index_workspaces WHERE workspace_id=?',
      )
        .bind(owner.workspaceId)
        .first(),
    ).toEqual({ ready_at: null })
    // Once the failures are more than an hour old, readiness is reported.
    await placed.exec('UPDATE pending SET failed_at=0, first_failed_at=1')
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(
      await env.DB.prepare(
        'SELECT ready_at FROM search_index_workspaces WHERE workspace_id=?',
      )
        .bind(owner.workspaceId)
        .first<{ ready_at: string | null }>(),
    ).toEqual({ ready_at: expect.any(String) })
  }, 60_000)

  test('a file that keeps failing does not keep its index busy', async () => {
    const owner = {
      workspaceId: 'ws-backoff',
      userId: 'user-backoff',
      email: 'backoff@example.test',
      name: 'Backoff',
      sessionToken: 'backoff-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('backoff-inbox',?,'inbox',?,?,'Inbox',?,?)",
      ).bind(owner.workspaceId, owner.userId, owner.userId, now, now),
      env.DB.prepare(
        "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES ('backoff-missing',?,?,'Missing','backoff-inbox','html_page','private','v-backoff-missing',?,?)",
      ).bind(owner.workspaceId, owner.userId, now, now),
      env.DB.prepare(
        "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES ('v-backoff-missing','backoff-missing','html_page','published','/index.html','artifacts/backoff/missing',100,'sha',?,?)",
      ).bind(owner.userId, now),
    ])
    // The source object never exists, so every attempt fails.
    await worker.scheduled({ cron: '*/5 * * * *' })
    const probe = searchProbe(owner.workspaceId)
    // After a counted failure the index waits minutes, not a second.
    expect(await probe.nextAlarm()).toBeGreaterThan(Date.now() + 60_000)
    // Once the source is back, the next sync request retries at once.
    await env.BUCKET.put('artifacts/backoff/missing', '<p>backoffneedle</p>')
    await worker.scheduled({ cron: '*/5 * * * *' })
    expect(
      (await probe.search({ query: 'backoffneedle' })).items.map(
        (row) => row.id,
      ),
    ).toEqual(['backoff-missing'])
  }, 60_000)

  test('an idle index reads only changed rows and sleeps until its next full pass', async () => {
    const owner = {
      workspaceId: 'ws-idle',
      userId: 'user-idle',
      email: 'idle@example.test',
      name: 'Idle',
      sessionToken: 'idle-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    // Written an hour ago, well before the change mark the first pass sets.
    const now = new Date(Date.now() - 60 * 60_000).toISOString()
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('idle-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    // More rows than one pass step, so the first pass takes several steps.
    for (let n = 0; n < 60; n++) {
      const id = `idle-${String(n).padStart(2, '0')}`
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'idle-inbox','pdf','private',?,?,?)",
        ).bind(id, owner.workspaceId, owner.userId, id, `v-${id}`, now, now),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'pdf','published','/file.pdf',?,1,'sha',?,?)",
        ).bind(`v-${id}`, id, `artifacts/idle/${id}`, owner.userId, now),
      ])
    }
    const probe = searchProbe(owner.workspaceId)
    await probe.sync()
    for (let step = 0; step < 50; step++) {
      if ((await probe.nextAlarm())! > Date.now() + 60_000) break
      await probe.resume()
    }
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-idle:0' },
    )
    expect(await index.exec('SELECT count(*) AS count FROM active')).toEqual([
      { count: 60 },
    ])
    // Once the first pass is done, the index sleeps until the next one.
    expect(await probe.nextAlarm()).toBeGreaterThan(
      Date.now() + 11 * 60 * 60_000,
    )
    // A notification with nothing changed neither restarts a full pass nor
    // keeps the index awake.
    const before = await probe.queryState()
    await probe.sync()
    // The writes are the state row (notification, flag, change mark) and the
    // three alarm settings.
    expect(
      (await probe.queryState()).changes - before.changes,
    ).toBeLessThanOrEqual(6)
    expect(
      await index.exec('SELECT cursor, sweep, recent_time FROM state'),
    ).toEqual([{ cursor: '', sweep: '', recent_time: '' }])
    expect(await probe.nextAlarm()).toBeGreaterThan(
      Date.now() + 11 * 60 * 60_000,
    )
    // A change written after the mark is found by the next notification.
    await env.DB.prepare(
      "UPDATE shareables SET description='idlechangedneedle',updated_at=? WHERE id='idle-42'",
    )
      .bind(new Date().toISOString())
      .run()
    await probe.sync()
    expect(
      (await probe.search({ query: 'idlechangedneedle' })).items.map(
        (row) => row.id,
      ),
    ).toEqual(['idle-42'])
    const settle = async () => {
      for (let step = 0; step < 50; step++) {
        if ((await probe.nextAlarm())! > Date.now() + 60_000) return
        await probe.resume()
      }
      throw new Error('the index did not settle')
    }
    // A notification that arrives while a walk is under way starts another
    // walk once it ends, so a write dated before the walk's position is found.
    const later = Date.now()
    for (let n = 0; n < 55; n++)
      await env.DB.prepare(
        'UPDATE shareables SET description=?,updated_at=? WHERE id=?',
      )
        .bind(
          `bulk${n}`,
          new Date(later + n).toISOString(),
          `idle-${String(n).padStart(2, '0')}`,
        )
        .run()
    await probe.sync()
    expect(
      (await index.exec('SELECT recent_time FROM state'))[0].recent_time,
    ).not.toBe('')
    await env.DB.prepare(
      "UPDATE shareables SET description='latecommitneedle',updated_at=? WHERE id='idle-58'",
    )
      .bind(new Date(later - 1000).toISOString())
      .run()
    await probe.sync()
    // The walks take longer than the five-minute overlap. The next walk still
    // reads from the mark saved when the previous walk started.
    for (let step = 1; step <= 6; step++)
      await probe.resumeAt(Date.now() + step * 10 * 60_000)
    expect(
      (await probe.search({ query: 'latecommitneedle' })).items.map(
        (row) => row.id,
      ),
    ).toEqual(['idle-58'])
    // A scan started under another index format starts again from the first
    // file, so files before its position are rebuilt too.
    await index.exec(
      "UPDATE state SET cursor='idle-20',scan_format=0,scanned_at=0",
    )
    await index.exec('UPDATE active SET format=0')
    await probe.resume()
    await settle()
    expect(
      await index.exec(
        'SELECT count(*) AS count FROM active WHERE format=?',
        INDEX_FORMAT_VERSION,
      ),
    ).toEqual([{ count: 60 }])
    // Between sweeps, files whose objects wait on a staged replacement do
    // not hold back other cleanup.
    for (let n = 0; n < 5; n++) {
      const id = `idle-0${n}`
      await index.exec(
        "INSERT INTO staging(id,generation,fingerprint,format) VALUES(?,'held','held',0)",
        id,
      )
      await index.exec(
        'INSERT INTO intentions(key,shareable) VALUES(?,?)',
        `held/${id}`,
        id,
      )
    }
    await index.exec("INSERT INTO reclaims(id) VALUES('idle-59')")
    await probe.sync()
    expect(await index.exec('SELECT * FROM reclaims')).toEqual([])
  }, 60_000)

  test('workspace search extracts all page kinds, isolates scripts and serves only complete generations', async () => {
    const owner = {
      workspaceId: 'ws-search',
      userId: 'user-search',
      email: 'search@example.test',
      name: 'Search',
      sessionToken: 'search-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('search-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    const fixtures = [
      {
        id: 'html',
        kind: 'html_page',
        path: '/index.html',
        title: 'rankingneedle',
        body:
          '<head><title>excludedhead</title><script>const x="日本語台本"</script></head><body><p>visible &amp; &#x65e5;本</p><img alt="imagealternative"><input placeholder="inputhint"><div aria-label="arialabel" title="attribute">node<span>boundary</span></div>beforeexclude<style>hiddenmiddle</style>afterexclude<svg/><svg><text title="excludedattribute">excludedsvg</text></svg><style>excludedstyle</style><noscript>excludednoscript</noscript><canvas>excludedcanvas</canvas>' +
          '<script>' +
          '('.repeat(20_000) +
          '"日本語深層"' +
          ')'.repeat(20_000) +
          '</script><script type=" Application/JSON ; charset=utf-8 ">{"props":{"label":"日本語jsonneedle"}}</script><script type="text/template">日本語templateneedle English</script><script type="module">export const label="日本語moduleneedle";</script></body>',
      },
      {
        id: 'markdown',
        kind: 'markdown_page',
        path: '/note.txt',
        title: 'Markdown',
        body: '# Heading\n\n**rankingneedle** [label](https://example.test) ![alternative](image.png)\n\n`codecontent`',
      },
      {
        id: 'pdf',
        kind: 'pdf',
        path: '/document.pdf',
        title: 'PDF',
        body: 'unparsedbytes',
      },
      {
        id: 'video',
        kind: 'video',
        path: '/movie.mp4',
        title: 'Video',
        body: 'unparsedbytes',
      },
      {
        id: 'site',
        kind: 'static_site',
        path: '/index.md',
        title: 'Site',
        body: '# Main markdown',
      },
    ]
    for (const fixture of fixtures) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,description,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'descriptiononly','search-inbox',?,'private',?,?,?)",
        ).bind(
          fixture.id,
          owner.workspaceId,
          owner.userId,
          fixture.title,
          fixture.kind,
          `v-${fixture.id}`,
          now,
          now,
        ),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,?,'published',?,?,100,'sha',?,?)",
        ).bind(
          `v-${fixture.id}`,
          fixture.id,
          fixture.kind,
          fixture.path,
          `artifacts/search/${fixture.id}`,
          owner.userId,
          now,
        ),
      ])
      await env.BUCKET.put(`artifacts/search/${fixture.id}`, fixture.body)
    }
    const longPath = '/' + '日'.repeat(120) + '.html'
    for (const [path, body] of [
      [longPath, '<p>longpathneedle</p>'],
      [
        '/lexer.js',
        [
          'function f() {} /"/.test(value); const label = "宣言後";',
          'function g() {} /"偽陽性"/.test(value); const label2 = "正例";',
          'const ratio = count++ / 2; const label3 = "増分後";',
          'if (enabled) /"/.test(value); const label4 = "条件後";',
        ].join('\n'),
      ],
      ['/secondary.markdown', '# Secondary markdown'],
      [
        '/other.html',
        '<p>Other HTML</p><p>&#26085本 &#x65e5本 &nbsp space &notit; &bogus; &#0; &#x80;</p><img alt="&nbsp space &notit; &amp=keep &#26085本"><script>const x="日本語ページ"</script>',
      ],
      ['/local.js', 'const x="日本語外部 rankingneedle"'],
      ['/local.json', '{"a":["日本語構造"]}'],
      ['/broken.json', '{broken'],
      [
        '/deep.json',
        '['.repeat(10_000) + '"日本語deepjsonneedle"' + ']'.repeat(10_000),
      ],
    ]) {
      const key = `artifacts/search/site${path}`
      await env.BUCKET.put(key, body)
      await env.DB.prepare(
        "INSERT INTO version_files (id,version_id,path,r2_key,mime_type,size_bytes,sha256,created_at) VALUES (?,'v-site',?,?,'text/plain',100,'sha',?)",
      )
        .bind(path, path, key, now)
        .run()
    }
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-search:0' },
    )
    expect(await index.exec('SELECT count(*) AS count FROM active')).toEqual([
      { count: 5 },
    ])
    expect(
      await index.exec(
        "SELECT path FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='site' ORDER BY path",
      ),
    ).toEqual([
      { path: '/index.md' },
      { path: '/other.html' },
      { path: '/secondary.markdown' },
      { path: longPath },
    ])
    const longKey = await searchTextKey('ws-search', 'site', 'v-site', longPath)
    expect(new TextEncoder().encode(longKey).byteLength).toBeLessThan(1024)
    expect(await (await env.BUCKET.get(longKey))!.json()).toMatchObject({
      body: 'longpathneedle',
    })
    expect(
      await index.exec(
        'SELECT DISTINCT c.path FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
        'longpathneedle',
      ),
    ).toEqual([{ path: longPath }])
    const html = await env.BUCKET.get(
      await searchTextKey('ws-search', 'html', 'v-html', '/index.html'),
    )
    expect(await html!.json()).toEqual({
      format: INDEX_FORMAT_VERSION,
      body: 'visible & 日本 imagealternative inputhint attribute arialabel node boundary beforeexclude afterexclude',
      script:
        '日本語台本  日本語jsonneedle 日本語templateneedle 日本語moduleneedle',
    })
    // An unusable optional script must not prevent the page body from serving.
    expect(
      await index.exec(
        "SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : visible'",
      ),
    ).toEqual([{ shareable: 'html' }])
    for (const [needle, shareable] of [
      ['jsonneedle', 'html'],
      ['templateneedle', 'html'],
      ['moduleneedle', 'html'],
      ['deepjsonneedle', 'site'],
    ]) {
      expect(
        await index.exec(
          'SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
          `script : ${needle}`,
        ),
      ).toEqual([{ shareable }])
      expect(
        await index.exec(
          'SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
          `body : ${needle}`,
        ),
      ).toEqual([])
    }
    const md = await env.BUCKET.get(
      await searchTextKey('ws-search', 'markdown', 'v-markdown', '/note.txt'),
    )
    expect(await md!.json()).toMatchObject({
      body: expect.stringContaining(
        'Heading rankingneedle label alternative codecontent',
      ),
    })
    expect(
      await (await env.BUCKET.get(
        await searchTextKey('ws-search', 'site', 'v-site', '/other.html'),
      ))!.json(),
    ).toEqual({
      format: INDEX_FORMAT_VERSION,
      body: 'Other HTML 日本 日本 space ¬it; &bogus; � € space &notit; &amp=keep 日本',
      script: '日本語ページ',
    })
    expect(
      await (await env.BUCKET.get(
        await searchTextKey(
          'ws-search',
          'site',
          'v-site',
          '/secondary.markdown',
        ),
      ))!.json(),
    ).toMatchObject({ body: 'Secondary markdown' })
    const site = await env.BUCKET.get(
      await searchTextKey('ws-search', 'site', 'v-site', '/index.md'),
    )
    const sitePayload = await site!.json<{ body: string; script: string }>()
    expect(sitePayload).toMatchObject({
      body: 'Main markdown',
      script: expect.stringContaining('日本語外部 rankingneedle 日本語構造'),
    })
    for (const literal of ['宣言後', '正例', '増分後', '条件後'])
      expect(sitePayload.script).toContain(literal)
    expect(sitePayload.script).not.toContain('偽陽性')
    for (const id of ['pdf', 'video']) {
      const file = fixtures.find((fixture) => fixture.id === id)!
      const object = await env.BUCKET.get(
        await searchTextKey('ws-search', id, `v-${id}`, file.path),
      )
      expect(await object!.json()).toEqual({
        format: INDEX_FORMAT_VERSION,
        body: 'descriptiononly',
        script: '',
      })
    }
    const ranked = await index.exec(
      'SELECT c.shareable, bm25(search,?,?,?) AS rank FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ? ORDER BY rank',
      ...BM25_WEIGHTS,
      'rankingneedle',
    )
    expect(ranked.map((row) => row.shareable)).toEqual([
      'html',
      'markdown',
      'site',
    ])
    const extractionProbe = searchProbe('ws-search')
    const lists = await extractionProbe.listCount()
    expect(lists).toBeGreaterThan(0) // Activation still cleans abandoned versions.
    const before = await index.exec('SELECT * FROM active ORDER BY id')
    const original = await env.BUCKET.head(
      await searchTextKey('ws-search', 'html', 'v-html', '/index.html'),
    )
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    await extractionProbe.sync()
    await extractionProbe.resume() // Finish the full five-row sweep, then repeat it.
    await extractionProbe.sync()
    expect(await extractionProbe.listCount()).toBe(lists)
    expect(await index.exec('SELECT * FROM active ORDER BY id')).toEqual(before)
    expect(
      (await env.BUCKET.head(
        await searchTextKey('ws-search', 'html', 'v-html', '/index.html'),
      ))!.version,
    ).toBe(original!.version)
    const patch = await worker.fetch('/api/shareables/html', {
      method: 'PATCH',
      headers: {
        Cookie: sessionCookie(owner.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ titleOverride: 'Renamed title' }),
    })
    expect(patch.status, await patch.clone().text()).toBe(200)
    await vi.waitFor(
      async () =>
        expect(
          await index.exec(
            "SELECT normalized_title FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='html'",
          ),
        ).toEqual([{ normalized_title: 'renamed title' }]),
      { timeout: 55_000, interval: 100 },
    )
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,created_by_id,name,created_at,updated_at) VALUES ('search-project','ws-search','project','user-search','Search project',?,?)",
    )
      .bind(now, now)
      .run()
    const move = await worker.fetch('/api/cli/shareables/html/move', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(owner.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ destination: { project_id: 'search-project' } }),
    })
    expect(move.status, await move.clone().text()).toBe(200)
    await vi.waitFor(
      async () =>
        expect(
          await index.exec(
            "SELECT container FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='html'",
          ),
        ).toEqual([{ container: 'search-project' }]),
      { timeout: 55_000, interval: 100 },
    )
    const edit = await worker.fetch('/api/cli/shareables/html/edit', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(owner.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Edited title' }),
    })
    expect(edit.status, await edit.clone().text()).toBe(200)
    await vi.waitFor(
      async () =>
        expect(
          await index.exec(
            "SELECT normalized_title FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='html'",
          ),
        ).toEqual([{ normalized_title: 'edited title' }]),
      { timeout: 55_000, interval: 100 },
    )
    const beforeArchive = await index.exec(
      "SELECT generation FROM active WHERE id='html'",
    )
    for (const action of ['archive', 'unarchive']) {
      const response = await worker.fetch('/api/projects/search-project', {
        method: 'POST',
        headers: {
          Cookie: sessionCookie(owner.sessionToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      // Also reconcile explicitly: archived projects must remain in the inventory.
      await searchProbe('ws-search').sync()
      expect(
        await index.exec("SELECT generation FROM active WHERE id='html'"),
      ).toEqual(beforeArchive)
      expect(
        await index.exec(
          "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'visible' AND c.shareable='html'",
        ),
      ).toEqual([{ shareable: 'html' }])
    }
    expect(
      (await env.BUCKET.head(
        await searchTextKey('ws-search', 'html', 'v-html', '/index.html'),
      ))!.version,
    ).toBe(original!.version)
    // Description currently has no editing service; D1 is its authoritative
    // input. Like every application write, the change also moves updated_at.
    await env.DB.prepare(
      "UPDATE shareables SET description='changeddescription',updated_at=? WHERE id='pdf'",
    )
      .bind(new Date().toISOString())
      .run()
    await searchProbe('ws-search').sync()
    expect(
      await index.exec(
        "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'changeddescription'",
      ),
    ).toEqual([{ shareable: 'pdf' }])
    expect(
      await index.exec(
        "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'descriptiononly' AND c.shareable='pdf'",
      ),
    ).toEqual([])
    const tables = await index.exec(
      "SELECT sql FROM sqlite_master WHERE type='table'",
    )
    for (const table of tables)
      expect(table.sql).not.toMatch(
        /\b(visibility|grants|memberships|link_expires_at|credentials)\b/iu,
      )
    await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
      name: 'ws-search:0',
    })
    await env.DB.prepare("DELETE FROM shareables WHERE id='html'").run()
    await env.BUCKET.put(
      await searchTextKey('ws-search', 'html', 'staged', '/index.html'),
      'staged',
    )
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    // A persisted sweep can be at its last batch after eviction. The next
    // sweep, due twice a day, must discover the deletion within the 24-hour bound.
    await searchProbe('ws-search').resumeAt(
      Date.now() + 12 * 60 * 60_000 + 60_000,
    )
    expect(
      await index.exec("SELECT * FROM serving_chunks WHERE shareable='html'"),
    ).toEqual([])
    expect(
      (await env.BUCKET.list({ prefix: 'search-text/ws-search/html/' }))
        .objects,
    ).toEqual([])
    expect(await env.BUCKET.head('artifacts/search/html')).not.toBeNull()
  }, 60_000)

  test.each(['html', 'md'])(
    'workspace search indexes %s static-site creation and inherited version commits within a minute',
    async (extension) => {
      const owner = {
        workspaceId: `ws-site-${extension}`,
        userId: `site-${extension}-user`,
        email: `site-${extension}@example.test`,
        name: 'Site',
        sessionToken: `site-${extension}-session`,
      }
      await seedRuntimeUser(owner)
      const boundary = 'search-site-boundary'
      const initial = [
        [
          `index.${extension}`,
          extension === 'md' ? '# Entrypoint body' : '<h1>Entrypoint body</h1>',
        ],
        ['secondary.md', '# Secondary body'],
        ['deleted.html', '<p>Removed page</p>'],
        ['local.js', 'const a="日本語外部"'],
        ['local.json', '{"a":"日本語構造"}'],
      ]
      const form = initial
        .flatMap(([path, body]) => [
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${path}"`,
          'Content-Type: text/plain',
          '',
          body,
        ])
        .concat([
          `--${boundary}`,
          'Content-Disposition: form-data; name="visibility"',
          '',
          'private',
          `--${boundary}--`,
          '',
        ])
        .join('\r\n')
      const response = await worker.fetch(
        '/api/shareables/uploads?artifact_kind=static_site',
        {
          method: 'POST',
          headers: {
            Cookie: sessionCookie(owner.sessionToken),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: form,
        },
      )
      expect(response.status, await response.clone().text()).toBe(200)
      const created = (await response.json()) as {
        id: string
        versionId: string
      }
      const env = await worker.getEnv()
      const index = await worker.getDurableObjectStorage(
        'WORKSPACE_SEARCH_INDEX',
        { name: `${owner.workspaceId}:0` },
      )
      await vi.waitFor(
        async () => {
          expect(
            await index.exec(
              'SELECT path FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable=? ORDER BY path',
              created.id,
            ),
          ).toEqual([
            { path: '/deleted.html' },
            { path: `/index.${extension}` },
            { path: '/secondary.md' },
          ])
          expect(
            await index.exec(
              "SELECT DISTINCT c.path FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : Entrypoint' AND c.shareable=?",
              created.id,
            ),
          ).toEqual([{ path: `/index.${extension}` }])
          expect(
            await index.exec(
              "SELECT DISTINCT c.path FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : Secondary' AND c.shareable=?",
              created.id,
            ),
          ).toEqual([{ path: '/secondary.md' }])
          const object = await env.BUCKET.get(
            await searchTextKey(
              owner.workspaceId,
              created.id,
              created.versionId,
              `/index.${extension}`,
            ),
          )
          expect(await object?.json()).toMatchObject({
            body: 'Entrypoint body',
            script: expect.stringContaining('日本語外部 日本語構造'),
          })
        },
        { timeout: 55_000, interval: 100 },
      )
      const next = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="index.${extension}"`,
        'Content-Type: text/plain',
        '',
        extension === 'md' ? '# Replacement body' : '<h1>Replacement body</h1>',
        `--${boundary}--`,
        '',
      ].join('\r\n')
      const updated = await worker.fetch(
        `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}&delete_path=%2Fdeleted.html`,
        {
          method: 'POST',
          headers: {
            Cookie: sessionCookie(owner.sessionToken),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: next,
        },
      )
      expect(updated.status, await updated.clone().text()).toBe(200)
      const version = (await updated.json()) as { versionId: string }
      await vi.waitFor(
        async () => {
          expect(
            await index.exec(
              'SELECT DISTINCT version,path FROM serving_chunks WHERE shareable=? ORDER BY path',
              created.id,
            ),
          ).toEqual([
            { version: version.versionId, path: `/index.${extension}` },
            { version: version.versionId, path: '/secondary.md' },
          ])
          expect(
            await index.exec(
              "SELECT DISTINCT c.path FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : Replacement' AND c.shareable=?",
              created.id,
            ),
          ).toEqual([{ path: `/index.${extension}` }])
          expect(
            await index.exec(
              "SELECT DISTINCT c.path FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : Entrypoint' AND c.shareable=?",
              created.id,
            ),
          ).toEqual([])

          const object = await env.BUCKET.get(
            await searchTextKey(
              owner.workspaceId,
              created.id,
              version.versionId,
              `/index.${extension}`,
            ),
          )
          expect(await object?.json()).toMatchObject({
            body: 'Replacement body',
            script: expect.stringContaining('日本語外部 日本語構造'),
          })
          expect(
            (
              await env.BUCKET.list({
                prefix: `search-text/${owner.workspaceId}/${created.id}/${created.versionId}/`,
              })
            ).objects,
          ).toEqual([])
        },
        { timeout: 55_000, interval: 100 },
      )
      const rejected = await worker.fetch(
        `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}`,
        {
          method: 'POST',
          headers: {
            Cookie: sessionCookie(owner.sessionToken),
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: next,
        },
      )
      expect(rejected.status).toBe(409)
      expect(
        await index.exec(
          'SELECT DISTINCT version FROM serving_chunks WHERE shareable=?',
          created.id,
        ),
      ).toEqual([{ version: version.versionId }])
    },
    120_000,
  )

  test('workspace search resumes backfill and format rebuild, recovers missed signals and cleans deleted source workspaces', async () => {
    const owner = {
      workspaceId: 'ws-backfill',
      userId: 'backfill-user',
      email: 'backfill@example.test',
      name: 'Backfill',
      sessionToken: 'backfill-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('backfill-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    for (let n = 0; n < 12; n++) {
      const id = `backfill-${String(n).padStart(2, '0')}`
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'backfill-inbox','html_page','private',?,?,?)",
        ).bind(id, owner.workspaceId, owner.userId, id, `v-${id}`, now, now),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'html_page','published','/index.html',?,100,'sha',?,?)",
        ).bind(`v-${id}`, id, `artifacts/backfill/${id}`, owner.userId, now),
      ])
      await env.BUCKET.put(
        `artifacts/backfill/${id}`,
        n === 0
          ? '<p>searchablebody フロントエンドエンジニア エンジニア募集</p>'
          : '<p>searchablebody</p>',
      )
    }
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-backfill:0' },
    )
    expect(await index.exec('SELECT * FROM active')).toEqual([])
    await index.exec(
      "CREATE TRIGGER pause_backfill BEFORE INSERT ON chunks WHEN (SELECT shareable FROM documents WHERE id=NEW.document)='backfill-11' BEGIN SELECT RAISE(ABORT,'hold backfill'); END",
    )
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
      name: 'ws-backfill:0',
    })
    expect(
      await index.exec("SELECT * FROM active WHERE id='backfill-11'"),
    ).toEqual([])
    const publishedAt = Date.now()
    const boundary = 'backfill-publication'
    const form = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="fresh.html"',
      'Content-Type: text/html',
      '',
      '<p>freshduringbackfill</p>',
      `--${boundary}`,
      'Content-Disposition: form-data; name="visibility"',
      '',
      'private',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const response = await worker.fetch('/api/shareables/uploads', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(owner.sessionToken),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: form,
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const published = (await response.json()) as {
      id: string
      versionId: string
    }
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : freshduringbackfill' AND c.shareable=?",
            published.id,
          ),
        ).toEqual([{ version: published.versionId }])
      },
      { timeout: 55_000, interval: 100 },
    )
    expect(Date.now() - publishedAt).toBeLessThan(60_000)
    expect(
      await index.exec("SELECT * FROM active WHERE id='backfill-11'"),
    ).toEqual([])
    expect(
      await index.exec(
        "SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'searchablebody' AND c.shareable='backfill-00'",
      ),
    ).toEqual([{ shareable: 'backfill-00' }])
    await index.exec('DROP TRIGGER pause_backfill')
    // Alarm continuations survive eviction; the test does not invoke a second import path.
    await vi.waitFor(
      async () => {
        expect(
          await index.exec('SELECT count(*) AS count FROM active'),
        ).toEqual([{ count: 13 }])
      },
      { timeout: 55_000, interval: 100 },
    )
    const generation = await index.exec(
      "SELECT generation FROM active WHERE id='backfill-00'",
    )
    await env.DB.prepare(
      "UPDATE shareables SET title_override='Renamed',updated_at='2026-08-01' WHERE id='backfill-00'",
    ).run()
    expect(
      await index.exec(
        "SELECT normalized_title FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='backfill-00'",
      ),
    ).toEqual([{ normalized_title: 'backfill 00' }])
    // A scheduled sync compares rows changed since the last mark; this write
    // is dated before it, so only the next full pass finds it.
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(
      await index.exec(
        "SELECT normalized_title FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='backfill-00'",
      ),
    ).toEqual([{ normalized_title: 'backfill 00' }])
    await index.exec('UPDATE state SET scanned_at=0')
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(
      await index.exec(
        "SELECT normalized_title FROM documents d JOIN active a ON a.generation=d.generation WHERE d.shareable='backfill-00'",
      ),
    ).toEqual([{ normalized_title: 'renamed' }])
    expect(
      await index.exec("SELECT generation FROM active WHERE id='backfill-00'"),
    ).not.toEqual(generation)
    const generationsBeforeRebuild = await index.exec(
      'SELECT generation FROM active ORDER BY id',
    )
    await index.exec('DROP TABLE search_runs')
    await index.exec('UPDATE active SET format=0')
    // A format change ships as a new INDEX_FORMAT_VERSION, which no finished
    // scan has used yet.
    await index.exec('UPDATE state SET scanned_format=0')
    const servingBefore = await index.exec(
      'SELECT count(*) AS count FROM serving_chunks',
    )
    await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
      name: 'ws-backfill:0',
    })
    expect(
      await index.exec('SELECT count(*) AS count FROM serving_chunks'),
    ).toEqual(servingBefore)
    expect(
      (await searchProbe('ws-backfill').search({ query: 'エンジ' })).items,
    ).toEqual([expect.objectContaining({ id: 'backfill-00' })])
    expect(
      (
        await searchProbe('ws-backfill').search({
          query: 'フロントエンドエンジ',
        })
      ).items,
    ).toEqual([])
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            'SELECT count(*) AS count FROM active WHERE format=?',
            INDEX_FORMAT_VERSION,
          ),
        ).toEqual([{ count: 13 }])
      },
      { timeout: 55_000, interval: 100 },
    )
    expect(
      await index.exec('SELECT generation FROM active ORDER BY id'),
    ).not.toEqual(generationsBeforeRebuild)
    expect(
      await index.exec(
        "SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : freshduringbackfill'",
      ),
    ).toEqual([{ shareable: published.id }])
    expect(
      (
        await searchProbe('ws-backfill').search({
          query: 'フロントエンドエンジ',
        })
      ).items,
    ).toEqual([expect.objectContaining({ id: 'backfill-00' })])
    // Stop after the first real storage chunk, preserving the serving generation.
    const oldVersion = await index.exec(
      "SELECT DISTINCT version FROM serving_chunks WHERE shareable='backfill-00'",
    )
    await index.exec(
      "CREATE TRIGGER pause_search_stage BEFORE INSERT ON chunks WHEN (SELECT count(*) FROM chunks WHERE document=NEW.document)>=1 BEGIN SELECT RAISE(ABORT,'test stage pause'); END",
    )
    await env.BUCKET.put(
      'artifacts/backfill/replacement',
      '<p>replacementhead ' + 'word '.repeat(60_000) + ' replacementtail</p>',
    )
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES ('replacement-version','backfill-00','html_page','published','/index.html','artifacts/backfill/replacement',300000,'next-sha',?,?)",
      ).bind(owner.userId, now),
      // Publishing a version moves updated_at to the time of the write.
      env.DB.prepare(
        "UPDATE shareables SET current_version_id='replacement-version',updated_at=? WHERE id='backfill-00'",
      ).bind(new Date().toISOString()),
    ])
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(
      await index.exec(
        "SELECT DISTINCT version FROM serving_chunks WHERE shareable='backfill-00'",
      ),
    ).toEqual(oldVersion)
    expect(
      await index.exec(
        "SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id=c.document JOIN staging s ON s.generation=d.generation WHERE d.shareable='backfill-00'",
      ),
    ).toEqual([{ count: 1 }])
    await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
      name: 'ws-backfill:0',
    })
    expect(
      await index.exec(
        "SELECT DISTINCT version FROM serving_chunks WHERE shareable='backfill-00'",
      ),
    ).toEqual(oldVersion)
    await index.exec('DROP TRIGGER pause_search_stage')
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(
      await index.exec(
        "SELECT DISTINCT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'replacementtail' AND c.shareable='backfill-00'",
      ),
    ).toEqual([{ version: 'replacement-version' }])
    expect(
      await index.exec(
        "SELECT count(*) AS count FROM documents WHERE shareable='backfill-00' AND version!='replacement-version'",
      ),
    ).toEqual([{ count: 0 }])
    // More than one R2 listing page includes abandoned and superseded extraction.
    for (let n = 0; n < 105; n++)
      await env.BUCKET.put(
        `search-text/ws-backfill/backfill-00/staged-${n}/index.html`,
        'abandoned',
      )
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id,hd,name,created_at,plan,storage_quota_bytes,storage_used_bytes,storage_updated_at) VALUES ('ws-destination',NULL,'Destination',?,'free',100000,0,?)",
      ).bind(now, now),
      env.DB.prepare(
        "UPDATE shareables SET workspace_id='ws-destination' WHERE workspace_id='ws-backfill'",
      ),
      env.DB.prepare(
        "UPDATE artifact_containers SET workspace_id='ws-destination' WHERE workspace_id='ws-backfill'",
      ),
      env.DB.prepare(
        "UPDATE users SET workspace_id='ws-destination' WHERE workspace_id='ws-backfill'",
      ),
      env.DB.prepare("DELETE FROM workspaces WHERE id='ws-backfill'"),
    ])
    expect(
      await env.DB.prepare(
        "SELECT workspace_id FROM search_index_workspaces WHERE workspace_id='ws-backfill'",
      ).first(),
    ).not.toBeNull()
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    const destination = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-destination:0' },
    )
    await vi.waitFor(
      async () => {
        expect(await index.exec('SELECT * FROM active')).toEqual([])
        expect(
          (await env.BUCKET.list({ prefix: 'search-text/ws-backfill/' }))
            .objects,
        ).toEqual([])
        expect(
          await destination.exec('SELECT count(*) AS count FROM active'),
        ).toEqual([{ count: 13 }])
      },
      { timeout: 55_000, interval: 100 },
    )
    expect(
      await env.BUCKET.head('artifacts/backfill/backfill-00'),
    ).not.toBeNull()
  }, 180_000)

  test.each([
    ['private_channel', 'file'],
    ['dm', 'file'],
    ['private_channel', 'static_site'],
    ['dm', 'static_site'],
  ] as const)(
    'workspace search follows bridge %s %s publish branches',
    async (conversationKind, contentKind) => {
      const owner = {
        workspaceId: 'ws-bridge-search',
        userId: 'bridge-search-owner',
        email: 'bridge-search@example.test',
        name: 'Bridge Search',
        sessionToken: 'bridge-search-owner-session',
      }
      await seedRuntimeUser(owner)
      const env = await worker.getEnv()
      const now = '2026-07-30T00:00:00.000Z'
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO users (id,email,email_verified,name,created_at,updated_at,workspace_id,kind) VALUES ('search-bot','search-bot@bots.artifactshare.invalid',1,'Search bot',?,?,'ws-bridge-search','bot')",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('ws-bridge-search','search-bot','member','active',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO artifact_containers (id,workspace_id,kind,created_by_id,name,base_visibility,created_at,updated_at) VALUES ('search-fallback','ws-bridge-search','project',?,'Fallback','private',?,?)",
        ).bind(owner.userId, now, now),
        env.DB.prepare(
          "INSERT INTO artifact_containers (id,workspace_id,kind,created_by_id,name,base_visibility,created_at,updated_at) VALUES ('search-mapped','ws-bridge-search','project',?,'Mapped','private',?,?)",
        ).bind(owner.userId, now, now),
        env.DB.prepare(
          "INSERT INTO project_share_defaults (id,project_container_id,email,role,created_at,updated_at) VALUES ('search-fallback-grant','search-fallback','search-bot@bots.artifactshare.invalid','contributor',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO project_share_defaults (id,project_container_id,email,role,created_at,updated_at) VALUES ('search-mapped-grant','search-mapped','search-bot@bots.artifactshare.invalid','contributor',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO agent_profiles (id,user_id,workspace_id,created_at) VALUES ('search-agent','search-bot','ws-bridge-search',?)",
        ).bind(now),
        env.DB.prepare(
          "INSERT INTO bridge_authorities (id,workspace_id,bot_user_id,agent_profile_id,source_kind,source_installation_id,external_workspace_id,fallback_project_id,created_at,updated_at) VALUES ('search-bridge','ws-bridge-search','search-bot','search-agent','qm','search-install','search-external','search-fallback',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO bridge_conversations (id,bridge_authority_id,project_id,conversation_kind,privacy_ceiling,privacy_epoch,created_at,updated_at) VALUES ('search-mapping','search-bridge','search-mapped','private_channel','private',1,?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO bridge_conversation_ids (mapping_id,bridge_authority_id,external_conversation_id,created_at) VALUES ('search-mapping','search-bridge','search-channel',?)",
        ).bind(now),
        env.DB.prepare(
          "INSERT INTO sessions (id,user_id,token,expires_at,created_at,updated_at) VALUES ('search-bot-session','search-bot','search-bot-bearer','2099-01-01',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO cli_family_authorities (family_id,user_id,preset,workspace_id,project_id,project_name_snapshot,agent_profile_id,bridge_authority_id,status,created_at,updated_at) VALUES ('search-family','search-bot','agent','ws-bridge-search','search-fallback','Fallback','search-agent','search-bridge','active',?,?)",
        ).bind(now, now),
        env.DB.prepare(
          "INSERT INTO cli_session_authorities (session_id,family_id,kind,preset,workspace_id,project_id,agent_profile_id,created_at) VALUES ('search-bot-session','search-family','family','agent','ws-bridge-search','search-fallback','search-agent',?)",
        ).bind(now),
        env.DB.prepare(
          "INSERT INTO cli_refresh_credentials (id,user_id,token_hash,expires_at,created_at,family_id) VALUES ('search-refresh','search-bot','search-refresh-hash','2099-01-01',?,'search-family')",
        ).bind(now),
        env.DB.prepare(
          "INSERT INTO cli_refresh_sessions (session_id,credential_id,family_id) VALUES ('search-bot-session','search-refresh','search-family')",
        ),
      ])
      const index = await worker.getDurableObjectStorage(
        'WORKSPACE_SEARCH_INDEX',
        { name: 'ws-bridge-search:0' },
      )
      let artifactId: string | undefined
      const operations =
        contentKind === 'file'
          ? ['publish', 'update', 'append']
          : ['publish', 'update']
      for (const operation of operations) {
        const text = `# bridge${operation}body`
        const path = contentKind === 'file' ? 'note.md' : '/index.md'
        const metadata = {
          schema_version: 1,
          request_id: `search-${operation}`,
          operation,
          requested_audience: 'private',
          ...(artifactId ? { target_artifact_id: artifactId } : {}),
          source: {
            kind: 'qm',
            installation_id: 'search-install',
            external_workspace_id: 'search-external',
          },
          conversation: {
            current_id:
              conversationKind === 'dm' ? 'search-dm' : 'search-channel',
            ids: [conversationKind === 'dm' ? 'search-dm' : 'search-channel'],
            kind: conversationKind,
          },
          requester: {
            stable_id: 'search-person',
            verified_email: owner.email,
          },
          content: {
            kind: contentKind,
            files: [
              {
                index: 0,
                path,
                media_type: 'text/markdown',
                size: new TextEncoder().encode(text).byteLength,
                sha256: createHash('sha256').update(text).digest('hex'),
              },
            ],
          },
        }
        const boundary = 'search-bridge-boundary'
        const form = [
          `--${boundary}`,
          'Content-Disposition: form-data; name="metadata"',
          '',
          JSON.stringify(metadata),
          `--${boundary}`,
          `Content-Disposition: form-data; name="file"; filename="${path}"`,
          'Content-Type: text/markdown',
          '',
          text,
          `--${boundary}--`,
          '',
        ].join('\r\n')
        const response = await worker.fetch('/api/bridge/v1/requests', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer search-bot-bearer',
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body: form,
        })
        expect(response.status, await response.clone().text()).toBe(200)
        const result = (await response.json()) as {
          data: { artifact: { id: string }; version_id: string }
        }
        artifactId = result.data.artifact.id
        await vi.waitFor(
          async () => {
            expect(
              await index.exec(
                'SELECT DISTINCT version FROM serving_chunks WHERE shareable=?',
                result.data.artifact.id,
              ),
            ).toEqual([{ version: result.data.version_id }])
            expect(
              await index.exec(
                'SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ? AND c.shareable=?',
                `body : bridge${operation}body`,
                result.data.artifact.id,
              ),
            ).toHaveLength(1)
          },
          { timeout: 55_000, interval: 100 },
        )
      }
    },
    180_000,
  )

  test('workspace search preserves oversized body and script tails and distinguishes long FTS tokens', async () => {
    // Generated fixtures exercise storage limits without committing megabytes or rendering a browser.
    const owner = {
      workspaceId: 'ws-search-large',
      userId: 'search-large-user',
      email: 'large@example.test',
      name: 'Large',
      sessionToken: 'large-session',
    }
    await seedRuntimeUser(owner)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.prepare(
      "INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('large-inbox',?,'inbox',?,?,'Inbox',?,?)",
    )
      .bind(owner.workspaceId, owner.userId, owner.userId, now, now)
      .run()
    const longPrefix = 'a'.repeat(40_000)
    const inputs = [
      { id: 'control', body: 'healthycontrol' },
      { id: 'long-a', body: longPrefix + 'suffixalpha' },
      { id: 'long-b', body: longPrefix + 'suffixbravo' },
      {
        id: 'large',
        body:
          'bodyhead ' +
          'content '.repeat(16_381) +
          'beforeboundary afterboundary ' +
          'content '.repeat(1_180_000 - 16_381) +
          ' bodytail',
      },
    ]
    for (const input of inputs) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO shareables (id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,current_version_id,created_at,updated_at) VALUES (?,?,?,?,'large-inbox','html_page','private',?,?,?)",
        ).bind(
          input.id,
          owner.workspaceId,
          owner.userId,
          input.id,
          `v-${input.id}`,
          now,
          now,
        ),
        env.DB.prepare(
          "INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at) VALUES (?,?,'html_page','published','/index.html',?,100,'sha',?,?)",
        ).bind(
          `v-${input.id}`,
          input.id,
          `artifacts/large/${input.id}`,
          owner.userId,
          now,
        ),
      ])
      await env.BUCKET.put(
        `artifacts/large/${input.id}`,
        `<p>${input.body}</p>`,
      )
    }
    await env.DB.prepare(
      "UPDATE shareables SET artifact_kind='static_site' WHERE id='large'",
    ).run()
    await env.DB.prepare(
      "UPDATE versions SET artifact_kind='static_site' WHERE id='v-large'",
    ).run()
    for (const [path, contents] of [
      [
        '/local.js',
        'const a="日本 ' +
          'scriptcontent '.repeat(330_000) +
          ' scriptboundary"',
      ],
      [
        '/local.json',
        JSON.stringify({
          label:
            '日本 jsonboundary ' +
            'scriptcontent '.repeat(330_000) +
            ' scripttail',
        }),
      ],
    ]) {
      const key = `artifacts/large/site${path}`
      await env.BUCKET.put(key, contents)
      await env.DB.prepare(
        "INSERT INTO version_files (id,version_id,path,r2_key,mime_type,size_bytes,sha256,created_at) VALUES (?,'v-large',?,?,'text/plain',?,'sha',?)",
      )
        .bind(path, path, key, new TextEncoder().encode(contents).length, now)
        .run()
    }

    await env.WORKSPACE_SEARCH_INDEX.getByName('ws-search-large:0').sync(
      'ws-search-large',
    )
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: 'ws-search-large:0' },
    )
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            "SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'bodytail'",
          ),
        ).toEqual([{ shareable: 'large' }])
      },
      { timeout: 55_000, interval: 100 },
    )
    for (const [term, id] of [
      ['healthycontrol', 'control'],
      ['bodyhead', 'large'],
      ['bodytail', 'large'],
      ['scripttail', 'large'],
      ['scriptboundary', 'large'],
      ['jsonboundary', 'large'],
    ]) {
      expect(
        await index.exec(
          'SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
          term,
        ),
      ).toEqual([{ shareable: id }])
    }
    for (const input of inputs.filter((entry) =>
      entry.id.startsWith('long-'),
    )) {
      const normalized = normalizeSearchText(input.body)
      for (const term of [`"${normalized}"`, normalized.split(' ').at(-1)!])
        expect(
          await index.exec(
            'SELECT DISTINCT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH ?',
            term,
          ),
        ).toEqual([{ shareable: input.id }])
    }
    for (const [term, ordinal] of [
      ['beforeboundary', 0],
      ['afterboundary', 1],
    ] as const) {
      expect(
        await index.exec(
          'SELECT c.ordinal FROM search JOIN chunks c ON c.id=search.rowid JOIN serving_chunks active ON active.id=c.id WHERE search MATCH ?',
          term,
        ),
      ).toEqual([{ ordinal }])
    }
    const probe = searchProbe(owner.workspaceId)
    // Both use production sync above: the first phrase is within a chunk, the
    // second needs the seam written by ingestion at the verified boundary.
    for (const query of ['bodyhead content', 'beforeboundary afterboundary']) {
      expect((await probe.search({ query })).items, query).toEqual([
        expect.objectContaining({ id: 'large', tier: 'phrase' }),
      ])
    }
    const sizes = await index.exec(
      'SELECT max(length(CAST(title AS BLOB))) AS title,max(length(CAST(body AS BLOB))) AS body,max(length(CAST(script AS BLOB))) AS script FROM search',
    )
    for (const size of Object.values(sizes[0]))
      expect(Number(size)).toBeLessThanOrEqual(COLUMN_BYTES)
    expect(
      await index.exec(
        "SELECT sum(length(s.body)) AS count FROM snippets s JOIN documents d ON d.id=s.document JOIN active a ON a.generation=d.generation WHERE d.shareable='large'",
      ),
    ).toEqual([{ count: 200000 }])
    const extracted = await env.BUCKET.get(
      await searchTextKey('ws-search-large', 'large', 'v-large', '/index.html'),
    )
    const payload = await extracted!.json<{ body: string; script: string }>()
    expect(createHash('sha256').update(payload.body).digest('hex')).toBe(
      createHash('sha256')
        .update(inputs[3].body.replace(/\s+/gu, ' ').trim())
        .digest('hex'),
    )
    expect(new TextEncoder().encode(payload.script).length).toBeGreaterThan(
      8 * 1024 * 1024,
    )
    expect(
      await index.exec(
        'SELECT count(*) AS count FROM search WHERE length(CAST(title AS BLOB))+length(CAST(body AS BLOB))+length(CAST(script AS BLOB))+1024 >= 1048576',
      ),
    ).toEqual([{ count: 0 }])
    expect(payload.script.endsWith('scripttail')).toBe(true)
  }, 120_000)

  test('boots the main bundle with auxiliary workers and applies migrations', async () => {
    const env = await worker.getEnv()
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sqlite_master',
    ).first<{ count: number }>()
    expect(row?.count).toBeGreaterThan(0)
    expect((await worker.fetch('/__workflows/d1-backup')).status).toBe(405)
  })

  test('extracts judgment input with the runtime HTML tokenizer', async () => {
    const extract = async (html: string) => {
      const response = await worker.fetch('/__integration/link-abuse-extract', {
        method: 'POST',
        body: html,
      })
      expect(response.status).toBe(200)
      return (await response.json()) as {
        text: string
        externalDomains: string[]
      }
    }

    const evasive = await extract(`<!doctype html><html><head>
<title>Doc</title>
<script>const trap = '</div>'; location.href = 'https://hidden-a.example/login'</script>
<!-- <script> --><p>Comment does not open a script</p><!-- </script> -->
<style>body::after { content: "https://hidden-b.example" }</style>
<meta http-equiv="refresh" content="0; url=https://redirect.example/x">
</head><body>
<script-content>Custom element keeps text</script-content>
<a href="https://phish.example/verify" title="a > b">Verify your account</a>
<img src="//cdn.example/pixel.gif">
<template><a href="https://template.example/">no</a></template>
<p>Visible body https://bare.example/path</p>
<script>document.write('</script')</script><p>After split closer</p>
<script>unclosed opener</body></html>`)
    expect(evasive.text).toContain('Comment does not open a script')
    expect(evasive.text).toContain('Custom element keeps text')
    expect(evasive.text).toContain('Verify your account')
    expect(evasive.text).toContain('After split closer')
    expect(evasive.text).not.toContain('hidden-a')
    expect(evasive.text).not.toContain('hidden-b')
    expect(evasive.text).not.toContain('document.write')
    expect(evasive.text).not.toContain('unclosed opener')
    expect(evasive.externalDomains).toEqual([
      'redirect.example',
      'phish.example',
      'cdn.example',
      'bare.example',
    ])

    const foreign = await extract(
      '<svg><script/><style/></svg><p>After foreign content</p><a href="https://a.example/?x=1&amp;y=2">entity</a><p>Bare &#x68;ttps://enc.example/ tail</p>',
    )
    expect(foreign.text).toContain('After foreign content')
    expect(foreign.text).toContain('Bare https://enc.example/ tail')
    expect(foreign.externalDomains).toEqual(['a.example', 'enc.example'])

    const padded = await extract(
      `<p>${'x'.repeat(200_000)}</p><a href="https://late.example/">late</a>`,
    )
    expect(padded.text.length).toBeLessThanOrEqual(LINK_ABUSE_TEXT_LIMIT)
    expect(padded.externalDomains).toEqual(['late.example'])
  })

  test('marks a real device-token session and lets it issue a CLI refresh credential', async () => {
    const deviceUser = {
      workspaceId: 'ws-device-token',
      userId: 'user-device-token',
      email: 'device-token@example.test',
      name: 'Device Token User',
      sessionToken: 'browser-session-before-device-token',
    }
    await seedRuntimeUser(deviceUser)
    const env = await worker.getEnv()
    await env.DB.prepare(
      `INSERT INTO deviceCode (
         id, deviceCode, userCode, userId, expiresAt, status,
         lastPolledAt, pollingInterval, clientId, scope
       ) VALUES (?, ?, ?, ?, ?, 'approved', NULL, NULL, ?, '')`,
    )
      .bind(
        'device-code-row',
        'device-code-secret',
        'AB12CD34',
        deviceUser.userId,
        '2099-01-01T00:00:00.000Z',
        'artifactshare-cli',
      )
      .run()

    const tokenResponse = await worker.fetch('/api/auth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'device-code-secret',
        client_id: 'artifactshare-cli',
      }),
    })
    expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(200)
    const tokenBody = (await tokenResponse.json()) as { access_token?: string }
    expect(tokenBody.access_token).toEqual(expect.any(String))

    const deviceSession = await env.DB.prepare(
      'SELECT user_agent FROM sessions WHERE token = ?',
    )
      .bind(tokenBody.access_token)
      .first<{ user_agent: string | null }>()
    expect(deviceSession?.user_agent).toBe('artifactshare-cli-device')

    const credentialResponse = await worker.fetch(
      '/api/cli/auth/refresh-credentials',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      },
    )
    expect(
      credentialResponse.status,
      await credentialResponse.clone().text(),
    ).toBe(200)
    await expect(credentialResponse.json()).resolves.toMatchObject({
      refresh_token: expect.stringMatching(/^asr_/u),
      refresh_token_expires_at: expect.any(String),
    })
  })

  test('publishes and views a private single-file artifact through the production runtime wiring', async () => {
    const owner = {
      workspaceId: 'ws-runtime-owner',
      userId: 'user-runtime-owner',
      email: 'runtime-owner@example.test',
      name: 'Runtime Owner',
      sessionToken: 'runtime-owner-session',
    }
    const outsider = {
      workspaceId: 'ws-runtime-outsider',
      userId: 'user-runtime-outsider',
      email: 'runtime-outsider@example.test',
      name: 'Runtime Outsider',
      sessionToken: 'runtime-outsider-session',
    }
    await seedRuntimeUser(owner)
    await seedRuntimeUser(outsider)

    const source =
      '<!doctype html><title>Runtime wiring</title><p>secret-runtime-body</p>'
    const boundary = 'artifactshare-runtime-boundary'
    const form = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="runtime.html"',
      'Content-Type: text/html',
      '',
      source,
      `--${boundary}`,
      'Content-Disposition: form-data; name="visibility"',
      '',
      'private',
      `--${boundary}--`,
      '',
    ].join('\r\n')
    const upload = await worker.fetch('/api/shareables/uploads', {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(owner.sessionToken),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: form,
    })
    expect(upload.status, await upload.clone().text()).toBe(200)
    const uploaded = (await upload.json()) as {
      id: string
      versionId: string
      visibility: string
    }
    expect(uploaded.visibility).toBe('private')
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: `${owner.workspaceId}:0` },
    )
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            'SELECT DISTINCT version FROM serving_chunks WHERE shareable=?',
            uploaded.id,
          ),
        ).toEqual([{ version: uploaded.versionId }])
        const hits = await index.exec(
          "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : secret' AND c.shareable=?",
          uploaded.id,
        )
        expect(hits).toHaveLength(1)
      },
      { timeout: 55_000, interval: 100 },
    )

    const env = await worker.getEnv()
    const stored = await env.DB.prepare(
      `SELECT
        s.current_version_id,
        s.visibility,
        v.r2_key,
        v.status,
        v.size_bytes
      FROM shareables s
      INNER JOIN versions v ON v.id = s.current_version_id
      WHERE s.id = ?`,
    )
      .bind(uploaded.id)
      .first<{
        current_version_id: string
        visibility: string
        r2_key: string
        status: string
        size_bytes: number
      }>()
    expect(stored).toMatchObject({
      current_version_id: uploaded.versionId,
      visibility: 'private',
      status: 'published',
      size_bytes: new TextEncoder().encode(source).byteLength,
    })
    const object = await env.BUCKET.get(stored!.r2_key)
    expect(object?.httpMetadata?.contentType).toBe('text/html; charset=utf-8')
    await expect(object?.text()).resolves.toBe(source)

    const viewer = await worker.fetch(`/a/${uploaded.id}`, {
      headers: { Cookie: sessionCookie(owner.sessionToken) },
    })
    expect(viewer.status).toBe(200)
    const viewerHtml = await viewer.text()
    const sandboxUrl = sandboxUrlFromHtml(viewerHtml, uploaded.id)
    expect(sandboxUrl.searchParams.get('__as_token')).toBeTruthy()
    const sandboxResponse = await sandboxWorker.fetch(sandboxUrl.toString())
    expect(sandboxResponse.status).toBe(200)
    await expect(sandboxResponse.text()).resolves.toContain(
      'secret-runtime-body',
    )

    const anonymous = await worker.fetch(`/a/${uploaded.id}`)
    expect(anonymous.status).toBe(200)
    const anonymousHtml = await anonymous.text()
    for (const secret of [
      source,
      'secret-runtime-body',
      stored!.r2_key,
      owner.name,
      owner.email,
    ]) {
      expect(anonymousHtml).not.toContain(secret)
    }

    const denied = await worker.fetch(`/a/${uploaded.id}`, {
      headers: { Cookie: sessionCookie(outsider.sessionToken) },
    })
    expect(denied.status).toBe(403)
    const deniedHtml = await denied.text()
    for (const secret of [
      source,
      'secret-runtime-body',
      stored!.r2_key,
      owner.name,
      owner.email,
    ]) {
      expect(deniedHtml).not.toContain(secret)
    }

    const missing = await worker.fetch('/a/missingruntimeid', {
      headers: { Cookie: sessionCookie(owner.sessionToken) },
    })
    expect(missing.status).toBe(404)
    const missingHtml = await missing.text()
    expect(missingHtml).toContain('This file is no longer available')

    const replaced = await worker.fetch(
      `/api/shareables/${uploaded.id}/versions`,
      {
        method: 'POST',
        headers: {
          Cookie: sessionCookie(owner.sessionToken),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: form.replace('secret-runtime-body', 'replacementbody'),
      },
    )
    expect(replaced.status).toBe(200)
    const replacement = (await replaced.json()) as { versionId: string }
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            'SELECT DISTINCT version FROM serving_chunks WHERE shareable=?',
            uploaded.id,
          ),
        ).toEqual([{ version: replacement.versionId }])
        expect(
          await index.exec(
            "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : replacementbody' AND c.shareable=?",
            uploaded.id,
          ),
        ).toEqual([{ version: replacement.versionId }])
        expect(
          await index.exec(
            "SELECT c.version FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : secret' AND c.shareable=?",
            uploaded.id,
          ),
        ).toEqual([])
      },
      { timeout: 55_000, interval: 100 },
    )

    const appended = await worker.fetch(
      `/api/cli/artifacts/${uploaded.id}/append`,
      {
        method: 'POST',
        headers: {
          Cookie: sessionCookie(owner.sessionToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '<p>appendedsearchbody</p>' }),
      },
    )
    expect(appended.status, await appended.clone().text()).toBe(200)
    const appendedVersion = (await appended.json()) as { versionId: string }
    await vi.waitFor(
      async () => {
        expect(
          await index.exec(
            'SELECT DISTINCT version FROM serving_chunks WHERE shareable=?',
            uploaded.id,
          ),
        ).toEqual([{ version: appendedVersion.versionId }])
        expect(
          await index.exec(
            "SELECT c.shareable FROM search JOIN serving_chunks c ON c.id=search.rowid WHERE search MATCH 'body : appendedsearchbody' AND c.shareable=?",
            uploaded.id,
          ),
        ).toHaveLength(1)
      },
      { timeout: 55_000, interval: 100 },
    )
    // Exercise the built React Router document and data paths: loader init
    // headers alone do not establish the document response's cache policy.
    await env.DB.prepare(
      'INSERT INTO version_retention_tombstones (version_id, shareable_id, version_number, removed_at) VALUES (?, ?, ?, ?)',
    )
      .bind(
        'removed-runtime-version',
        uploaded.id,
        3,
        '2026-07-30T00:00:00.000Z',
      )
      .run()
    for (const suffix of ['', '.data']) {
      const removed = await worker.fetch(
        `/a/${uploaded.id}${suffix}?version=removed-runtime-version`,
        {
          headers: { Cookie: sessionCookie(owner.sessionToken) },
        },
      )
      expect(removed.status).toBe(410)
      expect(removed.headers.get('Cache-Control')).toContain('private')
      expect(removed.headers.get('Cache-Control')).toContain('no-store')
      const body = await removed.text()
      expect(body).not.toContain('secret-runtime-body')
      expect(body).not.toContain('__as_token')
    }
    // A real shared reader can open content but cannot learn removal history
    // or retention management evidence.
    await env.DB.prepare(
      'INSERT INTO shareable_grants (shareable_id, granted_email, granted_at, granted_by) VALUES (?, ?, ?, ?)',
    )
      .bind(
        uploaded.id,
        outsider.email,
        '2026-07-30T00:00:00.000Z',
        owner.userId,
      )
      .run()
    for (const query of ['', `?version=${uploaded.versionId}`]) {
      const allowed = await worker.fetch(`/a/${uploaded.id}.data${query}`, {
        headers: { Cookie: sessionCookie(outsider.sessionToken) },
      })
      expect(allowed.status).toBe(200)
      const allowedData = await allowed.text()
      expect(allowedData).toContain('sandboxUrl')
      expect(allowedData).not.toContain('publisherManaged')
      expect(allowedData).not.toContain('extraProtectedCurrentVersion')
    }
    for (const version of [
      'removed-runtime-version',
      'unknown-runtime-version',
    ]) {
      const unavailable = await worker.fetch(
        `/a/${uploaded.id}?version=${version}`,
        { headers: { Cookie: sessionCookie(outsider.sessionToken) } },
      )
      expect(unavailable.status).toBe(404)
      expect(await unavailable.text()).not.toContain('version-removed')
    }
    await env.DB.prepare(
      "UPDATE shareables SET visibility = 'link', link_expires_at = NULL WHERE id = ?",
    )
      .bind(uploaded.id)
      .run()
    await env.DB.prepare(
      'UPDATE workspaces SET link_sharing_enabled = 1 WHERE id = ?',
    )
      .bind(owner.workspaceId)
      .run()
    for (const version of [
      'removed-runtime-version',
      'unknown-runtime-version',
    ]) {
      const redirected = await worker.fetch(
        `/a/${uploaded.id}?version=${version}`,
        { redirect: 'manual' },
      )
      expect(redirected.status).toBe(301)
      expect(redirected.headers.get('Location')).toBe(
        `https://${uploaded.id}.localhost:5173/`,
      )
      expect(await redirected.text()).toBe('')
    }
  }, 180_000)

  test('verifies Stripe webhook signatures with the runtime Web Crypto provider', async () => {
    const stripe = new Stripe(STRIPE_SECRET_KEY)
    const validEvent = {
      id: 'evt_runtime_valid',
      object: 'event',
      api_version: '2026-06-30.basil',
      created: 1_775_000_000,
      data: { object: { id: 'cus_runtime', object: 'customer' } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'customer.created',
    }
    const body = JSON.stringify(validEvent)
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_WEBHOOK_SECRET,
    })
    const webhook = await worker.fetch('/api/stripe/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body,
    })
    expect(webhook.status).toBe(200)

    const env = await worker.getEnv()
    const receipt = await env.DB.prepare(
      `SELECT event_type, processed_at, error
       FROM billing_webhook_events
       WHERE stripe_event_id = ?`,
    )
      .bind(validEvent.id)
      .first<{
        event_type: string
        processed_at: string | null
        error: string | null
      }>()
    expect(receipt).toMatchObject({
      event_type: validEvent.type,
      error: null,
    })
    expect(receipt?.processed_at).not.toBeNull()

    const mutatedBody = JSON.stringify({
      ...validEvent,
      id: 'evt_runtime_mutated_body',
    })
    const bodyRejected = await worker.fetch('/api/stripe/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
      },
      body: mutatedBody,
    })
    expect(bodyRejected.status).toBe(400)

    const signatureEvent = {
      ...validEvent,
      id: 'evt_runtime_mutated_signature',
    }
    const signatureBody = JSON.stringify(signatureEvent)
    const validSignatureForSecondEvent =
      stripe.webhooks.generateTestHeaderString({
        payload: signatureBody,
        secret: STRIPE_WEBHOOK_SECRET,
      })
    const mutatedSignature = `${validSignatureForSecondEvent.slice(0, -1)}${
      validSignatureForSecondEvent.endsWith('0') ? '1' : '0'
    }`
    const signatureRejected = await worker.fetch('/api/stripe/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': mutatedSignature,
      },
      body: signatureBody,
    })
    expect(signatureRejected.status).toBe(400)

    const invalidReceiptCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM billing_webhook_events
       WHERE stripe_event_id IN (?, ?)`,
    )
      .bind('evt_runtime_mutated_body', 'evt_runtime_mutated_signature')
      .first<{ count: number }>()
    expect(invalidReceiptCount?.count).toBe(0)
  })

  test.each(['2026-08-26.dahlia', '2026-10-28.endive'])(
    'reconciles signed %s snapshot references from current state with retry and duplicate delivery',
    async (apiVersion) => {
      const env = await worker.getEnv()
      await env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('ws-stripe', 'Stripe fixture', '2026-07-01T00:00:00Z')",
      ).run()
      let retrievals = 0
      let failRetrieval = true
      network.use(
        http.get(
          'https://api.stripe.com/v1/subscriptions/sub_runtime',
          ({ request }) => {
            retrievals += 1
            expect(request.headers.get('Stripe-Version')).toBe(
              '2026-10-28.endive',
            )
            if (failRetrieval)
              return HttpResponse.json(
                {
                  error: {
                    type: 'invalid_request_error',
                    message: 'controlled retrieval failure',
                  },
                },
                { status: 400 },
              )
            return HttpResponse.json({
              id: 'sub_runtime',
              object: 'subscription',
              status: 'active',
              customer: 'cus_runtime',
              currency: 'usd',
              metadata: { workspace_id: 'ws-stripe' },
              items: {
                data: [
                  {
                    id: 'si_runtime',
                    price: {
                      id: 'price_public_local_plus_monthly',
                      recurring: { usage_type: 'licensed' },
                    },
                  },
                ],
              },
            })
          },
        ),
      )
      const stripe = new Stripe(STRIPE_SECRET_KEY)
      const shapes = [
        {
          type: 'checkout.session.completed',
          object: {
            id: 'cs_runtime',
            object: 'checkout.session',
            subscription: 'sub_runtime',
          },
        },
        {
          type: 'customer.subscription.updated',
          object: {
            id: 'sub_runtime',
            object: 'subscription',
            status: 'canceled',
          },
        },
        {
          type: 'invoice.paid',
          object: {
            id: 'in_runtime',
            object: 'invoice',
            parent: { subscription_details: { subscription: 'sub_runtime' } },
          },
        },
      ]
      for (const [index, shape] of shapes.entries()) {
        const eventId = `evt_runtime_shape_${index}`
        const body = JSON.stringify({
          id: eventId,
          object: 'event',
          api_version: apiVersion,
          created: 1775000000,
          livemode: false,
          pending_webhooks: 1,
          request: { id: null, idempotency_key: null },
          type: shape.type,
          data: { object: shape.object },
        })
        const signature = stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: STRIPE_WEBHOOK_SECRET,
        })
        const deliver = () =>
          worker.fetch('/api/stripe/webhook', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'stripe-signature': signature,
            },
            body,
          })
        if (index === 0) {
          expect((await deliver()).status).toBe(500)
          expect(
            await env.DB.prepare(
              'SELECT processed_at, error FROM billing_webhook_events WHERE stripe_event_id = ?',
            )
              .bind(eventId)
              .first(),
          ).toEqual({
            processed_at: null,
            error: 'controlled retrieval failure',
          })
          expect(
            await env.DB.prepare(
              'SELECT COUNT(*) AS count FROM audit_events',
            ).first(),
          ).toEqual({ count: 0 })
          failRetrieval = false
        }
        expect((await deliver()).status).toBe(200)
        expect(
          await env.DB.prepare(
            'SELECT processed_at, error FROM billing_webhook_events WHERE stripe_event_id = ?',
          )
            .bind(eventId)
            .first(),
        ).toEqual({ processed_at: expect.any(String), error: null })
        const beforeDuplicate = retrievals
        expect((await deliver()).status).toBe(200)
        expect(retrievals).toBe(beforeDuplicate)
      }
      expect(retrievals).toBe(4)
      expect(
        await env.DB.prepare(
          "SELECT plan, stripe_subscription_id, stripe_subscription_status FROM workspaces WHERE id = 'ws-stripe'",
        ).first(),
      ).toEqual({
        plan: 'plus',
        stripe_subscription_id: 'sub_runtime',
        stripe_subscription_status: 'active',
      })
      expect(
        await env.DB.prepare(
          'SELECT COUNT(*) AS count FROM audit_events',
        ).first(),
      ).toEqual({ count: 1 })
    },
  )

  test('rejects expired and tampered subscription signatures before receipts or retrieval', async () => {
    let retrievals = 0
    network.use(
      http.get('https://api.stripe.com/v1/subscriptions/sub_invalid', () => {
        retrievals += 1
        return HttpResponse.json(
          { error: { message: 'must not retrieve' } },
          { status: 400 },
        )
      }),
    )
    const stripe = new Stripe(STRIPE_SECRET_KEY)
    // Installed v23 Webhooks.js DEFAULT_TOLERANCE is 300 seconds.
    expect(stripe.webhooks.DEFAULT_TOLERANCE).toBe(300)
    const body = JSON.stringify({
      id: 'evt_runtime_invalid_subscription',
      object: 'event',
      api_version: '2026-10-28.endive',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_invalid', object: 'subscription' } },
    })
    const fresh = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_WEBHOOK_SECRET,
    })
    const expired = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: STRIPE_WEBHOOK_SECRET,
      timestamp:
        Math.floor(Date.now() / 1000) -
        stripe.webhooks.DEFAULT_TOLERANCE -
        3600,
    })
    for (const [payload, signature] of [
      [body, expired],
      [body.replace('sub_invalid', 'sub_tampered'), fresh],
      [body, `${fresh.slice(0, -1)}${fresh.endsWith('0') ? '1' : '0'}`],
    ]) {
      const response = await worker.fetch('/api/stripe/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature!,
        },
        body: payload,
      })
      expect(response.status).toBe(400)
      const env = await worker.getEnv()
      expect(
        await env.DB.prepare(
          'SELECT COUNT(*) AS count FROM billing_webhook_events',
        ).first(),
      ).toEqual({ count: 0 })
      expect(retrievals).toBe(0)
    }
  })

  test('dispatches scheduled reconciliation through the Worker runtime', async () => {
    const env = await worker.getEnv()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at) VALUES ('ws-integration', NULL, 'Integration', '2026-07-01T00:00:00.000Z', 'free', 100000, 4096, '2026-07-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id) VALUES ('user-integration', 'integration@example.test', 1, 'Integration', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'ws-integration')",
      ),
      env.DB.prepare(
        "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('container-integration', 'ws-integration', 'inbox', 'user-integration', 'user-integration', 'Inbox', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO shareables (id, workspace_id, owner_user_id, name, derived_title, container_id, artifact_kind, visibility, current_version_id, created_at, updated_at) VALUES ('share-integration', 'ws-integration', 'user-integration', 'index.html', 'Index', 'container-integration', 'html_page', 'private', 'version-integration', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES ('version-integration', 'share-integration', 'html_page', 'published', '/index.html', 'artifacts/integration/used.html', 1024, 'sha', 'user-integration', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
      ),
    ])
    await env.BUCKET.put('artifacts/integration/used.html', 'used')
    await env.BUCKET.put('artifacts/integration/orphan.html', 'orphan')
    await expect(
      worker.scheduled({
        cron: '0 17 * * *',
        scheduledTime: new Date(Date.now() + 48 * 60 * 60 * 1000),
      }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    const quota = await env.DB.prepare(
      "SELECT storage_used_bytes FROM workspaces WHERE id = 'ws-integration'",
    ).first<{ storage_used_bytes: number }>()
    expect(quota?.storage_used_bytes).toBe(1024)
    expect(
      await env.BUCKET.head('artifacts/integration/used.html'),
    ).not.toBeNull()
    expect(
      await env.BUCKET.head('artifacts/integration/orphan.html'),
    ).toBeNull()
  })

  test('cleans expired CLI rotation replay material through scheduled runtime', async () => {
    const env = await worker.getEnv()
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at) VALUES ('ws-rotation-cleanup', NULL, 'Rotation Cleanup', '2026-08-09T00:00:00.000Z', 'free', 100000, 0, '2026-08-09T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id) VALUES ('user-rotation-cleanup', 'rotation-cleanup@example.test', 1, 'Rotation Cleanup', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', 'ws-rotation-cleanup')",
      ),
      env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('session-rotation-cleanup', 'user-rotation-cleanup', 'ass_rotation_cleanup', '2026-08-16T00:00:00.000Z', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO cli_refresh_credentials (id, user_id, token_hash, expires_at, revoked_at, created_at, family_id) VALUES ('next-rotation-cleanup', 'user-rotation-cleanup', 'next-hash', '2027-02-05T00:00:00.000Z', NULL, '2026-08-09T00:00:00.000Z', 'family-rotation-cleanup')",
      ),
      env.DB.prepare(
        "INSERT INTO cli_refresh_credentials (id, user_id, token_hash, expires_at, revoked_at, created_at, family_id, replaced_by_id, rotation_request_hash, rotation_retry_until, rotation_session_id) VALUES ('old-rotation-cleanup', 'user-rotation-cleanup', 'old-hash', '2027-02-05T00:00:00.000Z', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', 'family-rotation-cleanup', 'next-rotation-cleanup', 'request-hash', '2026-08-09T00:10:00.000Z', 'session-rotation-cleanup')",
      ),
    ])

    await expect(
      worker.scheduled({
        cron: '*/5 * * * *',
        scheduledTime: new Date('2026-08-09T00:15:00.000Z'),
      }),
    ).resolves.toMatchObject({ outcome: 'ok' })

    const old = await env.DB.prepare(
      `SELECT family_id, replaced_by_id, rotation_request_hash,
              rotation_retry_until, rotation_session_id
       FROM cli_refresh_credentials
       WHERE id = 'old-rotation-cleanup'`,
    ).first<Record<string, string | null>>()
    expect(old).toMatchObject({
      family_id: 'family-rotation-cleanup',
      replaced_by_id: 'next-rotation-cleanup',
      rotation_request_hash: null,
      rotation_retry_until: null,
      rotation_session_id: null,
    })
  })

  test('runs D1 backup through the production workflow binding and saves R2 output', async () => {
    const env = await worker.getEnv()
    expect(env.D1_REST_API_TOKEN).toBe('test-token')
    let pollCount = 0
    network.use(
      http.post(
        'https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-database/export',
        async ({ request }) => {
          const body = (await request.json()) as { current_bookmark?: string }
          pollCount += 1
          return HttpResponse.json({
            success: true,
            result: body.current_bookmark
              ? {
                  signed_url: 'https://signed.example.test/export.sql',
                  filename: 'export.sql',
                  status: 'complete',
                }
              : { at_bookmark: 'bookmark-1', status: 'active' },
          })
        },
      ),
      http.get('https://signed.example.test/export.sql', () =>
        HttpResponse.text(
          '-- integration export\nCREATE TABLE seeded (id TEXT);\n',
        ),
      ),
    )
    const introspector = await worker.introspectWorkflow('D1_BACKUP_WORKFLOW')
    const route = await worker.fetch('/__workflows/d1-backup', {
      method: 'POST',
      body: JSON.stringify({ reason: 'integration-test' }),
    })
    expect(route.status).toBe(202)
    const { id } = (await route.json()) as { id: string }
    const instance = await worker.introspectWorkflowInstance(
      'D1_BACKUP_WORKFLOW',
      id,
    )
    try {
      await expect(
        instance.waitForStatus('complete', { timeout: 30_000 }),
      ).resolves.not.toThrow()
      await expect(instance.getOutput()).resolves.toMatchObject({
        backup_key: expect.stringContaining('d1/artifactshare/'),
      })
      const output = (await instance.getOutput()) as { backup_key: string }
      const object = await env.BACKUP_BUCKET.get(output.backup_key)
      expect(object).not.toBeNull()
      expect(object?.httpMetadata?.contentType).toBe('application/sql')
      expect(object?.customMetadata).toMatchObject({
        database_id: 'test-database',
        source_filename: 'export.sql',
      })
      await expect(object?.text()).resolves.toContain('CREATE TABLE seeded')
      expect(pollCount).toBeGreaterThanOrEqual(2)
    } finally {
      await instance.dispose()
      await introspector.dispose()
    }
  })

  test('uses the production ArtifactLiveRoom namespace for SQLite-backed WebSocket presence', async () => {
    const env = await worker.getEnv()
    const id = env.ARTIFACT_LIVE.idFromName('integration-room')
    const room = env.ARTIFACT_LIVE.get(id)
    const deadline = Date.now() + 60_000
    const first = await room.fetch(
      `https://artifactshare.com/live?user_id=u1&name=Alice&initial=A&authorization_deadline_ms=${deadline}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(first.status).toBe(101)
    const firstSocket = first.webSocket!
    firstSocket.accept()
    const joined = waitForPresence(firstSocket, ['u1', 'u2'])
    const second = await room.fetch(
      `https://artifactshare.com/live?user_id=u2&name=Bob&initial=B&authorization_deadline_ms=${deadline}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(second.status).toBe(101)
    const secondSocket = second.webSocket!
    secondSocket.accept()
    await joined
    await worker.evictDurableObject('ARTIFACT_LIVE', {
      name: 'integration-room',
      webSockets: 'hibernate',
    })
    const afterEviction = waitForLiveMessage(
      secondSocket,
      (message) => message.type === 'version-changed',
    )
    await room.notifyVersionChanged('version-after-eviction')
    await expect(afterEviction).resolves.toMatchObject({
      type: 'version-changed',
      currentVersionId: 'version-after-eviction',
    })
    const left = waitForPresence(secondSocket, ['u2'])
    firstSocket.close(1000, 'integration test')
    await left
    const wrangler = await readFile(
      new URL('../build/server/wrangler.json', import.meta.url),
      'utf8',
    )
    expect(JSON.parse(wrangler).migrations.at(-1).new_sqlite_classes).toContain(
      'WorkspaceSearchIndex',
    )
    expect(await worker.listDurableObjectIds('ARTIFACT_LIVE')).toHaveLength(1)
    secondSocket.close(1000, 'integration test')
  })

  test('evicts an expired hibernated socket at its original deadline with a valid control still receiving', async () => {
    const env = await worker.getEnv()
    const roomName = 'integration-expiry-room'
    const room = env.ARTIFACT_LIVE.getByName(roomName)
    const expiringDeadline = Date.now() + 8_000
    const controlDeadline = Date.now() + 30_000
    const expiringResponse = await room.fetch(
      `https://artifactshare.com/live?user_id=expiring&name=Expiring&initial=E&authorization_deadline_ms=${expiringDeadline}`,
      { headers: { Upgrade: 'websocket' } },
    )
    const controlResponse = await room.fetch(
      `https://artifactshare.com/live?user_id=control&name=Control&initial=C&authorization_deadline_ms=${controlDeadline}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(expiringResponse.status).toBe(101)
    expect(controlResponse.status).toBe(101)
    const expiring = expiringResponse.webSocket!
    const control = controlResponse.webSocket!
    expiring.accept()
    control.accept()
    await worker.evictDurableObject('ARTIFACT_LIVE', {
      name: roomName,
      webSockets: 'hibernate',
    })

    const beforeExpiry = waitForLiveMessage(
      expiring,
      (message) => message.type === 'version-changed',
    )
    await room.notifyVersionChanged('before-expiry')
    await beforeExpiry

    // No notification or manual alarm invocation may cause this correction.
    await waitForLiveMessage(
      control,
      (message) => {
        const users = message.users as Array<{ id: string }> | undefined
        return (
          Date.now() >= expiringDeadline &&
          message.type === 'presence' &&
          users?.length === 1 &&
          users[0]?.id === 'control'
        )
      },
      Math.max(0, expiringDeadline - Date.now()) + 5_000,
    )
    const controlNotification = waitForLiveMessage(
      control,
      (message) =>
        message.type === 'version-changed' &&
        message.currentVersionId === 'after-expiry',
    )
    const excludedNotification = expect(
      waitForLiveMessage(
        expiring,
        (message) => message.currentVersionId === 'after-expiry',
        300,
      ),
    ).rejects.toThrow('Timed out waiting for live message')
    await room.notifyVersionChanged('after-expiry')
    await controlNotification
    await excludedNotification
    control.close(1000, 'integration test')
  })

  test('reauthorizes membership and independent grants through fresh application handshakes', async () => {
    const owner = {
      workspaceId: 'ws-live-policy',
      userId: 'owner-live-policy',
      email: 'owner-live-policy@example.test',
      name: 'Live Owner',
      sessionToken: 'owner-live-policy-session',
    }
    const grantee = {
      workspaceId: 'ws-live-grantee',
      userId: 'grantee-live-policy',
      email: 'grantee-live-policy@example.test',
      name: 'Live Grantee',
      sessionToken: 'grantee-live-policy-session',
    }
    await seedRuntimeUser(owner)
    await seedRuntimeUser(grantee)
    const env = await worker.getEnv()
    const now = '2026-07-30T00:00:00.000Z'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at, workspace_id
        ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(
        'member-live-policy',
        'member-live-policy@example.test',
        'Live Member',
        now,
        now,
        owner.workspaceId,
      ),
      env.DB.prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at, workspace_id
        ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
      ).bind(
        'dual-live-policy',
        'dual-live-policy@example.test',
        'Live Dual',
        now,
        now,
        owner.workspaceId,
      ),
      env.DB.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES (?, ?, 'member', 'active', ?, ?)`,
      ).bind(owner.workspaceId, 'member-live-policy', now, now),
      env.DB.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES (?, ?, 'member', 'active', ?, ?)`,
      ).bind(owner.workspaceId, 'dual-live-policy', now, now),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).bind(
        'session-member-live-policy',
        'member-live-policy',
        'member-live-policy-session',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).bind(
        'session-dual-live-policy',
        'dual-live-policy',
        'dual-live-policy-session',
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          created_at, updated_at
        ) VALUES (?, ?, 'inbox', ?, ?, 'Live artifacts', ?, ?)`,
      ).bind(
        'container-live-policy',
        owner.workspaceId,
        owner.userId,
        owner.userId,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          current_version_id, created_at, updated_at, container_id
        ) VALUES (?, ?, ?, 'live.html', 'html_page', 'workspace', ?, ?, ?, ?)`,
      ).bind(
        'share-live-policy',
        owner.workspaceId,
        owner.userId,
        'version-live-policy',
        now,
        now,
        'container-live-policy',
      ),
      env.DB.prepare(
        `INSERT INTO versions (
          id, shareable_id, artifact_kind, status, entrypoint_path, r2_key,
          size_bytes, sha256, created_by_id, created_at, published_at
        ) VALUES (?, ?, 'html_page', 'published', '/live.html', ?, 1, 'sha', ?, ?, ?)`,
      ).bind(
        'version-live-policy',
        'share-live-policy',
        'artifacts/live-policy.html',
        owner.userId,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO shareable_grants (
          shareable_id, granted_email, granted_at, granted_by
        ) VALUES (?, ?, ?, ?)`,
      ).bind('share-live-policy', grantee.email, now, owner.userId),
      env.DB.prepare(
        `INSERT INTO shareable_grants (
          shareable_id, granted_email, granted_at, granted_by
        ) VALUES (?, ?, ?, ?)`,
      ).bind(
        'share-live-policy',
        'dual-live-policy@example.test',
        now,
        owner.userId,
      ),
    ])

    const cookies = {
      member: cachedSessionCookies({
        token: 'member-live-policy-session',
        userId: 'member-live-policy',
        email: 'member-live-policy@example.test',
        name: 'Live Member',
        workspaceId: owner.workspaceId,
      }),
      grantee: cachedSessionCookies({
        token: grantee.sessionToken,
        userId: grantee.userId,
        email: grantee.email,
        name: grantee.name,
        workspaceId: grantee.workspaceId,
      }),
      dual: cachedSessionCookies({
        token: 'dual-live-policy-session',
        userId: 'dual-live-policy',
        email: 'dual-live-policy@example.test',
        name: 'Live Dual',
        workspaceId: owner.workspaceId,
      }),
    }
    const connect = (cookie: string) =>
      worker.fetch('/api/shareables/share-live-policy/live', {
        headers: { Cookie: cookie, Upgrade: 'websocket' },
      })

    const member = await connect(cookies.member)
    expect(member.status).toBe(101)
    member.webSocket?.accept()
    member.webSocket?.close(1000, 'integration test')
    await env.DB.prepare(
      `UPDATE workspace_members SET status = 'removed', updated_at = ?
       WHERE workspace_id = ? AND user_id = 'member-live-policy'`,
    )
      .bind(now, owner.workspaceId)
      .run()
    expect((await connect(cookies.member)).status).toBe(404)

    const granted = await connect(cookies.grantee)
    expect(granted.status).toBe(101)
    granted.webSocket?.accept()
    granted.webSocket?.close(1000, 'integration test')
    await env.DB.prepare(
      `DELETE FROM shareable_grants
       WHERE shareable_id = 'share-live-policy' AND granted_email = ?`,
    )
      .bind(grantee.email)
      .run()
    expect((await connect(cookies.grantee)).status).toBe(404)

    const dualBefore = await connect(cookies.dual)
    expect(dualBefore.status).toBe(101)
    dualBefore.webSocket?.accept()
    dualBefore.webSocket?.close(1000, 'integration test')
    await env.DB.prepare(
      `UPDATE workspace_members SET status = 'removed', updated_at = ?
       WHERE workspace_id = ? AND user_id = 'dual-live-policy'`,
    )
      .bind(now, owner.workspaceId)
      .run()
    const dualAfter = await connect(cookies.dual)
    expect(dualAfter.status).toBe(101)
    dualAfter.webSocket?.accept()
    dualAfter.webSocket?.close(1000, 'integration test')
  })

  test('resolves the production OG service binding and alerts tail consumer', async () => {
    const env = await worker.getEnv()
    const response = await env.OG_IMAGE_WORKER.fetch(
      'https://og-worker.internal/share',
    )
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toBe('bad request\n')
  })

  test('isolates D1/R2/KV/DO/Workflow state before reset', async () => {
    const env = await worker.getEnv()
    await env.VIEW_DEDUP.put('integration-isolation', 'must-not-leak')
    await env.BUCKET.put('integration/isolation', 'must-not-leak')
    await env.DB.prepare(
      "INSERT INTO sandbox_token_uses (jti, expires_at) VALUES ('integration-isolation', '2026-08-03T00:00:00.000Z')",
    ).run()
    const isolationRoom = env.ARTIFACT_LIVE.get(
      env.ARTIFACT_LIVE.idFromName('isolation-room'),
    )
    const socketResponse = await isolationRoom.fetch(
      `https://artifactshare.com/live?user_id=u1&name=Alice&initial=A&authorization_deadline_ms=${Date.now() + 60_000}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(socketResponse.status).toBe(101)
    const workflows = await worker.introspectWorkflow('D1_BACKUP_WORKFLOW')
    const workflowResponse = await worker.fetch('/__workflows/d1-backup', {
      method: 'POST',
      body: '{}',
    })
    expect(workflowResponse.status).toBe(202)
    expect(await worker.listDurableObjectIds('ARTIFACT_LIVE')).toHaveLength(1)
    expect(await workflows.get()).toHaveLength(1)
    await workflows.dispose()
  })

  test('reset removed D1/R2/KV/DO/Workflow state and reapplied migrations', async () => {
    const env = await worker.getEnv()
    expect(await env.VIEW_DEDUP.get('integration-isolation')).toBeNull()
    expect(await env.BUCKET.head('integration/isolation')).toBeNull()
    expect(
      await env.DB.prepare(
        "SELECT jti FROM sandbox_token_uses WHERE jti = 'integration-isolation'",
      ).first(),
    ).toBeNull()
    expect(await worker.listDurableObjectIds('ARTIFACT_LIVE')).toEqual([])
    const workflows = await worker.introspectWorkflow('D1_BACKUP_WORKFLOW')
    expect(await workflows.get()).toEqual([])
    await workflows.dispose()
    const value = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).first()
    expect(value).toBeTruthy()
  })

  test('rejects an undeclared outbound request with fail-closed MSW', async () => {
    const response = await worker.fetch('/__integration/outbound')
    expect(response.status).toBe(500)
    expect(await response.text()).toMatch(/unhandled|Unhandled/i)
  })
})

test('workspace search benchmark smoke', async () => {
  const size = Number(process.env.SEARCH_BENCHMARK_SIZE ?? 40)
  const warmup = Number(process.env.SEARCH_BENCHMARK_WARMUP ?? 1)
  const samples = Number(process.env.SEARCH_BENCHMARK_SAMPLES ?? 2)
  const workspace = `search-benchmark-${crypto.randomUUID()}`
  const invoke = async (action: string) => {
    const response = await worker.fetch('/__test/search-index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, workspace, size, warmup, samples }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json()
  }
  await invoke('seedSearch')
  const measurement = (await invoke('measureSearch')) as {
    p95: number
    classes: Array<{
      query: string
      durations: number[]
      p95: number
      result: {
        total: { value: number; relation: string }
        items: Array<{ id: string; groupSize: number }>
      }
    }>
    queries: string[]
    suggestionDurations: number[]
    paletteDurations: number[]
    result: {
      total: { value: number; relation: string }
      items: Array<{ id: string; groupSize: number }>
    }
  }
  expect(Number.isFinite(measurement.p95)).toBe(true)
  expect(measurement.p95).toBeGreaterThanOrEqual(0)
  const groupCount = size - 1 - (size >= 4 ? 1 : 0)
  expect(measurement.result.total).toEqual({
    value: Math.min(groupCount, 1000),
    relation: groupCount > 1000 ? 'gte' : 'eq',
  })
  expect(measurement.result.items.length).toBe(Math.min(20, groupCount))
  expect(
    measurement.result.items.every(
      (item) => item.id !== `${workspace}-${size - 1}` && item.groupSize >= 1,
    ),
  ).toBe(true)
  if (size >= 4)
    expect(
      measurement.result.items.find((item) => item.id === `${workspace}-0`),
    ).toMatchObject({ groupSize: 2 })
  expect(measurement.suggestionDurations).toHaveLength(samples)
  expect(measurement.paletteDurations).toHaveLength(samples)
  // Every hundredth file has the rare terms. The final file is denied; the
  // penultimate file (size >= 4) shares file 0's title and rare-term body.
  const rareGroupCount =
    Math.ceil((size - 1) / 100) - (size >= 4 && (size - 2) % 100 === 0 ? 1 : 0)
  const expectedCounts: Record<string, number> = {
    payload: groupCount,
    rareword: rareGroupCount,
    'rareword partner': rareGroupCount,
    lpha: groupCount,
    '': groupCount,
  }
  expect(measurement.classes.map(({ query }) => query)).toEqual(
    Object.keys(expectedCounts),
  )
  for (const entry of measurement.classes) {
    expect(entry.durations).toHaveLength(samples)
    expect(Number.isFinite(entry.p95)).toBe(true)
    const expectedCount = expectedCounts[entry.query]
    expect(entry.result.total, entry.query).toEqual({
      value: Math.min(expectedCount, 1000),
      relation: expectedCount > 1000 ? 'gte' : 'eq',
    })
    expect(entry.result.items, entry.query).toHaveLength(
      Math.min(20, expectedCount),
    )
    for (const item of entry.result.items) {
      const duplicate =
        size >= 4 &&
        (item.id === `${workspace}-0` || item.id === `${workspace}-${size - 2}`)
      expect(item.groupSize, `${entry.query}: ${item.id}`).toBe(
        duplicate ? 2 : 1,
      )
    }
    if (
      (entry.query === 'rareword' || entry.query === 'rareword partner') &&
      size > 1
    )
      expect(
        entry.result.items.find((item) => item.id === `${workspace}-0`),
        entry.query,
      ).toMatchObject({ groupSize: size >= 4 ? 2 : 1 })
    expect(
      entry.result.items.some((item) => item.id === `${workspace}-${size - 1}`),
    ).toBe(false)
  }
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
  const report = JSON.stringify({
    classes: measurement.classes.map(({ query, durations, p95 }) => ({
      query,
      durations,
      p95,
    })),
    suggestionP95: percentile(measurement.suggestionDurations),
    paletteP95: percentile(measurement.paletteDurations),
    benchmark: 'member-first-page-count',
    size,
    warmup,
    samples,
    p95: measurement.p95,
    runtime: 'Workers',
    eligibilityRate: (size - 1) / size,
  })
  console.log(report)
  if (process.env.SEARCH_BENCHMARK_REPORT)
    await writeFile(process.env.SEARCH_BENCHMARK_REPORT, report + '\n')
}, 600000)

test('workspace search RPC ranks active pages, cross-chunk evidence and literal syntax', async () => {
  const probe = searchProbe(`query-${crypto.randomUUID()}`)
  await probe.seedDocuments([
    { id: 'title', title: 'alpha beta', chunks: [{ body: '' }] },
    { id: 'phrase', title: 'Phrase', chunks: [{ body: 'alpha beta' }] },
    { id: 'all', title: 'Scattered', chunks: [{ body: 'alpha filler beta' }] },
    {
      id: 'split',
      title: 'Split',
      chunks: [{ body: 'alpha' }, { body: 'beta' }],
    },
    {
      id: 'site',
      title: 'Site',
      path: 'a.html',
      chunks: [{ body: 'alpha filler beta' }],
    },
    {
      id: 'site',
      title: 'Site',
      path: 'z.html',
      chunks: [{ body: 'alpha beta' }],
    },
    {
      id: 'staged',
      title: 'alpha beta staging',
      generation: 'staging',
      active: false,
      chunks: [{ body: 'alpha beta' }],
    },
    {
      id: 'old',
      title: 'alpha beta old',
      generation: 'old',
      active: false,
      chunks: [{ body: 'alpha beta' }],
    },
    {
      id: 'old',
      title: 'Unrelated',
      generation: 'new',
      chunks: [{ body: 'unrelated' }],
    },
    { id: 'substring', title: 'alphabet', chunks: [{ body: '' }] },
    { id: 'katakana', title: 'Katakana', chunks: [{ body: 'プログラミング' }] },
    {
      id: 'syntax',
      title: 'Syntax',
      chunks: [{ body: 'a b near title:x or' }],
    },
    { id: 'weight-title', title: 'weight-probe', chunks: [{ body: 'filler' }] },
    { id: 'weight-body', title: 'Body', chunks: [{ body: 'weight probe' }] },
    {
      id: 'weight-script',
      title: 'Script',
      chunks: [{ body: '', script: 'weight probe' }],
    },
    {
      id: 'newest',
      title: 'Newest',
      activityAt: '2026-10-01T00:00:00.000Z',
      chunks: [{ body: '' }],
    },
  ])
  const page = await probe.search({ query: 'alpha beta' })
  expect(page.items[0]).toMatchObject({ id: 'title', tier: 'title', rank: 1 })
  expect(page.items.find((row) => row.id === 'split')).toMatchObject({
    tier: 'phrase',
  })
  expect(page.items.at(-1)).toMatchObject({ id: 'all', tier: 'all' })
  expect(page.items.map((row) => row.id).sort()).toEqual([
    'all',
    'phrase',
    'site',
    'split',
    'title',
  ])
  expect(JSON.stringify(page)).not.toMatch(/score|bm25|staged/)
  expect(await probe.details({ query: 'alpha beta' }, ['site'])).toEqual([
    {
      id: 'site',
      path: 'z.html',
      excerpt: 'alpha beta',
      hasBody: true,
      matchedKeywords: ['alpha', 'beta'],
    },
  ])
  expect(
    (await probe.search({ query: 'weight probe' })).items.map((row) => row.id),
  ).toEqual(['weight-title', 'weight-body', 'weight-script'])
  expect(
    await probe.details({ query: 'weight absent', any: true }, [
      'weight-script',
    ]),
  ).toMatchObject([{ id: 'weight-script', matchedKeywords: ['weight'] }])
  // A single term reuses the page query for its keyword evidence; each term
  // of a longer query still has its own query.
  expect(await probe.detailsSearches({ query: 'alpha' }, ['site'])).toEqual({
    rows: [
      {
        id: 'site',
        path: 'z.html',
        excerpt: 'alpha beta',
        hasBody: true,
        matchedKeywords: ['alpha'],
      },
    ],
    searches: 1,
  })
  expect(
    (await probe.detailsSearches({ query: 'alpha beta' }, ['site'])).searches,
  ).toBe(3)
  expect(
    (await probe.detailsSearches({ query: 'alpha', any: true }, ['site']))
      .searches,
  ).toBe(2)
  expect(
    await probe.details({ query: 'alpha beta', sort: 'newest' }, ['site']),
  ).toEqual([
    {
      id: 'site',
      path: 'z.html',
      excerpt: 'alpha beta',
      hasBody: true,
      matchedKeywords: ['alpha', 'beta'],
    },
  ])
  expect(
    (await probe.search({ query: 'pha' })).items.map((row) => row.id),
  ).toContain('substring')
  expect(
    (await probe.search({ query: 'プログ' })).items.map((row) => row.id),
  ).toEqual(['katakana'])
  for (const query of ['a*', 'NEAR(a b)', 'title:x', 'OR'])
    expect((await probe.search({ query })).items.map((row) => row.id)).toEqual([
      'syntax',
    ])
  expect((await probe.search({ query: '"' })).items).toEqual([])
  expect((await probe.search({ query: '' })).items[0].id).toBe('newest')
  expect(
    (await probe.search({ query: 'alpha', allowedIds: [] })).items,
  ).toEqual([])
  const allowed = Array.from({ length: 2100 }, (_, i) => `missing-${i}`).concat(
    'title',
  )
  expect(
    (await probe.search({ query: 'alpha', allowedIds: allowed })).items.map(
      (row) => row.id,
    ),
  ).toEqual(['title'])
})

test('search cookie routes reject anonymous callers and return the authenticated result shape', async () => {
  for (const path of [
    '/api/search',
    '/api/search-suggestions',
    '/api/search-logs',
  ]) {
    const response = await worker.fetch(path)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  await seedRuntimeUser({
    workspaceId: 'search-route',
    userId: 'search-route-user',
    email: 'search-route@example.com',
    name: 'Search User',
    sessionToken: 'search-route-session',
  })
  const response = await worker.fetch('/api/search?q=alpha', {
    headers: { Cookie: sessionCookie('search-route-session') },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({
    items: [],
    total: { value: 0, relation: 'eq' },
    tier: 'all',
    relaxations: [],
    nextCursor: null,
    searchLogId: expect.any(String),
  })
})

test('external search preserves title-substring and body recall without exposing an ungranted file', async () => {
  await seedRuntimeUser({
    workspaceId: 'search-external',
    userId: 'search-external-user',
    email: 'search-external@example.com',
    name: 'External User',
    sessionToken: 'search-external-session',
  })
  await seedRuntimeUser({
    workspaceId: 'search-source',
    userId: 'search-source-owner',
    email: 'search-source@example.com',
    name: 'Source Owner',
    sessionToken: 'search-source-session',
  })
  const env = await worker.getEnv()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO artifact_containers(id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES('search-source-home','search-source','inbox','search-source-owner','search-source-owner','Home','2026-09-15','2026-09-15')",
    ),
    env.DB.prepare(
      "INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at) VALUES('external-title','search-source','search-source-owner','alphabet','html_page','private','search-source-home','2026-09-15','2026-09-15','2026-09-15'),('external-body','search-source','search-source-owner','Body document','html_page','private','search-source-home','2026-09-15','2026-09-15','2026-09-15'),('external-denied','search-source','search-source-owner','Denied alphabet','html_page','private','search-source-home','2026-09-15','2026-09-15','2026-09-15')",
    ),
    env.DB.prepare(
      "INSERT INTO shareable_grants(shareable_id,granted_email,granted_at,granted_by) VALUES('external-title','search-external@example.com','2026-09-15','search-source-owner'),('external-body','search-external@example.com','2026-09-15','search-source-owner')",
    ),
  ])
  const probe = searchProbe('search-source')
  await probe.seedDocuments([
    { id: 'external-title', title: 'alphabet', chunks: [{ body: '' }] },
    {
      id: 'external-body',
      title: 'Body document',
      chunks: [{ body: 'needletoken in authorized text' }],
    },
    {
      id: 'external-denied',
      title: 'Denied alphabet',
      chunks: [{ body: 'needletoken forbidden excerpt' }],
    },
  ])
  for (const [q, id] of [
    ['pha', 'external-title'],
    ['needletoken', 'external-body'],
  ]) {
    const response = await worker.fetch(`/api/search?q=${q}`, {
      headers: { Cookie: sessionCookie('search-external-session') },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      total: { value: 1, relation: 'eq' },
      items: [{ id }],
    })
    expect(JSON.stringify(result)).not.toMatch(
      /Denied alphabet|forbidden excerpt|external-denied/,
    )
    const suggestion = await worker.fetch(`/api/search-suggestions?q=${q}`, {
      headers: { Cookie: sessionCookie('search-external-session') },
    })
    expect(suggestion.status).toBe(200)
    expect(await suggestion.json()).toMatchObject({ files: [{ id }] })
  }
  // Actual Workers crypto must seal and authenticate both cursor and open tokens.
  const headers = { Cookie: sessionCookie('search-external-session') }
  const firstResponse = await worker.fetch('/api/search?pageSize=1', {
    headers,
  })
  expect(firstResponse.status, await firstResponse.clone().text()).toBe(200)
  const first = await firstResponse.json<{
    searchLogId: string
    nextCursor: string
    items: Array<{ id: string; receipt: string }>
  }>()
  expect(first.items).toMatchObject([{ id: 'external-body' }])
  expect(first.nextCursor).toEqual(expect.any(String))
  const secondResponse = await worker.fetch(
    `/api/search?pageSize=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    { headers },
  )
  expect(secondResponse.status, await secondResponse.clone().text()).toBe(200)
  expect(await secondResponse.json()).toMatchObject({
    searchLogId: first.searchLogId,
    items: [{ id: 'external-title', rank: 2 }],
    nextCursor: null,
  })
  const opened = await worker.fetch(
    `http://localhost/api/search-logs/${first.searchLogId}/opens`,
    {
      method: 'POST',
      headers: {
        ...headers,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ receipt: first.items[0].receipt }),
    },
  )
  expect(opened.status, await opened.clone().text()).toBe(204)
  const logs = await worker.fetch('/api/search-logs', { headers })
  expect(await logs.json()).toMatchObject({
    searches: expect.arrayContaining([
      expect.objectContaining({
        id: first.searchLogId,
        opens: [
          {
            shareableId: 'external-body',
            rank: 1,
            openedAt: expect.any(String),
          },
        ],
      }),
    ]),
  })
})

test('workspace search SQL restricts and recomputes read-only rankings and requires whole boundary tokens', async () => {
  const probe = searchProbe(`sql-search-${crypto.randomUUID()}`)
  await probe.seedDocuments([
    {
      id: 'boundary-kana',
      title: 'Control',
      chunks: [{ body: 'エンジニア募集' }],
    },
    {
      id: 'false',
      title: 'Control',
      chunks: [{ body: 'a alpha' }, { body: 'beta b' }],
    },
    {
      id: 'true',
      title: 'Control',
      chunks: [{ body: 'filler a' }, { body: 'b filler' }],
    },
    {
      id: 'katakana',
      title: 'Control',
      chunks: [{ body: 'フロントエンドエンジニアの募集' }],
    },
    ...Array.from({ length: 2100 }, (_, i) => ({
      id: `noise-${i}`,
      title: 'a b',
      chunks: [{ body: 'a b' }],
    })),
  ])
  const before = await probe.queryState()
  const limited = await probe.search({
    query: 'a b',
    maxResults: 65,
    limit: 64,
  })
  expect(limited).toEqual(await probe.search({ query: 'a b', limit: 64 }))
  const nextLimited = await probe.search({
    query: 'a b',
    maxResults: 129,
    limit: 64,
    cursor: limited.nextCursor!,
  })
  expect(nextLimited).toEqual(
    await probe.search({
      query: 'a b',
      limit: 64,
      cursor: limited.nextCursor!,
    }),
  )
  expect(await probe.queryState()).toEqual(before)
  const criteria = { query: 'a b', allowedIds: ['false', 'true'], limit: 1 }
  const first = await probe.search(criteria)
  expect(first.items).toEqual([
    expect.objectContaining({ id: 'true', tier: 'phrase', rank: 1 }),
  ])
  expect(await probe.search({ ...criteria, maxResults: 2 })).toEqual(first)
  const state = await probe.queryState()
  expect(state).toEqual(before)
  const second = await probe.search({ ...criteria, cursor: first.nextCursor! })
  expect(second.items).toEqual([
    expect.objectContaining({ id: 'false', tier: 'all', rank: 2 }),
  ])
  expect(await probe.queryState()).toEqual(state)
  expect((await probe.search({ ...criteria, limit: 10 })).items).toEqual([
    ...first.items,
    ...second.items,
  ])
  expect(
    (await probe.search({ query: 'フロントエンドエンジ' })).items.map(
      (row) => row.id,
    ),
  ).toEqual(['katakana'])
  expect(
    (await probe.search({ query: 'エンジ' })).items.map((row) => row.id).sort(),
  ).toEqual(['boundary-kana', 'katakana'])
  expect((await probe.search({ query: 'バックエンドエンジ' })).items).toEqual(
    [],
  )
  expect((await probe.search({ query: 'エンジニア 募集' })).items).toEqual([
    expect.objectContaining({ id: 'boundary-kana', tier: 'phrase' }),
    expect.objectContaining({ id: 'katakana', tier: 'all' }),
  ])
  expect(
    await probe.details({ query: 'フロントエンドエンジニア' }, ['katakana']),
  ).toEqual([
    {
      id: 'katakana',
      path: 'index.html',
      excerpt: 'フロントエンドエンジニアの募集',
      hasBody: true,
      matchedKeywords: expect.arrayContaining([
        expect.stringContaining('エンジニア'),
      ]),
    },
  ])
  expect(await probe.queryState()).toEqual(before)
  await probe.seedDocuments([
    {
      id: 'true',
      generation: 'replacement',
      title: 'Unrelated',
      chunks: [{ body: 'unrelated' }],
    },
  ])
  expect((await probe.search(criteria)).items).toEqual([
    expect.objectContaining({ id: 'false', tier: 'all', rank: 1 }),
  ])
  const left = Array.from({ length: 40 }, (_, i) => `term${i.toString(36)}`)
  const whole = [...left, 'rightword'].join(' ')
  expect(whole.length).toBeLessThanOrEqual(500)
  await probe.seedDocuments([
    {
      id: 'long-seam',
      title: 'Boundary',
      chunks: [{ body: left.join(' ') }, { body: 'rightword' }],
    },
    { id: 'inline', title: 'Inline', chunks: [{ body: whole }] },
  ])
  expect(
    (await probe.search({ query: whole })).items
      .map(({ id, tier }) => ({ id, tier }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { id: 'inline', tier: 'phrase' },
    { id: 'long-seam', tier: 'all' },
  ])
  expect(
    (
      await probe.search({ query: [...left.slice(-32), 'rightword'].join(' ') })
    ).items
      .map(({ id, tier }) => ({ id, tier }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual([
    { id: 'inline', tier: 'phrase' },
    { id: 'long-seam', tier: 'phrase' },
  ])
})

test('previous-format construction leaves segmented FTS untouched with constant writes', async () => {
  const writes: number[] = []
  for (const count of [1, 1000]) {
    const workspace = `upgrade-${crypto.randomUUID()}`
    const probe = searchProbe(workspace)
    const index = await worker.getDurableObjectStorage(
      'WORKSPACE_SEARCH_INDEX',
      { name: `${workspace}:0` },
    )
    await probe.seedDocuments(
      Array.from({ length: count }, (_, i) => ({
        id: `old-${i}`,
        title: 'Control',
        chunks: [{ body: 'フロントエンドエンジニア' }],
      })),
    )
    await index.exec('DROP TABLE search_runs')
    await index.exec('UPDATE active SET format=7')
    const schema = await index.exec(
      "SELECT sql FROM sqlite_master WHERE name='search'",
    )
    await worker.evictDurableObject('WORKSPACE_SEARCH_INDEX', {
      name: `${workspace}:0`,
    })
    writes.push((await probe.queryState()).constructorChanges)
    expect(
      await index.exec("SELECT sql FROM sqlite_master WHERE name='search'"),
    ).toEqual(schema)
    expect(await index.exec('SELECT count(*) AS n FROM search_runs')).toEqual([
      { n: 0 },
    ])
    expect((await probe.search({ query: 'エンジ' })).items).toHaveLength(count)
    expect(
      (await probe.search({ query: 'フロントエンドエンジ' })).items,
    ).toEqual([])
  }
  expect(writes[0]).toBeLessThan(30)
  expect(writes[1]).toBe(writes[0])
})

test('allowed-ID sets above 125000 preserve selective recall and remain write-free', async () => {
  const probe = searchProbe(`allowed-${crypto.randomUUID()}`)
  await probe.seedDocuments([
    { id: 'visible', title: 'Needle', chunks: [{ body: 'needle' }] },
    { id: 'denied', title: 'Needle', chunks: [{ body: 'needle' }] },
  ])
  const workspace = `search-benchmark-${crypto.randomUUID()}`
  const ids = Array.from({ length: 130_000 }, (_, i) => `${workspace}-${i}`)
  ids.push('visible')
  expect(
    new TextEncoder().encode(JSON.stringify(ids)).byteLength,
  ).toBeGreaterThan(5 * 1024 * 1024)
  const before = await probe.queryState()
  expect(
    (await probe.search({ query: 'needle', allowedIds: ids })).items,
  ).toEqual([expect.objectContaining({ id: 'visible' })])
  expect(
    await probe.searchResult({
      query: 'needle',
      allowedIds: Array.from({ length: 125_001 }, () => 'x').concat('visible'),
    }),
  ).toMatchObject({ items: [{ id: 'visible' }], nextCursor: null })
  expect(await probe.queryState()).toEqual(before)
})

test('allowed-ID completion pages a ranking beyond a candidate page', async () => {
  const probe = searchProbe(`complete-${crypto.randomUUID()}`)
  const ids = Array.from({ length: 2101 }, (_, i) => `complete-${i}`)
  await probe.seedDocuments(
    ids.map((id) => ({ id, title: 'Complete', chunks: [{ body: 'needle' }] })),
  )
  const criteria = { query: 'needle', allowedIds: ids }
  const first = await probe.search(criteria)
  const second = await probe.search({ ...criteria, cursor: first.nextCursor! })
  const complete = [...first.items, ...second.items]
  expect(first.items).toHaveLength(2000)
  expect(complete).toHaveLength(ids.length)
  expect(complete.map((row) => row.id).sort()).toEqual([...ids].sort())
  expect(second.nextCursor).toBeNull()
  expect(JSON.stringify(complete)).not.toMatch(/score|bm25/)
})

test('workspace search bounds each page group and counts active documents only on request', async () => {
  const probe = searchProbe(`group-bound-${crypto.randomUUID()}`)
  const documents = Array.from({ length: 3001 }, (_, i) => ({
    id: `group-${i}`,
    title: i < 2001 ? `Alpha ${i}` : `Beta ${i}`,
    chunks: [{ body: 'needle' }],
  }))
  await probe.seedDocuments(documents)
  const criteria = { query: 'needle' }
  const first = await probe.search({
    ...criteria,
    includeActiveDocumentCount: true,
  })
  expect(first.activeDocumentCount).toBe(3001)
  expect(
    await probe.search({ ...criteria, cursor: first.nextCursor! }),
  ).not.toHaveProperty('activeDocumentCount')
  const groups = await probe.groupMembers(criteria, ['alpha ', 'beta '])
  expect(groups.items).toHaveLength(3000)
  expect(
    groups.items.filter((row) => Number(row.id.slice(6)) < 2001),
  ).toHaveLength(2000)
  expect(groups.incompleteGroupKeys).toEqual(['alpha '])
  const tail = await probe.groupMembers({ ...criteria, cursor: 2000 }, [
    'alpha ',
  ])
  expect(tail.items).toHaveLength(1)
  expect(tail.incompleteGroupKeys).toEqual([])
  expect(groups.nextCursor).toBeNull()
  expect(groups).not.toHaveProperty('activeDocumentCount')
})

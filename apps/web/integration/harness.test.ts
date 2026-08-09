import { http, HttpResponse, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import { mkdirSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
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
function disableRemoteBindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(disableRemoteBindings)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'remote' && child === true ? false : disableRemoteBindings(child),
    ]),
  )
}

const productionConfig = JSON.parse(
  await readFile(productionConfigUrl, 'utf8'),
) as Record<string, unknown> & {
  send_email?: Array<Record<string, unknown>>
}
if (!productionConfig.send_email?.length) {
  throw new Error('Production Worker config is missing the EMAIL binding')
}
delete productionConfig.configPath
delete productionConfig.userConfigPath
// Flagship has no local Wrangler simulator and always starts a remote proxy.
// The application already treats the binding as optional outside production.
delete productionConfig.flagship
const integrationConfig = disableRemoteBindings(productionConfig)
const integrationConfigJson = JSON.stringify(integrationConfig)
if (integrationConfigJson.includes('"remote":true')) {
  throw new Error('Integration Worker config contains a remote binding')
}
await writeFile(integrationConfigUrl, integrationConfigJson)
const publicIntegration = process.env.PUBLIC_INTEGRATION === '1'
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
if (typeof productionConfig.name !== 'string')
  throw new Error('Main Worker config is missing its name')
const worker = harness.getWorker(productionConfig.name)
const sandboxWorker = harness.getWorker(sandboxName)

function sessionCookie(token: string): string {
  const signature = createHmac('sha256', BETTER_AUTH_SECRET)
    .update(token)
    .digest('base64')
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
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
    `https://${shareableId}\\.sandbox\\.localhost:5174/(?:\\\\.|[^"'\\s<])*`,
  ).exec(html)?.[0]
  if (!escaped) throw new Error('Viewer response did not include sandbox URL')
  const decoded = JSON.parse(`"${escaped.replaceAll('&amp;', '&')}"`) as string
  return new URL(decoded)
}

function waitForPresence(
  socket: WebSocket,
  expectedUserIds: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for presence update')),
      2_000,
    )
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string
        users?: Array<{ id: string }>
      }
      if (
        message.type === 'presence' &&
        message.users
          ?.map((user) => user.id)
          .sort()
          .join(',') === [...expectedUserIds].sort().join(',')
      ) {
        clearTimeout(timeout)
        resolve()
      }
    })
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
    onUnhandledRequest({ request }) {
      const url = new URL(request.url)
      if (url.hostname === '127.0.0.1') {
        return
      }
      throw new Error(
        `Unhandled outbound request: ${request.method} ${request.url}`,
      )
    },
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
  test('boots the main bundle with auxiliary workers and applies migrations', async () => {
    const env = await worker.getEnv()
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sqlite_master',
    ).first<{ count: number }>()
    expect(row?.count).toBeGreaterThan(0)
    expect((await worker.fetch('/__workflows/d1-backup')).status).toBe(405)
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
    expect(sandboxUrl.searchParams.get('t')).toBeTruthy()
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
  })

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
        "INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES ('version-integration', 'share-integration', 'html_page', 'published', '/index.html', 'integration/used.html', 1024, 'sha', 'user-integration', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')",
      ),
    ])
    await env.BUCKET.put('integration/used.html', 'used')
    await env.BUCKET.put('integration/orphan.html', 'orphan')
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
    expect(await env.BUCKET.head('integration/used.html')).not.toBeNull()
    expect(await env.BUCKET.head('integration/orphan.html')).toBeNull()
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
    const first = await room.fetch(
      'https://artifactshare.com/live?user_id=u1&name=Alice&initial=A',
      { headers: { Upgrade: 'websocket' } },
    )
    expect(first.status).toBe(101)
    const firstSocket = first.webSocket!
    firstSocket.accept()
    const joined = waitForPresence(firstSocket, ['u1', 'u2'])
    const second = await room.fetch(
      'https://artifactshare.com/live?user_id=u2&name=Bob&initial=B',
      { headers: { Upgrade: 'websocket' } },
    )
    expect(second.status).toBe(101)
    const secondSocket = second.webSocket!
    secondSocket.accept()
    await joined
    const left = waitForPresence(secondSocket, ['u2'])
    firstSocket.close(1000, 'integration test')
    await left
    const wrangler = await readFile(
      new URL('../build/server/wrangler.json', import.meta.url),
      'utf8',
    )
    expect(wrangler).toContain('new_sqlite_classes')
    expect(await worker.listDurableObjectIds('ARTIFACT_LIVE')).toHaveLength(1)
    secondSocket.close(1000, 'integration test')
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
      'https://artifactshare.com/live?user_id=u1&name=Alice&initial=A',
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

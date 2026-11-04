import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createDb } from '../services/db.server'
import { executeBridgeRequest } from '../services/bridge-publishing.server'

const objects = vi.hoisted(() => new Map<string, Blob>())

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {
      put: vi.fn(async (key: string, body: BlobPart) => {
        objects.set(key, new Blob([body]))
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key)
        return body
          ? {
              body: body.stream(),
              text: () => body.text(),
              size: body.size,
              uploaded: new Date(),
            }
          : null
      }),
      delete: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          objects.delete(key)
      }),
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    },
    ARTIFACT_LIVE: { getByName: () => ({ notifyVersionChanged: vi.fn() }) },
  },
}))

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
})
afterAll(async () => {
  await server.close()
})

// Each race has an otherwise identical successful control on the same binding.
test.each([
  ['mapped', 'publish', 'file'],
  ['fallback', 'publish', 'file'],
  ['mapped', 'update', 'file'],
  ['fallback', 'update', 'file'],
  ['mapped', 'append', 'file'],
  ['fallback', 'append', 'file'],
  ['mapped', 'update', 'static_site'],
  ['fallback', 'update', 'static_site'],
] as const)(
  '%s %s %s revocation immediately before the final D1 batch wins',
  async (destination, operation, contentKind) => {
    const prefix = [destination, operation, contentKind].join('-')
    const ws = `${prefix}-ws`
    const bot = `${prefix}-bot`
    const project = `${prefix}-project`
    const fallbackProject =
      destination === 'mapped' ? `${prefix}-fallback-project` : project
    const bridge = `${prefix}-bridge`
    const profile = `${prefix}-profile`
    const email = `${prefix}@bots.artifactshare.invalid`
    const at = new Date().toISOString()
    const db = createDb(database)
    await db
      .insertInto('workspaces')
      .values({ id: ws, name: prefix, plan: 'team', created_at: at })
      .execute()
    await database
      .prepare(
        `INSERT INTO users (
          id, google_sub, email, email_verified, name, workspace_id, kind,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'Bridge bot', ?, 'bot', ?, ?)`,
      )
      .bind(bot, `${prefix}-sub`, email, ws, at, at)
      .run()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: ws,
        user_id: bot,
        role: 'member',
        status: 'active',
        created_at: at,
        updated_at: at,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: project,
        workspace_id: ws,
        kind: 'project',
        created_by_id: bot,
        name: 'Private',
        base_visibility: 'private',
        created_at: at,
        updated_at: at,
      })
      .execute()
    if (destination === 'mapped') {
      await db
        .insertInto('artifact_containers')
        .values({
          id: fallbackProject,
          workspace_id: ws,
          kind: 'project',
          created_by_id: bot,
          name: 'Fallback',
          base_visibility: 'workspace',
          created_at: at,
          updated_at: at,
        })
        .execute()
    }
    await db
      .insertInto('agent_profiles')
      .values({ id: profile, user_id: bot, workspace_id: ws, created_at: at })
      .execute()
    await db
      .insertInto('bridge_authorities')
      .values({
        id: bridge,
        workspace_id: ws,
        bot_user_id: bot,
        agent_profile_id: profile,
        source_kind: 'qm',
        source_installation_id: prefix,
        external_workspace_id: prefix,
        fallback_project_id: fallbackProject,
        created_at: at,
        updated_at: at,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: `${prefix}-grant`,
        project_container_id: project,
        email,
        role: 'contributor',
        created_at: at,
        updated_at: at,
      })
      .execute()
    if (destination === 'mapped') {
      await db
        .insertInto('bridge_conversations')
        .values({
          id: `${prefix}-mapping`,
          bridge_authority_id: bridge,
          project_id: project,
          conversation_kind: 'private_channel',
          privacy_ceiling: 'private',
          privacy_epoch: 1,
          created_at: at,
          updated_at: at,
        })
        .execute()
      await db
        .insertInto('bridge_conversation_ids')
        .values({
          mapping_id: `${prefix}-mapping`,
          bridge_authority_id: bridge,
          external_conversation_id: 'channel-1',
          created_at: at,
        })
        .execute()
    }
    const authority = {
      kind: 'bridge' as const,
      familyId: `${prefix}-family`,
      bridgeAuthorityId: bridge,
      workspaceId: ws,
      fallbackProjectId: fallbackProject,
      agentProfileId: profile,
      sourceKind: 'qm',
      sourceInstallationId: prefix,
      externalWorkspaceId: prefix,
    }
    const user = {
      id: bot,
      email,
      emailVerified: true,
      workspaceId: ws,
      hd: 'example.com',
    }
    const body = new TextEncoder().encode('# Placement')
    const digest = await crypto.subtle.digest('SHA-256', body)
    const metadata = {
      schema_version: 1,
      request_id: 'control',
      operation: 'publish',
      requested_audience: 'private',
      source: {
        kind: 'qm',
        installation_id: prefix,
        external_workspace_id: prefix,
      },
      conversation: {
        current_id: 'channel-1',
        ids: ['channel-1'],
        kind: destination === 'mapped' ? 'private_channel' : 'dm',
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
      },
      content: {
        kind: contentKind,
        files: [
          {
            index: 0,
            path: contentKind === 'file' ? 'note.md' : 'index.html',
            media_type: contentKind === 'file' ? 'text/markdown' : 'text/html',
            size: body.byteLength,
            sha256: [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
          },
        ],
      },
    }
    const files = [
      new File([body], metadata.content.files[0].path, {
        type: metadata.content.files[0].media_type,
      }),
    ]
    const control = await executeBridgeRequest(
      db,
      authority,
      user,
      metadata,
      files,
      'https://artifactshare.com',
    )
    expect(control.kind).toBe('ok')
    if (control.kind !== 'ok') return
    const mutationMetadata = {
      ...metadata,
      operation,
      ...(operation === 'publish'
        ? {}
        : { target_artifact_id: control.result.artifact.id }),
    }
    if (operation !== 'publish') {
      const allowed = await executeBridgeRequest(
        db,
        authority,
        user,
        { ...mutationMetadata, request_id: 'version-control' },
        files,
        'https://artifactshare.com',
      )
      expect(allowed.kind).toBe('ok')
    }
    const storedObjects = [...objects.keys()]
    const originalArtifact = await db
      .selectFrom('shareables')
      .selectAll()
      .where('id', '=', control.result.artifact.id)
      .executeTakeFirstOrThrow()
    let fired = false
    const inserts = new WeakSet<D1PreparedStatement>()
    const guardedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            const statement = target.prepare(query)
            if (
              !query.startsWith(
                operation === 'publish'
                  ? 'insert into "shareables"'
                  : 'insert into "versions"',
              )
            )
              return statement
            // Track the bound statement actually passed to batch, not earlier binding batches.
            return new Proxy(statement, {
              get(prepared, key) {
                if (key === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values)
                    inserts.add(bound)
                    return bound
                  }
                const value = Reflect.get(prepared, key)
                return typeof value === 'function'
                  ? value.bind(prepared)
                  : value
              },
            })
          }
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => inserts.has(statement))) {
              expect(fired).toBe(false)
              fired = true
              await database
                .prepare(
                  'DELETE FROM project_share_defaults WHERE project_container_id = ?',
                )
                .bind(project)
                .run()
            }
            return target.batch(statements)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const racedDb = createDb(guardedDatabase)
    const rejected = await executeBridgeRequest(
      racedDb,
      authority,
      user,
      { ...mutationMetadata, request_id: 'revoked' },
      files,
      'https://artifactshare.com',
    )
    expect(fired).toBe(true)
    expect(rejected).toEqual({ kind: 'upload-failed' })
    expect([...objects.keys()]).toEqual(storedObjects)
    expect(
      await db
        .selectFrom('shareables')
        .selectAll()
        .where('id', '=', control.result.artifact.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalArtifact)
    expect(
      await db
        .selectFrom('project_share_defaults')
        .select('id')
        .where('project_container_id', '=', project)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('shareables')
        .select('id')
        .where('workspace_id', '=', ws)
        .execute(),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('versions')
        .select('id')
        .where('created_by_id', '=', bot)
        .execute(),
    ).toHaveLength(operation === 'publish' ? 1 : 2)
    expect(
      await db
        .selectFrom('bridge_operations')
        .select('request_id')
        .where('bridge_authority_id', '=', bridge)
        .orderBy('request_id')
        .execute(),
    ).toEqual(
      operation === 'publish'
        ? [{ request_id: 'control' }]
        : [{ request_id: 'control' }, { request_id: 'version-control' }],
    )
    expect(
      await db
        .selectFrom('bridge_requests')
        .select('status')
        .where('bridge_authority_id', '=', bridge)
        .where('request_id', '=', 'revoked')
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'binding' })
    if (destination === 'mapped')
      expect(
        await db
          .selectFrom('bridge_conversations')
          .select('project_id')
          .where('bridge_authority_id', '=', bridge)
          .execute(),
      ).toEqual([{ project_id: project }])
    await racedDb.destroy()
    await db.destroy()
  },
)

test('backfills private mapping grants idempotently and preserves existing roles', async () => {
  const at = '2026-01-01T00:00:00.000Z'
  await database.batch([
    database
      .prepare(
        "INSERT INTO workspaces (id, name, plan, created_at) VALUES ('migration-ws', 'Migration', 'team', ?)",
      )
      .bind(at),
    database
      .prepare(`
      INSERT INTO users (id, google_sub, email, email_verified, name, workspace_id, kind, created_at, updated_at)
      VALUES ('migration-bot', 'migration-sub', 'Migration@bots.artifactshare.invalid', 1,
        'Bot', 'migration-ws', 'bot', ?, ?)
    `)
      .bind(at, at),
    ...['fallback', 'missing', 'viewer', 'manager', 'workspace'].map((name) =>
      database
        .prepare(`
        INSERT INTO artifact_containers (id, workspace_id, kind, created_by_id, name, base_visibility, created_at, updated_at)
        VALUES (?, 'migration-ws', 'project', 'migration-bot', ?, ?, ?, ?)
      `)
        .bind(
          'migration-' + name,
          name,
          ['fallback', 'workspace'].includes(name) ? 'workspace' : 'private',
          at,
          at,
        ),
    ),
    database
      .prepare(`
      INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
      VALUES ('migration-profile', 'migration-bot', 'migration-ws', ?)
    `)
      .bind(at),
    database
      .prepare(`
      INSERT INTO bridge_authorities (id, workspace_id, bot_user_id, agent_profile_id,
        source_kind, source_installation_id, external_workspace_id, fallback_project_id, created_at, updated_at)
      VALUES ('migration-bridge', 'migration-ws', 'migration-bot', 'migration-profile',
        'qm', 'migration-install', 'migration-external', 'migration-fallback', ?, ?)
    `)
      .bind(at, at),
    ...['missing', 'viewer', 'manager', 'workspace'].map((name) =>
      database
        .prepare(`
        INSERT INTO bridge_conversations (id, bridge_authority_id, project_id,
          conversation_kind, privacy_ceiling, privacy_epoch, created_at, updated_at)
        VALUES (?, 'migration-bridge', ?, 'private_channel', 'private', 1, ?, ?)
      `)
        .bind('migration-map-' + name, 'migration-' + name, at, at),
    ),
    ...['viewer', 'manager'].map((role) =>
      database
        .prepare(`
        INSERT INTO project_share_defaults (id, project_container_id, email, role, created_at, updated_at)
        VALUES (?, ?, 'MIGRATION@bots.artifactshare.invalid', ?, ?, ?)
      `)
        .bind('migration-grant-' + role, 'migration-' + role, role, at, at),
    ),
  ])
  const migration = readFileSync(
    new URL(
      '../../db/migrations/0121_bridge_bot_project_grants.sql',
      import.meta.url,
    ),
    'utf8',
  )
  await database.prepare(migration).run()
  const first = await database
    .prepare(`
    SELECT id, project_container_id, email, role FROM project_share_defaults
    WHERE project_container_id LIKE 'migration-%' ORDER BY project_container_id
  `)
    .all()
  expect(first.results).toEqual([
    {
      id: 'migration-grant-manager',
      project_container_id: 'migration-manager',
      email: 'MIGRATION@bots.artifactshare.invalid',
      role: 'manager',
    },
    {
      id: expect.any(String),
      project_container_id: 'migration-missing',
      email: 'migration@bots.artifactshare.invalid',
      role: 'contributor',
    },
    {
      id: 'migration-grant-viewer',
      project_container_id: 'migration-viewer',
      email: 'MIGRATION@bots.artifactshare.invalid',
      role: 'viewer',
    },
  ])
  await database.prepare(migration).run()
  expect(
    (
      await database
        .prepare(`
    SELECT id, project_container_id, email, role FROM project_share_defaults
    WHERE project_container_id LIKE 'migration-%' ORDER BY project_container_id
  `)
        .all()
    ).results,
  ).toEqual(first.results)
})

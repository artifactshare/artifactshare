import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createDb } from '../services/db.server'
import { executeBridgeRequest } from '../services/bridge-publishing.server'

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {
      put: vi.fn(),
      delete: vi.fn(),
      list: async () => ({ objects: [], truncated: false }),
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
test.each(['mapped', 'fallback'] as const)(
  '%s revocation immediately before the final D1 batch wins',
  async (destination) => {
    const prefix = destination
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
        kind: 'file',
        files: [
          {
            index: 0,
            path: 'note.md',
            media_type: 'text/markdown',
            size: body.byteLength,
            sha256: [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
          },
        ],
      },
    }
    const files = [new File([body], 'note.md', { type: 'text/markdown' })]
    const control = await executeBridgeRequest(
      db,
      authority,
      user,
      metadata,
      files,
      'https://artifactshare.com',
    )
    expect(control.kind).toBe('ok')
    let fired = false
    const inserts = new WeakSet<D1PreparedStatement>()
    const guardedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            const statement = target.prepare(query)
            if (!query.startsWith('insert into "shareables"')) return statement
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
      { ...metadata, request_id: 'revoked' },
      files,
      'https://artifactshare.com',
    )
    expect(fired).toBe(true)
    expect(rejected).toEqual({ kind: 'upload-failed' })
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
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('bridge_operations')
        .select('request_id')
        .where('bridge_authority_id', '=', bridge)
        .execute(),
    ).toEqual([{ request_id: 'control' }])
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

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest'

const bucketObjects = vi.hoisted(() => new Set<string>())
const bucketDelete = vi.hoisted(() =>
  vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys])
      bucketObjects.delete(key)
  }),
)

vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() {
      return database
    },
    BUCKET: {
      delete: bucketDelete,
      get: async (key: string) =>
        bucketObjects.has(key)
          ? { body: new Response('<p>Report</p>').body, size: 13 }
          : null,
      put: async (key: string) => {
        bucketObjects.add(key)
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...bucketObjects]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    },
    ['BETTER_AUTH_' + 'SECRET']: 'd1-test-secret-with-enough-entropy',
  },
}))

import { createDb } from '../services/db.server'
import {
  beginStaticSiteBundleUploadSession,
  beginStaticSiteBundleVersionUploadSession,
} from '../services/shareables.server'
import { uploadShareable, createVersion, publish } from '../modules/publish'
import type { CliAuthority } from '../services/cli-authority.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database

const at = '2026-09-17T00:00:00.000Z'

beforeAll(async () => {
  await server.listen()
  database = (await worker.getEnv()).DB
  // Production starts at the clean rebuild baseline. The older historical
  // migrations retain columns intentionally removed by that cutover.
  const baseline = '0055_d1_name_cutover_clean_rebuild_v2.sql'
  const baselineSql = readFileSync(
    new URL(`../../db/baselines/${baseline}`, import.meta.url),
    'utf8',
  )
  await database.batch(
    unstable_splitSqlQuery(baselineSql)
      .filter((statement) => !/^\s*PRAGMA/iu.test(statement))
      .map((statement) => database.prepare(statement)),
  )
  for (const name of readdirSync(
    new URL('../../db/migrations/', import.meta.url),
  ).sort()) {
    if (name <= baseline || !name.endsWith('.sql')) continue
    const migration = readFileSync(
      new URL(`../../db/migrations/${name}`, import.meta.url),
      'utf8',
    )
    await database.batch(
      unstable_splitSqlQuery(migration).map((statement) =>
        database.prepare(statement),
      ),
    )
  }
})

afterAll(async () => {
  await server.close()
})

function beforeFirstBatch(
  source: D1Database,
  action: () => Promise<unknown>,
): D1Database {
  let pending = true
  return new Proxy(source, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false
            await action()
          }
          return await target.batch(statements)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function seedProject(prefix: string) {
  await database.batch([
    database
      .prepare(
        `INSERT INTO workspaces (
          id, name, plan, external_posting_enabled, created_at
        ) VALUES (?, ?, 'team', 1, ?)`,
      )
      .bind(`${prefix}-ws`, prefix, at),
    database
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at,
          workspace_id, kind
        ) VALUES (?, ?, 1, ?, ?, ?, ?, 'human')`,
      )
      .bind(
        `${prefix}-owner`,
        `${prefix}@example.com`,
        prefix,
        at,
        at,
        `${prefix}-ws`,
      ),
    database
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, created_by_id, name, created_at, updated_at
        ) VALUES (?, ?, 'project', ?, ?, ?, ?)`,
      )
      .bind(
        `${prefix}-project`,
        `${prefix}-ws`,
        `${prefix}-owner`,
        prefix,
        at,
        at,
      ),
  ])
}

async function placementSnapshot(workspaceId: string) {
  const selects = [
    'SELECT * FROM shareables WHERE workspace_id = ?',
    'SELECT * FROM versions WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?))',
    'SELECT * FROM shareable_grants WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM project_pins WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM artifact_keys WHERE workspace_id = ?',
    'SELECT * FROM events WHERE workspace_id = ?',
    'SELECT * FROM slack_notification_outbox WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM link_publication_attempts WHERE workspace_id = ?',
    'SELECT * FROM link_publications WHERE workspace_id = ?',
  ]
  return (
    await database.batch(
      selects.map((query) => database.prepare(query).bind(workspaceId)),
    )
  ).map((result) => result.results)
}

describe(
  'ordinary bot destinations at the real D1 commit boundary',
  { concurrent: false },
  () => {
    it.each([
      'file-create',
      'site-create',
      'file-version',
      'site-version',
      'key-file',
      'key-site',
      'append',
    ] as const)(
      'enforces live approval, credential and placement for %s',
      async (operation) => {
        const { createWorkspaceBot, listWorkspaceBots, stopWorkspaceBot } =
          await import('../services/bot-members.server')
        const { updateWorkspaceBotDestinations } =
          await import('../services/bot-destinations.server')
        for (const change of [
          'allowed',
          'remove',
          'stop',
          'credential',
          'archive',
          'grant',
        ] as const) {
          const prefix = `bot-${operation}-${change}`
          await seedProject(prefix)
          const actor = { id: `${prefix}-owner`, workspaceId: `${prefix}-ws` }
          const a = `${prefix}-project`
          const b = `${prefix}-private`
          await database.batch([
            database
              .prepare(
                "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'owner','active',?,?)",
              )
              .bind(actor.workspaceId, actor.id, at, at),
            database
              .prepare(
                "INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES (?,?,'project','Management','private',?,?,?)",
              )
              .bind(b, actor.workspaceId, actor.id, at, at),
          ])
          const db = createDb(database)
          const bot = await createWorkspaceBot(db, actor, {
            name: 'Reports',
            projectId: a,
            projectIds: [a, b],
          })
          if (bot.kind !== 'ok') throw new Error(bot.kind)
          const family = await db
            .selectFrom('cli_family_authorities')
            .selectAll()
            .where('user_id', '=', bot.botUserId)
            .executeTakeFirstOrThrow()
          const authority: Extract<CliAuthority, { kind: 'agent' }> = {
            kind: 'agent',
            familyId: family.family_id,
            workspaceId: actor.workspaceId,
            projectId: a,
            projectNameSnapshot: prefix,
            agentProfileId: family.agent_profile_id!,
            ordinaryBot: true,
          }
          const user = {
            id: bot.botUserId,
            workspaceId: actor.workspaceId,
            email: bot.email,
            emailVerified: true,
            hd: 'example.com',
          }
          const file = () =>
            new File(['<p>Report</p>'], 'index.html', { type: 'text/html' })
          let artifactId = ''
          let versionId = ''
          let keyId: string | null = null
          if (!operation.endsWith('create')) {
            if (operation.includes('site')) {
              const begun = await beginStaticSiteBundleUploadSession(
                db,
                user,
                b,
                'stable',
                { authority, agentProfileId: authority.agentProfileId },
              )
              if (begun.kind !== 'ok') throw new Error(begun.kind)
              await begun.session.addFile(file())
              const created = await begun.session.commit('project')
              if (created.kind !== 'ok') throw new Error(created.kind)
              artifactId = created.id
              versionId = created.versionId
            } else {
              const created = await uploadShareable(
                db,
                user,
                file(),
                'project',
                [],
                b,
                'stable',
                { authority, agentProfileId: authority.agentProfileId },
              )
              if (created.kind !== 'ok') throw new Error(created.kind)
              artifactId = created.id
              versionId = created.versionId
            }
            keyId = (
              await db
                .selectFrom('artifact_keys')
                .select('id')
                .where('shareable_id', '=', artifactId)
                .executeTakeFirstOrThrow()
            ).id
          }
          const before = await placementSnapshot(actor.workspaceId)
          const objects = [...bucketObjects].sort()
          const usage = await db
            .selectFrom('workspaces')
            .select('storage_used_bytes')
            .where('id', '=', actor.workspaceId)
            .executeTakeFirstOrThrow()
          let intercepted = false
          const guarded = createDb(
            beforeFirstBatch(database, async () => {
              intercepted = true
              if (change === 'remove') {
                const inventory = (
                  await listWorkspaceBots(db, actor.workspaceId)
                )[0]!
                expect(
                  await updateWorkspaceBotDestinations(db, actor, {
                    botUserId: user.id,
                    projectId: a,
                    projectIds: [a],
                    revision: inventory.destinationRevision!,
                  }),
                ).toEqual({ kind: 'ok' })
              }
              if (change === 'stop')
                expect(await stopWorkspaceBot(db, actor, user.id)).toEqual({
                  kind: 'ok',
                })
              if (change === 'credential')
                await db
                  .updateTable('cli_refresh_credentials')
                  .set({ revoked_at: at })
                  .where('family_id', '=', authority.familyId)
                  .execute()
              if (change === 'archive')
                await db
                  .updateTable('artifact_containers')
                  .set({ archived_at: at })
                  .where('id', '=', b)
                  .execute()
              if (change === 'grant')
                await db
                  .deleteFrom('project_share_defaults')
                  .where('project_container_id', '=', b)
                  .execute()
            }),
          )
          try {
            let result: { kind: string }
            if (operation === 'append')
              result = await publish({
                db: guarded,
                actor: {
                  kind: 'bot',
                  user: { ...user, kind: 'bot', selfUploadEnabled: true },
                  authority,
                },
                target: { kind: 'append', artifactId },
                content: { kind: 'append', content: '<p>More</p>' },
              })
            else if (operation === 'file-create')
              result = await uploadShareable(
                guarded,
                user,
                file(),
                'project',
                [],
                b,
                'new',
                { authority, agentProfileId: authority.agentProfileId },
              )
            else if (operation === 'site-create') {
              const begun = await beginStaticSiteBundleUploadSession(
                guarded,
                user,
                b,
                'new',
                { authority, agentProfileId: authority.agentProfileId },
              )
              if (begun.kind !== 'ok') throw new Error(begun.kind)
              await begun.session.addFile(file())
              result = await begun.session.commit('project')
            } else if (operation.includes('site')) {
              const begun = await beginStaticSiteBundleVersionUploadSession(
                guarded,
                user,
                artifactId,
                operation === 'key-site' ? keyId : null,
                {
                  authority,
                  agentProfileId: authority.agentProfileId,
                  expectedCurrentVersionId: versionId,
                },
              )
              if (begun.kind !== 'ok') throw new Error(begun.kind)
              await begun.session.addFile(file())
              result = await begun.session.commitVersion()
            } else
              result = await createVersion({
                db: guarded,
                user,
                shareableId: artifactId,
                file: file(),
                authority,
                agentProfileId: authority.agentProfileId,
                expectedCurrentVersionId: versionId,
                touchArtifactKeyId:
                  operation === 'key-file' ? keyId! : undefined,
              })
            expect(intercepted).toBe(true)
            expect(result.kind).toBe(
              change === 'allowed'
                ? 'ok'
                : operation.endsWith('create')
                  ? 'invalid-container'
                  : 'not-found',
            )
            if (change !== 'allowed') {
              // Management audits are expected; publication state and accounting are not.
              const after = await placementSnapshot(actor.workspaceId)
              expect(after).toEqual(before)
              expect([...bucketObjects].sort()).toEqual(objects)
              expect(
                await db
                  .selectFrom('workspaces')
                  .select('storage_used_bytes')
                  .where('id', '=', actor.workspaceId)
                  .executeTakeFirstOrThrow(),
              ).toEqual(usage)
            }
            if (change === 'remove')
              expect(
                (
                  await uploadShareable(
                    db,
                    user,
                    file(),
                    'project',
                    [],
                    a,
                    null,
                    { authority },
                  )
                ).kind,
              ).toBe('ok')
          } finally {
            await guarded.destroy()
            await db.destroy()
          }
        }
      },
    )
  },
)

test.each(['demotion', 'stop', 'edit', 'reissue', 'quota', 'archive'] as const)(
  'destination edit rolls back on concurrent %s',
  async (change) => {
    const {
      createWorkspaceBot,
      listWorkspaceBots,
      stopWorkspaceBot,
      reissueWorkspaceBotCredential,
    } = await import('../services/bot-members.server')
    const { updateWorkspaceBotDestinations } =
      await import('../services/bot-destinations.server')
    const prefix = `edit-${change}`
    await seedProject(prefix)
    const actor = { id: `${prefix}-owner`, workspaceId: `${prefix}-ws` }
    const a = `${prefix}-project`
    const b = `${prefix}-private`
    await database.batch([
      database
        .prepare(
          "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'owner','active',?,?)",
        )
        .bind(actor.workspaceId, actor.id, at, at),
      database
        .prepare(
          "INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES (?,?,'project','Private','private',?,?,?)",
        )
        .bind(b, actor.workspaceId, actor.id, at, at),
    ])
    const db = createDb(database)
    const created = await createWorkspaceBot(db, actor, {
      name: 'Reports',
      projectId: a,
    })
    if (created.kind !== 'ok') throw new Error(created.kind)
    const bot = (await listWorkspaceBots(db, actor.workspaceId))[0]!
    const guarded = createDb(
      beforeFirstBatch(database, async () => {
        if (change === 'demotion')
          await db
            .updateTable('workspace_members')
            .set({ role: 'member' })
            .where('user_id', '=', actor.id)
            .execute()
        if (change === 'stop') await stopWorkspaceBot(db, actor, bot.id)
        if (change === 'reissue')
          expect(
            (await reissueWorkspaceBotCredential(db, actor, bot.id)).kind,
          ).toBe('ok')
        if (change === 'edit')
          expect(
            await updateWorkspaceBotDestinations(db, actor, {
              botUserId: bot.id,
              projectId: a,
              projectIds: [a],
              revision: bot.destinationRevision!,
            }),
          ).toEqual({ kind: 'ok' })
        if (change === 'archive')
          await db
            .updateTable('artifact_containers')
            .set({ archived_at: at })
            .where('id', '=', b)
            .execute()
        if (change === 'quota') {
          for (let i = 0; i < 50; i++)
            await db
              .insertInto('project_share_defaults')
              .values({
                id: `${prefix}-${i}`,
                project_container_id: b,
                email: `person${i}@example.com`,
                role: 'viewer',
                created_by_id: actor.id,
                created_at: at,
                updated_at: at,
              })
              .execute()
        }
      }),
    )
    try {
      expect(
        await updateWorkspaceBotDestinations(guarded, actor, {
          botUserId: bot.id,
          projectId: b,
          projectIds: [a, b],
          revision: bot.destinationRevision!,
        }),
      ).toEqual({ kind: 'bot-conflict' })
      expect(
        await db
          .selectFrom('bot_destination_projects')
          .select('project_id')
          .where('project_id', '=', b)
          .execute(),
      ).toEqual([])
      expect(
        await db
          .selectFrom('project_share_defaults')
          .select('id')
          .where('email', '=', created.email)
          .where('project_container_id', '=', b)
          .execute(),
      ).toEqual([])
      const audits = await db
        .selectFrom('audit_events')
        .select('detail')
        .where('workspace_id', '=', actor.workspaceId)
        .where('action', '=', 'bot.destinations.update')
        .execute()
      expect(audits).toHaveLength(change === 'edit' ? 1 : 0)
    } finally {
      await guarded.destroy()
      await db.destroy()
    }
  },
)

test('migration backfills only ordinary bot families without changing issued authentication', async () => {
  await server.reset()
  database = (await worker.getEnv()).DB
  const baseline = '0055_d1_name_cutover_clean_rebuild_v2.sql'
  await database.batch(
    unstable_splitSqlQuery(
      readFileSync(
        new URL(`../../db/baselines/${baseline}`, import.meta.url),
        'utf8',
      ),
    )
      .filter((statement) => !/^\s*PRAGMA/iu.test(statement))
      .map((statement) => database.prepare(statement)),
  )
  for (const name of readdirSync(
    new URL('../../db/migrations/', import.meta.url),
  ).sort()) {
    if (name <= baseline || name >= '0123' || !name.endsWith('.sql')) continue
    await database.batch(
      unstable_splitSqlQuery(
        readFileSync(
          new URL(`../../db/migrations/${name}`, import.meta.url),
          'utf8',
        ),
      ).map((statement) => database.prepare(statement)),
    )
  }
  await seedProject('migration')
  for (const kind of ['ordinary', 'stopped', 'bridge', 'human']) {
    await database.batch([
      database
        .prepare(
          "INSERT INTO users (id,email,email_verified,name,kind,workspace_id,created_at,updated_at,bot_stopped_at) VALUES (?,?,1,?,?,'migration-ws',?,?,?)",
        )
        .bind(
          kind,
          `${kind}@bots.artifactshare.invalid`,
          kind,
          kind === 'human' ? 'human' : 'bot',
          at,
          at,
          kind === 'stopped' ? at : null,
        ),
      database
        .prepare(
          "INSERT INTO agent_profiles (id,user_id,workspace_id,created_at) VALUES (?,?,'migration-ws',?)",
        )
        .bind(`${kind}-profile`, kind, at),
    ])
    if (kind === 'bridge')
      await database
        .prepare(
          "INSERT INTO bridge_authorities (id,workspace_id,bot_user_id,agent_profile_id,source_kind,source_installation_id,external_workspace_id,fallback_project_id,created_at,updated_at) VALUES ('bridge','migration-ws','bridge','bridge-profile','qm','test','test','migration-project',?,?)",
        )
        .bind(at, at)
        .run()
    await database.batch([
      database
        .prepare(
          "INSERT INTO cli_family_authorities (family_id,user_id,preset,workspace_id,project_id,project_name_snapshot,agent_profile_id,bridge_authority_id,status,created_at,updated_at) VALUES (?,?,'agent','migration-ws','migration-project','Original name',?,?,?, ?,?)",
        )
        .bind(
          kind,
          kind,
          `${kind}-profile`,
          kind === 'bridge' ? kind : null,
          kind === 'stopped' ? 'revoked' : 'active',
          at,
          at,
        ),
      database
        .prepare(
          "INSERT INTO cli_refresh_credentials (id,user_id,token_hash,family_id,expires_at,created_at) VALUES (?,?,?,?,'2099-01-01',?)",
        )
        .bind(
          kind,
          kind,
          createHash('sha256').update(`${kind}-refresh-token`).digest('hex'),
          kind,
          at,
        ),
      database
        .prepare(
          "INSERT INTO sessions (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,'2099-01-01',?,?)",
        )
        .bind(kind, kind, `${kind}-token`, at, at),
      database
        .prepare(
          "INSERT INTO cli_session_authorities (session_id,family_id,kind,preset,workspace_id,project_id,agent_profile_id,bearer_only,created_at) VALUES (?,?,'family','agent','migration-ws','migration-project',?,1,?)",
        )
        .bind(kind, kind, `${kind}-profile`, at),
    ])
  }
  const tables = [
    'cli_family_authorities',
    'cli_refresh_credentials',
    'cli_session_authorities',
    'sessions',
  ]
  const before = await Promise.all(
    tables.map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  )
  const migration = readFileSync(
    new URL(
      '../../db/migrations/0123_bot_destination_projects.sql',
      import.meta.url,
    ),
    'utf8',
  )
  await database.batch(
    unstable_splitSqlQuery(migration).map((statement) =>
      database.prepare(statement),
    ),
  )
  const after = await Promise.all(
    tables.map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  )
  expect(after.map((result) => result.results)).toEqual(
    before.map((result) => result.results),
  )
  expect(
    (
      await database
        .prepare('SELECT * FROM bot_destination_projects ORDER BY family_id')
        .all()
    ).results,
  ).toEqual(
    ['ordinary', 'stopped'].map((family_id) => ({
      family_id,
      project_id: 'migration-project',
      project_name_snapshot: 'Original name',
      created_at: at,
    })),
  )
  const db = createDb(database)
  const actor = { id: 'migration-owner', workspaceId: 'migration-ws' }
  await database.batch([
    database
      .prepare(
        "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('migration-ws','migration-owner','owner','active',?,?)",
      )
      .bind(at, at),
    database
      .prepare(
        "INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES ('migration-b','migration-ws','project','Private B','private','migration-owner',?,?)",
      )
      .bind(at, at),
  ])
  const { resolveCliAuthorityBySessionToken } =
    await import('../services/cli-authority.server')
  const { refreshCliSession } =
    await import('../services/cli-refresh-credentials.server')
  const { listWorkspaceBots } = await import('../services/bot-members.server')
  const { updateWorkspaceBotDestinations } =
    await import('../services/bot-destinations.server')
  const original = await resolveCliAuthorityBySessionToken('ordinary-token')
  if (!original || original === 'denied' || original.kind !== 'agent')
    throw new Error('migrated session did not authenticate')
  expect(original.projectId).toBe('migration-project')
  const inventory = (await listWorkspaceBots(db, actor.workspaceId)).find(
    (bot) => bot.id === 'ordinary',
  )!
  expect(
    await updateWorkspaceBotDestinations(db, actor, {
      botUserId: 'ordinary',
      projectId: 'migration-project',
      projectIds: ['migration-project', 'migration-b'],
      revision: inventory.destinationRevision!,
    }),
  ).toEqual({ kind: 'ok' })
  const refreshed = await refreshCliSession(
    db,
    'ordinary-refresh-token',
    'migration-rotation',
    'migration-test-secret',
  )
  if (refreshed.kind !== 'ok') throw new Error(refreshed.kind)
  const user = {
    id: 'ordinary',
    workspaceId: actor.workspaceId,
    email: 'ordinary@bots.artifactshare.invalid',
    emailVerified: true,
    hd: 'example.com',
  }
  const file = () =>
    new File(['<p>Migrated report</p>'], 'index.html', { type: 'text/html' })
  for (const token of ['ordinary-token', refreshed.sessionToken]) {
    const authority = await resolveCliAuthorityBySessionToken(token)
    if (!authority || authority === 'denied' || authority.kind !== 'agent')
      throw new Error('existing authentication lost')
    expect(authority).toMatchObject({
      projectId: 'migration-project',
      approvedProjects: expect.arrayContaining([
        expect.objectContaining({ id: 'migration-project' }),
        expect.objectContaining({ id: 'migration-b' }),
      ]),
    })
    for (const project of ['migration-project', 'migration-b']) {
      const created = await uploadShareable(
        db,
        user,
        file(),
        'project',
        [],
        project,
        null,
        { authority, agentProfileId: authority.agentProfileId },
      )
      if (created.kind !== 'ok') throw new Error(created.kind)
      expect(
        (
          await createVersion({
            db,
            user,
            shareableId: created.id,
            file: file(),
            authority,
            agentProfileId: authority.agentProfileId,
            expectedCurrentVersionId: created.versionId,
          })
        ).kind,
      ).toBe('ok')
    }
  }
  const latest = (await listWorkspaceBots(db, actor.workspaceId)).find(
    (bot) => bot.id === 'ordinary',
  )!
  expect(
    await updateWorkspaceBotDestinations(db, actor, {
      botUserId: 'ordinary',
      projectId: 'migration-project',
      projectIds: ['migration-project'],
      revision: latest.destinationRevision!,
    }),
  ).toEqual({ kind: 'ok' })
  const secondary = await db
    .selectFrom('shareables')
    .select(['id', 'current_version_id'])
    .where('container_id', '=', 'migration-b')
    .execute()
  for (const token of ['ordinary-token', refreshed.sessionToken]) {
    const authority = await resolveCliAuthorityBySessionToken(token)
    if (!authority || authority === 'denied' || authority.kind !== 'agent')
      throw new Error('remaining primary lost authentication')
    for (const artifact of secondary) {
      expect(
        (
          await createVersion({
            db,
            user,
            shareableId: artifact.id,
            file: file(),
            authority,
            agentProfileId: authority.agentProfileId,
            expectedCurrentVersionId: artifact.current_version_id!,
          })
        ).kind,
      ).toBe('not-found')
    }
    expect(
      (
        await uploadShareable(
          db,
          user,
          file(),
          'project',
          [],
          'migration-b',
          null,
          { authority, agentProfileId: authority.agentProfileId },
        )
      ).kind,
    ).toBe('invalid-container')
    expect(
      (
        await uploadShareable(
          db,
          user,
          file(),
          'project',
          [],
          'migration-project',
          null,
          { authority, agentProfileId: authority.agentProfileId },
        )
      ).kind,
    ).toBe('ok')
  }
  expect(
    (
      await uploadShareable(
        db,
        user,
        file(),
        'project',
        [],
        'migration-b',
        null,
        { authority: original, agentProfileId: original.agentProfileId },
      )
    ).kind,
  ).toBe('invalid-container')
  await db.destroy()
})

test('private destination audience and bot read/comment access survive posting approval removal', async () => {
  const { createWorkspaceBot, listWorkspaceBots } =
    await import('../services/bot-members.server')
  const { updateWorkspaceBotDestinations } =
    await import('../services/bot-destinations.server')
  const { authorizeAgentArtifactRead, isAgentPublishableDestination } =
    await import('../services/agent-scope.server')
  const { loadShareableViewAccess, loadCommentAccess } =
    await import('../services/comments.server')
  const prefix = 'private-audience'
  await seedProject(prefix)
  const db = createDb(database)
  const actor = { id: `${prefix}-owner`, workspaceId: `${prefix}-ws` }
  const a = `${prefix}-project`
  const b = `${prefix}-private`
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: actor.workspaceId,
      user_id: actor.id,
      role: 'owner',
      status: 'active',
      created_at: at,
      updated_at: at,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: b,
      workspace_id: actor.workspaceId,
      kind: 'project',
      name: 'Private reports',
      base_visibility: 'private',
      created_by_id: actor.id,
      created_at: at,
      updated_at: at,
    })
    .execute()
  const created = await createWorkspaceBot(db, actor, {
    name: 'Reports',
    projectId: a,
    projectIds: [a, b],
  })
  if (created.kind !== 'ok') throw new Error(created.kind)
  const family = await db
    .selectFrom('cli_family_authorities')
    .selectAll()
    .where('user_id', '=', created.botUserId)
    .executeTakeFirstOrThrow()
  const authority: Extract<CliAuthority, { kind: 'agent' }> = {
    kind: 'agent',
    ordinaryBot: true,
    familyId: family.family_id,
    workspaceId: actor.workspaceId,
    projectId: a,
    projectNameSnapshot: 'Reports',
    agentProfileId: family.agent_profile_id!,
  }
  const user = {
    id: created.botUserId,
    workspaceId: actor.workspaceId,
    email: created.email,
    emailVerified: true,
    hd: 'example.com',
    name: 'Reports',
    image: null,
    msTenantId: null,
    locale: 'en' as const,
    kind: 'bot' as const,
  }
  const report = await uploadShareable(
    db,
    user,
    new File(['Report'], 'report.html', { type: 'text/html' }),
    'project',
    [],
    b,
    undefined,
    { authority, agentProfileId: authority.agentProfileId },
  )
  if (report.kind !== 'ok') throw new Error(report.kind)
  for (const role of ['admin', 'audience', 'excluded'] as const) {
    await db
      .insertInto('users')
      .values({
        id: `${prefix}-${role}`,
        workspace_id: actor.workspaceId,
        email: `${role}@example.com`,
        email_verified: 1,
        name: role,
        created_at: at,
        updated_at: at,
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: actor.workspaceId,
        user_id: `${prefix}-${role}`,
        role: role === 'admin' ? 'admin' : 'member',
        status: 'active',
        created_at: at,
        updated_at: at,
      })
      .execute()
  }
  await db
    .insertInto('project_share_defaults')
    .values({
      id: `${prefix}-grant`,
      project_container_id: b,
      email: 'audience@example.com',
      role: 'viewer',
      created_by_id: actor.id,
      created_at: at,
      updated_at: at,
    })
    .execute()
  for (const role of ['admin', 'audience', 'excluded'] as const) {
    const viewer = {
      ...user,
      id: `${prefix}-${role}`,
      email: `${role}@example.com`,
    }
    const access = await loadShareableViewAccess(db, viewer, report.id)
    if (role === 'excluded') expect(access).toBeNull()
    else expect(access?.id).toBe(report.id)
  }
  expect((await loadShareableViewAccess(db, user, report.id))?.id).toBe(
    report.id,
  )
  const inventory = (await listWorkspaceBots(db, actor.workspaceId))[0]!
  expect(
    await updateWorkspaceBotDestinations(db, actor, {
      botUserId: user.id,
      projectId: a,
      projectIds: [a],
      revision: inventory.destinationRevision!,
    }),
  ).toEqual({ kind: 'ok' })
  expect(await isAgentPublishableDestination(db, user, authority, b)).toBe(
    false,
  )
  const read = await authorizeAgentArtifactRead(db, user, authority, report.id)
  expect(read.kind).toBe('authorized')
  if (read.kind !== 'authorized') throw new Error(read.kind)
  expect(
    (await loadCommentAccess(db, user, report.id, read.authorization))
      ?.shareableId,
  ).toBe(report.id)
  expect(
    await db
      .selectFrom('project_share_defaults')
      .select('id')
      .where('project_container_id', '=', b)
      .where('email', '=', user.email)
      .executeTakeFirst(),
  ).toBeDefined()
  await db.destroy()
})

test.each(['replace-primary', 'archive-secondary', 'revoke-secondary-grant'])(
  'existing bot session placement follows %s',
  async (change) => {
    const { createWorkspaceBot, listWorkspaceBots } =
      await import('../services/bot-members.server')
    const { updateWorkspaceBotDestinations } =
      await import('../services/bot-destinations.server')
    const { refreshCliSession } =
      await import('../services/cli-refresh-credentials.server')
    const { resolveCliAuthorityBySessionToken } =
      await import('../services/cli-authority.server')
    const { deleteProjectContainer } =
      await import('../services/projects.server')
    const prefix = `session-${change}`
    await seedProject(prefix)
    const actor = { id: `${prefix}-owner`, workspaceId: `${prefix}-ws` }
    const a = `${prefix}-project`
    const b = `${prefix}-private`
    await database.batch([
      database
        .prepare(
          "INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'owner','active',?,?)",
        )
        .bind(actor.workspaceId, actor.id, at, at),
      database
        .prepare(
          "INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES (?,?,'project','Private B','private',?,?,?)",
        )
        .bind(b, actor.workspaceId, actor.id, at, at),
    ])
    const db = createDb(database)
    const bot = await createWorkspaceBot(db, actor, {
      name: 'Reports',
      projectId: a,
      projectIds: [a, b],
    })
    if (bot.kind !== 'ok') throw new Error(bot.kind)
    const session = await refreshCliSession(
      db,
      bot.token,
      prefix,
      'test-secret',
    )
    if (session.kind !== 'ok') throw new Error(session.kind)
    if (change === 'replace-primary') {
      const inventory = (await listWorkspaceBots(db, actor.workspaceId))[0]!
      expect(
        await updateWorkspaceBotDestinations(db, actor, {
          botUserId: bot.botUserId,
          projectId: b,
          projectIds: [b],
          revision: inventory.destinationRevision!,
        }),
      ).toEqual({ kind: 'ok' })
      expect(
        await deleteProjectContainer(db, actor.workspaceId, a, actor.id),
      ).toBe('ok')
      expect(
        await deleteProjectContainer(db, actor.workspaceId, b, actor.id),
      ).toMatchObject({ kind: 'has-agent-credentials' })
    } else if (change === 'archive-secondary') {
      await db
        .updateTable('artifact_containers')
        .set({ archived_at: at })
        .where('id', '=', b)
        .execute()
    } else {
      await db
        .deleteFrom('project_share_defaults')
        .where('project_container_id', '=', b)
        .where('email', '=', bot.email)
        .execute()
    }
    const authority = await resolveCliAuthorityBySessionToken(
      session.sessionToken,
    )
    if (!authority || authority === 'denied' || authority.kind !== 'agent')
      throw new Error('existing session lost authentication')
    expect(authority.projectId).toBe(change === 'replace-primary' ? b : a)
    if (change === 'replace-primary') return

    const { RouterContextProvider } = await import('react-router')
    const { userContext, cliAuthorityContext } =
      await import('../middleware/context')
    const { loader: doctor } = await import('../routes/api.cli.doctor')
    const { loader: projects } = await import('../routes/api.cli.projects')
    const context = new RouterContextProvider()
    context.set(userContext, {
      id: bot.botUserId,
      email: bot.email,
      workspaceId: actor.workspaceId,
      emailVerified: true,
      selfUploadEnabled: true,
      hd: null,
    } as never)
    context.set(cliAuthorityContext, authority)
    const response = await doctor({ context } as never)
    expect(await response.json()).toMatchObject({
      auth: {
        ok: true,
        authority: {
          project_id: a,
          approved_project_ids: expect.arrayContaining([a, b]),
          publishable_project_ids: [a],
        },
      },
      upload: { ok: true },
    })
    expect(await (await projects({ context } as never)).json()).toMatchObject({
      projects: [{ id: a }],
    })
  },
)

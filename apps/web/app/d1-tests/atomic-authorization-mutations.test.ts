import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const bucketObjects = vi.hoisted(() => new Set<string>())
const bucketDelete = vi.hoisted(() =>
  vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys])
      bucketObjects.delete(key)
  }),
)

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {
      delete: bucketDelete,
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

import { removeWorkspaceMember } from '../services/team-management.server'
import {
  createApiToken,
  findUserByApiToken,
} from '../services/api-tokens.server'
import { issueCliRefreshCredential } from '../services/cli-refresh-credentials.server'
import { createDb } from '../services/db.server'
import { saveProjectShareDefaults } from '../services/projects.server'
import {
  deleteShareable,
  moveShareableContainer,
  editShareableSettings,
  beginStaticSiteBundleUploadSession,
  beginStaticSiteBundleVersionUploadSession,
} from '../services/shareables.server'
import { uploadShareable, createVersion } from '../modules/publish'
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
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
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

function failStatement(source: D1Database, pattern: RegExp): D1Database {
  return new Proxy(source, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) =>
          pattern.test(query)
            ? target.prepare('INSERT INTO table_that_does_not_exist VALUES (1)')
            : target.prepare(query)
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
          workspace_id, google_sub, kind
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'human')`,
      )
      .bind(
        `${prefix}-owner`,
        `${prefix}@example.com`,
        prefix,
        at,
        at,
        `${prefix}-ws`,
        `${prefix}-sub`,
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

async function seedDeletion(prefix: string) {
  await seedProject(prefix)
  await database.batch([
    database
      .prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          created_at, updated_at, container_id
        ) VALUES (?, ?, ?, ?, 'html_page', 'private', ?, ?, ?)`,
      )
      .bind(
        `${prefix}-share`,
        `${prefix}-ws`,
        `${prefix}-owner`,
        `${prefix}.html`,
        at,
        at,
        `${prefix}-project`,
      ),
    database
      .prepare(
        `INSERT INTO versions (
          id, shareable_id, artifact_kind, status, r2_key, size_bytes,
          sha256, created_by_id, created_at, entrypoint_path
        ) VALUES (?, ?, 'html_page', 'published', ?, 100, ?, ?, ?, '/index.html')`,
      )
      .bind(
        `${prefix}-version`,
        `${prefix}-share`,
        `${prefix}/index.html`,
        `${prefix}-sha`,
        `${prefix}-owner`,
        at,
      ),
    database
      .prepare(
        `UPDATE workspaces
         SET storage_used_bytes = 100, storage_updated_at = ?
         WHERE id = ?`,
      )
      .bind(at, `${prefix}-ws`),
  ])
}

describe.sequential('atomic authorization mutation D1 batches', () => {
  it.each(['creator', 'owner', 'admin'] as const)(
    'refuses all defaults when non-viewer policy is disabled before a %s batch',
    async (actorRole) => {
      const prefix = `atomic-role-policy-${actorRole}`
      await seedProject(prefix)
      const db = createDb(database)
      const creator = {
        id: `${prefix}-owner`,
        email: `${prefix}@example.com`,
        emailVerified: true,
      }
      const actor =
        actorRole === 'creator'
          ? creator
          : {
              id: `${prefix}-admin`,
              email: `${prefix}-admin@example.com`,
              emailVerified: true,
            }
      if (actorRole !== 'creator') {
        await database
          .prepare(
            `INSERT INTO users (
              id, email, google_sub, email_verified, name, workspace_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .bind(
            actor.id,
            actor.email,
            `${prefix}-admin-sub`,
            actorRole,
            `${prefix}-ws`,
            at,
            at,
          )
          .run()
        await db
          .insertInto('workspace_members')
          .values({
            workspace_id: `${prefix}-ws`,
            user_id: actor.id,
            role: actorRole,
            status: 'active',
            created_at: at,
            updated_at: at,
          })
          .execute()
      }
      await expect(
        saveProjectShareDefaults(
          db,
          `${prefix}-ws`,
          `${prefix}-project`,
          creator,
          {
            addEmails: ['target@example.com', 'remove@example.com'],
          },
        ),
      ).resolves.toBe('ok')
      const readRows = () =>
        db
          .selectFrom('project_share_defaults')
          .selectAll()
          .where('project_container_id', '=', `${prefix}-project`)
          .orderBy('id')
          .execute()
      const before = await readRows()
      const raced = createDb(
        beforeFirstBatch(database, () =>
          database
            .prepare(
              'UPDATE workspaces SET external_posting_enabled = 0 WHERE id = ?',
            )
            .bind(`${prefix}-ws`)
            .run(),
        ),
      )
      await expect(
        saveProjectShareDefaults(
          raced,
          `${prefix}-ws`,
          `${prefix}-project`,
          actor,
          {
            addEmails: ['human@example.com'],
            addEntries:
              actorRole === 'creator'
                ? [{ email: 'new@example.com', role: 'contributor' }]
                : [],
            removeEmails: ['remove@example.com'],
            roleChanges: [
              {
                email: 'target@example.com',
                role: actorRole === 'creator' ? 'viewer' : 'manager',
              },
            ],
          },
          creator.email,
          { allowNonViewerRoles: true },
        ),
      ).resolves.toBe('role-not-allowed')
      expect(await readRows()).toEqual(before)
    },
  )

  it('executes a guarded project save and classifies creator revocation', async () => {
    const prefix = 'atomic-project-auth'
    await seedProject(prefix)
    const actor = {
      id: `${prefix}-owner`,
      email: `${prefix}@example.com`,
      emailVerified: true,
    }
    const db = createDb(database)
    await expect(
      saveProjectShareDefaults(
        db,
        `${prefix}-ws`,
        `${prefix}-project`,
        actor,
        { addEmails: ['first@example.com'] },
        actor.email,
      ),
    ).resolves.toBe('ok')

    const raced = createDb(
      beforeFirstBatch(database, () =>
        database
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, role, status, created_at, updated_at
            ) VALUES (?, ?, 'member', 'removed', ?, ?)`,
          )
          .bind(`${prefix}-ws`, actor.id, at, at)
          .run(),
      ),
    )
    await expect(
      saveProjectShareDefaults(
        raced,
        `${prefix}-ws`,
        `${prefix}-project`,
        actor,
        { addEmails: ['second@example.com'] },
        actor.email,
      ),
    ).resolves.toBe('forbidden')
    const rows = await database
      .prepare(
        'SELECT email FROM project_share_defaults WHERE project_container_id = ? ORDER BY email',
      )
      .bind(`${prefix}-project`)
      .all<{ email: string }>()
    expect(rows.results).toEqual([{ email: 'first@example.com' }])
  })

  it('suppresses debit, audit, delete, and R2 cleanup after owner revocation', async () => {
    const prefix = 'atomic-delete-auth'
    await seedDeletion(prefix)
    bucketDelete.mockClear()
    const user = {
      id: `${prefix}-owner`,
      email: `${prefix}@example.com`,
      emailVerified: true,
      workspaceId: `${prefix}-ws`,
    }
    const raced = createDb(
      beforeFirstBatch(database, () =>
        database
          .prepare(
            `INSERT INTO workspace_members (
              workspace_id, user_id, role, status, created_at, updated_at
            ) VALUES (?, ?, 'member', 'removed', ?, ?)`,
          )
          .bind(user.workspaceId, user.id, at, at)
          .run(),
      ),
    )

    await expect(
      deleteShareable(raced, user, `${prefix}-share`),
    ).resolves.toEqual({ kind: 'not-found' })
    const [shareable, workspace, audit] = await Promise.all([
      database
        .prepare('SELECT id FROM shareables WHERE id = ?')
        .bind(`${prefix}-share`)
        .first(),
      database
        .prepare(
          'SELECT storage_used_bytes, storage_updated_at FROM workspaces WHERE id = ?',
        )
        .bind(user.workspaceId)
        .first<{ storage_used_bytes: number; storage_updated_at: string }>(),
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM audit_events WHERE subject_id = ?',
        )
        .bind(`${prefix}-share`)
        .first<{ count: number }>(),
    ])
    expect(shareable).toEqual({ id: `${prefix}-share` })
    expect(workspace).toEqual({
      storage_used_bytes: 100,
      storage_updated_at: at,
    })
    expect(Number(audit?.count)).toBe(0)
    expect(bucketDelete).not.toHaveBeenCalled()
  })

  it('accepts the production D1 delete receipt before R2 cleanup', async () => {
    const prefix = 'atomic-delete-receipt'
    await seedDeletion(prefix)
    bucketDelete.mockClear()
    const user = {
      id: `${prefix}-owner`,
      email: `${prefix}@example.com`,
      emailVerified: true,
      workspaceId: `${prefix}-ws`,
    }

    await expect(
      deleteShareable(createDb(database), user, `${prefix}-share`),
    ).resolves.toEqual({ kind: 'ok' })
    const [shareable, workspace, audit] = await Promise.all([
      database
        .prepare('SELECT id FROM shareables WHERE id = ?')
        .bind(`${prefix}-share`)
        .first(),
      database
        .prepare('SELECT storage_used_bytes FROM workspaces WHERE id = ?')
        .bind(user.workspaceId)
        .first<{ storage_used_bytes: number }>(),
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM audit_events WHERE subject_id = ?',
        )
        .bind(`${prefix}-share`)
        .first<{ count: number }>(),
    ])
    expect(shareable).toBeNull()
    expect(workspace?.storage_used_bytes).toBe(0)
    expect(Number(audit?.count)).toBe(1)
    expect(bucketDelete).toHaveBeenCalledTimes(1)
  })

  it('rolls back earlier deletion writes when DELETE fails', async () => {
    const prefix = 'atomic-delete-rollback'
    await seedDeletion(prefix)
    bucketDelete.mockClear()
    const db = createDb(failStatement(database, /delete from "shareables"/u))
    const user = {
      id: `${prefix}-owner`,
      email: `${prefix}@example.com`,
      emailVerified: true,
      workspaceId: `${prefix}-ws`,
    }

    await expect(deleteShareable(db, user, `${prefix}-share`)).resolves.toEqual(
      {
        kind: 'delete-failed',
      },
    )
    const workspace = await database
      .prepare(
        'SELECT storage_used_bytes, storage_updated_at FROM workspaces WHERE id = ?',
      )
      .bind(user.workspaceId)
      .first<{ storage_used_bytes: number; storage_updated_at: string }>()
    expect(workspace).toEqual({
      storage_used_bytes: 100,
      storage_updated_at: at,
    })
    expect(bucketDelete).not.toHaveBeenCalled()
  })
})

const removalFailures = {
  none: null,
  audit: /^insert into "audit_events"/,
  api: /^update "api_tokens"/,
  access: /^delete from "oauthAccessToken"/,
  refresh: /^delete from "oauthRefreshToken"/,
  version: /^update "users" set "oauth_token_version"/,
  cli: /^update "cli_refresh_credentials"/,
  sessions: /^delete from "sessions"/,
  workspace: /^insert into "workspaces"/,
  owner: /^insert into "workspace_members"/,
  move: /^update "users" set "workspace_id"/,
  membership: /^update "workspace_members" set "status" = /,
}

it.each(Object.entries(removalFailures))(
  'member removal atomically revokes credentials (failure=%s)',
  async (failure, failurePattern) => {
    const prefix = `remove-${failure}`
    const finalFailed = failure !== 'none'
    await seedProject(prefix)
    const ws = `${prefix}-ws`
    const owner = `${prefix}-owner`
    const member = `${prefix}-member`
    await database.batch([
      database
        .prepare(
          'INSERT INTO users (id, email, email_verified, name, created_at, updated_at, workspace_id, google_sub) VALUES (?, ?, 1, ?, ?, ?, ?, ?)',
        )
        .bind(
          member,
          `${member}@example.com`,
          member,
          at,
          at,
          ws,
          `${member}-sub`,
        ),
      database
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)",
        )
        .bind(ws, owner, at, at),
      database
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)",
        )
        .bind(ws, member, at, at),
      database
        .prepare(
          'INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(prefix, member, crypto.randomUUID(), '2099-01-01', at, at),
      database
        .prepare(
          "INSERT INTO oauthClient (id, clientId, public, redirectUris) VALUES (?, ?, 1, '[]')",
        )
        .bind(prefix, prefix),
      database
        .prepare(
          "INSERT INTO oauthRefreshToken (id, token, clientId, userId, scopes) VALUES (?, ?, ?, ?, '[]')",
        )
        .bind(prefix, crypto.randomUUID(), prefix, member),
      database
        .prepare(
          "INSERT INTO oauthAccessToken (id, token, clientId, userId, scopes) VALUES (?, ?, ?, ?, '[]')",
        )
        .bind(prefix, crypto.randomUUID(), prefix, member),
    ])
    const setupDb = createDb(database)
    const api = await createApiToken(setupDb, member, 'existing')
    await issueCliRefreshCredential(setupDb, member)
    await setupDb.destroy()
    const beforeWorkspaces = await database
      .prepare('SELECT count(*) AS n FROM workspaces')
      .first()
    const db = createDb(
      failurePattern ? failStatement(database, failurePattern) : database,
    )
    try {
      const removal = removeWorkspaceMember(
        db,
        { id: owner, workspaceId: ws },
        member,
      )
      if (finalFailed) await expect(removal).rejects.toThrow()
      else expect(await removal).toEqual({ kind: 'ok' })
      expect(Boolean(await findUserByApiToken(db, api.token))).toBe(finalFailed)
      const user = await db
        .selectFrom('users')
        .select(['workspace_id', 'oauth_token_version'])
        .where('id', '=', member)
        .executeTakeFirstOrThrow()
      expect(user.workspace_id === ws).toBe(finalFailed)
      if (finalFailed) {
        expect(
          await database
            .prepare('SELECT count(*) AS n FROM workspaces')
            .first(),
        ).toEqual(beforeWorkspaces)
        expect(
          await db
            .selectFrom('workspace_members')
            .select('workspace_id')
            .where('user_id', '=', member)
            .execute(),
        ).toEqual([{ workspace_id: ws }])
      }
      expect(user.oauth_token_version).toBe(finalFailed ? 0 : 1)
      expect(
        await database
          .prepare('SELECT revoked FROM oauthRefreshToken WHERE id = ?')
          .bind(prefix)
          .first(),
      ).toEqual(finalFailed ? { revoked: null } : null)
      expect(
        Boolean(
          await database
            .prepare('SELECT id FROM oauthAccessToken WHERE id = ?')
            .bind(prefix)
            .first(),
        ),
      ).toBe(finalFailed)
      expect(
        Boolean(
          await db
            .selectFrom('sessions')
            .select('id')
            .where('user_id', '=', member)
            .executeTakeFirst(),
        ),
      ).toBe(finalFailed)
      expect(
        Boolean(
          await db
            .selectFrom('cli_refresh_credentials')
            .select('id')
            .where('user_id', '=', member)
            .where('revoked_at', 'is', null)
            .executeTakeFirst(),
        ),
      ).toBe(finalFailed)
      const audits = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('workspace_id', '=', ws)
        .where('action', 'in', [
          'member.remove',
          'cli.refresh_credential.revoke',
        ])
        .execute()
      expect(audits.length).toBe(finalFailed ? 0 : 2)
      if (!finalFailed)
        expect(
          JSON.parse(
            audits.find((row) => row.action === 'member.remove')!.detail!,
          ),
        ).toMatchObject({
          revoked_api_token_count: 1,
          revoked_oauth_token_count: 2,
        })
      expect(
        (
          await db
            .selectFrom('workspace_members')
            .select('status')
            .where('workspace_id', '=', ws)
            .where('user_id', '=', member)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe(finalFailed ? 'active' : 'removed')
      if (finalFailed) {
        const retryDb = createDb(database)
        try {
          expect(
            await removeWorkspaceMember(
              retryDb,
              { id: owner, workspaceId: ws },
              member,
            ),
          ).toEqual({ kind: 'ok' })
          expect(await findUserByApiToken(retryDb, api.token)).toBeNull()
          expect(
            await database
              .prepare('SELECT id FROM oauthRefreshToken WHERE userId = ?')
              .bind(member)
              .first(),
          ).toBeNull()
          expect(
            await retryDb
              .selectFrom('sessions')
              .select('id')
              .where('user_id', '=', member)
              .execute(),
          ).toEqual([])
          expect(
            await retryDb
              .selectFrom('cli_refresh_credentials')
              .select('id')
              .where('user_id', '=', member)
              .where('revoked_at', 'is', null)
              .execute(),
          ).toEqual([])
          expect(
            await retryDb
              .selectFrom('users')
              .select('oauth_token_version')
              .where('id', '=', member)
              .executeTakeFirstOrThrow(),
          ).toEqual({ oauth_token_version: 1 })
          expect(
            await removeWorkspaceMember(
              retryDb,
              { id: owner, workspaceId: ws },
              member,
            ),
          ).toEqual({ kind: 'not-found' })
          const removals = await retryDb
            .selectFrom('audit_events')
            .select('detail')
            .where('workspace_id', '=', ws)
            .where('action', '=', 'member.remove')
            .execute()
          expect(removals).toHaveLength(1)
          expect(JSON.parse(removals[0]!.detail!)).toMatchObject({
            revoked_api_token_count: 1,
            revoked_oauth_token_count: 2,
          })
        } finally {
          await retryDb.destroy()
        }
      }
    } finally {
      await db.destroy()
    }
  },
)

async function placementSnapshot(workspaceId: string) {
  const selects = [
    'SELECT * FROM shareables WHERE workspace_id = ?',
    'SELECT * FROM versions WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?))',
    'SELECT * FROM shareable_grants WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM project_pins WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM artifact_keys WHERE workspace_id = ?',
    'SELECT * FROM events WHERE workspace_id = ?',
    'SELECT * FROM audit_events WHERE workspace_id = ?',
    'SELECT * FROM slack_notification_outbox WHERE shareable_id IN (SELECT id FROM shareables WHERE workspace_id = ?)',
    'SELECT * FROM link_publication_attempts WHERE workspace_id = ?',
    'SELECT * FROM link_publications WHERE workspace_id = ?',
  ]
  return await Promise.all(
    selects.map(
      async (query) =>
        (await database.prepare(query).bind(workspaceId).all()).results,
    ),
  )
}

// Each case owns a fresh interceptor. Setup uses the original database so it
// cannot consume the hook intended for the final publication/edit batch.
describe.sequential('destination placement at the real D1 commit boundary', () => {
  const changes = [
    'allowed',
    'archive',
    'remove-member',
    'downgrade-grant',
    'remove-grant',
    'unverify',
  ] as const
  const families = [
    'move',
    'mixed-edit',
    'file-create',
    'bundle-create',
    'agent-file-version',
    'agent-bundle-version',
    'keyed-version',
    'keyed-bundle-version',
  ] as const
  it.each([
    ...families.flatMap((family) =>
      changes.map((change) => ({ family, change })),
    ),
    ...(
      ['move', 'mixed-edit', 'file-create', 'bundle-create'] as const
    ).flatMap((family) =>
      (['admin-downgrade', 'plan-downgrade'] as const).map((change) => ({
        family,
        change,
      })),
    ),
  ])(
    '$family / $change preserves atomic placement',
    async ({ family, change }) => {
      const prefix = `place-${family}-${change}`
      await seedProject(prefix)
      const user = {
        id: `${prefix}-owner`,
        workspaceId: `${prefix}-ws`,
        email: `${prefix}@example.com`,
        emailVerified: true,
        hd: 'example.com',
      }
      const projectId = `${prefix}-project`
      await database.batch([
        database
          .prepare(
            "UPDATE artifact_containers SET base_visibility = 'private', created_by_id = NULL WHERE id = ?",
          )
          .bind(projectId),
        database
          .prepare(`INSERT INTO project_share_defaults (id, project_container_id, email, role, created_by_id, created_at, updated_at)
          VALUES (?, ?, ?, 'contributor', ?, ?, ?)`)
          .bind(`${prefix}-grant`, projectId, user.email, user.id, at, at),
        database
          .prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
          VALUES (?, ?, 'member', 'active', ?, ?)`)
          .bind(user.workspaceId, user.id, at, at),
        database
          .prepare(
            `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?)`,
          )
          .bind(`${prefix}-profile`, user.id, user.workspaceId, at),
      ])
      if (change === 'admin-downgrade' || change === 'plan-downgrade') {
        await database.batch([
          database
            .prepare(
              'DELETE FROM project_share_defaults WHERE project_container_id = ?',
            )
            .bind(projectId),
          database
            .prepare(
              "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?",
            )
            .bind(user.workspaceId, user.id),
        ])
      }
      const db = createDb(database)
      const file = () =>
        new File(['<p>placement</p>'], 'index.html', { type: 'text/html' })
      const authority: CliAuthority = {
        kind: 'agent',
        familyId: `${prefix}-family`,
        workspaceId: user.workspaceId,
        projectId,
        projectNameSnapshot: prefix,
        agentProfileId: `${prefix}-profile`,
      }
      let artifactId = ''
      let versionId = ''
      let keyId: string | undefined
      if (
        family === 'agent-bundle-version' ||
        family === 'keyed-bundle-version'
      ) {
        const started = await beginStaticSiteBundleUploadSession(
          db,
          user,
          projectId,
          family === 'keyed-bundle-version' ? 'stable' : null,
        )
        if (started.kind !== 'ok') throw new Error(`setup: ${started.kind}`)
        expect((await started.session.addFile(file())).kind).toBe('ok')
        const created = await started.session.commit('project')
        if (created.kind !== 'ok') throw new Error(`setup: ${created.kind}`)
        artifactId = created.id
        versionId = created.versionId
      } else if (
        ['move', 'mixed-edit', 'agent-file-version', 'keyed-version'].includes(
          family,
        )
      ) {
        const created = await uploadShareable(
          db,
          user,
          file(),
          'project',
          [],
          projectId,
          family === 'keyed-version' ? 'stable' : null,
        )
        if (created.kind !== 'ok') throw new Error(`setup: ${created.kind}`)
        artifactId = created.id
        versionId = created.versionId
        if (family === 'keyed-version')
          keyId = (
            await db
              .selectFrom('artifact_keys')
              .select('id')
              .where('shareable_id', '=', artifactId)
              .executeTakeFirstOrThrow()
          ).id
        if (family === 'move' || family === 'mixed-edit') {
          const home = await moveShareableContainer(db, user, artifactId, {
            type: 'inbox',
          })
          expect(home.kind).toBe('ok')
        }
      }
      if (family === 'keyed-bundle-version')
        keyId = (
          await db
            .selectFrom('artifact_keys')
            .select('id')
            .where('shareable_id', '=', artifactId)
            .executeTakeFirstOrThrow()
        ).id
      const before = await placementSnapshot(user.workspaceId)
      const used = await database
        .prepare('SELECT storage_used_bytes FROM workspaces WHERE id = ?')
        .bind(user.workspaceId)
        .first()
      const deletes = bucketDelete.mock.calls.length
      let hookCalled = false
      const guardedDb = createDb(
        beforeFirstBatch(database, async () => {
          hookCalled = true
          if (change === 'archive')
            await database
              .prepare(
                'UPDATE artifact_containers SET archived_at = ? WHERE id = ?',
              )
              .bind(at, projectId)
              .run()
          if (change === 'remove-member')
            await database
              .prepare(
                "UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?",
              )
              .bind(user.workspaceId, user.id)
              .run()
          if (change === 'downgrade-grant')
            await database
              .prepare(
                "UPDATE project_share_defaults SET role = 'viewer' WHERE project_container_id = ?",
              )
              .bind(projectId)
              .run()
          if (change === 'unverify')
            await database
              .prepare('UPDATE users SET email_verified = 0 WHERE id = ?')
              .bind(user.id)
              .run()
          if (change === 'remove-grant')
            await database
              .prepare(
                'DELETE FROM project_share_defaults WHERE project_container_id = ?',
              )
              .bind(projectId)
              .run()
          if (change === 'admin-downgrade')
            await database
              .prepare(
                "UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?",
              )
              .bind(user.workspaceId, user.id)
              .run()
          if (change === 'plan-downgrade')
            await database
              .prepare("UPDATE workspaces SET plan = 'free' WHERE id = ?")
              .bind(user.workspaceId)
              .run()
        }),
      )
      try {
        let result: { kind: string }
        if (family === 'move')
          result = await moveShareableContainer(guardedDb, user, artifactId, {
            type: 'project',
            projectId,
          })
        else if (family === 'mixed-edit')
          result = await editShareableSettings(guardedDb, user, artifactId, {
            destination: { type: 'project', projectId },
            title: 'Changed title',
            visibility: 'project',
            addEmails: ['viewer@example.com'],
          })
        else if (family === 'file-create')
          result = await uploadShareable(
            guardedDb,
            user,
            file(),
            'project',
            ['viewer@example.com'],
            projectId,
            'new-key',
          )
        else if (family === 'bundle-create') {
          const started = await beginStaticSiteBundleUploadSession(
            guardedDb,
            user,
            projectId,
            'new-key',
          )
          if (started.kind !== 'ok') throw new Error(`begin: ${started.kind}`)
          expect((await started.session.addFile(file())).kind).toBe('ok')
          result = await started.session.commit('project', [
            'viewer@example.com',
          ])
        } else if (
          family === 'agent-bundle-version' ||
          family === 'keyed-bundle-version'
        ) {
          const started = await beginStaticSiteBundleVersionUploadSession(
            guardedDb,
            user,
            artifactId,
            family === 'keyed-bundle-version' ? keyId! : null,
            family === 'keyed-bundle-version'
              ? { expectedCurrentVersionId: versionId }
              : { authority, agentProfileId: `${prefix}-profile` },
          )
          if (started.kind !== 'ok') throw new Error(`begin: ${started.kind}`)
          expect((await started.session.addFile(file())).kind).toBe('ok')
          result = await started.session.commitVersion()
        } else
          result = await createVersion({
            db: guardedDb,
            user,
            shareableId: artifactId,
            file: file(),
            ...(family === 'keyed-version'
              ? {
                  expectedCurrentVersionId: versionId,
                  touchArtifactKeyId: keyId,
                }
              : { authority, agentProfileId: `${prefix}-profile` }),
          })
        expect(hookCalled).toBe(true)
        if (change === 'allowed') expect(result.kind).toBe('ok')
        else {
          expect(result.kind).toBe(
            family.endsWith('create')
              ? 'invalid-container'
              : ['move', 'mixed-edit'].includes(family) &&
                  change === 'remove-member'
                ? 'not-found'
                : ['move', 'mixed-edit'].includes(family)
                  ? 'invalid-destination'
                  : 'not-found',
          )
          expect(await placementSnapshot(user.workspaceId)).toEqual(before)
          expect(
            await database
              .prepare('SELECT storage_used_bytes FROM workspaces WHERE id = ?')
              .bind(user.workspaceId)
              .first(),
          ).toEqual(used)
          const member = await database
            .prepare(
              'SELECT pending_uploads FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
            )
            .bind(user.workspaceId, user.id)
            .first<{ pending_uploads: number }>()
          expect(member?.pending_uploads).toBe(0)
          if (!['move', 'mixed-edit'].includes(family))
            expect(bucketDelete.mock.calls.length).toBeGreaterThan(deletes)
        }
      } finally {
        await guardedDb.destroy()
        await db.destroy()
      }
    },
  )
  it.each([false, true])(
    'link edit to home checks membership at D1 commit: removed=%s',
    async (removed) => {
      const prefix = `home-link-${removed}`
      await seedProject(prefix)
      const user = {
        id: `${prefix}-owner`,
        workspaceId: `${prefix}-ws`,
        email: `${prefix}@example.com`,
        emailVerified: true,
        hd: 'example.com',
      }
      await database
        .prepare('UPDATE workspaces SET link_sharing_enabled = 1 WHERE id = ?')
        .bind(user.workspaceId)
        .run()
      await database
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)",
        )
        .bind(user.workspaceId, user.id, at, at)
        .run()
      const db = createDb(database)
      const created = await uploadShareable(
        db,
        user,
        new File(['<p>home</p>'], 'index.html', { type: 'text/html' }),
        'project',
        [],
        `${prefix}-project`,
      )
      if (created.kind !== 'ok') throw new Error(`setup: ${created.kind}`)
      const before = await placementSnapshot(user.workspaceId)
      let intercepted = false
      const guardedDb = createDb(
        beforeFirstBatch(database, async () => {
          intercepted = true
          if (removed)
            await database
              .prepare(
                "UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?",
              )
              .bind(user.workspaceId, user.id)
              .run()
        }),
      )
      try {
        const result = await editShareableSettings(
          guardedDb,
          user,
          created.id,
          { destination: { type: 'inbox' }, visibility: 'link' },
        )
        expect(intercepted).toBe(true)
        expect(result.kind).toBe(removed ? 'invalid-destination' : 'ok')
        if (removed)
          expect(await placementSnapshot(user.workspaceId)).toEqual(before)
        else {
          expect(
            await db
              .selectFrom('shareables')
              .innerJoin(
                'artifact_containers',
                'artifact_containers.id',
                'shareables.container_id',
              )
              .select(['shareables.visibility', 'artifact_containers.kind'])
              .where('shareables.id', '=', created.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ visibility: 'link', kind: 'inbox' })
          expect(
            await db
              .selectFrom('link_publications')
              .select('shareable_id')
              .where('shareable_id', '=', created.id)
              .execute(),
          ).toHaveLength(1)
        }
      } finally {
        await guardedDb.destroy()
        await db.destroy()
      }
    },
  )

  it.each(['file', 'bundle'] as const)(
    'external posting policy is live in the final %s create',
    async (kind) => {
      const prefix = `place-external-${kind}`
      await seedProject(prefix)
      const sourceWorkspace = `${prefix}-source`
      const projectId = `${prefix}-project`
      const user = {
        id: `${prefix}-owner`,
        workspaceId: sourceWorkspace,
        email: `${prefix}@example.com`,
        emailVerified: true,
        hd: 'example.com',
      }
      await database.batch([
        database
          .prepare(
            "INSERT INTO workspaces (id, name, plan, created_at) VALUES (?, ?, 'plus', ?)",
          )
          .bind(sourceWorkspace, prefix, at),
        database
          .prepare('UPDATE users SET workspace_id = ? WHERE id = ?')
          .bind(sourceWorkspace, user.id),
        database
          .prepare(`INSERT INTO project_share_defaults (id, project_container_id, email, role, created_by_id, created_at, updated_at)
        VALUES (?, ?, ?, 'contributor', ?, ?, ?)`)
          .bind(`${prefix}-grant`, projectId, user.email, user.id, at, at),
      ])
      const before = await placementSnapshot(`${prefix}-ws`)
      const deletes = bucketDelete.mock.calls.length
      const db = createDb(
        beforeFirstBatch(database, () =>
          database
            .prepare(
              'UPDATE workspaces SET external_posting_enabled = 0 WHERE id = ?',
            )
            .bind(`${prefix}-ws`)
            .run(),
        ),
      )
      try {
        const file = new File(['<p>external</p>'], 'index.html', {
          type: 'text/html',
        })
        let result: { kind: string }
        if (kind === 'file')
          result = await uploadShareable(
            db,
            user,
            file,
            'private',
            [],
            projectId,
          )
        else {
          const started = await beginStaticSiteBundleUploadSession(
            db,
            user,
            projectId,
          )
          if (started.kind !== 'ok') throw new Error('begin failed')
          expect((await started.session.addFile(file)).kind).toBe('ok')
          result = await started.session.commit('private')
        }
        expect(result.kind).toBe('invalid-container')
        expect(await placementSnapshot(`${prefix}-ws`)).toEqual(before)
        expect(bucketDelete.mock.calls.length).toBeGreaterThan(deletes)
      } finally {
        await db.destroy()
      }
    },
  )
  it.each(['file', 'bundle'] as const)(
    'ordinary external owner %s versions enforce live posting policy',
    async (kind) => {
      for (const allowed of [true, false]) {
        const prefix = `owner-external-${kind}-${allowed}`
        await seedProject(prefix)
        const workspaceId = `${prefix}-ws`
        const projectId = `${prefix}-project`
        const user = {
          id: `${prefix}-owner`,
          workspaceId: `${prefix}-source`,
          email: `${prefix}@example.com`,
          emailVerified: true,
          hd: 'example.com',
        }
        await database.batch([
          database
            .prepare(
              "INSERT INTO workspaces (id, name, plan, created_at) VALUES (?, ?, 'plus', ?)",
            )
            .bind(user.workspaceId, prefix, at),
          database
            .prepare('UPDATE users SET workspace_id = ? WHERE id = ?')
            .bind(user.workspaceId, user.id),
          database
            .prepare(
              "INSERT INTO project_share_defaults (id, project_container_id, email, role, created_by_id, created_at, updated_at) VALUES (?, ?, ?, 'contributor', ?, ?, ?)",
            )
            .bind(`${prefix}-grant`, projectId, user.email, user.id, at, at),
        ])
        const db = createDb(database)
        const file = () =>
          new File(['<p>version</p>'], 'index.html', { type: 'text/html' })
        let artifactId: string
        if (kind === 'file') {
          const created = await uploadShareable(
            db,
            user,
            file(),
            'private',
            [],
            projectId,
          )
          if (created.kind !== 'ok') throw new Error(created.kind)
          artifactId = created.id
        } else {
          const started = await beginStaticSiteBundleUploadSession(
            db,
            user,
            projectId,
          )
          if (started.kind !== 'ok') throw new Error(started.kind)
          expect((await started.session.addFile(file())).kind).toBe('ok')
          const created = await started.session.commit('private')
          if (created.kind !== 'ok') throw new Error(created.kind)
          artifactId = created.id
        }
        const before = await placementSnapshot(workspaceId)
        const objects = [...bucketObjects].sort()
        const quota = await database
          .prepare('SELECT storage_used_bytes FROM workspaces WHERE id = ?')
          .bind(workspaceId)
          .first()
        let hookCalled = false
        const guarded = createDb(
          beforeFirstBatch(database, async () => {
            hookCalled = true
            if (!allowed)
              await database
                .prepare(
                  'UPDATE workspaces SET external_posting_enabled = 0 WHERE id = ?',
                )
                .bind(workspaceId)
                .run()
          }),
        )
        try {
          let result: { kind: string }
          if (kind === 'file')
            result = await createVersion({
              db: guarded,
              user,
              shareableId: artifactId,
              file: file(),
            })
          else {
            const started = await beginStaticSiteBundleVersionUploadSession(
              guarded,
              user,
              artifactId,
              null,
            )
            if (started.kind !== 'ok') throw new Error(started.kind)
            expect((await started.session.addFile(file())).kind).toBe('ok')
            result = await started.session.commitVersion()
          }
          expect(hookCalled).toBe(true)
          expect(result.kind).toBe(allowed ? 'ok' : 'invalid-container')
          if (!allowed) {
            expect(await placementSnapshot(workspaceId)).toEqual(before)
            expect([...bucketObjects].sort()).toEqual(objects)
            expect(
              await database
                .prepare(
                  'SELECT storage_used_bytes FROM workspaces WHERE id = ?',
                )
                .bind(workspaceId)
                .first(),
            ).toEqual(quota)
          }
        } finally {
          await guarded.destroy()
          await db.destroy()
        }
      }
    },
  )
})

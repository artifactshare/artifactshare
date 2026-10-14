import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const bucketDelete = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: { delete: bucketDelete },
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
import { deleteShareable } from '../services/shareables.server'

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

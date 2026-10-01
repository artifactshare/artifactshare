import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const objects = vi.hoisted(() => new Map<string, ArrayBuffer>())
const notify = vi.hoisted(() => vi.fn())
vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {},
    ARTIFACT_LIVE: { getByName: () => ({ notifyVersionChanged: notify }) },
    ['BETTER_AUTH_' + 'SECRET']: 'd1-test-secret-with-enough-entropy',
  },
}))
vi.mock('../services/storage.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/storage.server')>()),
  putArtifact: async (
    _bucket: unknown,
    key: string,
    body: ArrayBuffer | ReadableStream,
  ) => {
    objects.set(key, await new Response(body).arrayBuffer())
  },
  deleteArtifact: async (_bucket: unknown, key: string) => {
    objects.delete(key)
  },
  deleteArtifactsByPrefix: async (_bucket: unknown, prefix: string) => {
    for (const key of objects.keys())
      if (key.startsWith(prefix)) objects.delete(key)
  },
}))

import { createDb } from '../services/db.server'
import { createVersion } from '../modules/publish'
import { beginStaticSiteBundleVersionUploadSession } from '../services/shareables.server'
import { securityAuditInsertQuery } from '../services/security-audit.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
const at = '2026-10-01T00:00:00.000Z'
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
  action: () => Promise<void>,
): D1Database {
  let pending = true
  return new Proxy(source, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false
            await action()
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function seed(prefix: string, site: boolean) {
  const db = createDb(database)
  const user = {
    id: `${prefix}-owner`,
    workspaceId: `${prefix}-ws`,
    email: `${prefix}@example.com`,
    emailVerified: true,
    hd: null,
  }
  await db
    .insertInto('workspaces')
    .values({
      id: user.workspaceId,
      name: prefix,
      created_at: at,
      storage_used_bytes: 100,
    })
    .execute()
  // Migrated databases retain the legacy NOT NULL google_sub column.
  await database
    .prepare(
      `INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at, workspace_id,
        google_sub
      ) VALUES (?, ?, 1, 'Owner', ?, ?, ?, ?)`,
    )
    .bind(user.id, user.email, at, at, user.workspaceId, `${prefix}-owner-sub`)
    .run()
  await db
    .insertInto('artifact_containers')
    .values({
      id: `${prefix}-inbox`,
      workspace_id: user.workspaceId,
      kind: 'inbox',
      owner_user_id: user.id,
      created_by_id: user.id,
      name: 'Inbox',
      created_at: at,
      updated_at: at,
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: prefix,
      workspace_id: user.workspaceId,
      owner_user_id: user.id,
      name: 'Original',
      artifact_kind: site ? 'static_site' : 'html_page',
      visibility: 'private',
      container_id: `${prefix}-inbox`,
      created_at: at,
      updated_at: at,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `${prefix}-v1`,
      shareable_id: prefix,
      artifact_kind: site ? 'static_site' : 'html_page',
      status: 'published',
      entrypoint_path: '/index.html',
      r2_key: `${prefix}/v1/index.html`,
      size_bytes: 100,
      sha256: 'test-sha',
      created_by_id: user.id,
      created_at: at,
      published_at: at,
      created_via: 'api',
    })
    .execute()
  await db
    .updateTable('shareables')
    .set({ current_version_id: `${prefix}-v1` })
    .where('id', '=', prefix)
    .execute()
  await db
    .insertInto('artifact_keys')
    .values({
      id: `${prefix}-key`,
      workspace_id: user.workspaceId,
      owner_user_id: user.id,
      container_id: `${prefix}-inbox`,
      stable_key: 'report',
      shareable_id: prefix,
      created_at: at,
      updated_at: at,
    })
    .execute()
  return { db, user }
}

function siteFile(content: string) {
  return new File([content], 'index.html', { type: 'text/html' })
}

describe.sequential('browser edit protection in real D1 transactions', () => {
  it.each([false, true])(
    'rejects a staged replacement atomically (static site %s)',
    async (site) => {
      const id = site ? 'browserbundle' : 'browserfile'
      const { db, user } = await seed(id, site)
      const browserContent = '<title>Browser fix</title>'
      let browserVersion = ''
      let objectsAfterBrowser = 0
      notify.mockClear()
      const guarded = createDb(
        beforeFirstBatch(database, async () => {
          if (site) {
            const begun = await beginStaticSiteBundleVersionUploadSession(
              db,
              user,
              id,
              null,
              { createdVia: 'web', expectedCurrentVersionId: `${id}-v1` },
            )
            if (begun.kind !== 'ok') throw new Error('browser session failed')
            await begun.session.addFile(siteFile(browserContent))
            const result = await begun.session.commitVersion()
            if (result.kind !== 'ok') throw new Error('browser commit failed')
            browserVersion = result.versionId
          } else {
            const result = await createVersion({
              db,
              user,
              shareableId: id,
              createdVia: 'web',
              expectedCurrentVersionId: `${id}-v1`,
              file: new File([browserContent], 'browser.html'),
            })
            if (result.kind !== 'ok') throw new Error('browser commit failed')
            browserVersion = result.versionId
          }
          objectsAfterBrowser = objects.size
        }),
      )
      let result
      if (site) {
        const begun = await beginStaticSiteBundleVersionUploadSession(
          guarded,
          user,
          id,
          `${id}-key`,
          { createdVia: 'cli' },
        )
        if (begun.kind !== 'ok') throw new Error('agent session failed')
        await begun.session.addFile(siteFile('<title>Stale copy</title>'))
        result = await begun.session.commitVersion()
      } else {
        result = await createVersion({
          db: guarded,
          user,
          shareableId: id,
          file: new File(['<title>Stale copy</title>'], 'stale.html'),
          createdVia: 'mcp',
          touchArtifactKeyId: `${id}-key`,
          auditQuery: ({ workspaceId, shareableId, createdAt }) =>
            securityAuditInsertQuery(guarded, {
              workspaceId,
              actorId: user.id,
              clientId: 'test-client',
              development: false,
              subjectId: shareableId,
              action: 'artifact.update',
              createdAt,
            }),
        })
      }
      expect(result).toEqual({
        kind: 'version-conflict',
        currentVersionId: browserVersion,
        readTarget: id,
      })
      expect(
        await db
          .selectFrom('shareables')
          .select(['current_version_id', 'derived_title'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        current_version_id: browserVersion,
        derived_title: 'Browser fix',
      })
      expect(
        await db
          .selectFrom('versions')
          .select('id')
          .where('shareable_id', '=', id)
          .execute(),
      ).toHaveLength(2)
      expect(
        await db
          .selectFrom('version_files')
          .select('id')
          .where('version_id', '=', browserVersion)
          .execute(),
      ).toHaveLength(site ? 1 : 0)
      expect(
        await db
          .selectFrom('events')
          .select('id')
          .where('shareable_id', '=', id)
          .execute(),
      ).toHaveLength(1)
      expect(
        await db
          .selectFrom('security_audit_records')
          .select('id')
          .where('subject_id', '=', id)
          .execute(),
      ).toHaveLength(0)
      expect(
        await db
          .selectFrom('artifact_keys')
          .select('updated_at')
          .where('id', '=', `${id}-key`)
          .executeTakeFirstOrThrow(),
      ).toEqual({ updated_at: at })
      expect(
        await db
          .selectFrom('workspaces')
          .select('storage_used_bytes')
          .where('id', '=', user.workspaceId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        storage_used_bytes:
          100 + new TextEncoder().encode(browserContent).length,
      })
      expect(objects.size).toBe(objectsAfterBrowser - 1)
      expect(notify).toHaveBeenCalledTimes(1)
      await guarded.destroy()
      await db.destroy()
    },
  )

  it.each([false, true])(
    'allows concurrent non-web owner updates and intentional force (static site %s)',
    async (site) => {
      const id = site ? 'ordinarybundle' : 'ordinaryfile'
      const { db, user } = await seed(id, site)
      for (const force of [false, true]) {
        const otherChannel = force ? 'web' : 'cli'
        const guarded = createDb(
          beforeFirstBatch(database, async () => {
            if (site) {
              const begun = await beginStaticSiteBundleVersionUploadSession(
                db,
                user,
                id,
                null,
                { createdVia: otherChannel },
              )
              if (begun.kind !== 'ok')
                throw new Error('concurrent session failed')
              await begun.session.addFile(siteFile('<title>Concurrent</title>'))
              expect((await begun.session.commitVersion()).kind).toBe('ok')
            } else {
              expect(
                (
                  await createVersion({
                    db,
                    user,
                    shareableId: id,
                    file: new File(
                      ['<title>Concurrent</title>'],
                      'concurrent.html',
                    ),
                    createdVia: otherChannel,
                  })
                ).kind,
              ).toBe('ok')
            }
          }),
        )
        if (site) {
          const begun = await beginStaticSiteBundleVersionUploadSession(
            guarded,
            user,
            id,
            null,
            { createdVia: 'api', force },
          )
          if (begun.kind !== 'ok') throw new Error('session failed')
          await begun.session.addFile(siteFile('<title>Intentional</title>'))
          expect((await begun.session.commitVersion()).kind).toBe('ok')
        } else {
          expect(
            (
              await createVersion({
                db: guarded,
                user,
                shareableId: id,
                file: new File(
                  ['<title>Intentional</title>'],
                  'intentional.html',
                ),
                createdVia: 'api',
                force,
              })
            ).kind,
          ).toBe('ok')
        }
        await guarded.destroy()
      }
      expect(
        await db
          .selectFrom('versions')
          .select('id')
          .where('shareable_id', '=', id)
          .execute(),
      ).toHaveLength(5)
      await db.destroy()
    },
  )
})

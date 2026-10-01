import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchFixture } from '~/test/d1-batch-mock'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import type { DB } from '~/types/db'

const state = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
  current: null as DatabaseSync | null,
}))
const objects = vi.hoisted(() => new Map<string, ArrayBuffer>())
vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {}, APP_ENV: 'development' },
}))
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: vi.fn(),
}))
vi.mock('~/services/db.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/db.server')>()),
  createDb: () => state.db!,
  withDb: (callback: (db: Kysely<DB>) => unknown) => callback(state.db!),
}))
vi.mock('~/services/storage.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/storage.server')>()),
  putArtifact: async (
    _bucket: unknown,
    key: string,
    body: ArrayBuffer | ReadableStream,
  ) => {
    objects.set(key, await new Response(body).arrayBuffer())
  },
  getArtifact: async (_bucket: unknown, key: string) => {
    const body = objects.get(key)
    return body
      ? {
          size: body.byteLength,
          body: new Blob([body]).stream(),
          text: async () => new TextDecoder().decode(body),
        }
      : null
  },
  deleteArtifact: async (_bucket: unknown, key: string) => {
    objects.delete(key)
  },
  deleteArtifactsByPrefix: async (_bucket: unknown, prefix: string) => {
    for (const key of objects.keys())
      if (key.startsWith(prefix)) objects.delete(key)
  },
}))

import {
  authSourceContext,
  ctxContext,
  userContext,
} from '~/middleware/context'
import { action as upload } from './api.shareables.uploads'
import { action as update } from './api.shareables.$id.versions'
import { loader as getArtifact } from './api.cli.artifacts.$id'
import { loader as download } from './api.cli.artifacts.$id.download'
import { loader as downloadFile } from './api.cli.artifacts.$id.download.$'

const user = {
  id: 'owner',
  email: 'owner@example.com',
  name: 'Owner',
  image: null,
  kind: 'human' as const,
  emailVerified: true,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  locale: 'en',
  selfUploadEnabled: true,
}

function requestContext(channel: 'web' | 'cli' | 'api') {
  const context = new RouterContextProvider()
  context.set(userContext, user)
  context.set(authSourceContext, channel === 'web' ? 'cookie' : 'bearer')
  context.set(ctxContext, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext)
  return context
}

async function replace(options: {
  id?: string
  key?: string
  site?: boolean
  channel?: 'web' | 'cli' | 'api'
  expected?: string
  force?: string
  content?: string
  marker?: string
}) {
  const channel = options.channel ?? 'api'
  const query = new URLSearchParams()
  if (options.key) query.set('publish_key', options.key)
  if (options.site) query.set('artifact_kind', 'static_site')
  if (options.expected !== undefined)
    query.set('expected_version', options.expected)
  if (options.force !== undefined) query.set('force', options.force)
  const form = new FormData()
  form.set(
    'file',
    new File(
      [options.content ?? '<title>Agent</title><p>local copy</p>'],
      'index.html',
      { type: 'text/html' },
    ),
  )
  form.set('visibility', 'private')
  const path = options.id
    ? `/api/shareables/${options.id}/versions`
    : '/api/shareables/uploads'
  const headers = new Headers()
  const marker = options.marker ?? (channel === 'cli' ? 'cli' : undefined)
  if (marker) headers.set('X-ArtifactShare-Client', marker)
  const request = new Request(`https://example.com${path}?${query}`, {
    method: 'POST',
    headers,
    body: form,
  })
  const args = {
    request,
    context: requestContext(channel),
    params: { id: options.id },
  } as never
  return await (options.id ? update(args) : upload(args))
}

async function snapshot() {
  const db = state.db!
  return {
    shareables: await db.selectFrom('shareables').selectAll().execute(),
    versions: await db.selectFrom('versions').selectAll().execute(),
    files: await db.selectFrom('version_files').selectAll().execute(),
    workspace: await db.selectFrom('workspaces').selectAll().execute(),
    keys: await db.selectFrom('artifact_keys').selectAll().execute(),
    events: await db.selectFrom('events').selectAll().execute(),
    notifications: await db
      .selectFrom('slack_notification_outbox')
      .selectAll()
      .execute(),
    objects: [...objects.entries()],
  }
}

beforeEach(() => {
  const fixture = createD1BatchFixture({ sqlite: state })
  state.db = fixture.db
  state.current = fixture.sqlite
  objects.clear()
  seedWorkspace(fixture.sqlite)
  seedUser(fixture.sqlite, user.id)
})
afterEach(async () => {
  await state.db?.destroy()
  state.db = null
  state.current = null
})

describe.each([false, true])(
  'HTTP browser edit protection (static site %s)',
  (site) => {
    test.each(['update', 'keyed-share', 'direct-api'] as const)(
      '%s rejects and recovers from web and stale bases',
      async (path) => {
        const first = await replace({
          site,
          key: 'report',
          channel: 'cli',
          content: '<title>Original</title>',
        })
        expect(first.status).toBe(200)
        const created = (await first.json()) as {
          id: string
          versionId: string
        }
        const browser = await replace({
          site,
          id: created.id,
          channel: 'web',
          expected: created.versionId,
          content: '<title>Browser fix</title>',
        })
        expect(browser.status).toBe(200)
        const browserBody = (await browser.json()) as { versionId: string }
        expect(
          await state
            .db!.selectFrom('versions')
            .select('created_via')
            .where('id', '=', browserBody.versionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ created_via: 'web' })
        const before = await snapshot()
        const target =
          path === 'keyed-share' ? { key: 'report' } : { id: created.id }
        const channel = path === 'direct-api' ? 'api' : 'cli'
        for (const expected of [undefined, created.versionId]) {
          const rejected = await replace({ ...target, site, channel, expected })
          expect(rejected.status).toBe(409)
          const body = (await rejected.json()) as {
            error: {
              code: string
              details: {
                current_version_id: string
                read_target: string
                recovery_guidance: string
              }
            }
          }
          expect(body.error).toMatchObject({
            code: 'version_conflict',
            details: {
              current_version_id: browserBody.versionId,
              read_target: created.id,
              recovery_guidance:
                'Get the latest source, reapply your change, and resend with its version.',
            },
          })
          expect(await snapshot()).toEqual(before)
        }
        // Use the conflict's authorized ID with the real recovery read adapters.
        const conflict = await replace({ ...target, site, channel })
        const conflictBody = (await conflict.json()) as {
          error: { details: { read_target: string } }
        }
        const readTarget = conflictBody.error.details.read_target
        const readArgs = {
          context: requestContext(channel),
          params: { id: readTarget },
          request: new Request(
            `https://example.com/api/cli/artifacts/${readTarget}${site ? '/download' : ''}`,
          ),
        } as never
        let latestSource: string
        let version: string
        if (site) {
          const manifestResponse = await download(readArgs)
          expect(manifestResponse.status).toBe(200)
          const manifest = (await manifestResponse.json()) as {
            version_id: string
            files: Array<{ path: string }>
          }
          version = manifest.version_id
          const file = manifest.files[0]!
          const response = await downloadFile({
            context: requestContext(channel),
            params: { id: readTarget, '*': file.path.replace(/^\//, '') },
            request: new Request(
              `https://example.com/api/cli/artifacts/${readTarget}/download${file.path}`,
            ),
          } as never)
          expect(response.status).toBe(200)
          latestSource = await response.text()
        } else {
          const response = await getArtifact(readArgs)
          expect(response.status).toBe(200)
          const read = (await response.json()) as {
            content: string
            version_id: string
            truncated: boolean
          }
          expect(read.truncated).toBe(false)
          version = read.version_id
          latestSource = read.content
        }
        expect(latestSource).toContain('Browser fix')
        const recovered = await replace({
          ...target,
          site,
          channel,
          expected: version,
          content: latestSource + '<p>Reapplied</p>',
        })
        expect(recovered.status).toBe(200)
        const body = (await recovered.json()) as { versionId: string }
        expect(
          await state
            .db!.selectFrom('versions')
            .select('created_via')
            .where('id', '=', body.versionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ created_via: channel })
        const stale = await replace({
          ...target,
          site,
          channel,
          expected: version,
        })
        expect(stale.status).toBe(409)
        // A non-browser current version accepts ordinary no-base updates again.
        expect((await replace({ ...target, site, channel })).status).toBe(200)
      },
    )

    test('force validates before mutation and deliberately replaces web content', async () => {
      const first = await replace({ site, key: 'forced', channel: 'web' })
      const created = (await first.json()) as { id: string; versionId: string }
      expect(first.status).toBe(200)
      for (const target of [{ id: created.id }, { key: 'forced' }]) {
        const before = await snapshot()
        for (const expected of [created.versionId, 'stale']) {
          expect(
            (await replace({ ...target, site, force: 'true', expected }))
              .status,
          ).toBe(400)
          expect(await snapshot()).toEqual(before)
        }
        for (const force of ['1', 'yes', '']) {
          expect((await replace({ ...target, site, force })).status).toBe(400)
          expect(await snapshot()).toEqual(before)
        }
        expect(
          (await replace({ ...target, site, force: 'false' })).status,
        ).toBe(409)
      }
      expect(
        (await replace({ id: created.id, site, force: 'true' })).status,
      ).toBe(200)
      expect(
        (await replace({ site, key: 'unused-key', force: 'true' })).status,
      ).toBe(200)
    })
  },
)

test.each([
  ['web', 'cli', 'web'],
  ['api', 'web', 'api'],
  ['api', 'mcp', 'api'],
  ['api', undefined, 'api'],
  ['cli', 'cli', 'cli'],
] as const)(
  'classifies authenticated %s publication with marker %s as %s',
  async (channel, marker, createdVia) => {
    const response = await replace({ channel, marker })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { versionId: string }
    expect(
      await state
        .db!.selectFrom('versions')
        .select('created_via')
        .where('id', '=', body.versionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ created_via: createdVia })
  },
)

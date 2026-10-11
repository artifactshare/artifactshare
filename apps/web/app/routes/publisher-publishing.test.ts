import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'

const fixture = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  db: null as Kysely<DB> | null,
}))
const blobs = vi.hoisted(() => new Map<string, string>())
const bucket = vi.hoisted(() => ({
  put: vi.fn(async (key: string, body: BodyInit) => {
    blobs.set(key, await new Response(body).text())
  }),
  delete: vi.fn(async (keys: string | string[]) => {
    for (const key of typeof keys === 'string' ? [keys] : keys)
      blobs.delete(key)
  }),
  get: vi.fn(async (key: string) => {
    const text = blobs.get(key)
    return text === undefined
      ? null
      : {
          body: new Response(text).body,
          text: async () => text,
          size: new TextEncoder().encode(text).length,
          uploaded: new Date('2026-01-01'),
        }
  }),
}))
const authority = vi.hoisted(() => ({
  kind: 'publisher' as const,
  familyId: 'publisher-family',
  workspaceId: 'workspace1',
  publisherClientId: 'client1',
  publisherClientName: 'Reports',
}))
const notify = vi.hoisted(() => vi.fn())
vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'development',
    BUCKET: bucket,
    DB: createD1BatchDbMock({ sqlite: fixture }),
    ARTIFACT_LIVE: { getByName: () => ({ notifyVersionChanged: notify }) },
  },
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => fixture.db,
  withDb: <T>(run: (db: Kysely<DB>) => Promise<T>) => run(fixture.db!),
}))
vi.mock('~/middleware/auth', () => ({ requireUserApiWithBearerMiddleware: [] }))
vi.mock('~/middleware/context', () => ({
  ctxContext: 'ctx',
  authSourceContext: 'authSource',
  getCliAuthority: () => authority,
  requireUser: () => ({
    id: 'owner1',
    email: 'owner@example.test',
    emailVerified: true,
    kind: 'human',
    workspaceId: 'workspace1',
    hd: 'example.test',
  }),
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: async () => ({ kind: 'allowed' }),
}))

import { action as upload } from './api.shareables.uploads'
import { action as update } from './api.shareables.$id.versions'
import { loader as download } from './api.cli.artifacts.$id.download'
import { loader as downloadWildcard } from './api.cli.artifacts.$id.download.$'
import { loader as readback, action as remove } from './api.cli.artifacts.$id'
import { loader as list } from './api.cli.artifacts'
import { loader as resolve } from './api.cli.resolve'
import {
  loader as comments,
  action as comment,
} from './api.cli.artifacts.$id.comments'
import { action as edit } from './api.cli.shareables.$id.edit'
import { action as move } from './api.cli.shareables.$id.move'
import { action as append } from './api.cli.artifacts.$id.append'
import { loader as projects, action as createProject } from './api.cli.projects'

const background: Promise<unknown>[] = []
const context = new Map([
  [
    'ctx',
    { waitUntil: (promise: Promise<unknown>) => background.push(promise) },
  ],
])
beforeEach(() => {
  const database = createD1BatchFixture({ sqlite: fixture })
  fixture.current = database.sqlite
  fixture.db = database.db
  blobs.clear()
  vi.clearAllMocks()
  fixture.current.exec(`
    INSERT INTO workspaces (id, name, hd, created_at) VALUES ('workspace1', 'Workspace', 'example.test', '2026-01-01');
    INSERT INTO users (id, email, email_verified, workspace_id, created_at, updated_at) VALUES ('owner1', 'owner@example.test', 1, 'workspace1', '2026-01-01', '2026-01-01');
    INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client1', 'owner1', 'workspace1', 'Reports', '2026-01-01');
    INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client2', 'owner1', 'workspace1', 'Other reports', '2026-01-01');
    INSERT INTO cli_family_authorities (family_id, user_id, preset, workspace_id, publisher_client_id, status, created_at, updated_at) VALUES ('publisher-family', 'owner1', 'publisher', 'workspace1', 'client1', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO cli_refresh_credentials (id, user_id, token_hash, family_id, expires_at, created_at) VALUES ('credential1', 'owner1', 'test-hash', 'publisher-family', '2099-01-01', '2026-01-01');
  `)
})
afterEach(async () => {
  await Promise.all(background.splice(0))
  await fixture.db?.destroy()
  fixture.current = null
  fixture.db = null
})

function form(text = '<p>Report</p>') {
  const result = new FormData()
  result.set('file', new File([text], 'report.html', { type: 'text/html' }))
  return result
}
function args(path: string, body?: FormData, id?: string) {
  return {
    request: new Request(
      `https://example.test${path}`,
      body ? { method: 'POST', body } : {},
    ),
    context,
    params: { id },
  } as never
}
async function create() {
  const response = await upload(args('/api/shareables/uploads', form()))
  expect(response.status).toBe(200)
  await Promise.all(background.splice(0))
  return (await response.json()) as { id: string; versionId: string }
}
function snapshot() {
  const tables = fixture
    .current!.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>
  return {
    rows: tables.map(({ name }) => [
      name,
      fixture.current!.prepare(`SELECT * FROM "${name}"`).all(),
    ]),
    blobs: [...blobs],
    writes: bucket.put.mock.calls.length,
    deletes: bucket.delete.mock.calls.length,
    notifications: notify.mock.calls.length,
  }
}

test('publisher endpoints create, download and update with provenance and required concurrency', async () => {
  const created = await create()
  const initial = fixture
    .current!.prepare('SELECT * FROM shareables WHERE id = ?')
    .get(created.id)
  expect(initial).toMatchObject({
    owner_user_id: 'owner1',
    visibility: 'private',
    created_by_publisher_client_id: 'client1',
  })
  const source = await download(
    args(`/api/cli/artifacts/${created.id}/download`, undefined, created.id),
  )
  expect(source.status).toBe(200)
  expect(await source.text()).toBe('<p>Report</p>')
  const before = snapshot()
  for (const query of ['', '?expected_version=']) {
    const response = await update(
      args(
        `/api/shareables/${created.id}/versions${query}`,
        form('<p>Rejected</p>'),
        created.id,
      ),
    )
    expect(response.status).toBe(400)
    expect(snapshot()).toEqual(before)
  }
  const stale = await update(
    args(
      `/api/shareables/${created.id}/versions?expected_version=wrong-version`,
      form('<p>Rejected</p>'),
      created.id,
    ),
  )
  expect(stale.status).toBe(409)
  const compensated = snapshot()
  // The conflict path stages and deletes the blob, and updates the quota
  // bookkeeping timestamp while releasing its reservation.
  expect(compensated.rows.filter(([name]) => name !== 'workspaces')).toEqual(
    before.rows.filter(([name]) => name !== 'workspaces'),
  )
  expect(
    fixture.current!.prepare('SELECT storage_used_bytes FROM workspaces').get(),
  ).toEqual({ storage_used_bytes: 13 })
  expect(compensated.blobs).toEqual(before.blobs)
  expect(compensated.writes).toBe(before.writes + 1)
  expect(compensated.deletes).toBe(before.deletes + 1)
  const response = await update(
    args(
      `/api/shareables/${created.id}/versions?expected_version=${created.versionId}`,
      form('<p>Updated</p>'),
      created.id,
    ),
  )
  expect(response.status).toBe(200)
  expect(
    fixture
      .current!.prepare(
        'SELECT created_by_publisher_client_id FROM versions WHERE shareable_id = ?',
      )
      .all(created.id),
  ).toEqual([
    { created_by_publisher_client_id: 'client1' },
    { created_by_publisher_client_id: 'client1' },
  ])
})

test('excluded publisher endpoints leave rows, storage and notifications unchanged', async () => {
  const created = await create()
  const before = snapshot()
  const routes = [
    [list, 'GET', '/api/cli/artifacts'],
    [readback, 'GET', `/api/cli/artifacts/${created.id}`],
    [
      downloadWildcard,
      'GET',
      `/api/cli/artifacts/${created.id}/download/index.html`,
    ],
    [resolve, 'GET', `/api/cli/resolve?q=${created.id}`],
    [comments, 'GET', `/api/cli/artifacts/${created.id}/comments`],
    [comment, 'POST', `/api/cli/artifacts/${created.id}/comments`],
    [edit, 'POST', `/api/cli/shareables/${created.id}/edit`],
    [move, 'POST', `/api/cli/shareables/${created.id}/move`],
    [remove, 'DELETE', `/api/cli/artifacts/${created.id}`],
    [append, 'POST', `/api/cli/artifacts/${created.id}/append`],
    [projects, 'GET', '/api/cli/projects'],
    [createProject, 'POST', '/api/cli/projects'],
  ] as const
  for (const [run, method, path] of routes) {
    const response = await run({
      request: new Request(`https://example.test${path}`, {
        method,
        ...(method !== 'GET'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                name: 'Changed',
                retain_versions: 1,
                destination: 'home',
                content: 'Append',
                body: 'Comment',
              }),
            }
          : {}),
      }),
      context,
      params: { id: created.id, '*': 'index.html' },
    } as never)
    expect(response.status, `${method} ${path}`).toBe(403)
    expect(snapshot(), `${method} ${path}`).toEqual(before)
  }
  for (const query of [
    'artifact_kind=static_site',
    'base_version=version1',
    'delete_path=index.html',
    'visibility=link',
  ]) {
    expect(
      (
        await update(
          args(
            `/api/shareables/${created.id}/versions?expected_version=${created.versionId}&${query}`,
            form(),
            created.id,
          ),
        )
      ).status,
    ).toBe(403)
    expect(snapshot()).toEqual(before)
  }
  for (const field of [
    'created_by_publisher_client_id',
    'visibility',
    'retain_versions',
    'container_id',
  ]) {
    const body = form()
    body.set(field, 'untrusted')
    expect(
      (
        await update(
          args(
            `/api/shareables/${created.id}/versions?expected_version=${created.versionId}`,
            body,
            created.id,
          ),
        )
      ).status,
    ).toBe(403)
    expect(snapshot()).toEqual(before)
  }
})

test('publisher upload bypasses leave every database row, blob and notification unchanged', async () => {
  await create()
  const before = snapshot()
  for (const query of [
    '?publish_key=reports',
    '?container_id=project1',
    '?artifact_kind=static_site',
    '?expected_version=version1',
    '?visibility=workspace',
  ]) {
    expect(
      (await upload(args(`/api/shareables/uploads${query}`, form()))).status,
    ).toBe(403)
    expect(snapshot()).toEqual(before)
  }
  for (const [field, value] of [
    ['container_id', 'project1'],
    ['visibility', 'link'],
    ['created_by_publisher_client_id', 'client2'],
    ['grant_email', 'viewer@example.test'],
    ['artifact_kind', 'static_site'],
  ]) {
    const body = form()
    body.set(field!, value!)
    expect((await upload(args('/api/shareables/uploads', body))).status).toBe(
      403,
    )
    expect(snapshot()).toEqual(before)
  }
  const multiple = form()
  multiple.append(
    'file',
    new File(['second'], 'second.html', { type: 'text/html' }),
  )
  expect((await upload(args('/api/shareables/uploads', multiple))).status).toBe(
    403,
  )
  expect(snapshot()).toEqual(before)
})

test.each([null, 'client2'])(
  'publisher endpoints reject foreign provenance %s without mutation',
  async (client) => {
    const created = await create()
    fixture
      .current!.prepare(
        'UPDATE shareables SET created_by_publisher_client_id = ?, visibility = ? WHERE id = ?',
      )
      .run(client, 'workspace', created.id)
    const before = snapshot()
    expect(
      (
        await download(
          args(
            `/api/cli/artifacts/${created.id}/download`,
            undefined,
            created.id,
          ),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await update(
          args(
            `/api/shareables/${created.id}/versions?expected_version=${created.versionId}`,
            form(),
            created.id,
          ),
        )
      ).status,
    ).toBe(404)
    expect(snapshot()).toEqual(before)
  },
)

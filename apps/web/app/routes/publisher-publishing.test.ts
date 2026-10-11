import type { CliAuthority } from '~/services/cli-authority.server'
import type { D1BatchStmt } from '~/test/d1-batch-mock'
import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'

const fixture = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  afterNextBatch: null as (() => void | Promise<void>) | null,
  beforeNextBatch: null as
    | ((statements: D1BatchStmt[]) => void | Promise<void>)
    | null,
  db: null as Kysely<DB> | null,
}))
const blobs = vi.hoisted(() => new Map<string, string>())
const bucket = vi.hoisted(() => ({
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    objects: [...blobs.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key })),
    truncated: false,
  })),
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
const credential = vi.hoisted(() => ({
  value: undefined as CliAuthority | null | undefined,
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
  getCliAuthority: () =>
    credential.value === undefined ? authority : credential.value,
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
const context = new Map<string, unknown>([
  [
    'ctx',
    { waitUntil: (promise: Promise<unknown>) => background.push(promise) },
  ],
])
beforeEach(() => {
  credential.value = undefined
  context.set('authSource', 'bearer')
  fixture.beforeNextBatch = null
  fixture.afterNextBatch = null
  const database = createD1BatchFixture({ sqlite: fixture })
  fixture.current = database.sqlite
  fixture.db = database.db
  bucket.put.mockImplementation(async (key: string, body: BodyInit) => {
    blobs.set(key, await new Response(body).text())
  })
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
  expect(source.headers.get('content-disposition')).toBe('attachment')
  expect(source.headers.get('x-content-type-options')).toBe('nosniff')
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
    [
      downloadWildcard,
      'GET',
      `/api/cli/artifacts/${created.id}/download/index.html`,
    ],
    [resolve, 'GET', `/api/cli/resolve?q=${created.id}`],
    [comments, 'GET', `/api/cli/artifacts/${created.id}/comments`],
    [comment, 'POST', `/api/cli/artifacts/${created.id}/comments`],
    [move, 'POST', `/api/cli/shareables/${created.id}/move`],
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
              headers: {
                'content-type': 'application/json',
                Origin: 'https://example.test',
              },
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

function jsonArgs(id: string, method: string, body?: unknown) {
  return {
    context,
    params: { id },
    url: new URL(`https://example.test/api/cli/shareables/${id}/edit`),
    request: new Request(`https://example.test/api/cli/shareables/${id}/edit`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: {
              'content-type': 'application/json',
              Origin: 'https://example.test',
            },
            body: JSON.stringify(body),
          }),
    }),
  } as never
}
function site(files: Record<string, string>) {
  const body = new FormData()
  for (const [path, text] of Object.entries(files))
    body.append(
      'file',
      new File([text], path, {
        type: path.endsWith('.html') ? 'text/html' : 'text/css',
      }),
    )
  return body
}

test('publisher static site manifest, delta, retention, readback and deletion', async () => {
  const response = await upload(
    args(
      '/api/shareables/uploads?artifact_kind=static_site',
      site({
        'index.html': '<h1>Site</h1>',
        'keep.css': 'a{}',
        'remove.css': 'b{}',
      }),
    ),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string; versionId: string }
  const manifestResponse = await download(
    args(`/api/cli/artifacts/${created.id}/download`, undefined, created.id),
  )
  const manifest = (await manifestResponse.json()) as {
    version_id: string
    files: { path: string; sha256: string }[]
  }
  expect(manifest.version_id).toBe(created.versionId)
  expect(manifest.files).toHaveLength(3)
  const initial = await fixture
    .db!.selectFrom('shareables')
    .selectAll()
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  const next = await update(
    args(
      `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${manifest.version_id}&delete_path=/remove.css`,
      site({ 'index.html': '<h1>Changed</h1>' }),
      created.id,
    ),
  )
  expect(next.status).toBe(200)
  const changed = await fixture
    .db!.selectFrom('shareables')
    .selectAll()
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  for (const key of [
    'visibility',
    'owner_user_id',
    'container_id',
    'retain_versions',
    'created_by_publisher_client_id',
  ] as const)
    expect(changed[key]).toBe(initial[key])
  const files = await fixture
    .db!.selectFrom('version_files')
    .select(['path', 'sha256'])
    .where('version_id', '=', changed.current_version_id!)
    .execute()
  expect(files).toContainEqual({
    path: '/keep.css',
    sha256: manifest.files.find((file) => file.path === '/keep.css')!.sha256,
  })
  expect(files.map((file) => file.path).sort()).toEqual([
    '/index.html',
    '/keep.css',
  ])
  expect(
    await fixture
      .db!.selectFrom('versions')
      .select('created_by_publisher_client_id')
      .where('shareable_id', '=', created.id)
      .execute(),
  ).toEqual([
    { created_by_publisher_client_id: 'client1' },
    { created_by_publisher_client_id: 'client1' },
  ])
  const before = snapshot()
  for (const payload of [
    {},
    { retain_versions: 0 },
    { retain_versions: 1, title: '' },
    { retain_versions: null, unexpected: null },
  ]) {
    expect((await edit(jsonArgs(created.id, 'PATCH', payload))).status).toBe(
      400,
    )
    expect(snapshot()).toEqual(before)
  }
  for (const [method, value, deleted] of [
    ['POST', 2, 0],
    ['PATCH', 1, 1],
    ['PATCH', null, 0],
  ] as const) {
    const edited = await edit(
      jsonArgs(created.id, method, { retain_versions: value }),
    )
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({
      retain_versions: value,
      deleted_versions: deleted,
    })
  }
  const read = await readback(
    args(`/api/cli/artifacts/${created.id}`, undefined, created.id),
  )
  expect(await read.json()).toMatchObject({
    id: created.id,
    artifact_kind: 'static_site',
    visibility: 'private',
    retain_versions: null,
  })
  expect(
    (
      await readback(
        args(
          `/api/cli/artifacts/${created.id}?include=comments`,
          undefined,
          created.id,
        ),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await readback(
        args(
          `/api/cli/artifacts/${created.id}?offset=0`,
          undefined,
          created.id,
        ),
      )
    ).status,
  ).toBe(400)
  expect((await remove(jsonArgs(created.id, 'DELETE'))).status).toBe(200)
  expect(blobs.size).toBe(0)
  expect(
    await fixture
      .db!.selectFrom('workspaces')
      .select('storage_used_bytes')
      .executeTakeFirst(),
  ).toEqual({ storage_used_bytes: 0 })
})

test('adoption preserves provenance, replaces scope, and audits repeated assignments', async () => {
  const { adoptPublisherArtifact } =
    await import('~/services/publisher-adoption.server')
  const created = await create()
  const user = { id: 'owner1', workspaceId: 'workspace1' }
  const original = await fixture
    .db!.selectFrom('shareables')
    .selectAll()
    .where('id', '=', created.id)
    .executeTakeFirstOrThrow()
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      user,
      authority,
      false,
      created.id,
      'client2',
    ),
  ).toEqual({ kind: 'scope-denied' })
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      user,
      null,
      true,
      created.id,
      'missing',
    ),
  ).toEqual({ kind: 'not-found' })
  for (let i = 0; i < 2; i++)
    expect(
      await adoptPublisherArtifact(
        fixture.db!,
        user,
        null,
        true,
        created.id,
        'client2',
      ),
    ).toEqual({ kind: 'ok' })
  expect(
    await fixture
      .db!.selectFrom('shareables')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirst(),
  ).toEqual({ ...original, assigned_publisher_client_id: 'client2' })
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
      await readback(
        args(`/api/cli/artifacts/${created.id}`, undefined, created.id),
      )
    ).status,
  ).toBe(404)
  expect((await remove(jsonArgs(created.id, 'DELETE'))).status).toBe(404)
  expect(
    (await edit(jsonArgs(created.id, 'POST', { retain_versions: 1 }))).status,
  ).toBe(404)
  const events = await fixture
    .db!.selectFrom('audit_events')
    .selectAll()
    .where('action', '=', 'artifact.publisher_adopted')
    .execute()
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({
    actor_user_id: 'owner1',
    workspace_id: 'workspace1',
    subject_type: 'shareable',
    subject_id: created.id,
  })
  expect(JSON.parse(events[0]!.detail!)).toEqual({
    artifact_title: 'report.html',
    previous_publisher_client_id: 'client1',
    previous_publisher_client_name: 'Reports',
    publisher_client_id: 'client2',
    publisher_client_name: 'Other reports',
  })
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      user,
      null,
      true,
      created.id,
      'client1',
    ),
  ).toEqual({ kind: 'ok' })
  expect(
    (
      await readback(
        args(`/api/cli/artifacts/${created.id}`, undefined, created.id),
      )
    ).status,
  ).toBe(200)
})

async function createSite() {
  const response = await upload(
    args(
      '/api/shareables/uploads?artifact_kind=static_site',
      site({
        'index.html': '<h1>Site</h1>',
        'keep.css': 'a{}',
        'remove.css': 'b{}',
      }),
    ),
  )
  expect(response.status).toBe(200)
  await Promise.all(background.splice(0))
  return (await response.json()) as { id: string; versionId: string }
}

const revoke = {
  assignment: "UPDATE shareables SET assigned_publisher_client_id = 'client2'",
  owner: "UPDATE shareables SET owner_user_id = 'owner2'",
  family: "UPDATE cli_family_authorities SET status = 'revoked'",
  superseded: "UPDATE cli_family_authorities SET status = 'superseded'",
  refresh: "UPDATE cli_refresh_credentials SET revoked_at = '2026-01-01'",
  expired: "UPDATE cli_refresh_credentials SET expires_at = '2020-01-01'",
  membership:
    "UPDATE workspace_members SET status = 'removed' WHERE user_id = 'owner1'",
} as const
function seedOtherOwner() {
  fixture.current!.exec(
    "INSERT INTO users (id, email, email_verified, workspace_id, created_at, updated_at) VALUES ('owner2', 'other@example.test', 1, 'workspace1', '2026-01-01', '2026-01-01')",
  )
}

test.each(Object.keys(revoke) as (keyof typeof revoke)[])(
  'static version commit rejects concurrent %s changes and cleans staged files',
  async (mode) => {
    const created = await createSite()
    seedOtherOwner()
    const versions = await fixture
      .db!.selectFrom('versions')
      .selectAll()
      .execute()
    const files = await fixture
      .db!.selectFrom('version_files')
      .selectAll()
      .execute()
    const objects = [...blobs]
    const stored = await fixture
      .db!.selectFrom('workspaces')
      .select('storage_used_bytes')
      .executeTakeFirst()
    bucket.put.mockImplementationOnce(async (key: string, body: BodyInit) => {
      blobs.set(key, await new Response(body).text())
      fixture.beforeNextBatch = () => {
        fixture.current!.exec(revoke[mode])
      }
    })
    const response = await update(
      args(
        `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}`,
        site({ 'index.html': '<h1>Rejected</h1>' }),
        created.id,
      ),
    )
    expect(response.status).toBe(404)
    expect(
      await fixture.db!.selectFrom('versions').selectAll().execute(),
    ).toEqual(versions)
    expect(
      await fixture.db!.selectFrom('version_files').selectAll().execute(),
    ).toEqual(files)
    expect([...blobs]).toEqual(objects)
    expect(
      await fixture
        .db!.selectFrom('workspaces')
        .select('storage_used_bytes')
        .executeTakeFirst(),
    ).toEqual(stored)
  },
)

test.each(['assignment', 'owner', 'family', 'refresh', 'membership'] as const)(
  'retention and delete recheck %s inside their mutation batches',
  async (mode) => {
    const created = await createSite()
    seedOtherOwner()
    const before = await fixture
      .db!.selectFrom('versions')
      .selectAll()
      .execute()
    fixture.beforeNextBatch = () => {
      fixture.current!.exec(revoke[mode])
    }
    expect(
      (await edit(jsonArgs(created.id, 'PATCH', { retain_versions: 1 })))
        .status,
    ).toBe(404)
    expect(
      await fixture
        .db!.selectFrom('shareables')
        .select('retain_versions')
        .executeTakeFirst(),
    ).toEqual({ retain_versions: null })
    expect(
      await fixture.db!.selectFrom('versions').selectAll().execute(),
    ).toEqual(before)
    expect((await remove(jsonArgs(created.id, 'DELETE'))).status).toBe(404)
    expect(bucket.delete).not.toHaveBeenCalled()
  },
)

test('delete authorization is rechecked after lookup and before accounting or audit', async () => {
  const created = await createSite()
  const before = snapshot()
  fixture.beforeNextBatch = () => {
    fixture.current!.exec(revoke.assignment)
  }
  expect((await remove(jsonArgs(created.id, 'DELETE'))).status).toBe(404)
  const after = snapshot()
  expect(after.rows.filter(([name]) => name !== 'shareables')).toEqual(
    before.rows.filter(([name]) => name !== 'shareables'),
  )
  expect(after.blobs).toEqual(before.blobs)
  expect(bucket.delete).not.toHaveBeenCalled()
})

test('static site validates multipart controls and version preconditions without publishing', async () => {
  const created = await createSite()
  const before = await fixture.db!.selectFrom('versions').selectAll().execute()
  const objects = [...blobs]
  for (const query of [
    '',
    '&base_version=',
    '&base_version=version1&base_version=version2',
    `&base_version=${created.versionId}&expected_version=version1`,
    '&delete_path=/keep.css',
    `&expected_version=${created.versionId}&expected_version=${created.versionId}`,
  ]) {
    expect(
      (
        await update(
          args(
            `/api/shareables/${created.id}/versions?artifact_kind=static_site${query}`,
            site({ 'index.html': 'Rejected' }),
            created.id,
          ),
        )
      ).status,
    ).toBe(400)
  }
  for (const field of [
    'retain_versions',
    'visibility',
    'container_id',
    'grant_email',
    'unexpected',
    'file',
  ]) {
    const body = site({ 'index.html': 'Rejected' })
    body.append(field, '')
    expect(
      (
        await update(
          args(
            `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}`,
            body,
            created.id,
          ),
        )
      ).status,
    ).toBe(403)
  }
  for (const field of [
    'retain_versions',
    'container_id',
    'grant_email',
    'link_expires_at',
    'publish_key',
    'unexpected',
  ]) {
    const body = site({ 'index.html': 'Rejected' })
    body.append(field, '')
    expect(
      (
        await upload(
          args('/api/shareables/uploads?artifact_kind=static_site', body),
        )
      ).status,
    ).toBe(403)
  }
  expect(
    await fixture.db!.selectFrom('versions').selectAll().execute(),
  ).toEqual(before)
  expect([...blobs]).toEqual(objects)
  const deletion = await update({
    context,
    params: { id: created.id },
    request: new Request(
      `https://example.test/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}&delete_path=/remove.css&delete_path=/keep.css`,
      { method: 'POST' },
    ),
  } as never)
  expect(deletion.status).toBe(200)
  const current = (await deletion.json()) as { versionId: string }
  expect(
    (
      await update(
        args(
          `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}`,
          site({ 'index.html': 'Stale' }),
          created.id,
        ),
      )
    ).status,
  ).toBe(409)
  expect(
    (
      await update({
        context,
        params: { id: created.id },
        request: new Request(
          `https://example.test/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${current.versionId}&delete_path=/index.html`,
          { method: 'POST' },
        ),
      } as never)
    ).status,
  ).toBe(400)
  expect(
    (
      await update(
        args(
          `/api/shareables/${created.id}/versions?artifact_kind=static_site&expected_version=${current.versionId}`,
          site({ 'index.html': 'Replacement' }),
          created.id,
        ),
      )
    ).status,
  ).toBe(200)
})

test('adopt route accepts owner unrestricted and genuine sessions and denies other credentials', async () => {
  const { action: adopt } = await import('./api.cli.artifacts.$id.adopt')
  credential.value = { kind: 'unrestricted' }
  const created = await create()
  expect(
    await fixture
      .db!.selectFrom('shareables')
      .select('created_by_publisher_client_id')
      .executeTakeFirst(),
  ).toEqual({ created_by_publisher_client_id: null })
  expect(
    (
      await adopt(
        jsonArgs(created.id, 'POST', { publisher_client_id: 'client1' }),
      )
    ).status,
  ).toBe(200)
  credential.value = undefined
  expect(
    (
      await readback(
        args(`/api/cli/artifacts/${created.id}`, undefined, created.id),
      )
    ).status,
  ).toBe(200)
  const before = snapshot()
  for (const denied of [
    authority,
    { kind: 'agent' },
    { kind: 'bootstrap' },
    { kind: 'bridge' },
  ] as CliAuthority[]) {
    credential.value = denied
    expect(
      (
        await adopt(
          jsonArgs(created.id, 'POST', { publisher_client_id: 'client2' }),
        )
      ).status,
    ).toBe(403)
    expect(snapshot()).toEqual(before)
  }
  credential.value = null
  expect(
    (
      await adopt(
        jsonArgs(created.id, 'POST', { publisher_client_id: 'client2' }),
      )
    ).status,
  ).toBe(403)
  context.set('authSource', 'cookie')
  for (const body of [
    {},
    { publisher_client_id: '' },
    { publisher_client_id: 'client2', visibility: null },
  ])
    expect((await adopt(jsonArgs(created.id, 'POST', body))).status).toBe(400)
  expect(
    (
      await adopt(
        jsonArgs(created.id, 'POST', { publisher_client_id: 'client2' }),
      )
    ).status,
  ).toBe(200)
  expect(
    (await edit(jsonArgs(created.id, 'PATCH', { retain_versions: 1 }))).status,
  ).toBe(405)
})

test('adoption compare-and-set and failed audit cannot mutate assignment', async () => {
  const { adoptPublisherArtifact } =
    await import('~/services/publisher-adoption.server')
  const created = await create()
  const user = { id: 'owner1', workspaceId: 'workspace1' }
  fixture.beforeNextBatch = () => {
    fixture.current!.exec(revoke.assignment)
  }
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      user,
      null,
      true,
      created.id,
      'client1',
    ),
  ).toEqual({ kind: 'conflict' })
  expect(
    await fixture
      .db!.selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'artifact.publisher_adopted')
      .execute(),
  ).toEqual([])
  fixture.current!.exec(
    "CREATE TRIGGER reject_adoption BEFORE INSERT ON audit_events WHEN NEW.action = 'artifact.publisher_adopted' BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
  )
  await expect(
    adoptPublisherArtifact(
      fixture.db!,
      user,
      null,
      true,
      created.id,
      'client1',
    ),
  ).rejects.toThrow()
  expect(
    await fixture
      .db!.selectFrom('shareables')
      .select('assigned_publisher_client_id')
      .executeTakeFirst(),
  ).toEqual({ assigned_publisher_client_id: 'client2' })
})

test('adoption rejects foreign clients, foreign artifacts, nonowners and revoked membership', async () => {
  const { adoptPublisherArtifact } =
    await import('~/services/publisher-adoption.server')
  const created = await create()
  seedOtherOwner()
  fixture.current!.exec(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('workspace2', 'Other workspace', '2026-01-01');
    INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client3', 'owner2', 'workspace1', 'Foreign owner', '2026-01-01');
    INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client4', 'owner1', 'workspace2', 'Foreign workspace', '2026-01-01');
  `)
  const user = { id: 'owner1', workspaceId: 'workspace1' }
  const before = snapshot()
  for (const client of ['client3', 'client4', 'missing'])
    expect(
      await adoptPublisherArtifact(
        fixture.db!,
        user,
        { kind: 'unrestricted' },
        false,
        created.id,
        client,
      ),
    ).toEqual({ kind: 'not-found' })
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      { id: 'owner2', workspaceId: 'workspace1' },
      { kind: 'unrestricted' },
      false,
      created.id,
      'client3',
    ),
  ).toEqual({ kind: 'not-found' })
  expect(snapshot()).toEqual(before)
  fixture.current!.exec(revoke.membership)
  expect(
    await adoptPublisherArtifact(
      fixture.db!,
      user,
      null,
      true,
      created.id,
      'client2',
    ),
  ).toEqual({ kind: 'not-found' })
  expect(
    await fixture
      .db!.selectFrom('audit_events')
      .select('id')
      .where('action', '=', 'artifact.publisher_adopted')
      .execute(),
  ).toEqual([])
})

test('static create cannot publish after authority revocation while files are staged', async () => {
  bucket.put.mockImplementationOnce(async (key: string, body: BodyInit) => {
    blobs.set(key, await new Response(body).text())
    fixture.beforeNextBatch = () => {
      fixture.current!.exec(revoke.family)
    }
  })
  const response = await upload(
    args(
      '/api/shareables/uploads?artifact_kind=static_site',
      site({ 'index.html': 'Rejected' }),
    ),
  )
  expect(response.ok).toBe(false)
  expect(
    await fixture.db!.selectFrom('shareables').select('id').execute(),
  ).toEqual([])
  expect(
    await fixture.db!.selectFrom('versions').select('id').execute(),
  ).toEqual([])
  expect(
    await fixture
      .db!.selectFrom('workspaces')
      .select('storage_used_bytes')
      .executeTakeFirst(),
  ).toEqual({ storage_used_bytes: 0 })
  expect(blobs.size).toBe(0)
})

test.each([
  ['html_page', 'session'],
  ['markdown_page', 'session'],
  ['static_site', 'session'],
  ['html_page', 'unrestricted'],
  ['markdown_page', 'unrestricted'],
  ['static_site', 'unrestricted'],
] as const)(
  'owner adopts a shared and moved %s via %s without changing provenance or settings',
  async (kind, auth) => {
    const { action: adopt } = await import('./api.cli.artifacts.$id.adopt')
    credential.value = null
    context.set('authSource', 'cookie')
    const body =
      kind === 'static_site'
        ? site({ 'index.html': 'Site', 'keep.css': 'a{}' })
        : new FormData()
    if (kind !== 'static_site')
      body.set(
        'file',
        new File(
          ['Original'],
          kind === 'html_page' ? 'report.html' : 'report.md',
        ),
      )
    const response = await upload(
      args(
        `/api/shareables/uploads${kind === 'static_site' ? '?artifact_kind=static_site' : ''}`,
        body,
      ),
    )
    expect(response.status).toBe(200)
    const created = (await response.json()) as { id: string; versionId: string }
    await Promise.all(background.splice(0))
    fixture.current!.exec(
      "INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('project1', 'workspace1', 'project', NULL, 'owner1', 'Project', '2026-01-01', '2026-01-01')",
    )
    await fixture
      .db!.updateTable('shareables')
      .set({
        container_id: 'project1',
        visibility: 'workspace',
        retain_versions: 3,
        title_override: 'Owner title',
      })
      .where('id', '=', created.id)
      .execute()
    await fixture
      .db!.insertInto('shareable_grants')
      .values({
        shareable_id: created.id,
        granted_email: 'viewer@example.test',
        granted_by: 'owner1',
        granted_at: '2026-01-01',
      })
      .execute()
    const initial = await fixture
      .db!.selectFrom('shareables')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    const versions = await fixture
      .db!.selectFrom('versions')
      .selectAll()
      .where('shareable_id', '=', created.id)
      .execute()
    const grants = await fixture
      .db!.selectFrom('shareable_grants')
      .selectAll()
      .execute()
    credential.value = auth === 'unrestricted' ? { kind: 'unrestricted' } : null
    const assigned = await adopt(
      jsonArgs(created.id, 'POST', { publisher_client_id: 'client1' }),
    )
    expect(assigned.status).toBe(200)
    expect(await assigned.json()).toEqual({
      id: created.id,
      publisher_client_id: 'client1',
    })
    expect(
      await fixture
        .db!.selectFrom('shareables')
        .selectAll()
        .where('id', '=', created.id)
        .executeTakeFirst(),
    ).toEqual({ ...initial, assigned_publisher_client_id: 'client1' })
    expect(
      await fixture
        .db!.selectFrom('versions')
        .selectAll()
        .where('shareable_id', '=', created.id)
        .execute(),
    ).toEqual(versions)
    credential.value = undefined
    const read = await readback(
      args(`/api/cli/artifacts/${created.id}`, undefined, created.id),
    )
    expect(await read.json()).toMatchObject({
      visibility: 'workspace',
      project_id: 'project1',
    })
    const versionBody =
      kind === 'static_site' ? site({ 'index.html': 'Next' }) : new FormData()
    if (kind !== 'static_site')
      versionBody.set(
        'file',
        new File(['Next'], kind === 'html_page' ? 'next.html' : 'next.md'),
      )
    const updated = await update(
      args(
        `/api/shareables/${created.id}/versions?${kind === 'static_site' ? 'artifact_kind=static_site&base_version' : 'expected_version'}=${created.versionId}`,
        versionBody,
        created.id,
      ),
    )
    expect(updated.status).toBe(200)
    const final = await fixture
      .db!.selectFrom('shareables')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()
    for (const key of [
      'owner_user_id',
      'container_id',
      'visibility',
      'retain_versions',
      'title_override',
      'created_by_publisher_client_id',
    ] as const)
      expect(final[key]).toEqual(initial[key])
    expect(
      await fixture.db!.selectFrom('shareable_grants').selectAll().execute(),
    ).toEqual(grants)
    expect(
      await fixture
        .db!.selectFrom('versions')
        .select('created_by_publisher_client_id')
        .where('id', '=', final.current_version_id!)
        .executeTakeFirst(),
    ).toEqual({ created_by_publisher_client_id: 'client1' })
    await expect(
      fixture
        .db!.deleteFrom('publisher_clients')
        .where('id', '=', 'client1')
        .execute(),
    ).rejects.toThrow()
  },
)

test('retention cannot prune or write accounting after assignment changes before the pruning batch', async () => {
  const created = await createSite()
  expect(
    (
      await update(
        args(
          `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}`,
          site({ 'index.html': 'Next' }),
          created.id,
        ),
      )
    ).status,
  ).toBe(200)
  const before = await fixture
    .db!.selectFrom('workspaces')
    .select(['storage_used_bytes', 'storage_updated_at'])
    .executeTakeFirst()
  const versions = await fixture
    .db!.selectFrom('versions')
    .selectAll()
    .execute()
  fixture.afterNextBatch = () => {
    fixture.beforeNextBatch = () => {
      fixture.current!.exec(revoke.assignment)
    }
  }
  const response = await edit(
    jsonArgs(created.id, 'POST', { retain_versions: 1 }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    retain_versions: 1,
    deleted_versions: 0,
  })
  expect(
    await fixture
      .db!.selectFrom('workspaces')
      .select(['storage_used_bytes', 'storage_updated_at'])
      .executeTakeFirst(),
  ).toEqual(before)
  expect(
    await fixture.db!.selectFrom('versions').selectAll().execute(),
  ).toEqual(versions)
  expect(
    await fixture
      .db!.selectFrom('version_retention_tombstones')
      .selectAll()
      .execute(),
  ).toEqual([])
  expect(bucket.delete).not.toHaveBeenCalled()
})

test.each([
  [{ 'Content-Type': 'application/json' }, 403],
  [
    {
      Origin: 'https://other.example.test',
      'Content-Type': 'application/json',
    },
    403,
  ],
  [
    {
      Origin: 'https://example.test',
      'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/json',
    },
    403,
  ],
  [{ Origin: 'https://example.test', 'Content-Type': 'text/plain' }, 415],
  [
    {
      Origin: 'https://example.test',
      'Content-Type': 'application/json-invalid',
    },
    415,
  ],
  [{ Origin: 'https://example.test' }, 415],
] as const)(
  'browser adoption rejects unsafe headers %j before reading the payload',
  async (headers, status) => {
    const { action: adopt } = await import('./api.cli.artifacts.$id.adopt')
    const created = await create()
    credential.value = null
    context.set('authSource', 'cookie')
    const before = snapshot()
    const request = new Request(
      `https://example.test/api/cli/artifacts/${created.id}/adopt`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ publisher_client_id: 'client2' }),
      },
    )
    const result = await adopt({
      context,
      params: { id: created.id },
      request,
    } as never)
    expect(result.status).toBe(status)
    expect(request.bodyUsed).toBe(false)
    expect(snapshot()).toEqual(before)
  },
)

test('unrestricted static-site updates retain the existing invalid-query response', async () => {
  credential.value = { kind: 'unrestricted' }
  const response = await upload(
    args(
      '/api/shareables/uploads?artifact_kind=static_site',
      site({ 'index.html': '<h1>First</h1>' }),
    ),
  )
  expect(response.status).toBe(200)
  const created = (await response.json()) as { id: string; versionId: string }
  const result = await update(
    args(
      `/api/shareables/${created.id}/versions?artifact_kind=static_site&base_version=${created.versionId}&expected_version=version1`,
      site({ 'index.html': '<h1>Second</h1>' }),
      created.id,
    ),
  )
  expect(result.status).toBe(400)
  expect(await result.json()).toMatchObject({
    error: { code: 'validation-failed', message: 'Invalid version query.' },
  })
})

test.each(['html_page', 'static_site'])(
  'published %s still enforces owner retention after publisher revocation',
  async (kind) => {
    const created =
      kind === 'html_page'
        ? await create()
        : ((await (
            await upload(
              args(
                '/api/shareables/uploads?artifact_kind=static_site',
                site({ 'index.html': '<h1>First</h1>' }),
              ),
            )
          ).json()) as { id: string; versionId: string })
    fixture
      .current!.prepare(
        'UPDATE shareables SET retain_versions = 1 WHERE id = ?',
      )
      .run(created.id)
    let revoked = false
    const revokeAfterPublish = () => {
      const row = fixture
        .current!.prepare(
          'SELECT current_version_id FROM shareables WHERE id = ?',
        )
        .get(created.id)
      if (row?.current_version_id !== created.versionId) {
        fixture.current!.exec(
          "UPDATE cli_family_authorities SET status = 'revoked'",
        )
        revoked = true
      } else fixture.afterNextBatch = revokeAfterPublish
    }
    fixture.afterNextBatch = revokeAfterPublish
    const result = await update(
      args(
        `/api/shareables/${created.id}/versions?${kind === 'static_site' ? 'artifact_kind=static_site&base_version' : 'expected_version'}=${created.versionId}`,
        kind === 'static_site'
          ? site({ 'index.html': '<h1>Second</h1>' })
          : form('<h1>Second</h1>'),
        created.id,
      ),
    )
    expect(result.status).toBe(200)
    expect(revoked).toBe(true)
    const versions = await fixture
      .db!.selectFrom('versions')
      .select('id')
      .where('shareable_id', '=', created.id)
      .execute()
    expect(versions).toHaveLength(1)
    expect(versions[0]!.id).not.toBe(created.versionId)
    expect(
      await fixture
        .db!.selectFrom('version_retention_tombstones')
        .select('version_id')
        .execute(),
    ).toEqual([{ version_id: created.versionId }])
  },
)

test('publisher edit uses the normalized public URL and shared edit response', async () => {
  const created = await create()
  const result = await edit({
    context,
    params: { id: created.id },
    url: new URL(`https://example.test/api/cli/shareables/${created.id}/edit`),
    request: new Request(
      `http://internal.invalid/api/cli/shareables/${created.id}/edit`,
      { method: 'PATCH', body: JSON.stringify({ retain_versions: null }) },
    ),
  } as never)
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({
    artifact: { id: created.id, url: `https://example.test/a/${created.id}` },
    title: 'report.html',
    destination: { type: 'home', project_id: null },
    share: { visibility: 'private', link_expires_at: null },
    retain_versions: null,
    deleted_versions: 0,
  })
})

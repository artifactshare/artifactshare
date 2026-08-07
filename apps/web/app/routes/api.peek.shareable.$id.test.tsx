import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
const h = vi.hoisted(() => ({
  db: null as any,
  selectedTables: [] as string[],
  loadPreviewExcerpt: vi.fn(),
  user: {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    emailVerified: true,
    name: 'U1',
    hd: null,
  },
}))
vi.mock('~/services/db.server', () => ({ createDb: () => h.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: () => {} }))
vi.mock('~/middleware/context', () => ({ requireUser: (c: any) => h.user }))
vi.mock('~/services/content.server', () => ({
  loadPreviewExcerpt: h.loadPreviewExcerpt,
}))
import { loader } from './api.peek.shareable.$id'
async function setup() {
  h.user = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    emailVerified: true,
    name: 'U1',
    hd: null,
  }
  h.loadPreviewExcerpt.mockReset()
  h.loadPreviewExcerpt.mockResolvedValue(null)
  const f = createMigratedInMemoryDb()
  h.selectedTables = []
  h.db = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property === 'selectFrom') {
        return (table: string) => {
          h.selectedTables.push(table)
          return target.selectFrom(table as never)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  for (const [id, ws] of [
    ['w1', 'example.com'],
    ['w2', 'other.example'],
  ] as const)
    await h.db
      .insertInto('workspaces')
      .values({
        id,
        name: id,
        hd: ws,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01',
      })
      .execute()
  for (const [id, ws] of [
    ['u1', 'w1'],
    ['u2', 'w1'],
    ['g1', 'w2'],
  ] as const)
    await h.db
      .insertInto('users')
      .values({
        id,
        email: `${id}@${ws === 'w1' ? 'example.com' : 'other.example'}`,
        name: id,
        email_verified: 1,
        image: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        workspace_id: ws,
        locale: null,
      })
      .execute()
  await h.db
    .insertInto('artifact_containers')
    .values({
      id: 'c1',
      workspace_id: 'w1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Inbox',
      base_visibility: 'workspace',
      archived_at: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    .execute()
  await h.db
    .insertInto('shareables')
    .values({
      id: 's1',
      workspace_id: 'w1',
      owner_user_id: 'u1',
      name: 'Title',
      derived_title: null,
      title_override: null,
      description: 'Desc',
      artifact_kind: 'markdown_page',
      visibility: 'workspace',
      container_id: 'c1',
      view_count: 3,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    .execute()
}
async function addCurrentVersion(
  artifactKind:
    | 'markdown_page'
    | 'html_page'
    | 'static_site'
    | 'spa'
    | 'workspace_app' = 'markdown_page',
) {
  await h.db
    .insertInto('versions')
    .values({
      id: 'v1',
      shareable_id: 's1',
      artifact_kind: artifactKind,
      status: 'published',
      entrypoint_path: 'index.html',
      r2_key: 'artifacts/s1/v1/index.html',
      size_bytes: 100,
      sha256: 'hash',
      created_by_id: 'u1',
      created_at: '2026-01-02T00:00:00Z',
      published_at: '2026-01-02T00:00:00Z',
    })
    .execute()
  await h.db
    .updateTable('shareables')
    .set({ current_version_id: 'v1', artifact_kind: artifactKind })
    .where('id', '=', 's1')
    .execute()
}
const args = (id: string) =>
  ({
    params: { id },
    context: new Map(),
    request: new Request('https://x'),
  }) as never
const json = async (response: Response) =>
  (await response.json()) as Record<string, unknown>
describe('peek shareable', () => {
  beforeEach(setup)
  test('member can read and fields are returned', async () => {
    h.selectedTables = []
    const r = await loader(args('s1'))
    expect(r.status).toBe(200)
    const body = await json(r)
    expect(body).toMatchObject({
      title: 'Title',
      description: 'Desc',
      ownerName: 'u1',
      versionCount: 0,
      viewCount: 3,
      commentCount: 0,
      containerName: 'Inbox',
    })
    expect(body).not.toHaveProperty('activity')
    expect(h.selectedTables).not.toContain('events')
  })
  test('Markdown uses the extracted body even when description exists', async () => {
    await addCurrentVersion()
    h.loadPreviewExcerpt.mockResolvedValue(
      'Markdown の本文抜粋です。十分な長さがあります。',
    )
    const body = await json(await loader(args('s1')))
    expect(body.excerpt).toBe('Markdown の本文抜粋です。十分な長さがあります。')
    expect(h.loadPreviewExcerpt).toHaveBeenCalledWith(
      'artifacts/s1/v1/index.html',
      'markdown_page',
    )
  })
  test('HTML uses description without reading stored content', async () => {
    await addCurrentVersion('html_page')
    const body = await json(await loader(args('s1')))
    expect(body.excerpt).toBe('Desc')
    expect(h.loadPreviewExcerpt).not.toHaveBeenCalled()
  })
  test('HTML without description falls back to extracted body', async () => {
    await addCurrentVersion('html_page')
    await h.db
      .updateTable('shareables')
      .set({ description: null })
      .where('id', '=', 's1')
      .execute()
    h.loadPreviewExcerpt.mockResolvedValue(
      'HTML の本文抜粋です。十分な長さがあります。',
    )
    const body = await json(await loader(args('s1')))
    expect(body.excerpt).toBe('HTML の本文抜粋です。十分な長さがあります。')
  })
  test.each([
    ['short', null],
    ['empty', null],
  ])('%s extracted content returns no excerpt', async (_label, excerpt) => {
    await addCurrentVersion()
    h.loadPreviewExcerpt.mockResolvedValue(excerpt)
    expect((await json(await loader(args('s1')))).excerpt).toBeNull()
  })
  test('unsupported content returns no excerpt without reading storage', async () => {
    await addCurrentVersion('static_site')
    expect((await json(await loader(args('s1')))).excerpt).toBeNull()
    expect(h.loadPreviewExcerpt).not.toHaveBeenCalled()
  })
  test('R2 failure returns no excerpt without failing the route', async () => {
    await addCurrentVersion()
    h.loadPreviewExcerpt.mockRejectedValue(new Error('R2 unavailable'))
    const response = await loader(args('s1'))
    expect(response.status).toBe(200)
    expect((await json(response)).excerpt).toBeNull()
  })
  test('other user private 404', async () => {
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'private' })
      .where('id', '=', 's1')
      .execute()
    h.user = { ...h.user, id: 'u2' }
    const r = await loader(args('s1'))
    expect(r.status).toBe(404)
  })
  test('per-file grant does not reveal a private project name to a non-member', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', 'c1')
      .execute()
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'private' })
      .where('id', '=', 's1')
      .execute()
    await h.db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's1',
        granted_email: 'u2@example.com',
        granted_at: '2026-01-01',
        granted_by: 'u1',
      })
      .execute()
    h.user = { ...h.user, id: 'u2', email: 'u2@example.com' }
    const body = await json(await loader(args('s1')))
    expect(body.containerId).toBeNull()
    expect(body.containerName).toBeNull()
    expect(body.containerKind).toBeNull()
  })
  test('invalid link policy metadata returns 404 without loading an excerpt', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', 'c1')
      .execute()
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 's1')
      .execute()
    h.user = { ...h.user, id: 'u2', email: 'u2@example.com' }
    const response = await loader(args('s1'))
    expect(response.status).toBe(404)
    expect(h.loadPreviewExcerpt).not.toHaveBeenCalled()
  })
  test('enabled paid link metadata remains accessible to another user', async () => {
    await h.db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'w1')
      .execute()
    await h.db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', 'c1')
      .execute()
    await h.db
      .updateTable('shareables')
      .set({
        visibility: 'link',
        link_expires_at: '2099-01-01T00:00:00.000Z',
      })
      .where('id', '=', 's1')
      .execute()
    h.user = { ...h.user, id: 'u2', email: 'u2@example.com' }

    const response = await loader(args('s1'))
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.id).toBe('s1')
    expect(body.containerId).toBeNull()
    expect(body.containerName).toBeNull()
    expect(body.containerKind).toBeNull()
  })
  test('an archived project name is hidden while its file remains accessible', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-01-02T00:00:00Z' })
      .where('id', '=', 'c1')
      .execute()
    const body = await json(await loader(args('s1')))
    expect(body.containerId).toBeNull()
    expect(body.containerName).toBeNull()
    expect(body.containerKind).toBeNull()
  })
  test('cross workspace shared project is visible only at project visibility', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ kind: 'project' })
      .where('id', '=', 'c1')
      .execute()
    await h.db
      .insertInto('project_share_defaults')
      .values({
        id: 'g',
        project_container_id: 'c1',
        email: 'g1@other.example',
        role: 'viewer',
        display_name: null,
        created_by_id: 'u1',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      })
      .execute()
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'project' })
      .where('id', '=', 's1')
      .execute()
    h.user = {
      ...h.user,
      id: 'g1',
      workspaceId: 'w2',
      email: 'g1@other.example',
    }
    expect((await loader(args('s1'))).status).toBe(200)
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'workspace' })
      .where('id', '=', 's1')
      .execute()
    expect((await loader(args('s1'))).status).toBe(404)
  })
  test('cross workspace without a current grant 404', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ kind: 'project' })
      .where('id', '=', 'c1')
      .execute()
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'project' })
      .where('id', '=', 's1')
      .execute()
    // 関係者 grant を作らないまま別 workspace から読む (id を知っていても 404)
    h.user = {
      ...h.user,
      id: 'g1',
      workspaceId: 'w2',
      email: 'g1@other.example',
    }
    expect((await loader(args('s1'))).status).toBe(404)
  })
  test('cross workspace per-artifact grant 200 without project grant', async () => {
    await h.db
      .updateTable('shareables')
      .set({ visibility: 'private' })
      .where('id', '=', 's1')
      .execute()
    await h.db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's1',
        granted_email: 'g1@other.example',
        granted_at: '2026-01-01',
        granted_by: 'u1',
      })
      .execute()
    h.user = {
      ...h.user,
      id: 'g1',
      workspaceId: 'w2',
      email: 'g1@other.example',
    }
    const response = await loader(args('s1'))
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.containerId).toBeNull()
    expect(body.containerName).toBeNull()
    expect(body.containerKind).toBeNull()
  })
})

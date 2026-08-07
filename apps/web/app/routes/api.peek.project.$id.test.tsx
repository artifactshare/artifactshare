import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
const h = vi.hoisted(() => ({
  db: null as any,
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
import { loader } from './api.peek.project.$id'
async function setup() {
  const f = createMigratedInMemoryDb()
  h.db = f.db
  await h.db
    .insertInto('workspaces')
    .values({
      id: 'w1',
      name: 'W',
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01',
    })
    .execute()
  await h.db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'u1@example.com',
      name: 'U1',
      email_verified: 1,
      image: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      workspace_id: 'w1',
      locale: null,
    })
    .execute()
  await h.db
    .insertInto('artifact_containers')
    .values({
      id: 'p1',
      workspace_id: 'w1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Project',
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
      name: 'Visible',
      artifact_kind: 'markdown_page',
      visibility: 'workspace',
      container_id: 'p1',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    .execute()
}
const args = (id = 'p1') =>
  ({
    params: { id },
    context: new Map(),
    request: new Request('https://x'),
  }) as never
describe('peek project', () => {
  beforeEach(setup)
  test('member gets project and visible recent files', async () => {
    const r = await loader(args())
    expect(r.status).toBe(200)
    expect(((await r.json()) as { fileCount: number }).fileCount).toBe(1)
  })
  test('non-stakeholder private project 404', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', 'p1')
      .execute()
    h.user = { ...h.user, id: 'u2' }
    expect((await loader(args())).status).toBe(404)
  })
  test('archived project 404', async () => {
    await h.db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-07-01' })
      .where('id', '=', 'p1')
      .execute()
    expect((await loader(args())).status).toBe(404)
  })
  test('private files are excluded from count and recent files', async () => {
    await h.db
      .insertInto('shareables')
      .values({
        id: 's2',
        workspace_id: 'w1',
        owner_user_id: 'u1',
        name: 'Private',
        artifact_kind: 'markdown_page',
        visibility: 'private',
        container_id: 'p1',
        created_at: '2026-01-01',
        updated_at: '2026-07-02',
      })
      .execute()
    const body = (await (await loader(args())).json()) as {
      fileCount: number
      recentFiles: { id: string }[]
    }
    expect(body.fileCount).toBe(1)
    expect(body.recentFiles.map((x) => x.id)).toEqual(['s1'])
  })
})

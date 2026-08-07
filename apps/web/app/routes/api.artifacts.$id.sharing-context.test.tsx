import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
const h = vi.hoisted(() => ({
  db: null as any,
  user: {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    emailVerified: true,
    name: 'User',
    hd: null,
  },
}))
vi.mock('~/services/db.server', () => ({ createDb: () => h.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: () => {} }))
vi.mock('~/middleware/context', () => ({ requireUser: (c: any) => h.user }))
vi.mock('~/services/link-sharing.server', () => ({
  loadWorkspaceLinkPolicy: async () => null,
  canUseLinkSharing: () => false,
}))
import { loader } from './api.artifacts.$id.sharing-context'
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
      name: 'U',
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
      id: 'c1',
      workspace_id: 'w1',
      kind: 'inbox',
      owner_user_id: 'u1',
      created_by_id: 'u1',
      name: 'C',
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
      name: 'S',
      artifact_kind: 'markdown_page',
      visibility: 'workspace',
      container_id: 'c1',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    .execute()
}
const args = (id: string, user = h.user) =>
  ({
    params: { id },
    context: new Map(),
    request: new Request('https://x'),
  }) as never
describe('sharing context loader', () => {
  beforeEach(setup)
  test('owner gets 200 and grants', async () => {
    const r = await loader(args('s1'))
    expect(r.status).toBe(200)
    expect(((await r.json()) as { grants: unknown[] }).grants).toEqual([])
  })
  test('non-owner 404', async () => {
    h.user = { ...h.user, id: 'u2' }
    await expect(loader(args('s1'))).rejects.toMatchObject({ status: 404 })
  })
  test('missing id 404', async () => {
    await expect(loader(args('missing'))).rejects.toMatchObject({ status: 404 })
  })
})

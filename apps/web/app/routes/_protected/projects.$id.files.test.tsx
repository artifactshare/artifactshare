import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbHolder = vi.hoisted(() => ({ db: null as unknown }))
const userState = vi.hoisted(() => ({
  user: {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    name: 'User One',
    image: null,
    emailVerified: true,
    hd: null,
  },
}))

vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => userState.user,
  userContext: Symbol('userContext'),
}))
vi.mock('~/services/link-sharing.server', () => ({
  isLinkSharingAllowedByPolicy: async () => false,
  loadWorkspaceLinkPolicy: async () => null,
}))

import { loader } from './projects.$id.files'

type Db = Kysely<DB>

async function fixture() {
  const f = createMigratedInMemoryDb()
  const db = f.db as Db
  dbHolder.db = db
  for (const id of ['w1', 'w2']) {
    await db
      .insertInto('workspaces')
      .values({
        id,
        name: `Workspace ${id}`,
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  for (const [id, ws] of [
    ['u1', 'w1'],
    ['u2', 'w1'],
    ['u9', 'w2'],
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@example.com`,
        name: id,
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: ws,
        locale: null,
      })
      .execute()
  }
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'proj1',
      workspace_id: 'w1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Project',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  return { db }
}

async function insertShareable(
  db: Db,
  id: string,
  {
    owner = 'u1',
    visibility = 'workspace' as 'workspace' | 'private' | 'project',
    createdAt = '2026-07-01T00:00:00Z',
  } = {},
) {
  await db
    .insertInto('shareables')
    .values({
      id,
      workspace_id: 'w1',
      owner_user_id: owner,
      name: `Artifact ${id}`,
      artifact_kind: 'markdown_page',
      visibility,
      container_id: 'proj1',
      created_at: createdAt,
      updated_at: createdAt,
    })
    .execute()
}

function args(cursor?: { createdAt: string; id: string }) {
  const url = cursor
    ? `https://example.com/projects/proj1/files?cursor=${encodeURIComponent(
        JSON.stringify(cursor),
      )}`
    : 'https://example.com/projects/proj1/files'
  return {
    params: { id: 'proj1' },
    context: new Map(),
    request: new Request(url),
  } as never
}

beforeEach(() => {
  userState.user = {
    id: 'u1',
    workspaceId: 'w1',
    email: 'u1@example.com',
    name: 'User One',
    image: null,
    emailVerified: true,
    hd: null,
  }
})

describe('project files subpage loader', () => {
  test('keyset paging returns every row exactly once across a same-created-at boundary', async () => {
    const { db } = await fixture()
    // 60 件全部を同じ created_at にして、50 件境界がタイムスタンプ内で割れる状態を作る
    for (let i = 0; i < 60; i++) {
      const id = `s${String(i).padStart(2, '0')}`
      await insertShareable(db, id, { createdAt: '2026-07-10T00:00:00Z' })
    }
    const page1 = await loader(args())
    expect(page1.files).toHaveLength(50)
    expect(page1.total).toBe(60)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await loader(args(page1.nextCursor!))
    const ids = [...page1.files, ...page2.files].map((f) => f.id)
    expect(new Set(ids).size).toBe(60)
    expect(page2.nextCursor).toBeNull()
  })

  test('rows come in created-date descending order', async () => {
    const { db } = await fixture()
    await insertShareable(db, 'old', { createdAt: '2026-07-01T00:00:00Z' })
    await insertShareable(db, 'new', { createdAt: '2026-07-20T00:00:00Z' })
    const data = await loader(args())
    expect(data.files.map((f) => f.id)).toEqual(['new', 'old'])
  })

  test('unrelated user from another workspace gets 404', async () => {
    await fixture()
    userState.user = {
      ...userState.user,
      id: 'u9',
      workspaceId: 'w2',
      email: 'u9@example.com',
    }
    await expect(loader(args())).rejects.toMatchObject({ status: 404 })
  })

  test('shared external viewer sees only project-visibility rows', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's-project', { visibility: 'project' })
    await insertShareable(db, 's-internal', { visibility: 'workspace' })
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'd1',
        project_container_id: 'proj1',
        email: 'u9@example.com',
        role: 'viewer',
        display_name: null,
        created_by_id: 'u1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    userState.user = {
      ...userState.user,
      id: 'u9',
      workspaceId: 'w2',
      email: 'u9@example.com',
    }
    const data = await loader(args())
    expect(data.files.map((f) => f.id)).toEqual(['s-project'])
    expect(data.total).toBe(1)
    expect(data.ctx.canUpload).toBe(false)
  })

  test("member hides other users' private rows", async () => {
    const { db } = await fixture()
    await insertShareable(db, 's-mine')
    await insertShareable(db, 's-priv', { owner: 'u2', visibility: 'private' })
    const data = await loader(args())
    expect(data.files.map((f) => f.id)).toEqual(['s-mine'])
  })
})

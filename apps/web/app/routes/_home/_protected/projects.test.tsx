import { describe, expect, test, vi } from 'vitest'
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
    hd: 'example.com',
  },
}))

vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/lib/flagship-fallback.server', () => ({}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => userState.user,
  userContext: Symbol('userContext'),
}))
const uploadAccess = vi.hoisted(() => ({ kind: 'allowed' as string }))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: async () => ({ kind: uploadAccess.kind }),
}))

import { action, loader } from './projects'

type Db = Kysely<DB>

async function fixture() {
  const f = createMigratedInMemoryDb()
  const db = f.db as Db
  dbHolder.db = db
  await db
    .insertInto('workspaces')
    .values({
      id: 'w1',
      name: 'Workspace',
      hd: 'example.com',
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'u1@example.com',
      name: 'u1',
      email_verified: 1,
      image: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      workspace_id: 'w1',
      locale: null,
    })
    .execute()
  async function project(id: string, visibility: 'workspace' | 'private') {
    await db
      .insertInto('artifact_containers')
      .values({
        id,
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: null,
        created_by_id: null,
        name: `Project ${id}`,
        base_visibility: visibility,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  return { db, project }
}

function loaderArgs() {
  return {
    context: new Map(),
    request: new Request('https://example.com/projects'),
  } as never
}

function actionArgs(intent: string, projectId: string) {
  return {
    context: new Map(),
    request: new Request('https://example.com/projects', {
      method: 'POST',
      body: new URLSearchParams({ intent, projectId }),
    }),
  } as never
}

describe('projects index loader', () => {
  test('returns workspace projects and membership rows', async () => {
    const { project } = await fixture()
    await project('p1', 'workspace')
    const data = await loader(loaderArgs())
    expect(data.rows.map((r) => r.id)).toEqual(['p1'])
  })

  test('hides private projects from membership rows', async () => {
    const { project } = await fixture()
    await project('p-open', 'workspace')
    await project('p-priv', 'private')
    const data = await loader(loaderArgs())
    expect(data.rows.map((r) => r.id)).toEqual(['p-open'])
  })
})

describe('projects index join action', () => {
  test('member joins an open project', async () => {
    const { db, project } = await fixture()
    await project('p1', 'workspace')
    const result = await action(actionArgs('join-project', 'p1'))
    expect(result).toEqual({ intent: 'join-project', result: 'joined' })
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(1)
  })

  test('read-only user without upload access can still join', async () => {
    uploadAccess.kind = 'denied'
    const { db, project } = await fixture()
    await project('p1', 'workspace')
    const result = await action(actionArgs('join-project', 'p1'))
    uploadAccess.kind = 'allowed'
    expect(result).toEqual({ intent: 'join-project', result: 'joined' })
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(1)
  })

  test('non-stakeholder join of a private project is 404', async () => {
    const { project } = await fixture()
    await project('p-priv', 'private')
    await expect(
      action(actionArgs('join-project', 'p-priv')),
    ).rejects.toMatchObject({ status: 404 })
  })
})

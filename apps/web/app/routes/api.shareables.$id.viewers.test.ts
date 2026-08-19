import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: {},
}))

const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const fixtureRef = vi.hoisted(() => ({
  db: null as unknown,
}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => fixtureRef.db,
  d1DatabaseFor: () => undefined,
}))

import type { Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { action, loader, middleware } from './api.shareables.$id.viewers'

const T0 = '2026-08-01T00:00:00.000Z'

const memberUser = sessionUser('u-member', 'member@example.com', 'ws1')
const outsiderUser = sessionUser(
  'u-outsider',
  'outsider@outside.example',
  'ws2',
)

describe('/api/shareables/:id/viewers', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb>
  let db: Kysely<DB>

  beforeEach(async () => {
    vi.clearAllMocks()
    fixture = createMigratedInMemoryDb()
    db = fixture.db
    fixtureRef.db = db
    requireUserMock.mockReturnValue(memberUser)
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
    fixtureRef.db = null
  })

  test('uses the user API auth middleware (anonymous requests 401 before the loader)', () => {
    expect(middleware).toEqual([requireUserApiMiddlewareMock])
  })

  test('GET returns viewers with Cache-Control: private, no-store', async () => {
    const response = await loaderResponse(
      'https://artifactshare.test/api/shareables/s1/viewers',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = (await response.json()) as {
      viewers: Array<{ userId: string; isSelf: boolean }>
      nextCursor: string | null
      totalViewers: number
    }
    expect(body.viewers.map((viewer) => viewer.userId)).toEqual([
      'u-member',
      'u-owner',
    ])
    expect(body.viewers[0]?.isSelf).toBe(true)
    expect(body.nextCursor).toBeNull()
    expect(body.totalViewers).toBe(2)
  })

  test('404 for a shareable the user cannot see, with Cache-Control', async () => {
    const response = await loaderResponse(
      'https://artifactshare.test/api/shareables/missing/viewers',
      { id: 'missing' },
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('not-found')
  })

  test('200 for a verified other-workspace user with a grant, with Cache-Control', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's1',
        granted_email: outsiderUser.email,
        granted_at: T0,
        granted_by: 'u-owner',
      })
      .execute()
    requireUserMock.mockReturnValue(outsiderUser)
    const response = await loaderResponse(
      'https://artifactshare.test/api/shareables/s1/viewers',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = (await response.json()) as { viewers: unknown[] }
    expect(body.viewers).toHaveLength(2)
  })

  test('400 for an invalid cursor and an invalid limit, with Cache-Control', async () => {
    const badCursor = await loaderResponse(
      'https://artifactshare.test/api/shareables/s1/viewers?cursor=%21%21garbage',
    )
    expect(badCursor.status).toBe(400)
    expect(badCursor.headers.get('Cache-Control')).toBe('private, no-store')
    const cursorBody = (await badCursor.json()) as { error: { code: string } }
    expect(cursorBody.error.code).toBe('invalid-cursor')

    const badLimit = await loaderResponse(
      'https://artifactshare.test/api/shareables/s1/viewers?limit=101',
    )
    expect(badLimit.status).toBe(400)
    expect(badLimit.headers.get('Cache-Control')).toBe('private, no-store')
    const limitBody = (await badLimit.json()) as { error: { code: string } }
    expect(limitBody.error.code).toBe('invalid-limit')
  })

  test('authenticated POST/PATCH/DELETE return 405 and leave recency and view_count unchanged', async () => {
    const before = await snapshot(db)
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await action()
      expect(response.status, method).toBe(405)
    }
    expect(await snapshot(db)).toEqual(before)
  })

  test('GET does not mutate recency or view_count', async () => {
    const before = await snapshot(db)
    const response = await loaderResponse(
      'https://artifactshare.test/api/shareables/s1/viewers',
    )
    expect(response.status).toBe(200)
    expect(await snapshot(db)).toEqual(before)
  })

  async function loaderResponse(
    url: string,
    params: { id: string } = { id: 's1' },
  ) {
    return (await loader({
      request: new Request(url),
      context: new Map(),
      params,
    } as never)) as Response
  }
})

async function snapshot(db: Kysely<DB>) {
  return {
    recency: await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .orderBy('viewer_user_id')
      .execute(),
    viewCounts: await db
      .selectFrom('shareables')
      .select(['id', 'view_count'])
      .orderBy('id')
      .execute(),
  }
}

function sessionUser(
  id: string,
  email: string,
  workspaceId: string,
): SessionUser {
  return {
    id,
    email,
    emailVerified: true,
    name: `User ${id}`,
    image: null,
    workspaceId,
    hd: 'example.com',
    msTenantId: null,
    locale: null,
    kind: 'human',
  }
}

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      { id: 'ws1', hd: 'example.com', name: 'Example', created_at: T0 },
      { id: 'ws2', hd: 'outside.example', name: 'Outside', created_at: T0 },
    ])
    .execute()
  await db
    .insertInto('users')
    .values(
      [
        ['u-owner', 'owner@example.com', 'ws1'],
        ['u-member', 'member@example.com', 'ws1'],
        ['u-outsider', 'outsider@outside.example', 'ws2'],
      ].map(([id, email, workspaceId]) => ({
        id,
        email,
        email_verified: 1,
        name: `User ${id}`,
        image: null,
        created_at: T0,
        updated_at: T0,
        workspace_id: workspaceId,
        locale: null,
      })),
    )
    .execute()
  await db
    .insertInto('workspace_members')
    .values(
      [
        ['ws1', 'u-owner'],
        ['ws1', 'u-member'],
        ['ws2', 'u-outsider'],
      ].map(([workspaceId, userId]) => ({
        workspace_id: workspaceId,
        user_id: userId,
        role: 'member' as const,
        status: 'active' as const,
        created_at: T0,
        updated_at: T0,
      })),
    )
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws1',
      kind: 'inbox',
      owner_user_id: 'u-owner',
      created_by_id: 'u-owner',
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 's1',
      workspace_id: 'ws1',
      owner_user_id: 'u-owner',
      slug: null,
      name: 's1.html',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'workspace',
      current_version_id: 'v1',
      container_id: 'owner-inbox',
      created_at: T0,
      updated_at: T0,
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v1',
      shareable_id: 's1',
      artifact_kind: 'html_page',
      status: 'published',
      entrypoint_path: '/s1.html',
      r2_key: 'ws1/s1/v1/s1.html',
      size_bytes: 100,
      sha256: 'sha',
      created_by_id: 'u-owner',
      created_at: T0,
      published_at: T0,
    })
    .execute()
  await db
    .insertInto('shareable_viewer_recency')
    .values(
      [
        ['u-member', '2026-08-01T04:00:00.000Z'],
        ['u-owner', '2026-08-01T03:00:00.000Z'],
      ].map(([viewerUserId, lastViewedAt]) => ({
        shareable_id: 's1',
        viewer_user_id: viewerUserId,
        first_viewed_at: lastViewedAt,
        last_viewed_at: lastViewedAt,
        version_seen_through_at: null,
        comment_seen_through_at: null,
        viewed_title: null,
        viewed_owner_name: null,
      })),
    )
    .execute()
}

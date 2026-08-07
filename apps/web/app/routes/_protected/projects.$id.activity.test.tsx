import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
const fetcherState = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'loading',
  data: undefined as unknown,
}))

vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useFetcher: () => ({ ...fetcherState, load: vi.fn() }),
  }
})
vi.mock('../_home/+components/topbar', () => ({ Topbar: () => null }))
vi.mock('../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => <div data-bottom-tab-bar />,
}))
vi.mock('../_home/+components/feed-list', () => ({
  FeedList: () => <div data-feed-list="true" />,
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => userState.user,
  userContext: Symbol('userContext'),
}))
vi.mock('~/services/link-sharing.server', () => ({
  isLinkSharingAllowedByPolicy: async () => false,
  loadWorkspaceLinkPolicy: async () => null,
}))

import ProjectActivity, { loader } from './projects.$id.activity'

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
      hd: null,
      ms_tenant_id: null,
      email_domain: null,
      created_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  for (const id of ['u1', 'u2']) {
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
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
  }
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: 'w1',
      user_id: 'u1',
      role: 'owner',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })
    .execute()
  for (const id of ['proj1', 'proj2']) {
    await db
      .insertInto('artifact_containers')
      .values({
        id,
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u1',
        name: `Project ${id}`,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  for (const [id, container] of [
    ['s1', 'proj1'],
    ['s2', 'proj2'],
  ] as const) {
    await db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: 'w1',
        owner_user_id: 'u2',
        name: `Artifact ${id}`,
        artifact_kind: 'markdown_page',
        visibility: 'workspace',
        container_id: container,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
  }
  return { db }
}

async function insertView(db: Db, id: string, shareableId: string, at: string) {
  await db
    .insertInto('events')
    .values({
      id,
      workspace_id: 'w1',
      type: 'artifact_viewed',
      shareable_id: shareableId,
      actor_user_id: 'u2',
      subject_id: null,
      created_at: at,
    })
    .execute()
}

function args(projectId = 'proj1', cursor?: unknown) {
  const url = cursor
    ? `https://example.com/projects/${projectId}/activity?cursor=${encodeURIComponent(
        JSON.stringify(cursor),
      )}`
    : `https://example.com/projects/${projectId}/activity`
  return {
    params: { id: projectId },
    context: new Map(),
    request: new Request(url),
  } as never
}

beforeEach(() => {
  fetcherState.state = 'idle'
  fetcherState.data = undefined
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

function componentData(overrides: Record<string, unknown> = {}) {
  return {
    ctx: {
      projectId: 'proj1',
      projectName: 'Project proj1',
      workspaceName: 'Workspace',
      user: userState.user,
      joinedNav: [],
    },
    rows: [],
    nextCursor: null,
    hasMore: false,
    timeZone: 'UTC',
    now: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

describe('project activity subpage states', () => {
  test('activity subpage keeps the mobile primary navigation', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectActivity, {
        loaderData: componentData({ rows: [] }),
      } as never),
    )
    expect(html).toContain('data-bottom-tab-bar')
  })
  test('error remains distinct from the empty state and keeps its retry link', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectActivity, {
        loaderData: componentData({ error: true }),
      } as never),
    )
    expect(html).toContain('home.feedError')
    expect(html).toContain('home.reload')
    expect(html).toContain('href="/projects/proj1/activity"')
    expect(html).not.toContain('project.noActivity')
  })

  test('loading keeps aria-busy and disables the pagination control', () => {
    fetcherState.state = 'loading'
    const html = renderToStaticMarkup(
      createElement(ProjectActivity, {
        loaderData: componentData({
          rows: [
            {
              id: 'event-1',
              type: 'artifact_viewed',
              shareableId: 'shareable-1',
              createdAt: '2026-07-02T00:00:00Z',
              dayKey: '2026-07-02',
            },
          ],
          hasMore: true,
          nextCursor: { createdAt: '2026-07-01T00:00:00Z', id: 'event-1' },
        }),
      } as never),
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('home.loadingActivity')
    expect(html).not.toContain('project.noActivity')
  })
})

describe('project activity subpage loader', () => {
  test('returns only this project events, newest first', async () => {
    const { db } = await fixture()
    await insertView(db, 'e1', 's1', '2026-07-01T10:00:00Z')
    await insertView(db, 'e2', 's2', '2026-07-02T10:00:00Z')
    const data = await loader(args())
    expect(data.rows.map((r) => r.shareableId)).toEqual(['s1'])
    expect(data.ctx.projectName).toBe('Project proj1')
  })

  test('keyset cursor loads the older page without duplicates', async () => {
    const { db } = await fixture()
    // 集約されないようコメントイベントでなく日をずらした閲覧を 25 日分積む
    for (let i = 0; i < 25; i++) {
      await insertView(
        db,
        `e${i}`,
        's1',
        `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
      )
    }
    const page1 = await loader(args())
    expect(page1.rows).toHaveLength(20)
    expect(page1.hasMore).toBe(true)
    const page2 = await loader(args('proj1', page1.nextCursor))
    const ids = [...page1.rows, ...page2.rows].map((r) => r.id)
    expect(new Set(ids).size).toBe(25)
  })

  test('unrelated user from another workspace gets 404', async () => {
    const { db } = await fixture()
    await db
      .insertInto('workspaces')
      .values({
        id: 'w2',
        name: 'Other',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    userState.user = {
      ...userState.user,
      id: 'u9',
      workspaceId: 'w2',
      email: 'u9@example.com',
    }
    await expect(loader(args())).rejects.toMatchObject({ status: 404 })
  })
})

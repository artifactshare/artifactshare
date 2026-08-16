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

vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/lib/flagship-fallback.server', () => ({}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => userState.user,
  userContext: Symbol('userContext'),
}))
vi.mock('~/services/link-sharing.server', () => ({
  isLinkSharingAllowedByPolicy: async () => false,
  loadWorkspaceLinkPolicy: async () => null,
}))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useFetcher: () => ({ submit: () => {} }),
    useLocation: () => ({ state: null }),
    useViewTransitionState: () => false,
  }
})
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'ja',
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
    tPlural: (stem: string, n: number) => `${stem}:${n}`,
  }),
}))
vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

import { action, loader } from './projects.$id'
import { versionBadgeLabel } from '~/lib/version-badge'
import { ProjectRedesignBody } from './+components/project-redesign-body'
import { MemberDetailActions } from './projects.$id'

type Db = Kysely<DB>

const NOW = '2026-07-29T00:00:00Z'

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
    containerId = 'proj1',
    owner = 'u1',
    visibility = 'workspace',
    createdAt = '2026-07-01T00:00:00Z',
  }: {
    containerId?: string
    owner?: string
    visibility?: 'workspace' | 'private'
    createdAt?: string
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
      container_id: containerId,
      created_at: createdAt,
      updated_at: createdAt,
    })
    .execute()
}

function loaderArgs(projectId = 'proj1') {
  return {
    params: { id: projectId },
    context: new Map(),
    request: new Request(`https://example.com/projects/${projectId}`),
  } as never
}

function actionArgs(intent: string, shareableId: string, projectId = 'proj1') {
  return {
    params: { id: projectId },
    context: new Map(),
    request: new Request(`https://example.com/projects/${projectId}`, {
      method: 'POST',
      body: new URLSearchParams({ intent, shareableId }),
    }),
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

describe('project detail loader', () => {
  test('returns pins, feed, ranking, and now', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    const data = await loader(loaderArgs())
    expect(data.projectActivity.pins).toEqual([])
    expect(Array.isArray(data.projectActivity.feed)).toBe(true)
    expect(data.projectActivity.ranking).toEqual([])
    expect(typeof data.projectActivity.now).toBe('string')
  })

  test('loader data never contains the Slack webhook secret', async () => {
    const { db } = await fixture()
    await db
      .insertInto('container_slack_channels')
      .values({
        container_id: 'proj1',
        webhook_url: 'https://hooks.slack.test/secret-loader',
        channel_id: 'C1',
        channel_name: 'general',
        slack_team_id: 'T1',
        slack_team_name: 'Team',
        configuration_url: null,
        created_by: 'u1',
        updated_by: 'u1',
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      })
      .execute()
    const data = await loader(loaderArgs())
    expect(data.access).toBe('member')
    if (data.access !== 'member') throw new Error('expected member data')
    expect(data.slackChannel?.channelName).toBe('general')
    // webhook URL は投稿 credential。閲覧者へ serialize される loader data に
    // 実値が混ざらないことを、キー名でなく値そのもので固定する。
    expect(JSON.stringify(data)).not.toContain('hooks.slack.test')
  })

  test("pins hide other users' private shareables from the viewer", async () => {
    const { db } = await fixture()
    await insertShareable(db, 's-vis')
    await insertShareable(db, 's-priv', { owner: 'u2', visibility: 'private' })
    for (const id of ['s-vis', 's-priv']) {
      await db
        .insertInto('project_pins')
        .values({
          container_id: 'proj1',
          shareable_id: id,
          pinned_by_user_id: 'u2',
          created_at: '2026-07-01T00:00:00Z',
        })
        .execute()
    }
    const data = await loader(loaderArgs())
    expect(data.projectActivity.pins.map((p) => p.shareableId)).toEqual([
      's-vis',
    ])
  })
})

describe('shared project pins visibility', () => {
  test('external shared viewer does not see workspace-only pinned titles', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's-project')
    await db
      .updateTable('shareables')
      .set({ visibility: 'project' })
      .where('id', '=', 's-project')
      .execute()
    await insertShareable(db, 's-internal', { visibility: 'workspace' })
    for (const id of ['s-project', 's-internal']) {
      await db
        .insertInto('project_pins')
        .values({
          container_id: 'proj1',
          shareable_id: id,
          pinned_by_user_id: 'u1',
          created_at: '2026-07-01T00:00:00Z',
        })
        .execute()
    }
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
    await db
      .insertInto('users')
      .values({
        id: 'u9',
        email: 'guest@partner.example.com',
        name: 'guest',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w2',
        locale: null,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'd9',
        project_container_id: 'proj1',
        email: 'guest@partner.example.com',
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
      email: 'guest@partner.example.com',
    }
    const data = await loader(loaderArgs())
    expect(data.projectActivity.pins.map((p) => p.shareableId)).toEqual([
      's-project',
    ])
  })
})

describe('pin action', () => {
  test('member can pin a project file', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    await expect(action(actionArgs('pin', 's1'))).resolves.toEqual({
      intent: 'pin',
      ok: true,
    })
    const rows = await db.selectFrom('project_pins').selectAll().execute()
    expect(rows.map((r) => r.shareable_id)).toEqual(['s1'])
  })

  test('unpin removes the pin', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    await action(actionArgs('pin', 's1'))
    await action(actionArgs('unpin', 's1'))
    expect(await db.selectFrom('project_pins').selectAll().execute()).toEqual(
      [],
    )
  })

  // アーカイブ済みプロジェクトは findWorkspaceProject が返さないため、
  // 詳細と同様に 404 になる (現行挙動の踏襲。403 でなく 404)。
  test('archived project rejects pin with 404', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-07-01T00:00:00Z' })
      .where('id', '=', 'proj1')
      .execute()
    await expect(action(actionArgs('pin', 's1'))).rejects.toMatchObject({
      status: 404,
    })
  })

  test('shareable outside the project rejects with 404', async () => {
    const { db } = await fixture()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'proj2',
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'u1',
        name: 'Other',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await insertShareable(db, 's-out', { containerId: 'proj2' })
    await expect(action(actionArgs('pin', 's-out'))).rejects.toMatchObject({
      status: 404,
    })
  })

  test("member cannot pin another user's private file (404)", async () => {
    const { db } = await fixture()
    await insertShareable(db, 's-priv', { owner: 'u2', visibility: 'private' })
    await expect(action(actionArgs('pin', 's-priv'))).rejects.toMatchObject({
      status: 404,
    })
    expect(await db.selectFrom('project_pins').selectAll().execute()).toEqual(
      [],
    )
  })

  test('pin limit returns 400 and keeps the count at 20', async () => {
    const { db } = await fixture()
    for (let i = 0; i < 21; i++) {
      await insertShareable(db, `s${i}`)
    }
    for (let i = 0; i < 20; i++) {
      await db
        .insertInto('project_pins')
        .values({
          container_id: 'proj1',
          shareable_id: `s${i}`,
          pinned_by_user_id: 'u1',
          created_at: '2026-07-01T00:00:00Z',
        })
        .execute()
    }
    await expect(action(actionArgs('pin', 's20'))).rejects.toMatchObject({
      status: 400,
    })
    const rows = await db.selectFrom('project_pins').selectAll().execute()
    expect(rows).toHaveLength(20)
  })

  test('external shared viewer (non-contributor) rejects with 403', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1', { visibility: 'workspace' })
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
    await db
      .insertInto('users')
      .values({
        id: 'u9',
        email: 'guest@partner.example.com',
        name: 'guest',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w2',
        locale: null,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'd1',
        project_container_id: 'proj1',
        email: 'guest@partner.example.com',
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
      email: 'guest@partner.example.com',
    }
    await expect(action(actionArgs('pin', 's1'))).rejects.toMatchObject({
      status: 403,
    })
  })
})

describe('seen / membership intents', () => {
  test('seen action updates last_seen_at while the loader does not', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    await db
      .insertInto('project_members')
      .values({
        container_id: 'proj1',
        user_id: 'u1',
        joined_at: '2026-01-01T00:00:00Z',
        last_seen_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await loader(loaderArgs())
    const afterLoader = await db
      .selectFrom('project_members')
      .select('last_seen_at')
      .executeTakeFirst()
    expect(afterLoader?.last_seen_at).toBe('2026-01-01T00:00:00Z')
    await action(actionArgs('seen', ''))
    const afterSeen = await db
      .selectFrom('project_members')
      .select('last_seen_at')
      .executeTakeFirst()
    expect(afterSeen?.last_seen_at).not.toBe('2026-01-01T00:00:00Z')
  })

  test('join and leave intents map membership results', async () => {
    const { db } = await fixture()
    await insertShareable(db, 's1')
    await expect(action(actionArgs('join-project', ''))).resolves.toEqual({
      intent: 'join-project',
      result: 'joined',
    })
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(1)
    await expect(action(actionArgs('leave-project', ''))).resolves.toEqual({
      intent: 'leave-project',
      result: 'left',
    })
    expect(
      await db.selectFrom('project_members').selectAll().execute(),
    ).toHaveLength(0)
  })
})

describe('versionBadgeLabel (「vN に更新」の境界)', () => {
  const label = (v: number) => `v${v} に更新`
  const base = {
    id: 's1',
    createdTime: '2026-07-01T00:00:00Z',
  }

  test('single version shows no badge', () => {
    expect(
      versionBadgeLabel(
        { ...base, versionCount: 1, latestPublishedAt: NOW } as never,
        NOW,
        label,
      ),
    ).toBeNull()
  })

  test('two versions published 8 days ago shows no badge', () => {
    expect(
      versionBadgeLabel(
        {
          ...base,
          versionCount: 2,
          latestPublishedAt: '2026-07-21T00:00:00Z',
        } as never,
        NOW,
        label,
      ),
    ).toBeNull()
  })

  test('two versions published within 7 days shows the badge', () => {
    expect(
      versionBadgeLabel(
        {
          ...base,
          versionCount: 3,
          latestPublishedAt: '2026-07-23T00:00:00Z',
        } as never,
        NOW,
        label,
      ),
    ).toBe('v3 に更新')
  })
})

describe('ProjectRedesignBody rendering', () => {
  const fileRow = (id: string, createdTime: string) =>
    ({
      id,
      fileName: `${id}.md`,
      derivedTitle: `Artifact ${id}`,
      titleOverride: null,
      renderType: 'markdown_page',
      ownerId: 'u1',
      ownerName: 'User One',
      ownerEmail: 'u1@example.com',
      ownerImage: null,
      ownerInitial: 'U',
      ownerIsExternal: false,
      modifiedTime: createdTime,
      createdTime,
      versionCount: 1,
      latestPublishedAt: null,
      registeredByMe: true,
      visibility: 'workspace',
      viewCount: 3,
      commentCount: 0,
      projectId: null,
      projectName: null,
    }) as never

  const baseProps = {
    projectId: 'proj1',
    pins: [],
    feed: [],
    ranking: [],
    now: NOW,
    canPin: true,
    canUpload: true,
    archived: false,
    onUpload: () => {},
    homeOwnerName: 'Owner',
  }

  test('zero files render a full-page empty state without pinned section', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectRedesignBody, { ...baseProps, files: [] }),
    )
    expect(html).toContain('project.noFilesTitle')
    expect(html).not.toContain('project.pinned')
    expect(html).not.toContain('project.recentFiles')
  })

  test('files render in created-date descending order with day groups', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectRedesignBody, {
        ...baseProps,
        files: [
          fileRow('older', '2026-07-01T00:00:00Z'),
          fileRow('newer', '2026-07-28T00:00:00Z'),
        ],
      }),
    )
    expect(html.indexOf('Artifact newer')).toBeGreaterThan(-1)
    expect(html.indexOf('Artifact newer')).toBeLessThan(
      html.indexOf('Artifact older'),
    )
    expect(html).not.toContain('project.pinned')
  })

  test('archived empty project hides the upload CTA', () => {
    const html = renderToStaticMarkup(
      createElement(ProjectRedesignBody, {
        ...baseProps,
        files: [],
        archived: true,
      }),
    )
    expect(html).toContain('project.archivedNoFilesBody')
    expect(html).not.toContain('upload.cta.primary')
  })
})

describe('project action menu', () => {
  const props = (overrides: Record<string, unknown> = {}) => ({
    loaderData: {
      project: { id: 'proj1', archivedAt: null },
      projectActivity: { joined: true, participants: { count: 0, top: [] } },
      canEditProject: false,
      ...overrides,
    },
    leaveFetcher: { submit: vi.fn() },
    setOpenDialog: vi.fn(),
    shareDefaultsActionLabel: 'projectShareDefaults.actionEmpty',
    showShareDefaultsAction: false,
  })

  test('viewer sees Slack notification menu item without edit permission', () => {
    const html = renderToStaticMarkup(
      createElement(MemberDetailActions, props() as never),
    )
    expect(html).toContain('project.slack.title')
  })

  test('viewer without edit permission does not see edit, archive, or delete', () => {
    const html = renderToStaticMarkup(
      createElement(MemberDetailActions, props() as never),
    )
    expect(html).not.toContain('project.edit')
    expect(html).not.toContain('project.archive')
    expect(html).not.toContain('project.delete')
  })

  test('editor who has not joined still sees edit, archive, and delete', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemberDetailActions,
        props({
          projectActivity: {
            joined: false,
            participants: { count: 0, top: [] },
          },
          canEditProject: true,
        }) as never,
      ),
    )
    expect(html).toContain('project.edit')
    expect(html).toContain('project.archive')
    expect(html).toContain('project.delete')
  })

  test('joined viewer without edit permission sees the leave action', () => {
    const html = renderToStaticMarkup(
      createElement(MemberDetailActions, props() as never),
    )
    expect(html).toContain('project.leave')
  })

  test('archived project does not show Slack notification menu item', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemberDetailActions,
        props({ project: { id: 'proj1', archivedAt: NOW } }) as never,
      ),
    )
    expect(html).not.toContain('project.slack.title')
  })
})

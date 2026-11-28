import { expect, test } from 'vitest'
import { viewerAccessAllowed } from '~/services/access.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  canOpenSql,
  viewerAccessFactsFromRow,
  viewerAccessFactsQuery,
  type ViewerAccessFactsRow,
} from './facts'

const NOW = '2026-09-15T00:00:00.000Z'

const VISIBILITIES = ['private', 'workspace', 'project', 'link'] as const

const LINKS = {
  open: { expires: null, suspended: false, sharing: 1 },
  live: { expires: '2026-09-15T00:00:00.001Z', suspended: false, sharing: 1 },
  expired: { expires: NOW, suspended: false, sharing: 1 },
  unreadable: {
    expires: 'x026-09-15T00:00:00.123Z',
    suspended: false,
    sharing: 1,
  },
  suspended: { expires: null, suspended: true, sharing: 1 },
  sharingOff: { expires: null, suspended: false, sharing: 0 },
} as const
type LinkKey = keyof typeof LINKS

const MEMBERSHIPS = [
  { membership: 'none', plan: 'team' },
  { membership: 'member', plan: 'team' },
  { membership: 'removed', plan: 'team' },
  { membership: 'admin', plan: 'team' },
  { membership: 'admin', plan: 'plus' },
  { membership: 'owner', plan: 'team' },
  { membership: 'owner', plan: 'plus' },
] as const

type ViewerClass = {
  home: 'artifact' | 'other'
  verified: boolean
  kind: 'human' | 'bot' | 'stopped'
  membership: (typeof MEMBERSHIPS)[number]['membership']
  plan: 'team' | 'plus'
}

const VIEWERS: ViewerClass[] = [
  ...(['artifact', 'other'] as const).flatMap((home) =>
    [true, false].flatMap((verified) =>
      MEMBERSHIPS.map((m) => ({
        home,
        verified,
        kind: 'human' as const,
        ...m,
      })),
    ),
  ),
  ...(['bot', 'stopped'] as const).flatMap((kind) =>
    (['member', 'removed'] as const).map((membership) => ({
      home: 'artifact' as const,
      verified: true,
      kind,
      membership,
      plan: 'team' as const,
    })),
  ),
]

type ContainerClass = {
  kind: 'inbox' | 'project'
  workspace: 'artifact' | 'home'
  base: 'workspace' | 'private'
  extra: 'none' | 'archived' | 'joined'
  creator: boolean
  audience: boolean
}

const CONTAINERS: ContainerClass[] = [
  {
    kind: 'inbox',
    workspace: 'artifact',
    base: 'workspace',
    extra: 'none',
    creator: true,
    audience: false,
  },
  ...(['workspace', 'private'] as const).flatMap((base) =>
    (['none', 'archived', 'joined'] as const).flatMap((extra) =>
      [true, false].flatMap((creator) =>
        [true, false].map((audience) => ({
          kind: 'project' as const,
          workspace: 'artifact' as const,
          base,
          extra,
          creator,
          audience,
        })),
      ),
    ),
  ),
  {
    kind: 'project',
    workspace: 'home',
    base: 'workspace',
    extra: 'none',
    creator: false,
    audience: false,
  },
  ...[true, false].flatMap((creator) =>
    [true, false].map((audience) => ({
      kind: 'project' as const,
      workspace: 'home' as const,
      base: 'private' as const,
      extra: 'none' as const,
      creator,
      audience,
    })),
  ),
]

function label(parts: object) {
  return Object.entries(parts)
    .map(([key, value]) =>
      typeof value === 'boolean'
        ? `${value ? '' : 'no-'}${key}`
        : `${key}=${String(value)}`,
    )
    .join(' ')
}

function describeCase(shareableId: string) {
  const [viewer, container, visibility, link, flags] = shareableId.split('/')
  return [
    label(VIEWERS[Number(viewer.slice(1, viewer.indexOf('.')))]),
    label(CONTAINERS[Number(container)]),
    label({
      visibility,
      link,
      owner: flags[0] === '1',
      grant: flags[1] === '1',
    }),
  ].join(' | ')
}

const COLUMNS = {
  workspaces: ['id', 'name', 'plan', 'link_sharing_enabled', 'created_at'],
  users: [
    'id',
    'name',
    'email',
    'email_verified',
    'workspace_id',
    'kind',
    'bot_stopped_at',
    'created_at',
    'updated_at',
  ],
  workspace_members: [
    'workspace_id',
    'user_id',
    'role',
    'status',
    'created_at',
    'updated_at',
  ],
  artifact_containers: [
    'id',
    'name',
    'workspace_id',
    'kind',
    'owner_user_id',
    'created_by_id',
    'base_visibility',
    'archived_at',
    'created_at',
    'updated_at',
  ],
  project_share_defaults: [
    'id',
    'project_container_id',
    'email',
    'created_at',
    'updated_at',
  ],
  project_members: ['container_id', 'user_id', 'joined_at', 'last_seen_at'],
  shareables: [
    'id',
    'workspace_id',
    'owner_user_id',
    'visibility',
    'container_id',
    'link_expires_at',
    'link_suspended_at',
    'name',
    'artifact_kind',
    'activity_at',
    'created_at',
    'updated_at',
  ],
  shareable_grants: [
    'shareable_id',
    'granted_email',
    'granted_by',
    'granted_at',
  ],
} as const
type Table = keyof typeof COLUMNS

function seed(sqlite: ReturnType<typeof createMigratedInMemoryDb>['sqlite']) {
  const rows = Object.fromEntries(
    Object.keys(COLUMNS).map((table) => [table, []]),
  ) as unknown as Record<Table, Array<Array<string | number | null>>>
  const workspace = (id: string, plan: string, sharing: number) =>
    rows.workspaces.push([id, id, plan, sharing, NOW])
  const membership = (
    workspaceId: string,
    userId: string,
    state: ViewerClass['membership'],
  ) => {
    if (state !== 'none')
      rows.workspace_members.push([
        workspaceId,
        userId,
        state === 'removed' ? 'admin' : state,
        state === 'removed' ? 'removed' : 'active',
        NOW,
        NOW,
      ])
  }

  const viewers: Array<{ id: string; viewer: ViewerClass; pairs: number }> = []
  for (const [index, viewer] of VIEWERS.entries())
    for (const sharing of [0, 1]) {
      const id = `v${index}.${sharing}`
      const artifactWorkspace = `${id}:artifact`
      const homeWorkspace = `${id}:home`
      const host = `${id}:host`
      const email = `Viewer-${id}@Example.com`
      const links = (Object.keys(LINKS) as LinkKey[]).filter(
        (key) => LINKS[key].sharing === sharing,
      )
      workspace(artifactWorkspace, viewer.plan, sharing)
      rows.users.push([
        host,
        host,
        `host-${id}@example.com`,
        1,
        artifactWorkspace,
        'human',
        null,
        NOW,
        NOW,
      ])
      if (viewer.home === 'other') workspace(homeWorkspace, 'team', 1)
      rows.users.push([
        id,
        id,
        email,
        viewer.verified ? 1 : 0,
        viewer.home === 'artifact' ? artifactWorkspace : homeWorkspace,
        viewer.kind === 'human' ? 'human' : 'bot',
        viewer.kind === 'stopped' ? NOW : null,
        NOW,
        NOW,
      ])
      membership(artifactWorkspace, id, viewer.membership)
      if (viewer.home === 'other')
        membership(
          homeWorkspace,
          id,
          viewer.membership === 'removed' ? 'owner' : 'removed',
        )

      let pairs = 0
      for (const [containerIndex, entry] of CONTAINERS.entries()) {
        if (entry.workspace === 'home' && viewer.home === 'artifact') continue
        const containerId = `${id}/${containerIndex}`
        rows.artifact_containers.push([
          containerId,
          containerId,
          entry.workspace === 'home' ? homeWorkspace : artifactWorkspace,
          entry.kind,
          entry.kind === 'inbox' ? id : null,
          entry.creator ? id : null,
          entry.base,
          entry.extra === 'archived' ? NOW : null,
          NOW,
          NOW,
        ])
        if (entry.kind === 'project')
          rows.project_share_defaults.push([
            containerId,
            containerId,
            entry.audience ? email.toUpperCase() : 'nobody@example.com',
            NOW,
            NOW,
          ])
        if (entry.extra === 'joined')
          rows.project_members.push([containerId, id, NOW, NOW])
        for (const visibility of VISIBILITIES)
          for (const link of links)
            for (const owner of [true, false])
              for (const granted of [true, false]) {
                const shareableId = `${containerId}/${visibility}/${link}/${Number(owner)}${Number(granted)}`
                rows.shareables.push([
                  shareableId,
                  artifactWorkspace,
                  owner ? id : host,
                  visibility,
                  containerId,
                  LINKS[link].expires,
                  LINKS[link].suspended ? NOW : null,
                  'file.html',
                  'html_page',
                  NOW,
                  NOW,
                  NOW,
                ])
                rows.shareable_grants.push([
                  shareableId,
                  granted ? email.toUpperCase() : 'nobody@example.com',
                  host,
                  NOW,
                ])
                pairs += 1
              }
      }
      viewers.push({ id, viewer, pairs })
    }
  for (const table of Object.keys(COLUMNS) as Table[])
    sqlite
      .prepare(
        `INSERT INTO ${table} (${COLUMNS[table].join(', ')})
         SELECT ${COLUMNS[table].map((_, i) => `value ->> ${i}`).join(', ')}
         FROM json_each(?)`,
      )
      .run(JSON.stringify(rows[table]))
  return viewers
}

test('canOpenSql decides every enumerated viewer and artifact the way viewerAccessAllowed decides on the loaded facts', async () => {
  const { db, sqlite } = createMigratedInMemoryDb()
  const viewers = seed(sqlite)
  const everyArtifactState = (['team', 'plus'] as const).flatMap((plan) =>
    viewers.filter(
      (entry) => entry.viewer === VIEWERS.find((v) => v.plan === plan),
    ),
  )
  const evaluations = [
    ...viewers.map((entry) => ({ ...entry, viewerUserId: entry.id })),
    ...[null, 'missing-viewer'].flatMap((viewerUserId) =>
      everyArtifactState.map((entry) => ({ ...entry, viewerUserId })),
    ),
  ]

  const mismatches: string[] = []
  for (const { id, pairs, viewerUserId } of evaluations) {
    const rows = (await viewerAccessFactsQuery(db, { viewerUserId, now: NOW })
      .select([
        'shareables.id as shareable_id',
        canOpenSql({ viewerUserId, now: NOW }).as('can_open'),
      ])
      .where('shareables.id', '>', `${id}/`)
      .where('shareables.id', '<', `${id}0`)
      .execute()) as unknown as Array<
      ViewerAccessFactsRow & { shareable_id: string; can_open: unknown }
    >
    expect(rows).toHaveLength(pairs)
    for (const row of rows) {
      const expected = viewerAccessAllowed(viewerAccessFactsFromRow(row))
        ? 1
        : 0
      if (row.can_open !== expected)
        mismatches.push(
          `viewer ${String(viewerUserId)}, ${describeCase(row.shareable_id)}: canOpenSql=${String(row.can_open)}, viewerAccessAllowed=${expected}`,
        )
    }
  }

  expect(mismatches.slice(0, 20)).toEqual([])
  await db.destroy()
}, 60_000)

import { afterEach, beforeEach, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { facts } from '~/modules/access'
import { viewerAccessAllowed } from './access.server'
import {
  buildCandidateDiscoveryQuery,
  discoverCandidates,
  enumerateDiscoverableIds,
  loadDiscoveryViewer,
} from './search-discovery.server'

const now = '2026-09-15T00:00:00.000Z'
let fixture: ReturnType<typeof createMigratedInMemoryDb>
const input = {
  viewerUserId: 'viewer',
  workspaceId: 'source',
  candidateIds: ['file'],
  now,
}
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id, name, plan, link_sharing_enabled, created_at) VALUES ('source','Source','team',1,'${now}'), ('external','External','free',1,'${now}');
    INSERT INTO users (id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES
      ('viewer','Viewer@Example.com',1,'Viewer','source','${now}','${now}'),
      ('owner','owner@example.com',1,'Owner','source','${now}','${now}');
    INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at)
      VALUES ('project','source','project','Project','private','owner','${now}','${now}');
    INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
      VALUES ('file','source','owner','File','html_page','private','project','${now}','2026-01-01T00:00:00.000Z','${now}');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})

const grant = `INSERT INTO shareable_grants VALUES ('file','VIEWER@example.com','${now}','owner');`
const defaults = `INSERT INTO project_share_defaults (id,project_container_id,email,created_at,updated_at) VALUES ('default','project','VIEWER@example.com','${now}','${now}');`
const join = `INSERT INTO project_members VALUES ('project','viewer','${now}','${now}');`
const seen = `INSERT INTO shareable_viewer_recency (shareable_id,viewer_user_id,first_viewed_at,last_viewed_at) VALUES ('file','viewer','${now}','${now}');`
const removed = `INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('source','viewer','member','removed','${now}','${now}');`

test.each([
  ['private', '', false],
  ['owner', "UPDATE shareables SET owner_user_id='viewer';", true],
  [
    'removed owner',
    "UPDATE shareables SET owner_user_id='viewer';" + removed,
    false,
  ],
  ['direct mixed-case', grant, true],
  ['unverified direct', grant + 'UPDATE users SET email_verified=0;', false],
  ['removed direct', grant + removed, true],
  [
    'foreign owner',
    "UPDATE shareables SET owner_user_id='viewer'; UPDATE users SET workspace_id='external' WHERE id='viewer';",
    true,
  ],
  [
    'foreign direct',
    grant + "UPDATE users SET workspace_id='external' WHERE id='viewer';",
    true,
  ],
  ['workspace', "UPDATE shareables SET visibility='workspace';", true],
  [
    'foreign workspace',
    "UPDATE shareables SET visibility='workspace'; UPDATE users SET workspace_id='external' WHERE id='viewer';",
    false,
  ],
  [
    'removed workspace',
    "UPDATE shareables SET visibility='workspace';" + removed,
    false,
  ],
  ['member alone', "UPDATE shareables SET visibility='project';" + join, false],
  [
    'creator alone',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET created_by_id='viewer';",
    false,
  ],
  [
    'creator member',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET created_by_id='viewer';" +
      join,
    true,
  ],
  [
    'removed creator member',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET created_by_id='viewer';" +
      join +
      removed,
    false,
  ],
  ['default', "UPDATE shareables SET visibility='project';" + defaults, true],
  [
    'unverified default',
    "UPDATE shareables SET visibility='project'; UPDATE users SET email_verified=0;" +
      defaults,
    false,
  ],
  [
    'foreign default',
    "UPDATE shareables SET visibility='project'; UPDATE users SET workspace_id='external' WHERE id='viewer';" +
      defaults,
    true,
  ],
  [
    'base',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET base_visibility='workspace';",
    true,
  ],
  [
    'removed base',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET base_visibility='workspace';" +
      removed,
    false,
  ],
  [
    'removed default',
    "UPDATE shareables SET visibility='project';" + defaults + removed,
    true,
  ],
  [
    'foreign base',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET base_visibility='workspace'; UPDATE users SET workspace_id='external' WHERE id='viewer';",
    false,
  ],
  ['unseen link', "UPDATE shareables SET visibility='link';", false],
  ['seen link', "UPDATE shareables SET visibility='link';" + seen, true],
  [
    'other viewer link',
    "UPDATE shareables SET visibility='link';" +
      seen.replace("'viewer'", "'owner'"),
    false,
  ],
  [
    'suspended link',
    `UPDATE shareables SET visibility='link',link_suspended_at='${now}';` +
      seen,
    false,
  ],
  [
    'disabled link',
    "UPDATE shareables SET visibility='link'; UPDATE workspaces SET link_sharing_enabled=0;" +
      seen,
    false,
  ],
  [
    'suspended owner',
    `UPDATE shareables SET visibility='link',owner_user_id='viewer',link_suspended_at='${now}';`,
    true,
  ],
  [
    'disabled direct',
    "UPDATE shareables SET visibility='link'; UPDATE workspaces SET link_sharing_enabled=0;" +
      grant,
    true,
  ],
] as const)(
  '%s discovery and non-administrative opening',
  async (_name, setup, allowed) => {
    fixture.sqlite.exec(setup)
    const rows = await discoverCandidates(fixture.db, input)
    expect(rows).toEqual(allowed ? [{ id: 'file', workspaceId: 'source' }] : [])
    if (allowed) {
      const access = await facts(fixture.db, {
        shareableId: 'file',
        viewerUserId: 'viewer',
        now,
      })
      expect(access).not.toBeNull()
      expect(viewerAccessAllowed(access!)).toBe(true)
      expect(
        viewerAccessAllowed({
          ...access!,
          isTeamAdmin: false,
          isProjectAdmin: false,
        }),
      ).toBe(true)
    }
    // Enumeration intentionally does not seed workspace-wide visibility/base.
    if (!['workspace', 'base'].includes(_name)) {
      expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual(
        allowed ? [{ workspaceId: 'source', ids: ['file'] }] : [],
      )
    }
  },
)

test.each(['owner', 'admin'] as const)(
  'joined Team %s requires an independent opening ground',
  async (role) => {
    fixture.sqlite.exec(`UPDATE shareables SET visibility='project'; ${join}
    INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('source','viewer','${role}','active','${now}','${now}');`)
    const access = await facts(fixture.db, {
      shareableId: 'file',
      viewerUserId: 'viewer',
      now,
    })
    expect(viewerAccessAllowed(access!)).toBe(true)
    expect(
      viewerAccessAllowed({
        ...access!,
        isTeamAdmin: false,
        isProjectAdmin: false,
      }),
    ).toBe(false)
    expect(await discoverCandidates(fixture.db, input)).toEqual([])
    expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
    // Fault control: normal opening wrongly used as the membership ceiling.
    const viewer = (await loadDiscoveryViewer(fixture.db, 'viewer'))!
    const compiled = buildCandidateDiscoveryQuery(
      fixture.db,
      viewer,
      input,
      now,
    ).compile()
    const faultySql = compiled.sql.replace(
      'c.created_by_id = ?',
      `${Number(viewerAccessAllowed(access!))} = (? IS NOT NULL)`,
    )
    const faultyRows = fixture.sqlite
      .prepare(faultySql)
      .all(...(compiled.parameters as string[]))
    expect(() => expect(faultyRows).toEqual([])).toThrow()
    fixture.sqlite.exec(defaults)
    expect(
      fixture.sqlite
        .prepare(faultySql)
        .all(...(compiled.parameters as string[])),
    ).toEqual([{ id: 'file', workspaceId: 'source' }])
    expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
    expect(await enumerateDiscoverableIds(fixture.db, input)).toHaveLength(1)
    fixture.sqlite.exec(
      "DELETE FROM project_share_defaults; UPDATE artifact_containers SET created_by_id='viewer';",
    )
    expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
    fixture.sqlite.exec('DELETE FROM project_members;')
    expect(await discoverCandidates(fixture.db, input)).toEqual([])
    fixture.sqlite.exec(
      join +
        "UPDATE artifact_containers SET created_by_id='owner'; UPDATE workspace_members SET role='member';",
    )
    expect(await discoverCandidates(fixture.db, input)).toEqual([])
  },
)

test.each([
  [null, true],
  ['2026-09-16T00:00:00Z', true],
  ['2026-09-15T00:00:00.123456Z', true],
  [now, false],
  ['2026-09-14T00:00:00Z', false],
  ['2026-09-16T00:00:00+00:00', false],
  ['2026-09-16T00:00:00.badZ', false],
  ['invalid', false],
])('seen link expiry %s', async (expiry, allowed) => {
  fixture.sqlite.exec("UPDATE shareables SET visibility='link';" + seen)
  await fixture.db
    .updateTable('shareables')
    .set({ link_expires_at: expiry })
    .execute()
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(
    allowed ? 1 : 0,
  )
  const access = await facts(fixture.db, {
    shareableId: 'file',
    viewerUserId: 'viewer',
    now,
  })
  expect(access?.anonymousLinkAllowed).toBe(allowed)
})

test('live permission changes revoke grants, defaults, membership and seen links on the next call', async () => {
  fixture.sqlite.exec(grant)
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec('UPDATE users SET email_verified=0;')
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(
    "UPDATE users SET email_verified=1; DELETE FROM shareable_grants; UPDATE shareables SET visibility='project';" +
      defaults +
      join,
  )
  expect(await enumerateDiscoverableIds(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec('DELETE FROM project_share_defaults;')
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
  fixture.sqlite.exec("UPDATE artifact_containers SET created_by_id='viewer';")
  expect(await enumerateDiscoverableIds(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec('DELETE FROM project_members;')
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
  fixture.sqlite.exec("UPDATE shareables SET visibility='link';" + seen)
  expect(await enumerateDiscoverableIds(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec(`UPDATE shareables SET link_suspended_at='${now}';`)
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(
    "UPDATE shareables SET link_suspended_at=NULL, visibility='private';",
  )
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
})

test.each([
  'owner',
  'grant',
  'workspace',
  'default',
  'base',
  'member',
  'link',
  'none',
])('archive gate for %s', async (ground) => {
  const setups: Record<string, string> = {
    owner: "UPDATE shareables SET owner_user_id='viewer';",
    grant,
    workspace: "UPDATE shareables SET visibility='workspace';",
    default: "UPDATE shareables SET visibility='project';" + defaults,
    base: "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET base_visibility='workspace';",
    member:
      "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET created_by_id='viewer';" +
      join,
    link: "UPDATE shareables SET visibility='link';" + seen,
    none: '',
  }
  fixture.sqlite.exec(
    setups[ground] + `UPDATE artifact_containers SET archived_at='${now}';`,
  )
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  expect(
    await discoverCandidates(fixture.db, { ...input, includeArchived: true }),
  ).toHaveLength(ground === 'none' ? 0 : 1)
  if (ground !== 'none') {
    const access = await facts(fixture.db, {
      shareableId: 'file',
      viewerUserId: 'viewer',
      now,
    })
    expect(
      viewerAccessAllowed({
        ...access!,
        isTeamAdmin: false,
        isProjectAdmin: false,
      }),
    ).toBe(true)
  }
})

test('owner/container filters intersect and candidate identity is not authority', async () => {
  fixture.sqlite.exec(grant)
  expect(
    await discoverCandidates(fixture.db, { ...input, ownerUserId: 'owner' }),
  ).toHaveLength(1)
  expect(
    await discoverCandidates(fixture.db, { ...input, containerId: 'project' }),
  ).toHaveLength(1)
  expect(
    await discoverCandidates(fixture.db, {
      ...input,
      ownerUserId: 'viewer',
      containerId: 'project',
    }),
  ).toEqual([])
  expect(
    await discoverCandidates(fixture.db, {
      ...input,
      ownerUserId: 'owner',
      containerId: 'missing',
    }),
  ).toEqual([])
  expect(
    await discoverCandidates(fixture.db, {
      ...input,
      candidateIds: ['file', 'file', 'missing'],
    }),
  ).toHaveLength(1)
  expect(
    await discoverCandidates(fixture.db, { ...input, candidateIds: [] }),
  ).toEqual([])
  expect(
    await discoverCandidates(fixture.db, { ...input, viewerUserId: 'missing' }),
  ).toEqual([])
  expect(
    await enumerateDiscoverableIds(fixture.db, {
      ...input,
      viewerUserId: 'missing',
    }),
  ).toEqual([])
})

test.each(['updated', 'viewed'] as const)(
  '%s bounds use activity or personal recency with inclusive lower and exclusive upper',
  async (field) => {
    fixture.sqlite.exec(grant)
    expect(
      await discoverCandidates(fixture.db, { ...input, date: { field } }),
    ).toHaveLength(1)
    if (field === 'viewed') {
      expect(
        await discoverCandidates(fixture.db, {
          ...input,
          date: { field, from: new Date(now) },
        }),
      ).toEqual([])
      fixture.sqlite.exec(seen)
    }
    expect(
      await discoverCandidates(fixture.db, {
        ...input,
        date: {
          field,
          from: new Date(now),
          to: new Date('2026-09-16T00:00:00.000Z'),
        },
      }),
    ).toHaveLength(1)
    expect(
      await discoverCandidates(fixture.db, {
        ...input,
        date: { field, to: new Date(now) },
      }),
    ).toEqual([])
    expect(
      await discoverCandidates(fixture.db, {
        ...input,
        date: { field, from: new Date('2026-09-16T00:00:00.000Z') },
      }),
    ).toEqual([])
  },
)

test('sparse sources deduplicate and group across workspaces, agreeing with candidate filters', async () => {
  fixture.sqlite
    .exec(`UPDATE users SET workspace_id='external' WHERE id='viewer'; ${grant} ${defaults} ${join} ${seen}
    UPDATE shareables SET visibility='project';
    INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_at,updated_at) VALUES ('external-project','external','project','External','private','${now}','${now}');
    INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at,activity_at)
    VALUES ('own','external','viewer','Own','html_page','private','external-project','${now}','${now}','${now}');`)
  const groups = await enumerateDiscoverableIds(fixture.db, input)
  expect(
    groups.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  ).toEqual([
    { workspaceId: 'external', ids: ['own'] },
    { workspaceId: 'source', ids: ['file'] },
  ])
  for (const group of groups) {
    const rows = await discoverCandidates(fixture.db, {
      ...input,
      workspaceId: group.workspaceId,
      candidateIds: ['file', 'own'],
    })
    expect(rows.map((row) => row.id)).toEqual(group.ids)
  }
  expect(
    await enumerateDiscoverableIds(fixture.db, {
      ...input,
      ownerUserId: 'owner',
      containerId: 'project',
      date: { field: 'viewed', from: new Date(now) },
    }),
  ).toEqual([{ workspaceId: 'source', ids: ['file'] }])
})

test('unseen-link fault fails the exclusion while the seen control remains discoverable', async () => {
  fixture.sqlite.exec("UPDATE shareables SET visibility='link';")
  const viewer = (await loadDiscoveryViewer(fixture.db, 'viewer'))!
  const query = buildCandidateDiscoveryQuery(
    fixture.db,
    viewer,
    input,
    now,
  ).compile()
  const faultySql = query.sql.replace(
    /EXISTS \(SELECT 1 FROM shareable_viewer_recency r\s+WHERE r.shareable_id = s.id AND r.viewer_user_id = \?\)/,
    '(? IS NOT NULL)',
  )
  const faulty = fixture.sqlite
    .prepare(faultySql)
    .all(...(query.parameters as string[]))
  expect(() => expect(faulty).toEqual([])).toThrow()
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(seen)
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
})

test('stopped bot and removed membership revoke identity on the next call', async () => {
  fixture.sqlite
    .exec(`INSERT INTO users (id,email,email_verified,name,workspace_id,kind,created_at,updated_at)
    VALUES ('bot','bot@example.com',1,'Bot','source','bot','${now}','${now}');
    UPDATE shareables SET owner_user_id='bot';`)
  const botInput = { ...input, viewerUserId: 'bot' }
  expect(await discoverCandidates(fixture.db, botInput)).toHaveLength(1)
  fixture.sqlite.exec(
    `UPDATE users SET bot_stopped_at='${now}' WHERE id='bot';`,
  )
  expect(await discoverCandidates(fixture.db, botInput)).toEqual([])
  expect(await enumerateDiscoverableIds(fixture.db, botInput)).toEqual([])
  fixture.sqlite.exec("UPDATE shareables SET owner_user_id='viewer';")
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec(removed)
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(grant)
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec('DELETE FROM shareable_grants;')
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
})

test('link policy, expiry and current viewer workspace are reread between calls', async () => {
  fixture.sqlite.exec("UPDATE shareables SET visibility='link';" + seen)
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec('UPDATE workspaces SET link_sharing_enabled=0;')
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(
    `UPDATE workspaces SET link_sharing_enabled=1; UPDATE shareables SET link_expires_at='${now}';`,
  )
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  fixture.sqlite.exec(
    "UPDATE shareables SET link_expires_at=NULL,visibility='workspace';",
  )
  expect(await discoverCandidates(fixture.db, input)).toHaveLength(1)
  fixture.sqlite.exec(
    "UPDATE users SET workspace_id='external' WHERE id='viewer';",
  )
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
})

test('mixed candidates return only qualifying IDs and omit unrelated workspace groups', async () => {
  fixture.sqlite.exec(`${grant}
    INSERT INTO workspaces (id,name,created_at) VALUES ('unrelated','Unrelated','${now}');
    INSERT INTO artifact_containers (id,workspace_id,kind,name,base_visibility,created_at,updated_at)
      VALUES ('unrelated-project','unrelated','project','Unrelated','workspace','${now}','${now}');
    INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
      VALUES ('denied','source','owner','Denied','html_page','private','project','${now}','${now}'),
      ('foreign','unrelated','owner','Foreign','html_page','workspace','unrelated-project','${now}','${now}');`)
  expect(
    await discoverCandidates(fixture.db, {
      ...input,
      candidateIds: ['file', 'denied', 'foreign', 'missing'],
    }),
  ).toEqual([{ id: 'file', workspaceId: 'source' }])
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([
    { workspaceId: 'source', ids: ['file'] },
  ])
  fixture.sqlite.exec(
    `UPDATE shareables SET visibility='link' WHERE id='file'; DELETE FROM shareable_grants; ${seen}`,
  )
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([
    { workspaceId: 'source', ids: ['file'] },
  ])
  fixture.sqlite.exec(
    `UPDATE shareables SET link_expires_at='${now}' WHERE id='file';`,
  )
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
})

test.each([
  ['unseen link', "UPDATE shareables SET visibility='link';"],
  [
    'creator only',
    "UPDATE shareables SET visibility='project'; UPDATE artifact_containers SET created_by_id='viewer';",
  ],
  [
    'archived owner',
    `UPDATE shareables SET owner_user_id='viewer'; UPDATE artifact_containers SET archived_at='${now}';`,
  ],
  [
    'link administrator',
    `UPDATE shareables SET visibility='link'; UPDATE workspaces SET link_sharing_enabled=0;
    INSERT INTO workspace_members (workspace_id,user_id,role,status,created_at,updated_at) VALUES ('source','viewer','admin','active','${now}','${now}');`,
  ],
])('%s can open but is not discoverable', async (_name, setup) => {
  fixture.sqlite.exec(setup)
  const access = await facts(fixture.db, {
    shareableId: 'file',
    viewerUserId: 'viewer',
    now,
  })
  expect(viewerAccessAllowed(access!)).toBe(true)
  expect(await discoverCandidates(fixture.db, input)).toEqual([])
  expect(await enumerateDiscoverableIds(fixture.db, input)).toEqual([])
})

test.each(['updated', 'viewed'] as const)(
  '%s bounds preserve milliseconds and normalize stored UTC precision in both paths',
  async (field) => {
    fixture.sqlite.exec(grant + seen)
    for (const stored of [
      now,
      '2026-09-15T00:00:00Z',
      '2026-09-15T00:00:00.001Z',
    ]) {
      fixture.sqlite
        .prepare('UPDATE shareables SET activity_at = ?')
        .run(stored)
      fixture.sqlite
        .prepare('UPDATE shareable_viewer_recency SET last_viewed_at = ?')
        .run(stored)
      for (const bound of [now, '2026-09-15T00:00:00.001Z']) {
        for (const edge of ['from', 'to'] as const) {
          const allowed =
            edge === 'from'
              ? new Date(stored).getTime() >= new Date(bound).getTime()
              : new Date(stored).getTime() < new Date(bound).getTime()
          const filtered = {
            ...input,
            date: { field, [edge]: new Date(bound) },
          }
          const context = `${stored} ${edge} ${bound}`
          expect(
            await discoverCandidates(fixture.db, filtered),
            context,
          ).toEqual(allowed ? [{ id: 'file', workspaceId: 'source' }] : [])
          expect(
            await enumerateDiscoverableIds(fixture.db, filtered),
            context,
          ).toEqual(allowed ? [{ workspaceId: 'source', ids: ['file'] }] : [])
        }
      }
    }
  },
)

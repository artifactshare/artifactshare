import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

describe('database migrations', () => {
  let sqlite: DatabaseSync | null = null

  afterEach(() => {
    sqlite?.close()
    sqlite = null
  })
  test('0022 migrates user storage counters into workspace storage counters', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0022_workspace_plan_storage.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (id, hd, name, created_at)
      VALUES ('ws-a', 'example.com', 'Workspace', '2026-05-22T00:00:00.000Z');

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale, plan, storage_quota_bytes,
        storage_used_bytes
      ) VALUES
        (
          'u1', 'one@example.com', 1, 'One', NULL,
          '2026-05-22T00:00:00.000Z', '2026-05-22T10:00:00.000Z',
          'ws-a', 'sub-1', NULL, 'free', 104857600, 1200
        ),
        (
          'u2', 'two@example.com', 1, 'Two', NULL,
          '2026-05-22T00:00:00.000Z', '2026-05-22T11:00:00.000Z',
          'ws-a', 'sub-2', NULL, 'team', 53687091200, 3400
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0022_workspace_plan_storage.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const workspace = sqlite
      .prepare(
        `
          SELECT plan, storage_quota_bytes, storage_used_bytes, storage_updated_at
          FROM workspaces
          WHERE id = 'ws-a'
        `,
      )
      .get() as {
      plan: string
      storage_quota_bytes: number
      storage_used_bytes: number
      storage_updated_at: string
    }

    expect(workspace).toEqual({
      plan: 'team',
      storage_quota_bytes: 53687091200,
      storage_used_bytes: 4600,
      storage_updated_at: '2026-05-22T11:00:00.000Z',
    })

    const userColumns = sqlite
      .prepare(`PRAGMA table_info(users)`)
      .all() as Array<{
      name: string
    }>
    expect(userColumns.map((column) => column.name)).not.toContain('plan')
    expect(userColumns.map((column) => column.name)).not.toContain(
      'storage_quota_bytes',
    )
    expect(userColumns.map((column) => column.name)).not.toContain(
      'storage_used_bytes',
    )
  })

  test('0023 migrates published version authors into workspace contributors', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0023_workspace_contributors.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      )
      VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-22T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-22T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'u1', 'one@example.com', 1, 'One', NULL,
          '2026-05-22T00:00:00.000Z', '2026-05-22T10:00:00.000Z',
          'ws-a', 'sub-1', NULL
        ),
        (
          'u2', 'two@example.com', 1, 'Two', NULL,
          '2026-05-22T00:00:00.000Z', '2026-05-22T11:00:00.000Z',
          'ws-a', 'sub-2', NULL
        );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, container_type, artifact_kind,
        visibility, current_version_id, created_at, updated_at,
        last_accessed_at
      ) VALUES
        (
          's1', 'ws-a', 'u1', NULL, 'one.html', NULL, NULL, NULL,
          'quick_share', 'html_page', 'private', 'v1',
          '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z', NULL
        ),
        (
          's2', 'ws-a', 'u2', NULL, 'two.html', NULL, NULL, NULL,
          'quick_share', 'html_page', 'private', 'v3',
          '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z', NULL
        );

      INSERT INTO versions (
        id, shareable_id, artifact_kind, status, entrypoint_path, r2_key,
        size_bytes, sha256, created_by_id, created_at, published_at
      ) VALUES
        (
          'v1', 's1', 'html_page', 'published', '/one.html',
          'artifacts/s1/v1/index.html', 10, 'sha1', 'u1',
          '2026-05-22T10:00:00.000Z', '2026-05-22T10:05:00.000Z'
        ),
        (
          'v2', 's1', 'html_page', 'failed', '/one.html',
          'artifacts/s1/v2/index.html', 10, 'sha2', 'u2',
          '2026-05-22T10:30:00.000Z', NULL
        ),
        (
          'v3', 's2', 'html_page', 'published', '/two.html',
          'artifacts/s2/v3/index.html', 10, 'sha3', 'u2',
          '2026-05-22T11:00:00.000Z', NULL
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0023_workspace_contributors.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const contributors = sqlite
      .prepare(
        `
          SELECT user_id, first_contributed_at, last_contributed_at, pending_uploads
          FROM workspace_contributors
          ORDER BY user_id
        `,
      )
      .all()

    expect(contributors).toEqual([
      {
        user_id: 'u1',
        first_contributed_at: '2026-05-22T10:05:00.000Z',
        last_contributed_at: '2026-05-22T10:05:00.000Z',
        pending_uploads: 0,
      },
      {
        user_id: 'u2',
        first_contributed_at: '2026-05-22T11:00:00.000Z',
        last_contributed_at: '2026-05-22T11:00:00.000Z',
        pending_uploads: 0,
      },
    ])
  })

  test('0070 backfills artifact, version, and comment events deterministically', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0070_events.sql') break
      sqlite.exec(migration.sql)
    }
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('w1','W1','2026-01-01'),('w2','W2','2026-01-01');
      INSERT INTO users (id,email,email_verified,name,created_at,updated_at,workspace_id,google_sub) VALUES
        ('u1','u1@x',1,'U1','2026-01-01','2026-01-01','w1','sub1'),('u2','u2@x',1,'U2','2026-01-01','2026-01-01','w2','sub2');
      INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES
        ('c1','w1','inbox','u1','u1','C1','2026-01-01','2026-01-01'),('c2','w2','inbox','u2','u2','C2','2026-01-01','2026-01-01');
      INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at) VALUES
        ('s1','w1','u1','S1','html_page','private','c1','2026-01-01','2026-01-01'),('s2','w2','u2','S2','html_page','private','c2','2026-01-01','2026-01-01');
      INSERT INTO versions (id,shareable_id,artifact_kind,status,entrypoint_path,r2_key,size_bytes,sha256,created_by_id,created_at,published_at) VALUES
        ('va','s1','html_page','published','/','a',1,'a','u1','2026-01-01','2026-01-02'),('vb','s1','html_page','published','/','b',1,'b','u1','2026-01-01','2026-01-03'),('vc','s1','html_page','published','/','c',1,'c','u1','2026-01-01','2026-01-03'),('vu','s1','html_page','uploading','/','u',1,'u','u1','2026-01-01',NULL),('vd','s2','html_page','published','/','d',1,'d','u2','2026-01-01','2026-01-02'),('ve','s2','html_page','published','/','e',1,'e','u2','2026-01-01','2026-01-02');
      INSERT INTO comment_threads (id,shareable_id,status,created_by_id,created_at,updated_at) VALUES ('t1','s1','open','u1','2026-01-04','2026-01-04');
      INSERT INTO comment_messages (id,thread_id,body,created_by_id,created_at,updated_at) VALUES ('m1','t1','first','u1','2026-01-04T01:00:00Z','2026-01-04T01:00:00Z'),('m2','t1','reply','u1','2026-01-04T02:00:00Z','2026-01-04T02:00:00Z');
    `)
    sqlite.exec(migrations.find((m) => m.name === '0070_events.sql')!.sql)
    const rows = sqlite
      .prepare(
        'SELECT type, shareable_id, actor_user_id, subject_id, created_at, workspace_id FROM events ORDER BY type, subject_id',
      )
      .all()
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          type: 'artifact_created',
          shareable_id: 's1',
          actor_user_id: 'u1',
          subject_id: 'va',
          created_at: '2026-01-02',
          workspace_id: 'w1',
        },
        {
          type: 'version_published',
          shareable_id: 's1',
          actor_user_id: 'u1',
          subject_id: 'vb',
          created_at: '2026-01-03',
          workspace_id: 'w1',
        },
        {
          type: 'version_published',
          shareable_id: 's1',
          actor_user_id: 'u1',
          subject_id: 'vc',
          created_at: '2026-01-03',
          workspace_id: 'w1',
        },
        {
          type: 'artifact_created',
          shareable_id: 's2',
          actor_user_id: 'u2',
          subject_id: 'vd',
          created_at: '2026-01-02',
          workspace_id: 'w2',
        },
        {
          type: 'version_published',
          shareable_id: 's2',
          actor_user_id: 'u2',
          subject_id: 've',
          created_at: '2026-01-02',
          workspace_id: 'w2',
        },
        {
          type: 'comment_posted',
          shareable_id: 's1',
          actor_user_id: 'u1',
          subject_id: 'm1',
          created_at: '2026-01-04T01:00:00Z',
          workspace_id: 'w1',
        },
        {
          type: 'comment_posted',
          shareable_id: 's1',
          actor_user_id: 'u1',
          subject_id: 'm2',
          created_at: '2026-01-04T02:00:00Z',
          workspace_id: 'w1',
        },
      ]),
    )
    expect(rows).toHaveLength(7)
  })

  test('0050 backfills non-public Google hosted domains into workspace domain claims', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0050_workspace_domain_claims.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES
        (
          'ws-company', 'Example.COM', 'Company',
          '2026-06-26T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        ),
        (
          'ws-company-later', 'example.com', 'Company Later',
          '2026-06-26T01:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        ),
        (
          'ws-public', 'gmail.com', 'Gmail',
          '2026-06-26T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        ),
        (
          'ws-personal', NULL, 'Personal',
          '2026-06-26T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0050_workspace_domain_claims.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const claims = sqlite
      .prepare(
        `
          SELECT domain, workspace_id, source, provider_tenant_id
          FROM workspace_domain_claims
          ORDER BY domain
        `,
      )
      .all()

    expect(claims).toEqual([
      {
        domain: 'example.com',
        workspace_id: 'ws-company',
        source: 'google_hd',
        provider_tenant_id: null,
      },
    ])
  })

  test('0051 backfills slack workspace owner from installer and cascades on workspace delete', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0051_slack_workspace_owner.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES
        (
          'ws-a', 'a.example.com', 'Workspace A',
          '2026-06-27T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        ),
        (
          'ws-b', 'b.example.com', 'Workspace B',
          '2026-06-27T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'u-b', 'b@example.com', 1, 'User B', NULL,
          '2026-06-27T00:00:00.000Z', '2026-06-27T00:00:00.000Z',
          'ws-b', 'sub-b', NULL
        ),
        (
          'u-a', 'a@example.com', 1, 'User A', NULL,
          '2026-06-27T00:00:00.000Z', '2026-06-27T00:00:00.000Z',
          'ws-a', 'sub-a', NULL
        );

      INSERT INTO slack_workspaces (
        id, team_id, team_name, bot_user_id, bot_token,
        installed_by_user_id, installed_at
      ) VALUES
        (
          'sw-installed', 'T-installed', 'Installed Team', 'B1', 'token-1',
          'u-b', '2026-06-27T01:00:00.000Z'
        ),
        (
          'sw-null-installer', 'T-null', 'Null Installer Team', 'B2', 'token-2',
          NULL, '2026-06-27T01:00:00.000Z'
        ),
        (
          'sw-cascade', 'T-cascade', 'Cascade Team', 'B3', 'token-3',
          'u-a', '2026-06-27T01:00:00.000Z'
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0051_slack_workspace_owner.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const rows = sqlite
      .prepare(
        `
          SELECT id, workspace_id
          FROM slack_workspaces
          ORDER BY id
        `,
      )
      .all()

    expect(rows).toEqual([
      { id: 'sw-cascade', workspace_id: 'ws-a' },
      { id: 'sw-installed', workspace_id: 'ws-b' },
      { id: 'sw-null-installer', workspace_id: null },
    ])

    sqlite.prepare(`DELETE FROM users WHERE id = 'u-a'`).run()
    sqlite.prepare(`DELETE FROM workspaces WHERE id = 'ws-a'`).run()

    const remaining = sqlite
      .prepare(
        `
          SELECT id FROM slack_workspaces ORDER BY id
        `,
      )
      .all()

    expect(remaining).toEqual([
      { id: 'sw-installed' },
      { id: 'sw-null-installer' },
    ])
  })

  test('0024 creates team admins from the earliest contributor or workspace user', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0024_team_management.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES
        (
          'ws-free', 'free.example.com', 'Free', '2026-05-22T00:00:00.000Z',
          'free', 104857600, 0, '2026-05-22T00:00:00.000Z'
        ),
        (
          'ws-team', 'team.example.com', 'Team', '2026-05-22T00:00:00.000Z',
          'team', 53687091200, 0, '2026-05-22T00:00:00.000Z'
        );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'u-later', 'later@example.com', 1, 'Later', NULL,
          '2026-05-22T10:00:00.000Z', '2026-05-22T10:00:00.000Z',
          'ws-team', 'sub-later', NULL
        ),
        (
          'u-earlier', 'earlier@example.com', 1, 'Earlier', NULL,
          '2026-05-22T09:00:00.000Z', '2026-05-22T09:00:00.000Z',
          'ws-team', 'sub-earlier', NULL
        ),
        (
          'u-free', 'free@example.com', 1, 'Free', NULL,
          '2026-05-22T08:00:00.000Z', '2026-05-22T08:00:00.000Z',
          'ws-free', 'sub-free', NULL
        );

      INSERT INTO workspace_contributors (
        workspace_id, user_id, first_contributed_at, last_contributed_at,
        pending_uploads, created_at, updated_at
      ) VALUES (
        'ws-team', 'u-later', '2026-05-22T08:30:00.000Z',
        '2026-05-22T08:30:00.000Z', 0, '2026-05-22T08:30:00.000Z',
        '2026-05-22T08:30:00.000Z'
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0024_team_management.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const admins = sqlite
      .prepare(
        `
          SELECT workspace_id, user_id
          FROM workspace_admins
          ORDER BY workspace_id
        `,
      )
      .all()

    expect(admins).toEqual([{ workspace_id: 'ws-team', user_id: 'u-later' }])
  })

  test('0027 creates default projects and assigns existing shareables', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0027_project_base_model.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      )
      VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-31T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, container_type, artifact_kind,
        visibility, current_version_id, created_at, updated_at,
        last_accessed_at
      ) VALUES (
        's1', 'ws-a', 'u1', NULL, 'one.html', NULL, NULL, NULL,
        'quick_share', 'html_page', 'private', NULL,
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', NULL
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0027_project_base_model.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const project = sqlite
      .prepare(
        `
          SELECT id, workspace_id, created_by_id, name, is_default
          FROM projects
          WHERE workspace_id = 'ws-a'
        `,
      )
      .get()

    expect(project).toEqual({
      id: 'default_ws-a',
      workspace_id: 'ws-a',
      created_by_id: null,
      name: 'すべての成果物',
      is_default: 1,
    })

    const shareable = sqlite
      .prepare(`SELECT project_id FROM shareables WHERE id = 's1'`)
      .get()

    expect(shareable).toEqual({ project_id: 'default_ws-a' })
  })

  test('0028 backfills existing grants as manual origins', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0028_project_grants_new_shareables.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      )
      VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-31T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO projects (
        id, workspace_id, created_by_id, name, description, is_default,
        archived_at, created_at, updated_at
      ) VALUES (
        'default_ws-a', 'ws-a', NULL, 'すべての成果物', NULL, 1,
        NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, container_type, artifact_kind,
        visibility, current_version_id, view_count, project_id,
        created_at, updated_at, last_accessed_at
      ) VALUES (
        's1', 'ws-a', 'u1', NULL, 'one.html', NULL, NULL, NULL,
        'quick_share', 'html_page', 'private', NULL, 0, 'default_ws-a',
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', NULL
      );

      INSERT INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES (
        's1', 'VIEWER@example.com', '2026-05-31T01:00:00.000Z', 'u1'
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0028_project_grants_new_shareables.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const grant = sqlite
      .prepare(
        `
          SELECT granted_email
          FROM shareable_grants
          WHERE shareable_id = 's1'
        `,
      )
      .get()
    const origin = sqlite
      .prepare(
        `
          SELECT granted_email, origin_type, project_grant_id, created_at, created_by
          FROM shareable_grant_origins
          WHERE shareable_id = 's1'
        `,
      )
      .get()

    expect(grant).toEqual({ granted_email: 'viewer@example.com' })
    expect(origin).toEqual({
      granted_email: 'viewer@example.com',
      origin_type: 'manual',
      project_grant_id: null,
      created_at: '2026-05-31T01:00:00.000Z',
      created_by: 'u1',
    })
  })

  test('0029 moves default project shareables into per-user inbox containers', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0029_artifact_containers.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      )
      VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-31T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'u1', 'one@example.com', 1, 'One', NULL,
          '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z',
          'ws-a', 'sub-1', NULL
        ),
        (
          'u2', 'two@example.com', 1, 'Two', NULL,
          '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z',
          'ws-a', 'sub-2', NULL
        );

      INSERT INTO projects (
        id, workspace_id, created_by_id, name, description, is_default,
        archived_at, created_at, updated_at
      ) VALUES
        (
          'default_ws-a', 'ws-a', NULL, 'すべての成果物', NULL, 1,
          NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        ),
        (
          'project-explicit', 'ws-a', 'u1', 'Northstar 週次', NULL, 0,
          NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, container_type, artifact_kind,
        visibility, current_version_id, view_count, project_id,
        created_at, updated_at, last_accessed_at
      ) VALUES
        (
          's-u1', 'ws-a', 'u1', NULL, 'one.html', NULL, NULL, NULL,
          'quick_share', 'html_page', 'private', NULL, 0, 'default_ws-a',
          '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', NULL
        ),
        (
          's-u2', 'ws-a', 'u2', NULL, 'two.html', NULL, NULL, NULL,
          'quick_share', 'html_page', 'private', NULL, 0, 'default_ws-a',
          '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', NULL
        ),
        (
          's-project', 'ws-a', 'u1', NULL, 'weekly.html', NULL, NULL, NULL,
          'project', 'html_page', 'private', NULL, 0, 'project-explicit',
          '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z', NULL
        );

      INSERT INTO versions (
        id, shareable_id, artifact_kind, status, entrypoint_path, r2_key,
        size_bytes, sha256, created_by_id, created_at, published_at
      ) VALUES (
        'v-project', 's-project', 'html_page', 'published', '/weekly.html',
        'artifacts/s-project/v-project/index.html', 120, 'sha-project', 'u1',
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO project_grants (
        id, project_id, email, role, display_name, created_by_id, created_at, updated_at
      ) VALUES
        (
          'pg-default', 'default_ws-a', 'default@example.com', 'viewer', NULL,
          'u1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        ),
        (
          'pg-explicit', 'project-explicit', 'weekly@example.com', 'viewer', NULL,
          'u1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        ),
        (
          'pg-explicit-case', 'project-explicit', 'WEEKLY@example.com', 'viewer', NULL,
          'u1', '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        );

      INSERT INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES
        (
          's-project', 'weekly@example.com', '2026-05-31T00:00:00.000Z', 'u1'
        ),
        (
          's-project', 'default@example.com', '2026-05-31T00:00:00.000Z', 'u1'
        ),
        (
          's-project', 'manual@example.com', '2026-05-31T00:00:00.000Z', 'u1'
        );

      INSERT INTO shareable_grant_origins (
        shareable_id, granted_email, origin_type, project_grant_id, created_at, created_by
      ) VALUES
        (
          's-project', 'weekly@example.com', 'project', 'pg-explicit',
          '2026-05-31T00:00:00.000Z', 'u1'
        ),
        (
          's-project', 'default@example.com', 'project', 'pg-default',
          '2026-05-31T00:00:00.000Z', 'u1'
        ),
        (
          's-project', 'manual@example.com', 'manual', NULL,
          '2026-05-31T00:00:00.000Z', 'u1'
        );

      INSERT INTO shareable_project_grant_exclusions (
        shareable_id, project_grant_id, created_by_id, created_at
      ) VALUES
        (
          's-project', 'pg-explicit', 'u1', '2026-05-31T00:00:00.000Z'
        ),
        (
          's-project', 'pg-default', 'u1', '2026-05-31T00:00:00.000Z'
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0029_artifact_containers.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const containers = sqlite
      .prepare(
        `
          SELECT kind, owner_user_id, name
          FROM artifact_containers
          ORDER BY kind, owner_user_id, id
        `,
      )
      .all()
    expect(containers).toEqual([
      { kind: 'inbox', owner_user_id: 'u1', name: '未整理' },
      { kind: 'inbox', owner_user_id: 'u2', name: '未整理' },
      { kind: 'project', owner_user_id: null, name: 'Northstar 週次' },
    ])

    const shareables = sqlite
      .prepare(
        `
          SELECT s.id, c.kind, c.owner_user_id
          FROM shareables AS s
          INNER JOIN artifact_containers AS c ON c.id = s.container_id
          ORDER BY s.id
        `,
      )
      .all()
    expect(shareables).toEqual([
      { id: 's-project', kind: 'project', owner_user_id: null },
      { id: 's-u1', kind: 'inbox', owner_user_id: 'u1' },
      { id: 's-u2', kind: 'inbox', owner_user_id: 'u2' },
    ])

    const shareDefaults = sqlite
      .prepare(
        `
          SELECT id, project_container_id, email
          FROM project_share_defaults
          ORDER BY id
        `,
      )
      .all()
    expect(shareDefaults).toEqual([
      {
        id: 'pg-explicit',
        project_container_id: 'project-explicit',
        email: 'weekly@example.com',
      },
    ])

    const origins = sqlite
      .prepare(
        `
          SELECT granted_email, origin_type, project_share_default_id
          FROM shareable_grant_origins
          ORDER BY origin_type, granted_email
        `,
      )
      .all()
    expect(origins).toEqual([
      {
        granted_email: 'manual@example.com',
        origin_type: 'manual',
        project_share_default_id: null,
      },
      {
        granted_email: 'weekly@example.com',
        origin_type: 'project',
        project_share_default_id: 'pg-explicit',
      },
    ])

    const exclusions = sqlite
      .prepare(
        `
          SELECT shareable_id, project_share_default_id, created_by_id
          FROM shareable_project_share_default_exclusions
        `,
      )
      .all()
    expect(exclusions).toEqual([
      {
        shareable_id: 's-project',
        project_share_default_id: 'pg-explicit',
        created_by_id: 'u1',
      },
    ])

    const cleanupMigration = migrations.find(
      (m) => m.name === '0030_drop_legacy_shareable_container_columns.sql',
    )
    expect(cleanupMigration).toBeDefined()
    sqlite.exec(cleanupMigration!.sql)

    const hardDeleteGuardMigration = migrations.find(
      (m) => m.name === '0031_prevent_container_hard_delete.sql',
    )
    expect(hardDeleteGuardMigration).toBeDefined()
    sqlite.exec(hardDeleteGuardMigration!.sql)

    const shareableColumns = sqlite
      .prepare(`PRAGMA table_info(shareables)`)
      .all() as Array<{ name: string; notnull: number }>
    expect(shareableColumns.map((column) => column.name)).not.toContain(
      'container_type',
    )
    expect(shareableColumns.map((column) => column.name)).not.toContain(
      'project_id',
    )
    expect(shareableColumns.map((column) => column.name)).toContain(
      'container_id',
    )

    const preservedVersion = sqlite
      .prepare(`SELECT id FROM versions WHERE id = 'v-project'`)
      .get()
    expect(preservedVersion).toEqual({ id: 'v-project' })

    const migratedDb = sqlite
    expect(() =>
      migratedDb
        .prepare(
          `UPDATE shareables SET container_id = NULL WHERE id = 's-project'`,
        )
        .run(),
    ).toThrow(/shareables\.container_id is required/)
    expect(() =>
      migratedDb
        .prepare(
          `
            INSERT INTO shareables (
              id, workspace_id, owner_user_id, slug, name, derived_title,
              title_override, description, artifact_kind, visibility,
              current_version_id, container_id, created_at, updated_at,
              last_accessed_at
            )
            VALUES (
              's-null-container', 'ws-a', 'u1', NULL, 'bad.html', NULL,
              NULL, NULL, 'html_page', 'private', NULL, NULL,
              '2026-05-22T00:00:00.000Z',
              '2026-05-22T00:00:00.000Z', NULL
            )
          `,
        )
        .run(),
    ).toThrow(/shareables\.container_id is required/)

    expect(() =>
      migratedDb
        .prepare(
          `DELETE FROM artifact_containers WHERE id = 'project-explicit'`,
        )
        .run(),
    ).toThrow(/artifact_containers with shareables cannot be deleted/)

    const legacyTables = sqlite
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('projects', 'project_grants')
          ORDER BY name
        `,
      )
      .all()
    expect(legacyTables).toEqual([])

    sqlite.prepare(`DELETE FROM shareables WHERE id = 's-project'`).run()
    const childVersion = sqlite
      .prepare(`SELECT id FROM versions WHERE id = 'v-project'`)
      .get()
    expect(childVersion).toBeUndefined()
  })

  test('0032 backfills project containers with a unique valid slug', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0032_artifact_container_slug.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      )
      VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-31T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-31T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, archived_at, created_at, updated_at
      ) VALUES
        (
          'proj-1', 'ws-a', 'project', NULL, 'u1', 'Northstar 週次', NULL,
          NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        ),
        (
          'inbox-1', 'ws-a', 'inbox', 'u1', 'u1', '未整理', NULL,
          NULL, '2026-05-31T00:00:00.000Z', '2026-05-31T00:00:00.000Z'
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0032_artifact_container_slug.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const project = sqlite
      .prepare(`SELECT slug FROM artifact_containers WHERE id = 'proj-1'`)
      .get() as { slug: string | null }
    expect(project.slug).not.toBeNull()
    expect(project.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(project.slug?.startsWith('project-')).toBe(true)

    const inbox = sqlite
      .prepare(`SELECT slug FROM artifact_containers WHERE id = 'inbox-1'`)
      .get() as { slug: string | null }
    expect(inbox.slug).toBeNull()

    expect(() =>
      sqlite!.exec(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          description, slug, archived_at, created_at, updated_at
        ) VALUES (
          'proj-2', 'ws-a', 'project', NULL, 'u1', 'Dup', NULL,
          '${project.slug}', NULL, '2026-05-31T00:00:00.000Z',
          '2026-05-31T00:00:00.000Z'
        )`,
      ),
    ).toThrow(/UNIQUE constraint failed/)
  })

  test('0036 drops the project slug column', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    applyMigrations(sqlite)

    const columns = sqlite
      .prepare(`PRAGMA table_info(artifact_containers)`)
      .all() as { name: string }[]
    expect(columns.some((column) => column.name === 'slug')).toBe(false)
  })

  test('0038 rejects an unknown shareables.visibility on insert and update', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    applyMigrations(sqlite)

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-22T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-22T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, archived_at, created_at, updated_at
      ) VALUES (
        'inbox-1', 'ws-a', 'inbox', 'u1', 'u1', '未整理', NULL,
        NULL, '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
      );
    `)

    const insertShareable = (id: string, visibility: string) => `
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, artifact_kind, visibility,
        current_version_id, container_id, created_at, updated_at,
        last_accessed_at
      ) VALUES (
        '${id}', 'ws-a', 'u1', NULL, 'x.html', NULL, NULL, NULL,
        'html_page', '${visibility}', NULL, 'inbox-1',
        '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z', NULL
      )
    `

    expect(() =>
      sqlite!.exec(insertShareable('s-ok', 'workspace')),
    ).not.toThrow()
    expect(() => sqlite!.exec(insertShareable('s-bad', 'public'))).toThrow(
      /visibility must be/,
    )
    expect(() =>
      sqlite!
        .prepare(
          `UPDATE shareables SET visibility = 'public' WHERE id = 's-ok'`,
        )
        .run(),
    ).toThrow(/visibility must be/)
  })

  test('0039 mcp_artifact_posts cascades when its shareable is deleted', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    applyMigrations(sqlite)

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-22T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-22T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, archived_at, created_at, updated_at
      ) VALUES (
        'inbox-1', 'ws-a', 'inbox', 'u1', 'u1', '未整理', NULL,
        NULL, '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
      );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, artifact_kind, visibility,
        current_version_id, container_id, created_at, updated_at,
        last_accessed_at
      ) VALUES (
        's-1', 'ws-a', 'u1', NULL, 'x.html', NULL, NULL, NULL,
        'html_page', 'workspace', NULL, 'inbox-1',
        '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z', NULL
      );

      INSERT INTO mcp_artifact_posts (
        id, shareable_id, user_id, workspace_id, client_id, action,
        content_hash, created_at
      ) VALUES (
        'post-1', 's-1', 'u1', 'ws-a', 'client-1', 'publish',
        'hash-1', '2026-05-22T00:00:00.000Z'
      );
    `)

    const before = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM mcp_artifact_posts`)
      .get() as { n: number }
    expect(before.n).toBe(1)

    expect(() =>
      sqlite!.exec(`
        INSERT INTO mcp_artifact_posts (
          id, shareable_id, user_id, workspace_id, client_id, action,
          content_hash, created_at
        ) VALUES (
          'post-bad', 's-1', 'u1', 'ws-a', NULL, 'delete',
          'hash-2', '2026-05-22T00:00:00.000Z'
        )
      `),
    ).toThrow(/CHECK/)

    sqlite.prepare(`DELETE FROM shareables WHERE id = 's-1'`).run()

    const after = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM mcp_artifact_posts`)
      .get() as { n: number }
    expect(after.n).toBe(0)
  })

  test('0045 widens project_share_defaults.role and preserves constraints', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    applyMigrations(sqlite)

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-05-22T00:00:00.000Z',
        'free', 104857600, 0, '2026-05-22T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES (
        'u1', 'one@example.com', 1, 'One', NULL,
        '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z',
        'ws-a', 'sub-1', NULL
      );

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, archived_at, created_at, updated_at
      ) VALUES (
        'proj-1', 'ws-a', 'project', NULL, 'u1', 'Project', NULL,
        NULL, '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
      ),
      (
        'inbox-1', 'ws-a', 'inbox', 'u1', 'u1', '未整理', NULL,
        NULL, '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
      );
    `)

    const insertDefault = (
      id: string,
      projectId: string,
      email: string,
      role?: string,
    ) => {
      if (role === undefined) {
        return `
          INSERT INTO project_share_defaults (
            id, project_container_id, email, display_name, created_by_id,
            created_at, updated_at
          ) VALUES (
            '${id}', '${projectId}', '${email}', NULL, 'u1',
            '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
          )
        `
      }
      return `
        INSERT INTO project_share_defaults (
          id, project_container_id, email, role, display_name, created_by_id,
          created_at, updated_at
        ) VALUES (
          '${id}', '${projectId}', '${email}', '${role}', NULL, 'u1',
          '2026-05-22T00:00:00.000Z', '2026-05-22T00:00:00.000Z'
        )
      `
    }

    expect(() =>
      sqlite!.exec(
        insertDefault(
          'psd-contrib',
          'proj-1',
          'contrib@example.com',
          'contributor',
        ),
      ),
    ).not.toThrow()
    expect(() =>
      sqlite!.exec(
        insertDefault(
          'psd-manager',
          'proj-1',
          'manager@example.com',
          'manager',
        ),
      ),
    ).not.toThrow()
    expect(() =>
      sqlite!.exec(
        insertDefault('psd-admin', 'proj-1', 'admin@example.com', 'admin'),
      ),
    ).toThrow(/CHECK/)
    expect(() =>
      sqlite!.exec(
        insertDefault('psd-viewer', 'proj-1', 'viewer@example.com', 'viewer'),
      ),
    ).not.toThrow()
    expect(() =>
      sqlite!.exec(
        insertDefault('psd-default', 'proj-1', 'default@example.com'),
      ),
    ).not.toThrow()

    const defaultRole = sqlite!
      .prepare(
        `SELECT role FROM project_share_defaults WHERE id = 'psd-default'`,
      )
      .get() as { role: string }
    expect(defaultRole.role).toBe('viewer')

    expect(() =>
      sqlite!.exec(
        insertDefault('psd-inbox', 'inbox-1', 'inbox@example.com', 'viewer'),
      ),
    ).toThrow(/requires project container/)

    expect(() =>
      sqlite!.exec(
        insertDefault('psd-dup', 'proj-1', 'contrib@example.com', 'viewer'),
      ),
    ).toThrow(/UNIQUE constraint failed/)
  })

  test('0054 migrates signed-in view events into recency without resetting display counts', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0054_view_count_recency.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES (
        'ws-a', 'example.com', 'Workspace', '2026-06-29T00:00:00.000Z',
        'free', 104857600, 0,
        '1970-01-01T00:00:00.000Z'
      );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'owner', 'owner@example.com', 1, 'Owner', NULL,
          '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z',
          'ws-a', 'google-owner', NULL
        ),
        (
          'viewer', 'viewer@example.com', 1, 'Viewer', NULL,
          '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z',
          'ws-a', 'google-viewer', NULL
        );

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, base_visibility, archived_at, created_at, updated_at
      ) VALUES (
        'inbox-owner', 'ws-a', 'inbox', 'owner', 'owner',
        'すべての成果物', NULL, 'private', NULL,
        '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z'
      );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, artifact_kind, visibility,
        current_version_id, view_count, created_at, updated_at,
        last_accessed_at, container_id
      ) VALUES (
        's1', 'ws-a', 'owner', NULL, 'demo.html', NULL, NULL, NULL,
        'html_page', 'private', NULL, 99,
        '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z',
        NULL, 'inbox-owner'
      );

      INSERT INTO views (
        id, shareable_id, viewer_user_id, viewed_at, user_agent_hash
      ) VALUES
        ('v1', 's1', 'viewer', '2026-06-29T00:00:00.000Z', NULL),
        ('v2', 's1', 'viewer', '2026-06-29T00:03:00.000Z', NULL);

      INSERT INTO views_anon (
        id, shareable_id, viewer_ip_hash, viewed_at, user_agent_hash
      ) VALUES (
        'a1', 's1', 'ip-hash', '2026-06-29T00:04:00.000Z', NULL
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0054_view_count_recency.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const recency = sqlite
      .prepare(
        `
          SELECT first_viewed_at, last_viewed_at, effective_view_count
          FROM shareable_viewer_recency
          WHERE shareable_id = 's1' AND viewer_user_id = 'viewer'
        `,
      )
      .get()
    expect(recency).toEqual({
      first_viewed_at: '2026-06-29T00:00:00.000Z',
      last_viewed_at: '2026-06-29T00:03:00.000Z',
      effective_view_count: 2,
    })

    const shareable = sqlite
      .prepare(`SELECT view_count FROM shareables WHERE id = 's1'`)
      .get()
    expect(shareable).toEqual({ view_count: 99 })

    const tables = sqlite
      .prepare(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('views', 'views_anon')
        `,
      )
      .all()
    expect(tables).toEqual([])
  })

  test('0058 migrates billing_meter_sends rows into billing_overage_charges as completed', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0058_billing_overage_charges.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at, stripe_customer_id
      ) VALUES
        (
          'ws-a', 'example.com', 'Workspace A', '2026-06-01T00:00:00.000Z',
          'team', 107374182400, 0, '1970-01-01T00:00:00.000Z', 'cus_a'
        ),
        (
          'ws-b', 'other.com', 'Workspace B', '2026-06-01T00:00:00.000Z',
          'team', 107374182400, 0, '1970-01-01T00:00:00.000Z', 'cus_b'
        );

      INSERT INTO billing_meter_sends (
        workspace_id, month, overage_gb_month, sent_at
      ) VALUES
        ('ws-a', '2026-05', 3, '2026-06-01T12:00:00.000Z'),
        ('ws-b', '2026-05', 0, '2026-06-01T12:30:00.000Z');
    `)

    const migration = migrations.find(
      (m) => m.name === '0058_billing_overage_charges.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const charges = sqlite
      .prepare(
        `
          SELECT
            workspace_id,
            month,
            overage_gb_month,
            status,
            stripe_invoice_item_id,
            stripe_invoice_id,
            created_at,
            processed_at
          FROM billing_overage_charges
          ORDER BY workspace_id
        `,
      )
      .all()
    expect(charges).toEqual([
      {
        workspace_id: 'ws-a',
        month: '2026-05',
        overage_gb_month: 3,
        status: 'completed',
        stripe_invoice_item_id: null,
        stripe_invoice_id: null,
        created_at: '2026-06-01T12:00:00.000Z',
        processed_at: '2026-06-01T12:00:00.000Z',
      },
      {
        workspace_id: 'ws-b',
        month: '2026-05',
        overage_gb_month: 0,
        status: 'completed',
        stripe_invoice_item_id: null,
        stripe_invoice_id: null,
        created_at: '2026-06-01T12:30:00.000Z',
        processed_at: '2026-06-01T12:30:00.000Z',
      },
    ])

    const legacyTable = sqlite
      .prepare(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'billing_meter_sends'
        `,
      )
      .get()
    expect(legacyTable).toBeUndefined()
  })

  test('0059 keeps existing workspaces self-upload enabled via default', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0059_email_otp_viewer_workspace.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES
        (
          'ws-existing', NULL, 'Existing Workspace', '2026-06-01T00:00:00.000Z',
          'free', 104857600, 0, '1970-01-01T00:00:00.000Z'
        );
    `)

    const migration = migrations.find(
      (m) => m.name === '0059_email_otp_viewer_workspace.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const workspace = sqlite
      .prepare(
        `
          SELECT self_upload_enabled, storage_quota_bytes
          FROM workspaces
          WHERE id = 'ws-existing'
        `,
      )
      .get()
    expect(workspace).toEqual({
      self_upload_enabled: 1,
      storage_quota_bytes: 104857600,
    })
  })

  test('0060 backfills workspace_members and audit_events from legacy tables', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0060_workspace_members_audit_events.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes,
        storage_used_bytes, storage_updated_at
      ) VALUES
        (
          'ws-a', 'example.com', 'Workspace A', '2026-07-01T00:00:00.000Z',
          'team', 53687091200, 0, '2026-07-01T00:00:00.000Z'
        ),
        (
          'ws-b', NULL, 'Workspace B', '2026-07-01T00:00:00.000Z',
          'free', 104857600, 0, '2026-07-01T00:00:00.000Z'
        );

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        (
          'u-admin', 'admin@example.com', 1, 'Admin', NULL,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
          'ws-a', 'sub-admin', NULL
        ),
        (
          'u-suspended', 'suspended@example.com', 1, 'Suspended', NULL,
          '2026-07-01T01:00:00.000Z', '2026-07-01T01:00:00.000Z',
          'ws-a', 'sub-suspended', NULL
        ),
        (
          'u-member', 'member@example.com', 1, 'Member', NULL,
          '2026-07-01T02:00:00.000Z', '2026-07-01T02:00:00.000Z',
          'ws-a', 'sub-member', NULL
        ),
        (
          'u-stale', 'stale@example.com', 1, 'Stale', NULL,
          '2026-07-01T03:00:00.000Z', '2026-07-01T03:00:00.000Z',
          'ws-b', 'sub-stale', NULL
        );

      INSERT INTO workspace_admins (
        workspace_id, user_id, created_at, updated_at
      ) VALUES (
        'ws-a', 'u-admin', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
      );

      INSERT INTO workspace_contributors (
        workspace_id, user_id, first_contributed_at, last_contributed_at,
        pending_uploads, upload_suspended_at, upload_suspended_by,
        created_at, updated_at
      ) VALUES
        (
          'ws-a', 'u-admin', '2026-07-01T01:00:00.000Z',
          '2026-07-01T02:00:00.000Z', 0, '2026-07-01T06:30:00.000Z', 'u-admin',
          '2026-07-01T01:00:00.000Z', '2026-07-01T06:30:00.000Z'
        ),
        (
          'ws-a', 'u-suspended', '2026-07-01T04:00:00.000Z',
          '2026-07-01T05:00:00.000Z', 2, '2026-07-01T06:00:00.000Z', 'u-admin',
          '2026-07-01T04:00:00.000Z', '2026-07-01T06:00:00.000Z'
        ),
        (
          'ws-a', 'u-stale', '2026-06-01T00:00:00.000Z',
          '2026-06-01T01:00:00.000Z', 1, NULL, NULL,
          '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z'
        );

      INSERT INTO shareable_delete_events (
        id, project_container_id, workspace_id, shareable_id, shareable_name,
        owner_user_id, deleted_by, deleted_at
      ) VALUES (
        'del-1', 'proj-1', 'ws-a', 's-deleted', 'deleted.html',
        'u-member', 'u-admin', '2026-07-01T07:00:00.000Z'
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0060_workspace_members_audit_events.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const adminMember = sqlite
      .prepare(
        `
          SELECT role, status
          FROM workspace_members
          WHERE workspace_id = 'ws-a' AND user_id = 'u-admin'
        `,
      )
      .get()
    expect(adminMember).toEqual({ role: 'admin', status: 'active' })

    const adminSuspendedFields = sqlite
      .prepare(
        `
          SELECT suspended_at
          FROM workspace_members
          WHERE workspace_id = 'ws-a' AND user_id = 'u-admin'
        `,
      )
      .get()
    expect(adminSuspendedFields).toEqual({
      suspended_at: '2026-07-01T06:30:00.000Z',
    })

    const suspendedMember = sqlite
      .prepare(
        `
          SELECT role, status, pending_uploads, suspended_at, suspended_by,
                 first_contributed_at, last_contributed_at
          FROM workspace_members
          WHERE workspace_id = 'ws-a' AND user_id = 'u-suspended'
        `,
      )
      .get()
    expect(suspendedMember).toEqual({
      role: 'member',
      status: 'suspended',
      pending_uploads: 2,
      suspended_at: '2026-07-01T06:00:00.000Z',
      suspended_by: 'u-admin',
      first_contributed_at: '2026-07-01T04:00:00.000Z',
      last_contributed_at: '2026-07-01T05:00:00.000Z',
    })

    const staleInOldWorkspace = sqlite
      .prepare(
        `
          SELECT 1 AS found
          FROM workspace_members
          WHERE workspace_id = 'ws-a' AND user_id = 'u-stale'
        `,
      )
      .get()
    expect(staleInOldWorkspace).toBeUndefined()

    const staleInCurrentWorkspace = sqlite
      .prepare(
        `
          SELECT role, status, first_contributed_at, pending_uploads
          FROM workspace_members
          WHERE workspace_id = 'ws-b' AND user_id = 'u-stale'
        `,
      )
      .get()
    expect(staleInCurrentWorkspace).toEqual({
      role: 'member',
      status: 'active',
      first_contributed_at: null,
      pending_uploads: 0,
    })

    const auditEvent = sqlite
      .prepare(
        `
          SELECT id, workspace_id, actor_user_id, action, subject_type,
                 subject_id, detail, created_at
          FROM audit_events
          WHERE id = 'del-1'
        `,
      )
      .get() as {
      id: string
      workspace_id: string
      actor_user_id: string
      action: string
      subject_type: string
      subject_id: string
      detail: string
      created_at: string
    }
    expect(auditEvent).toEqual({
      id: 'del-1',
      workspace_id: 'ws-a',
      actor_user_id: 'u-admin',
      action: 'artifact.delete',
      subject_type: 'shareable',
      subject_id: 's-deleted',
      detail: JSON.stringify({
        name: 'deleted.html',
        project_container_id: 'proj-1',
        owner_user_id: 'u-member',
      }),
      created_at: '2026-07-01T07:00:00.000Z',
    })

    expect(() => {
      sqlite!.exec(`
        INSERT INTO workspace_members (
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES (
          'ws-a', 'u-member', 'admin', 'active',
          '2026-07-01T08:00:00.000Z', '2026-07-01T08:00:00.000Z'
        );
      `)
    }).toThrow()

    const cleanupMigration = migrations.find(
      (m) => m.name === '0062_remove_upload_suspension.sql',
    )
    expect(cleanupMigration).toBeDefined()
    sqlite.exec(cleanupMigration!.sql)

    const memberColumns = sqlite
      .prepare(`PRAGMA table_info(workspace_members)`)
      .all() as Array<{ name: string }>
    expect(memberColumns.map((column) => column.name)).not.toContain(
      'suspended_at',
    )
    expect(memberColumns.map((column) => column.name)).not.toContain(
      'suspended_by',
    )

    const migratedMember = sqlite
      .prepare(
        `SELECT role, status, pending_uploads, first_contributed_at
         FROM workspace_members
         WHERE workspace_id = 'ws-a' AND user_id = 'u-suspended'`,
      )
      .get()
    expect(migratedMember).toEqual({
      role: 'member',
      status: 'active',
      pending_uploads: 2,
      first_contributed_at: '2026-07-01T04:00:00.000Z',
    })

    expect(() =>
      sqlite!.exec(
        `INSERT INTO workspace_members (
           workspace_id, user_id, status, created_at, updated_at
         ) VALUES ('ws-a', 'u-member', 'suspended',
           '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z')`,
      ),
    ).toThrow()

    const indexes = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'workspace_members_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    expect(indexes.map((index) => index.name)).toEqual([
      'workspace_members_single_admin',
      'workspace_members_user',
      'workspace_members_workspace_status',
    ])
  })

  test('0063 widens workspace member roles without changing existing rows', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0063_workspace_owner_role.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (id, hd, name, created_at)
      VALUES ('ws-a', 'example.com', 'Workspace', '2026-07-14T00:00:00.000Z');
      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        ('u-admin', 'admin@example.com', 1, 'Admin', NULL,
         '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-admin', NULL),
        ('u-member', 'member@example.com', 1, 'Member', NULL,
         '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-member', NULL);
      INSERT INTO workspace_members (
        workspace_id, user_id, role, status, first_contributed_at,
        last_contributed_at, pending_uploads, removed_at, removed_by,
        created_at, updated_at
      ) VALUES
        ('ws-a', 'u-admin', 'admin', 'active', '2026-07-01T01:00:00.000Z',
         '2026-07-02T01:00:00.000Z', 3, NULL, NULL,
         '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
        ('ws-a', 'u-member', 'member', 'removed', NULL, NULL, 0,
         '2026-07-03T00:00:00.000Z', 'u-admin',
         '2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z');
    `)

    const migration = migrations.find(
      (m) => m.name === '0063_workspace_owner_role.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_members').get(),
    ).toEqual({ count: 2 })
    expect(
      sqlite
        .prepare(
          `SELECT workspace_id, user_id, role, status, first_contributed_at,
                  last_contributed_at, pending_uploads, removed_at, removed_by,
                  created_at, updated_at
           FROM workspace_members ORDER BY user_id`,
        )
        .all(),
    ).toEqual([
      {
        workspace_id: 'ws-a',
        user_id: 'u-admin',
        role: 'admin',
        status: 'active',
        first_contributed_at: '2026-07-01T01:00:00.000Z',
        last_contributed_at: '2026-07-02T01:00:00.000Z',
        pending_uploads: 3,
        removed_at: null,
        removed_by: null,
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-02T00:00:00.000Z',
      },
      {
        workspace_id: 'ws-a',
        user_id: 'u-member',
        role: 'member',
        status: 'removed',
        first_contributed_at: null,
        last_contributed_at: null,
        pending_uploads: 0,
        removed_at: '2026-07-03T00:00:00.000Z',
        removed_by: 'u-admin',
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-03T00:00:00.000Z',
      },
    ])

    expect(
      sqlite.prepare(`PRAGMA table_info(workspace_members)`).all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace_id', pk: 1 }),
        expect.objectContaining({ name: 'user_id', pk: 2 }),
      ]),
    )
    const tableSql = sqlite
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_members'`,
      )
      .get() as { sql: string }
    expect(tableSql.sql).toContain(
      "CHECK (role IN ('owner', 'admin', 'member'))",
    )

    const indexRows = sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'workspace_members_%' ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
    expect(indexRows.map((index) => index.name)).toEqual([
      'workspace_members_single_admin',
      'workspace_members_single_owner',
      'workspace_members_user',
      'workspace_members_workspace_status',
    ])
    expect(
      indexRows.find((index) => index.name === 'workspace_members_single_admin')
        ?.sql,
    ).toContain("WHERE role = 'admin'")
    expect(
      indexRows.find((index) => index.name === 'workspace_members_single_owner')
        ?.sql,
    ).toContain("WHERE role = 'owner'")
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('0064 preserves existing owners, promotes legacy admins, and allows multiple admins', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0064_workspace_owner_admins.sql') break
      sqlite.exec(migration.sql)
    }
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('ws-a', 'Legacy workspace', '2026-07-14T00:00:00.000Z'),
             ('ws-b', 'Owner workspace', '2026-07-14T00:00:00.000Z');
      INSERT INTO users (id, email, email_verified, name, image, created_at, updated_at, workspace_id, google_sub, locale)
      VALUES ('u-1', 'one@example.com', 1, 'One', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-1', NULL),
             ('u-2', 'two@example.com', 1, 'Two', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-2', NULL),
             ('u-3', 'three@example.com', 1, 'Three', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-3', NULL),
             ('u-4', 'four@example.com', 1, 'Four', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-a', 'sub-4', NULL),
             ('u-5', 'five@example.com', 1, 'Five', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-b', 'sub-5', NULL),
             ('u-6', 'six@example.com', 1, 'Six', NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', 'ws-b', 'sub-6', NULL);
      INSERT INTO workspace_members (
        workspace_id, user_id, role, status, first_contributed_at,
        last_contributed_at, pending_uploads, removed_at, removed_by,
        created_at, updated_at
      ) VALUES
        ('ws-a', 'u-1', 'admin', 'active', '2026-07-01T01:00:00.000Z',
         '2026-07-02T01:00:00.000Z', 3, NULL, NULL,
         '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
        ('ws-a', 'u-2', 'member', 'active', '2026-07-03T01:00:00.000Z',
         '2026-07-04T01:00:00.000Z', 4, NULL, NULL,
         '2026-07-03T00:00:00.000Z', '2026-07-04T00:00:00.000Z'),
        ('ws-a', 'u-3', 'member', 'active', NULL, NULL, 5, NULL, NULL,
         '2026-07-05T00:00:00.000Z', '2026-07-05T01:00:00.000Z'),
        ('ws-a', 'u-4', 'member', 'removed', '2026-07-06T01:00:00.000Z',
         '2026-07-07T01:00:00.000Z', 6, '2026-07-08T00:00:00.000Z', 'u-1',
         '2026-07-06T00:00:00.000Z', '2026-07-08T01:00:00.000Z'),
        ('ws-b', 'u-5', 'owner', 'active', NULL, NULL, 0, NULL, NULL,
         '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z'),
        ('ws-b', 'u-6', 'admin', 'active', NULL, NULL, 0, NULL, NULL,
         '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z');
    `)
    const before = sqlite
      .prepare(
        `SELECT workspace_id, user_id, role, status, first_contributed_at,
                last_contributed_at, pending_uploads, removed_at, removed_by,
                created_at, updated_at
         FROM workspace_members ORDER BY user_id`,
      )
      .all() as Array<Record<string, unknown>>
    sqlite.exec(
      migrations.find((m) => m.name === '0064_workspace_owner_admins.sql')!.sql,
    )

    const after = sqlite
      .prepare(
        `SELECT workspace_id, user_id, role, status, first_contributed_at,
                last_contributed_at, pending_uploads, removed_at, removed_by,
                created_at, updated_at
         FROM workspace_members ORDER BY user_id`,
      )
      .all() as Array<Record<string, unknown>>
    expect(after).toEqual(
      before.map((row) =>
        row.workspace_id === 'ws-a' && row.role === 'admin'
          ? { ...row, role: 'owner' }
          : row,
      ),
    )
    expect(after).toHaveLength(before.length)
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workspace_members_single_admin'",
        )
        .get(),
    ).toBeUndefined()
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workspace_members_single_owner'",
        )
        .get(),
    ).toEqual({ name: 'workspace_members_single_owner' })
    sqlite
      .prepare(
        `UPDATE workspace_members SET role = 'admin' WHERE user_id IN ('u-2', 'u-3')`,
      )
      .run()
    expect(
      sqlite
        .prepare(
          `SELECT user_id FROM workspace_members
           WHERE role = 'admin' AND status = 'active' ORDER BY user_id`,
        )
        .all(),
    ).toEqual([{ user_id: 'u-2' }, { user_id: 'u-3' }, { user_id: 'u-6' }])
    expect(() =>
      sqlite!
        .prepare(
          `UPDATE workspace_members SET role = 'owner' WHERE user_id = 'u-2'`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      sqlite!
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
           VALUES ('ws-a', 'u-2', 'member', 'active', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      sqlite!
        .prepare(
          `UPDATE workspace_members SET role = 'invalid' WHERE user_id = 'u-2'`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      sqlite!
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
           VALUES ('missing-workspace', 'u-2', 'member', 'active', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow()
    expect(() =>
      sqlite!
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
           VALUES ('ws-a', 'missing-user', 'member', 'active', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow()
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  test('0067 adds link policy columns and preserves existing link shares', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0067_link_sharing_policy.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at, plan)
      VALUES
        ('ws-plus', 'Plus', '2026-07-20T00:00:00.000Z', 'plus'),
        ('ws-team', 'Team', '2026-07-20T00:00:00.000Z', 'team'),
        ('ws-team-legacy', 'Team legacy', '2026-07-20T00:00:00.000Z', 'team'),
        ('ws-free', 'Free', '2026-07-20T00:00:00.000Z', 'free');
      INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at, workspace_id,
        google_sub
      ) VALUES (
        'u-plus', 'plus@example.com', 1, 'Plus',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'ws-plus',
        'google-plus'
      );
      INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at, workspace_id,
        google_sub
      ) VALUES (
        'u-team', 'team@example.com', 1, 'Team',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'ws-team-legacy',
        'google-team'
      );
      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, name, created_at, updated_at
      ) VALUES (
        'inbox-plus', 'ws-plus', 'inbox', 'u-plus', 'Inbox',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, name, created_at, updated_at
      ) VALUES (
        'inbox-team', 'ws-team-legacy', 'inbox', 'u-team', 'Inbox',
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (
        'legacy-link', 'ws-plus', 'u-plus', 'legacy.html', 'html_page',
        'link', '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z', 'inbox-plus'
      );
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (
        'legacy-team-link', 'ws-team-legacy', 'u-team', 'legacy.html', 'html_page',
        'link', '2026-07-20T00:00:00.000Z',
        '2026-07-20T00:00:00.000Z', 'inbox-team'
      );
    `)

    sqlite.exec(
      migrations.find((m) => m.name === '0067_link_sharing_policy.sql')!.sql,
    )

    const policies = sqlite
      .prepare(
        `SELECT id, link_sharing_enabled, external_posting_enabled,
                link_expiry_default_days, link_expiry_max_days
         FROM workspaces ORDER BY id`,
      )
      .all()
    expect(policies).toEqual([
      {
        id: 'ws-free',
        link_sharing_enabled: 0,
        external_posting_enabled: 0,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'ws-plus',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      },
      {
        id: 'ws-team',
        link_sharing_enabled: 0,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: 90,
      },
      {
        id: 'ws-team-legacy',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      },
    ])

    const link = sqlite
      .prepare(
        `SELECT link_expires_at FROM shareables WHERE id = 'legacy-link'`,
      )
      .get()
    expect(link).toEqual({ link_expires_at: null })
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%legacy%'",
        )
        .all(),
    ).toEqual([])
    expect(() =>
      sqlite!
        .prepare(
          `UPDATE workspaces SET link_expiry_default_days = NULL
           WHERE id = 'ws-team'`,
        )
        .run(),
    ).toThrow()
  })

  // 既存行を backfill しないことが正しい。可視の行はスナップショットを参照せず
  // 次の閲覧で埋まり、すでに権限を失っている行へ現在値を入れると失効後の改名が
  // 恒久的に見えてしまうため、移行済みの状態を明示する。
  test('0074 adds recency snapshot columns without backfilling existing rows', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')

    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0074_recency_view_snapshots.sql') break
      sqlite.exec(migration.sql)
    }

    sqlite.exec(`
      INSERT INTO workspaces (id, hd, name, created_at)
      VALUES ('ws-a', 'example.com', 'Workspace', '2026-06-29T00:00:00.000Z');

      INSERT INTO users (
        id, email, email_verified, name, image, created_at, updated_at,
        workspace_id, google_sub, locale
      ) VALUES
        ('owner', 'owner@example.com', 1, 'Snapshot Owner', NULL,
         '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', 'ws-a', 'sub-owner', NULL),
        ('viewer', 'viewer@example.com', 1, 'Viewer', NULL,
         '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', 'ws-a', 'sub-viewer', NULL);

      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        description, base_visibility, archived_at, created_at, updated_at
      ) VALUES (
        'inbox-owner', 'ws-a', 'inbox', 'owner', 'owner', 'Inbox', NULL,
        'private', NULL, '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z'
      );

      INSERT INTO shareables (
        id, workspace_id, owner_user_id, slug, name, derived_title,
        title_override, description, artifact_kind, visibility,
        current_version_id, created_at, updated_at, last_accessed_at, container_id
      ) VALUES (
        's1', 'ws-a', 'owner', NULL, 'file.html', 'Derived snapshot', NULL,
        NULL, 'html_page', 'private', NULL,
        '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', NULL, 'inbox-owner'
      );

      INSERT INTO shareable_viewer_recency (
        shareable_id, viewer_user_id, first_viewed_at, last_viewed_at,
        effective_view_count
      ) VALUES (
        's1', 'viewer', '2026-06-29T00:00:00.000Z', '2026-06-29T00:01:00.000Z', 1
      );
    `)

    const migration = migrations.find(
      (m) => m.name === '0074_recency_view_snapshots.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    const recency = sqlite
      .prepare(
        `
          SELECT viewed_title, viewed_owner_name
          FROM shareable_viewer_recency
          WHERE shareable_id = 's1' AND viewer_user_id = 'viewer'
        `,
      )
      .get()
    expect(recency).toEqual({
      viewed_title: null,
      viewed_owner_name: null,
    })
  })

  test('0075 backfills both seen boundaries from last_viewed_at', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    const migrations = loadMigrations()
    for (const migration of migrations) {
      if (migration.name === '0075_recency_seen_boundaries.sql') break
      sqlite.exec(migration.sql)
    }
    sqlite.exec(`
      INSERT INTO workspaces (id, hd, name, created_at)
      VALUES ('ws-a', 'example.com', 'Workspace', '2026-06-29T00:00:00.000Z');
      INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at,
        workspace_id, google_sub, locale
      )
      VALUES
        ('owner', 'owner@example.com', 1, 'Owner', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', 'ws-a', 'sub-owner', NULL),
        ('viewer', 'viewer@example.com', 1, 'Viewer', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', 'ws-a', 'sub-viewer', NULL);
      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        base_visibility, created_at, updated_at
      ) VALUES (
        'inbox-owner', 'ws-a', 'inbox', 'owner', 'owner', 'Inbox',
        'private', '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z'
      );
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (
        's1', 'ws-a', 'owner', 'file.html', 'html_page', 'private',
        '2026-06-29T00:00:00.000Z', '2026-06-29T00:00:00.000Z', 'inbox-owner'
      );
      INSERT INTO shareable_viewer_recency (
        shareable_id, viewer_user_id, first_viewed_at, last_viewed_at
      ) VALUES (
        's1', 'viewer', '2026-06-29T00:00:00.000Z', '2026-06-29T00:01:00.000Z'
      );
    `)
    const migration = migrations.find(
      (item) => item.name === '0075_recency_seen_boundaries.sql',
    )
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)
    expect(
      sqlite
        .prepare(`SELECT version_seen_through_at, comment_seen_through_at
          FROM shareable_viewer_recency WHERE shareable_id = 's1'`)
        .get(),
    ).toEqual({
      version_seen_through_at: '2026-06-29T00:01:00.000Z',
      comment_seen_through_at: '2026-06-29T00:01:00.000Z',
    })
  })
})

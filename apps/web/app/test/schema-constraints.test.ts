import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { currentSchemaSources } from './sqlite-fixture'

type SqlValue = string | number | null

const AT = '2026-09-01T00:00:00.000Z'

function requiresGoogleSub(sqlite: DatabaseSync) {
  return (
    sqlite
      .prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?")
      .get('google_sub') !== undefined
  )
}

function insert(
  sqlite: DatabaseSync,
  table: string,
  row: Record<string, SqlValue>,
) {
  const columns = Object.keys(row)
  sqlite
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row))
}

function insertUser(
  sqlite: DatabaseSync,
  user: {
    id: string
    name?: string
    kind?: 'human' | 'bot'
    workspaceId?: string
  },
) {
  insert(sqlite, 'users', {
    id: user.id,
    email: `${user.id}@example.test`,
    name: user.name ?? user.id,
    created_at: AT,
    updated_at: AT,
    workspace_id: user.workspaceId ?? 'ws1',
    kind: user.kind ?? 'human',
    ...(requiresGoogleSub(sqlite) ? { google_sub: `sub-${user.id}` } : {}),
  })
}

function seedWorkspace(sqlite: DatabaseSync) {
  insert(sqlite, 'workspaces', { id: 'ws1', name: 'Workspace', created_at: AT })
  insertUser(sqlite, { id: 'u1' })
  insert(sqlite, 'artifact_containers', {
    id: 'c1',
    workspace_id: 'ws1',
    kind: 'inbox',
    owner_user_id: 'u1',
    created_by_id: 'u1',
    name: 'Inbox',
    created_at: AT,
    updated_at: AT,
  })
}

function insertShareable(
  sqlite: DatabaseSync,
  shareable: {
    id: string
    visibility?: string
    createdAt?: string
    ownerId?: string
    workspaceId?: string
    containerId?: string
    artifactKind?: string
  },
) {
  const at = shareable.createdAt ?? AT
  insert(sqlite, 'shareables', {
    id: shareable.id,
    workspace_id: shareable.workspaceId ?? 'ws1',
    owner_user_id: shareable.ownerId ?? 'u1',
    name: shareable.id,
    artifact_kind: shareable.artifactKind ?? 'html_page',
    visibility: shareable.visibility ?? 'private',
    container_id: shareable.containerId ?? 'c1',
    created_at: at,
    updated_at: at,
  })
}

function insertVersion(
  sqlite: DatabaseSync,
  version: {
    id: string
    shareableId?: string
    status?: string
    createdAt?: string
    publishedAt?: string | null
    publisherClientId?: string | null
    artifactKind?: string
  },
) {
  const status = version.status ?? 'published'
  insert(sqlite, 'versions', {
    id: version.id,
    shareable_id: version.shareableId ?? 's1',
    artifact_kind: version.artifactKind ?? 'html_page',
    status,
    entrypoint_path: '/index.html',
    r2_key: `artifacts/${version.id}/index.html`,
    size_bytes: 12,
    sha256: `hash-${version.id}`,
    created_by_id: 'u1',
    created_by_publisher_client_id: version.publisherClientId ?? null,
    created_at: version.createdAt ?? AT,
    published_at:
      version.publishedAt === undefined
        ? status === 'published'
          ? (version.createdAt ?? AT)
          : null
        : version.publishedAt,
  })
}

function insertEvent(
  sqlite: DatabaseSync,
  event: {
    id: string
    type: string
    actor?: string | null
    subject?: string | null
    payload?: string | null
  },
) {
  insert(sqlite, 'events', {
    id: event.id,
    workspace_id: 'ws1',
    type: event.type,
    shareable_id: 's1',
    actor_user_id: event.actor ?? null,
    subject_id: event.subject === undefined ? event.id : event.subject,
    payload: event.payload ?? null,
    created_at: AT,
  })
}

function insertJudgment(
  sqlite: DatabaseSync,
  judgment: { id: string; trigger: string; risk: string },
) {
  insert(sqlite, 'link_abuse_judgments', {
    id: judgment.id,
    shareable_id: 's1',
    trigger: judgment.trigger,
    risk: judgment.risk,
    reason: 'reason',
    external_targets: '[]',
    provider: 'provider',
    model: 'model',
    created_at: AT,
  })
}

function insertAnchor(
  sqlite: DatabaseSync,
  anchor: {
    id: string
    threadId: string
    versionId?: string | null
    page?: number | string | null
  },
) {
  insert(sqlite, 'comment_anchors', {
    id: anchor.id,
    thread_id: anchor.threadId,
    version_id: anchor.versionId ?? 'v1',
    target_path: '/deck.pdf',
    quoted_text: 'quote',
    prefix_text: '',
    suffix_text: '',
    text_start: 0,
    text_end: 5,
    created_at: AT,
    page_number: anchor.page ?? null,
  })
}

function count(sqlite: DatabaseSync, sql: string) {
  return (sqlite.prepare(sql).get() as { n: number }).n
}

describe.each(currentSchemaSources)('constraints (%s)', (_name, create) => {
  let sqlite: DatabaseSync

  beforeEach(() => {
    sqlite = create()
    seedWorkspace(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  test('refuses an unknown artifact visibility on insert and on update', () => {
    insertShareable(sqlite, { id: 's1', visibility: 'workspace' })
    expect(() =>
      insertShareable(sqlite, { id: 's2', visibility: 'public' }),
    ).toThrow()
    expect(() =>
      sqlite.exec(
        "UPDATE shareables SET visibility = 'public' WHERE id = 's1'",
      ),
    ).toThrow()
    sqlite.exec("UPDATE shareables SET visibility = 'link' WHERE id = 's1'")
  })

  test('accepts only published MCP post actions and clears them with the artifact', () => {
    insertShareable(sqlite, { id: 's1' })
    const post = (id: string, action: string) =>
      insert(sqlite, 'mcp_artifact_posts', {
        id,
        shareable_id: 's1',
        user_id: 'u1',
        workspace_id: 'ws1',
        action,
        content_hash: `hash-${id}`,
        created_at: AT,
      })
    post('post-1', 'publish')
    expect(() => post('post-2', 'delete')).toThrow()
    sqlite.exec("DELETE FROM shareables WHERE id = 's1'")
    expect(count(sqlite, 'SELECT COUNT(*) AS n FROM mcp_artifact_posts')).toBe(
      0,
    )
  })

  test('fixes a member kind at creation', () => {
    insertUser(sqlite, { id: 'b1', kind: 'bot', name: 'Deploy' })
    expect(() =>
      sqlite.exec("UPDATE users SET kind = 'bot' WHERE id = 'u1'"),
    ).toThrow()
    expect(() =>
      sqlite.exec("UPDATE users SET kind = 'human' WHERE id = 'b1'"),
    ).toThrow()
    sqlite.exec("UPDATE users SET name = 'Renamed' WHERE id = 'u1'")
  })

  test('holds a bot name until the bot stops', () => {
    insertUser(sqlite, { id: 'b1', kind: 'bot', name: 'Deploy' })
    expect(() =>
      insertUser(sqlite, { id: 'b2', kind: 'bot', name: 'Deploy' }),
    ).toThrow()
    insertUser(sqlite, { id: 'u2', name: 'Deploy' })
    sqlite.exec(`UPDATE users SET bot_stopped_at = '${AT}' WHERE id = 'b1'`)
    insertUser(sqlite, { id: 'b3', kind: 'bot', name: 'Deploy' })
  })

  test('keeps API tokens and unrestricted CLI families away from bots', () => {
    insertUser(sqlite, { id: 'b1', kind: 'bot', name: 'Deploy' })
    const token = (id: string, userId: string) =>
      insert(sqlite, 'api_tokens', {
        id,
        user_id: userId,
        name: 'ci',
        token_hash: `hash-${id}`,
        created_at: AT,
      })
    expect(() => token('t1', 'b1')).toThrow()
    token('t2', 'u1')
    expect(() =>
      sqlite.exec("UPDATE api_tokens SET user_id = 'b1' WHERE id = 't2'"),
    ).toThrow()
    expect(() =>
      insert(sqlite, 'cli_family_authorities', {
        family_id: 'f1',
        user_id: 'b1',
        preset: 'unrestricted',
        status: 'active',
        created_at: AT,
        updated_at: AT,
      }),
    ).toThrow()
  })

  test('keeps active project names unique per workspace', () => {
    const project = (id: string, name: string, archivedAt: string | null) =>
      insert(sqlite, 'artifact_containers', {
        id,
        workspace_id: 'ws1',
        kind: 'project',
        created_by_id: 'u1',
        name,
        archived_at: archivedAt,
        created_at: AT,
        updated_at: AT,
      })
    project('p1', 'Launch', null)
    expect(() => project('p2', 'launch', null)).toThrow()
    project('p3', 'launch', AT)
  })

  test('stores device project selectors trimmed and within the project-name limit', () => {
    const selector = (id: string, value: string) =>
      insert(sqlite, 'deviceCode', {
        id,
        deviceCode: `device-${id}`,
        userCode: `CODE${id}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
        status: 'pending',
        requestedProjectSelector: value,
      })
    selector('dc1', '界'.repeat(120))
    expect(() => selector('dc2', '界'.repeat(121))).toThrow()
    expect(() => selector('dc3', ' Reports ')).toThrow()
  })

  test('requires a payload and the matching actor for link-safety events', () => {
    insertShareable(sqlite, { id: 's1', visibility: 'link' })
    insertEvent(sqlite, {
      id: 'visibility',
      type: 'visibility_changed',
      actor: 'u1',
      payload: '{"from":"private","to":"link"}',
    })
    insertEvent(sqlite, {
      id: 'reported',
      type: 'link_reported',
      payload: '{"reason":"phishing"}',
    })
    insertEvent(sqlite, {
      id: 'appealed',
      type: 'link_appealed',
      actor: 'u1',
      payload: '{"note":"mine"}',
    })
    insertEvent(sqlite, {
      id: 'viewed',
      type: 'artifact_viewed',
      subject: null,
    })

    expect(() =>
      insertEvent(sqlite, {
        id: 'unparsable',
        type: 'link_reported',
        payload: 'not-json',
      }),
    ).toThrow()
    expect(() =>
      insertEvent(sqlite, { id: 'no-payload', type: 'link_suspended' }),
    ).toThrow()
    for (const type of ['link_reported', 'link_suspended', 'link_resumed'])
      expect(() =>
        insertEvent(sqlite, {
          id: `operator-${type}`,
          type,
          actor: 'u1',
          payload: '{"reason":"other"}',
        }),
      ).toThrow()
    expect(() =>
      insertEvent(sqlite, {
        id: 'anonymous-appeal',
        type: 'link_appealed',
        payload: '{"note":"mine"}',
      }),
    ).toThrow()
  })

  test('keeps one anchor result per version path and drops them with the thread', () => {
    insertShareable(sqlite, { id: 's1' })
    insertVersion(sqlite, { id: 'v1' })
    insert(sqlite, 'comment_threads', {
      id: 't1',
      shareable_id: 's1',
      status: 'open',
      created_by_id: 'u1',
      created_at: AT,
      updated_at: AT,
    })
    insertAnchor(sqlite, { id: 'a1', threadId: 't1' })
    const result = (overrides: Partial<Record<string, SqlValue>> = {}) =>
      insert(sqlite, 'comment_anchor_results', {
        anchor_id: 'a1',
        version_id: 'v1',
        target_path: '/index.html',
        state: 'attached',
        hint_start: 1,
        hint_end: 5,
        text_hash: 'a'.repeat(64),
        frame_token: 'b'.repeat(64),
        generation: 1,
        updated_at: AT,
        ...overrides,
      })
    result()
    expect(() => result()).toThrow()
    expect(() =>
      result({
        target_path: '/other.html',
        hint_start: null,
        hint_end: null,
        text_hash: null,
      }),
    ).toThrow()
    expect(() => result({ version_id: 'missing' })).toThrow()

    const plan = sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM comment_anchor_results WHERE version_id = ?',
      )
      .all('v1') as Array<{ detail: string }>
    expect(plan.map((step) => step.detail).join('\n')).toContain('USING INDEX')

    sqlite.exec("DELETE FROM comment_threads WHERE id = 't1'")
    expect(
      count(sqlite, 'SELECT COUNT(*) AS n FROM comment_anchor_results'),
    ).toBe(0)
  })

  test('bounds stored PDF pages and keeps anchors when their version is deleted', () => {
    insertShareable(sqlite, { id: 's1', artifactKind: 'pdf' })
    insertVersion(sqlite, { id: 'v1', artifactKind: 'pdf' })
    for (const id of ['t1', 't2', 't3'])
      insert(sqlite, 'comment_threads', {
        id,
        shareable_id: 's1',
        status: 'open',
        created_by_id: 'u1',
        created_at: AT,
        updated_at: AT,
      })
    insertAnchor(sqlite, { id: 'a1', threadId: 't1' })
    insertAnchor(sqlite, { id: 'a2', threadId: 't2', page: 12 })
    for (const page of [0, 100_001, 1.5, 'twelve'])
      expect(() =>
        insertAnchor(sqlite, { id: 'a3', threadId: 't3', page }),
      ).toThrow()

    insertVersion(sqlite, { id: 'v2', artifactKind: 'pdf', createdAt: AT })
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v2' WHERE id = 's1'",
    )
    sqlite.exec("DELETE FROM versions WHERE id = 'v1'")
    expect(
      sqlite
        .prepare(
          'SELECT id, version_id, page_number FROM comment_anchors ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'a1', version_id: null, page_number: null },
      { id: 'a2', version_id: null, page_number: 12 },
    ])
  })

  test('bounds version labels', () => {
    insertShareable(sqlite, { id: 's1' })
    insertVersion(sqlite, { id: 'v1' })
    const label = sqlite.prepare('UPDATE versions SET label = ? WHERE id = ?')
    for (const invalid of ['', 'a'.repeat(81)])
      expect(() => label.run(invalid, 'v1')).toThrow()
    label.run('😀'.repeat(80), 'v1')
    expect(sqlite.prepare('SELECT label FROM versions').get()).toEqual({
      label: '😀'.repeat(80),
    })
    label.run(null, 'v1')
  })

  test('never reuses a version number and bounds the retained count', () => {
    insertShareable(sqlite, { id: 's1' })
    insertVersion(sqlite, { id: 'v1' })
    insertVersion(sqlite, { id: 'v2' })
    insertVersion(sqlite, { id: 'pending', status: 'uploading' })
    expect(
      sqlite.prepare('SELECT id, number FROM versions ORDER BY id').all(),
    ).toEqual([
      { id: 'pending', number: null },
      { id: 'v1', number: 1 },
      { id: 'v2', number: 2 },
    ])

    sqlite.exec("DELETE FROM versions WHERE id IN ('v1', 'v2')")
    sqlite.exec(
      `UPDATE versions SET status = 'published', published_at = '${AT}' WHERE id = 'pending'`,
    )
    expect(
      sqlite.prepare("SELECT number FROM versions WHERE id = 'pending'").get(),
    ).toEqual({ number: 3 })

    const retain = sqlite.prepare('UPDATE shareables SET retain_versions = ?')
    for (const invalid of [0, -1, 1.5, 'invalid'])
      expect(() => retain.run(invalid)).toThrow()
    retain.run(1)
    retain.run(null)
  })

  test('keeps a retention tombstone until its artifact is deleted', () => {
    insertShareable(sqlite, { id: 's1' })
    insertVersion(sqlite, { id: 'v1' })
    const tombstone = () =>
      insert(sqlite, 'version_retention_tombstones', {
        version_id: 'v1',
        shareable_id: 's1',
        version_number: 1,
        removed_at: AT,
      })
    tombstone()
    expect(() => tombstone()).toThrow()
    sqlite.exec("DELETE FROM versions WHERE id = 'v1'")
    expect(
      sqlite
        .prepare('SELECT version_id FROM version_retention_tombstones')
        .all(),
    ).toEqual([{ version_id: 'v1' }])
    sqlite.exec("DELETE FROM shareables WHERE id = 's1'")
    expect(
      count(sqlite, 'SELECT COUNT(*) AS n FROM version_retention_tombstones'),
    ).toBe(0)
  })

  test('holds a link publication attempt until it is consumed', () => {
    const attempt = (shareableId: string, dailyLimit: number) =>
      insert(sqlite, 'link_publication_attempts', {
        workspace_id: 'ws1',
        shareable_id: shareableId,
        published_at: AT,
        window_start: '2026-08-31T00:00:00.000Z',
        daily_limit: dailyLimit,
        limit_applies: 0,
      })
    expect(() => attempt('s-negative', -1)).toThrow()
    attempt('s1', 20)
    expect(() =>
      sqlite.exec(
        'UPDATE link_publication_attempts SET requested_grants_present = 0',
      ),
    ).toThrow()
    expect(() => sqlite.exec('DELETE FROM link_publication_attempts')).toThrow()
    sqlite.exec(
      'UPDATE link_publication_attempts SET consumed = 1; DELETE FROM link_publication_attempts',
    )
    expect(
      count(sqlite, 'SELECT COUNT(*) AS n FROM link_publication_attempts'),
    ).toBe(0)
  })

  test('records a link publication without an attempt and keeps it after deletion', () => {
    insertShareable(sqlite, { id: 'created-link', visibility: 'link' })
    insertShareable(sqlite, { id: 'transitioned' })
    sqlite.exec(
      `UPDATE shareables SET visibility = 'link', updated_at = '2026-09-02T00:00:00.000Z' WHERE id = 'transitioned'`,
    )
    sqlite.exec("DELETE FROM shareables WHERE id = 'created-link'")
    expect(
      sqlite
        .prepare('SELECT shareable_id FROM link_publications ORDER BY 1')
        .all(),
    ).toEqual([
      { shareable_id: 'created-link' },
      { shareable_id: 'transitioned' },
    ])
    expect(
      count(sqlite, 'SELECT COUNT(*) AS n FROM link_publication_attempts'),
    ).toBe(0)

    insert(sqlite, 'workspaces', {
      id: 'ws2',
      name: 'Cascade',
      created_at: AT,
    })
    insert(sqlite, 'link_publications', {
      workspace_id: 'ws2',
      shareable_id: 'deleted-elsewhere',
      latest_published_at: AT,
    })
    sqlite.exec("DELETE FROM workspaces WHERE id = 'ws2'")
    expect(
      count(
        sqlite,
        "SELECT COUNT(*) AS n FROM link_publications WHERE workspace_id = 'ws2'",
      ),
    ).toBe(0)
  })

  test('reserves a link-published id for 24 hours after deletion', () => {
    insertShareable(sqlite, {
      id: 'reused',
      visibility: 'link',
      createdAt: '2026-09-08T01:00:00.000Z',
    })
    sqlite.exec("DELETE FROM shareables WHERE id = 'reused'")
    expect(() =>
      insertShareable(sqlite, {
        id: 'reused',
        createdAt: '2026-09-09T00:59:59.999Z',
      }),
    ).toThrow()
    insertShareable(sqlite, {
      id: 'reused',
      createdAt: '2026-09-09T01:00:00.000Z',
    })
    expect(
      sqlite
        .prepare("SELECT created_at FROM shareables WHERE id = 'reused'")
        .get(),
    ).toEqual({ created_at: '2026-09-09T01:00:00.000Z' })
  })

  test('bounds link-abuse judgments and clears them with the artifact', () => {
    insertShareable(sqlite, { id: 's1', visibility: 'link' })
    insertJudgment(sqlite, {
      id: 'j1',
      trigger: 'publish_burst',
      risk: 'high',
    })
    expect(() =>
      insertJudgment(sqlite, { id: 'j2', trigger: 'unknown', risk: 'high' }),
    ).toThrow()
    expect(() =>
      insertJudgment(sqlite, { id: 'j3', trigger: 'manual', risk: 'critical' }),
    ).toThrow()

    const gate = (kind: string) =>
      insert(sqlite, 'link_abuse_judgment_gates', {
        shareable_id: 's1',
        kind,
        expires_at: AT,
      })
    gate('automatic')
    expect(() => gate('automatic')).toThrow()
    expect(() => gate('scheduled')).toThrow()

    insert(sqlite, 'anonymous_view_signals', {
      id: 'signal-1',
      shareable_id: 's1',
      workspace_id: 'ws1',
      viewed_at: AT,
    })
    sqlite.exec("DELETE FROM shareables WHERE id = 's1'")
    for (const table of [
      'link_abuse_judgments',
      'link_abuse_judgment_gates',
      'anonymous_view_signals',
    ])
      expect(count(sqlite, `SELECT COUNT(*) AS n FROM ${table}`)).toBe(0)
  })

  test('mirrors artifact activity except for publisher version pointers', () => {
    sqlite.exec('PRAGMA recursive_triggers = ON')
    insert(sqlite, 'publisher_clients', {
      id: 'pc1',
      user_id: 'u1',
      workspace_id: 'ws1',
      name: 'Reports',
      created_at: AT,
    })
    insertShareable(sqlite, { id: 's1', createdAt: '2026-09-02T00:00:00.000Z' })
    const activity = () =>
      sqlite
        .prepare("SELECT activity_at FROM shareables WHERE id = 's1'")
        .get() as { activity_at: string }
    expect(activity()).toEqual({ activity_at: '2026-09-02T00:00:00.000Z' })

    insertVersion(sqlite, { id: 'machine1', publisherClientId: 'pc1' })
    insertVersion(sqlite, { id: 'human1' })
    const point = (versionId: string, at: string) =>
      sqlite
        .prepare(
          'UPDATE shareables SET current_version_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(versionId, at, 's1')

    point('machine1', '2026-09-03T00:00:00.000Z')
    expect(activity()).toEqual({ activity_at: '2026-09-02T00:00:00.000Z' })
    point('human1', '2026-09-04T00:00:00.000Z')
    expect(activity()).toEqual({ activity_at: '2026-09-04T00:00:00.000Z' })
    sqlite.exec(
      `UPDATE shareables SET name = 'Renamed', updated_at = '2026-09-05T00:00:00.000Z' WHERE id = 's1'`,
    )
    expect(activity()).toEqual({ activity_at: '2026-09-05T00:00:00.000Z' })
  })

  test('ties a publisher client to publisher authorities only', () => {
    insert(sqlite, 'publisher_clients', {
      id: 'pc1',
      user_id: 'u1',
      workspace_id: 'ws1',
      name: 'Reports',
      created_at: AT,
    })
    expect(() =>
      insert(sqlite, 'publisher_clients', {
        id: 'pc2',
        user_id: 'u1',
        workspace_id: 'ws1',
        name: 'Reports',
        created_at: AT,
      }),
    ).toThrow()

    const authority = (overrides: Partial<Record<string, SqlValue>>) =>
      insert(sqlite, 'cli_family_authorities', {
        family_id: 'f1',
        user_id: 'u1',
        preset: 'publisher',
        workspace_id: 'ws1',
        publisher_client_id: 'pc1',
        status: 'active',
        created_at: AT,
        updated_at: AT,
        ...overrides,
      })
    expect(() => authority({ publisher_client_id: null })).toThrow()
    expect(() => authority({ workspace_id: null })).toThrow()
    expect(() =>
      authority({ preset: 'unrestricted', workspace_id: null }),
    ).toThrow()
    authority({})
    expect(() =>
      sqlite.exec("DELETE FROM publisher_clients WHERE id = 'pc1'"),
    ).toThrow()
  })
})

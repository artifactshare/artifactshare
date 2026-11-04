import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { getArtifactVersions } from './artifact-versions.server'
import { loadArtifactVersionSummaries } from './artifact-version-summary.server'
import { getCliArtifactReadback } from './artifact-readback-service.server'
import { listCliArtifacts } from './cli-artifacts.server'
import type { SessionUser } from '~/lib/user'
vi.mock('cloudflare:workers', () => ({ env: {} }))
const source = vi.hoisted(() => vi.fn())
vi.mock('./content.server', () => ({ fetchArtifactSource: source }))
let fixture: ReturnType<typeof createMigratedInMemoryDb>
const user = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'u1@example.com',
  emailVerified: true,
} as SessionUser
beforeEach(() => {
  source
    .mockReset()
    .mockResolvedValue({ kind: 'ok', body: 'hello', sizeBytes: 5 })
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id,name,created_at) VALUES ('ws1','One','2026-01-01');
    INSERT INTO users (id,email,email_verified,name,workspace_id,created_at,updated_at)
    VALUES ('u1','u1@example.com',1,'User','ws1','2026-01-01','2026-01-01');
    INSERT INTO artifact_containers (id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at) VALUES ('home','ws1','inbox','u1','u1','Home','2026-01-01','2026-01-01');
  `)
  for (const [id, kind] of [
    ['html', 'html_page'],
    ['md', 'markdown_page'],
    ['site', 'static_site'],
    ['empty', 'html_page'],
  ]) {
    fixture.sqlite
      .prepare(
        `INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,created_at,updated_at,container_id,retain_versions) VALUES (?, 'ws1','u1','Artifact',?,'private','2026-01-01','2026-01-01','home',?)`,
      )
      .run(id!, kind!, id === 'site' ? 3 : null)
    if (id === 'empty') continue
    for (let i = 0; i < 53; i++) {
      fixture.sqlite
        .prepare(
          `INSERT INTO versions (id,shareable_id,status,artifact_kind,r2_key,size_bytes,created_at,created_by_id,entrypoint_path,sha256,published_at) VALUES (?, ?, ?, ?, 'fixture', ?, '2026-01-01T00:00:00Z', 'u1','index.html','hash','2026-01-01T00:00:00Z')`,
        )
        .run(
          `${id}-${String(i).padStart(2, '0')}`,
          id!,
          i === 0 ? 'draft' : 'published',
          kind!,
          i + 1,
        )
    }
    fixture.sqlite
      .prepare('UPDATE shareables SET current_version_id = ? WHERE id = ?')
      .run(`${id}-52`, id!)
  }
})
afterEach(async () => {
  await fixture.db.destroy()
})

test('summaries count all surviving statuses, unlimited policies and empty histories', async () => {
  const summary = await loadArtifactVersionSummaries(
    fixture.db,
    ['html', 'md', 'site', 'empty'],
    user.id,
  )
  for (const id of ['html', 'md', 'site'])
    expect(summary.get(id)).toEqual({
      retain_versions: id === 'site' ? 3 : null,
      version_count: 53,
      total_size_bytes: 1431,
    })
  expect(summary.get('empty')).toEqual({
    retain_versions: null,
    version_count: 0,
    total_size_bytes: 0,
  })
  expect(source).not.toHaveBeenCalled()
})

for (const id of ['html', 'md', 'site'])
  test(`${id} history traverses timestamp ties without source reads`, async () => {
    const first = await getArtifactVersions(fixture.db, user, { id })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') throw new Error('expected history')
    expect(first.data.versions).toHaveLength(50)
    expect(first.data.versions[0]).toMatchObject({
      version_id: `${id}-52`,
      size_bytes: 53,
      is_current: true,
    })
    expect(first.data).toMatchObject({
      version_count: 53,
      total_size_bytes: 1431,
      has_more: true,
    })
    const second = await getArtifactVersions(fixture.db, user, {
      id,
      cursor: first.data.next_cursor!,
    })
    if (second.kind !== 'ok') throw new Error('expected second page')
    expect(second.data.versions).toHaveLength(3)
    expect(second.data.has_more).toBe(false)
    expect(
      new Set(
        [...first.data.versions, ...second.data.versions].map(
          (v) => v.version_id,
        ),
      ).size,
    ).toBe(53)
    expect(second.data.versions.every((v) => !v.is_current)).toBe(true)
    expect(
      await getArtifactVersions(fixture.db, user, {
        id: 'empty',
        cursor: first.data.next_cursor!,
      }),
    ).toEqual({ kind: 'not-found' })
    expect(
      await getArtifactVersions(fixture.db, user, {
        id: id === 'html' ? 'site' : 'html',
        cursor: first.data.next_cursor!,
      }),
    ).toEqual({ kind: 'invalid-cursor' })
    expect(
      await getArtifactVersions(fixture.db, user, { id, cursor: 'bad' }),
    ).toEqual({ kind: 'invalid-cursor' })
    expect(source).not.toHaveBeenCalled()
  })

test('static get is metadata-only and rejects source selections and includes', async () => {
  const args = {
    id: 'site',
    baseUrl: 'https://example.com',
    allowStaticMetadata: true,
  }
  expect(
    await getCliArtifactReadback(fixture.db, user, {
      id: 'site',
      baseUrl: 'https://example.com',
    }),
  ).toEqual({ kind: 'unsupported-kind', artifactKind: 'static_site' })
  const result = await getCliArtifactReadback(fixture.db, user, args)
  expect(result).toMatchObject({
    kind: 'ok',
    data: {
      artifact_kind: 'static_site',
      retain_versions: 3,
      version_count: 53,
      total_size_bytes: 1431,
    },
  })
  if (result.kind === 'ok') expect(result.data).not.toHaveProperty('content')
  expect(
    await getCliArtifactReadback(fixture.db, user, { ...args, offset: 0 }),
  ).toEqual({ kind: 'invalid-offset' })
  expect(
    await getCliArtifactReadback(fixture.db, user, {
      ...args,
      version_id: 'site-01',
    }),
  ).toMatchObject({ kind: 'unsupported-kind' })
  expect(
    await getCliArtifactReadback(fixture.db, user, {
      ...args,
      include: ['versions'],
    }),
  ).toMatchObject({ kind: 'unsupported-kind' })
  expect(source).not.toHaveBeenCalled()
})

test('single-file get summaries are independent of selected source', async () => {
  const result = await getCliArtifactReadback(fixture.db, user, {
    id: 'html',
    baseUrl: 'https://example.com',
    version_id: 'html-01',
  })
  expect(result).toMatchObject({
    kind: 'ok',
    data: {
      version_id: 'html-01',
      content: 'hello',
      version_count: 53,
      total_size_bytes: 1431,
      retain_versions: null,
    },
  })
})

test('unauthorized and missing history are concealed before cursor validation', async () => {
  for (const id of ['missing', 'site'])
    expect(
      await getArtifactVersions(
        fixture.db,
        { ...user, id: 'other' },
        { id, cursor: 'bad' },
      ),
    ).toEqual({ kind: 'not-found' })
  expect(source).not.toHaveBeenCalled()
})

test('list includes batched summaries including zero-history rows', async () => {
  const result = await listCliArtifacts(fixture.db, user, {
    includeVersionSummaries: true,
    baseUrl: 'https://example.com',
  })
  if (result.kind !== 'ok') throw new Error('expected list')
  expect(result.data.artifacts.find((row) => row.id === 'site')).toMatchObject({
    retain_versions: 3,
    version_count: 53,
    total_size_bytes: 1431,
  })
  expect(result.data.artifacts.find((row) => row.id === 'empty')).toMatchObject(
    { retain_versions: null, version_count: 0, total_size_bytes: 0 },
  )
  expect(source).not.toHaveBeenCalled()
})

test('shared viewers can read history with creator emails redacted', async () => {
  fixture.sqlite
    .exec(`INSERT INTO workspaces (id,name,created_at) VALUES ('ws2','Two','2026-01-01');
    INSERT INTO users (id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES ('u2','u2@example.com',1,'Reader','ws2','2026-01-01','2026-01-01');
    INSERT INTO shareable_grants (shareable_id,granted_email,granted_at,granted_by) VALUES ('site','u2@example.com','2026-01-01','u1');`)
  fixture.sqlite.exec(`
    INSERT INTO publisher_clients (id,user_id,workspace_id,name,created_at)
    VALUES ('pub1','u1','ws1','Publisher','2026-01-01');
    UPDATE versions SET created_by_publisher_client_id = 'pub1' WHERE id = 'site-52';
    UPDATE versions SET published_at = NULL WHERE id = 'site-01';
    UPDATE users SET name = NULL WHERE id = 'u1';
  `)
  const result = await getArtifactVersions(
    fixture.db,
    { ...user, id: 'u2', workspaceId: 'ws2', email: 'u2@example.com' },
    { id: 'site' },
  )
  if (result.kind !== 'ok') throw new Error('expected shared history')
  expect(result.data).toMatchObject({
    version_count: 51,
    total_size_bytes: 1428,
  })
  const readback = await getCliArtifactReadback(
    fixture.db,
    { ...user, id: 'u2', workspaceId: 'ws2', email: 'u2@example.com' },
    { id: 'site', baseUrl: 'https://example.com', allowStaticMetadata: true },
  )
  expect(readback).toMatchObject({
    kind: 'ok',
    data: { version_count: 51, total_size_bytes: 1428 },
  })
  const owner = await getArtifactVersions(fixture.db, user, { id: 'site' })
  if (owner.kind !== 'ok') throw new Error('expected owner history')
  expect(owner.data).toMatchObject({
    version_count: 53,
    total_size_bytes: 1431,
  })
  expect(owner.data.versions[1]?.creator?.name).toBe('u1@example.com')
  expect(result.data.versions[0]?.creator).toBeNull()
  const next = await getArtifactVersions(
    fixture.db,
    { ...user, id: 'u2', workspaceId: 'ws2', email: 'u2@example.com' },
    { id: 'site', cursor: result.data.next_cursor! },
  )
  if (next.kind !== 'ok') throw new Error('expected next page')
  expect(next.data.versions.map((v) => v.version_id)).toEqual(['site-02'])
  expect(next.data.has_more).toBe(false)

  expect(result.data.versions[1]?.creator).toEqual({
    kind: 'human',
    name: 'User',
    email: null,
    agent_profile_id: null,
  })
  expect(source).not.toHaveBeenCalled()
})

test('MCP list defaults omit summaries and their query', async () => {
  const prepare = vi.spyOn(fixture.sqlite, 'prepare')
  try {
    const result = await listCliArtifacts(fixture.db, user, {
      baseUrl: 'https://example.com',
    })
    if (result.kind !== 'ok') throw new Error('expected list')
    expect(result.data.artifacts.length).toBeGreaterThan(0)
    for (const row of result.data.artifacts) {
      expect(row).not.toHaveProperty('retain_versions')
      expect(row).not.toHaveProperty('version_count')
      expect(row).not.toHaveProperty('total_size_bytes')
    }
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('sum(v.size_bytes)')),
    ).toHaveLength(0)
  } finally {
    prepare.mockRestore()
  }
})

test('list summaries add one bounded query for both one and fifty rows', async () => {
  fixture.sqlite.exec(
    "UPDATE shareables SET name = 'Only one' WHERE id = 'site'",
  )
  for (let i = 0; i < 50; i++)
    fixture.sqlite
      .prepare(
        `INSERT INTO shareables (id,workspace_id,owner_user_id,name,artifact_kind,visibility,created_at,updated_at,container_id) VALUES (?,'ws1','u1','Artifact','html_page','private','2026-01-01','2026-01-01','home')`,
      )
      .run(`extra-${i}`)
  const prepare = vi.spyOn(fixture.sqlite, 'prepare')
  try {
    const one = await listCliArtifacts(fixture.db, user, {
      includeVersionSummaries: true,
      baseUrl: 'https://example.com',
      query: 'Only one',
    })
    expect(one.kind === 'ok' && one.data.artifacts.length).toBe(1)
    const oneCalls = prepare.mock.calls.length
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('sum(v.size_bytes)')),
    ).toHaveLength(1)
    prepare.mockClear()
    const fifty = await listCliArtifacts(fixture.db, user, {
      includeVersionSummaries: true,
      baseUrl: 'https://example.com',
    })
    expect(fifty.kind === 'ok' && fifty.data.artifacts.length).toBe(50)
    expect(prepare.mock.calls.length).toBe(oneCalls)
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('sum(v.size_bytes)')),
    ).toHaveLength(1)
  } finally {
    prepare.mockRestore()
  }
})

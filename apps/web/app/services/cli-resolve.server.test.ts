import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { resolveCliCandidates } from './cli-resolve.server'

describe('resolveCliCandidates', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seedResolveData(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns artifact, project, and version candidates', async () => {
    const byTitle = await resolveCliCandidates(db, USER, 'Weekly report')

    expect(byTitle.candidates[0]).toMatchObject({
      kind: 'artifact',
      id: 'art123',
      title: 'Weekly report',
      artifact_kind: 'html_page',
      visibility: 'project',
      project: { id: 'project-a', name: 'Launch review' },
      owner: { id: 'u1', email: 'owner@example.com' },
      match: { kind: 'title', confidence: 'exact' },
    })
    expect(byTitle.has_more).toBe(false)

    const byProject = await resolveCliCandidates(db, USER, 'Launch')
    expect(byProject.candidates).toContainEqual(
      expect.objectContaining({
        kind: 'project',
        id: 'project-a',
        name: 'Launch review',
        match: { kind: 'project_name', confidence: 'candidate' },
      }),
    )

    const byVersion = await resolveCliCandidates(db, USER, 'ver1')
    expect(byVersion.candidates).toContainEqual(
      expect.objectContaining({
        kind: 'version',
        id: 'ver1',
        artifact_id: 'art123',
        version_id: 'ver1',
        ordinal: 2,
        is_current: true,
        size_bytes: 42,
        match: { kind: 'id', confidence: 'exact' },
      }),
    )
  })

  test('resolves pasted share URLs with asset suffixes', async () => {
    const result = await resolveCliCandidates(
      db,
      USER,
      'artifactshare.com/a/art123.preview.png',
    )

    expect(result.candidates[0]).toMatchObject({
      kind: 'artifact',
      id: 'art123',
      match: { kind: 'url', confidence: 'exact' },
    })
  })

  test('returns an empty successful result when nothing matches', async () => {
    const result = await resolveCliCandidates(db, USER, 'not found')

    expect(result).toEqual({
      query: 'not found',
      candidates: [],
      has_more: false,
    })
  })

  test('artifact and version resolution enforce the link policy', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'ws1')
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u2',
        email: 'other@example.com',
        email_verified: 1,
        name: 'Other',
        image: null,
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        workspace_id: 'ws1',
        locale: null,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'linked',
        workspace_id: 'ws1',
        owner_user_id: 'u2',
        name: 'linked.html',
        derived_title: 'Linked report',
        artifact_kind: 'html_page',
        visibility: 'link',
        current_version_id: 'linked-version',
        container_id: 'project-a',
        link_expires_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'linked-version',
        shareable_id: 'linked',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/linked.html',
        r2_key: 'ws1/linked/version/linked.html',
        size_bytes: 1,
        sha256: 'linked',
        fallback_to_index: 0,
        created_by_id: 'u2',
        created_at: '2026-06-09T00:00:00.000Z',
        published_at: '2026-06-09T00:00:00.000Z',
      })
      .execute()

    expect(
      (await resolveCliCandidates(db, USER, 'linked')).candidates.map(
        (row) => row.id,
      ),
    ).toContain('linked')
    expect(
      (await resolveCliCandidates(db, USER, 'linked-version')).candidates.map(
        (row) => row.id,
      ),
    ).toContain('linked-version')
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', 'ws1')
      .execute()
    expect((await resolveCliCandidates(db, USER, 'linked')).candidates).toEqual(
      [],
    )
    expect(
      (await resolveCliCandidates(db, USER, 'linked-version')).candidates,
    ).toEqual([])
  })
})

const USER = {
  id: 'u1',
  email: 'owner@example.com',
  emailVerified: true,
  workspaceId: 'ws1',
}

async function seedResolveData(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws1',
      hd: 'example.com',
      name: 'Example',
      created_at: '2026-06-09T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'u1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-06-09T00:00:00.000Z',
      updated_at: '2026-06-09T00:00:00.000Z',
      workspace_id: 'ws1',
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'project-a',
      workspace_id: 'ws1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Launch review',
      description: 'Release work',
      base_visibility: 'workspace',
      archived_at: null,
      created_at: '2026-06-09T00:00:00.000Z',
      updated_at: '2026-06-09T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'art123',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      slug: null,
      name: 'weekly.html',
      derived_title: 'Weekly report',
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'project',
      current_version_id: 'ver1',
      view_count: 0,
      container_id: 'project-a',
      created_at: '2026-06-09T00:00:00.000Z',
      updated_at: '2026-06-09T00:01:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values([
      {
        id: 'ver0',
        shareable_id: 'art123',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/weekly.html',
        r2_key: 'ws1/art123/ver0/weekly.html',
        size_bytes: 21,
        sha256: 'sha0',
        fallback_to_index: 0,
        created_by_id: 'u1',
        created_at: '2026-06-09T00:01:00.000Z',
        published_at: '2026-06-09T00:01:00.000Z',
      },
      {
        id: 'ver1',
        shareable_id: 'art123',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/weekly.html',
        r2_key: 'ws1/art123/ver1/weekly.html',
        size_bytes: 42,
        sha256: 'sha1',
        fallback_to_index: 0,
        created_by_id: 'u1',
        created_at: '2026-06-09T00:01:00.000Z',
        published_at: '2026-06-09T00:01:00.000Z',
      },
    ])
    .execute()
}

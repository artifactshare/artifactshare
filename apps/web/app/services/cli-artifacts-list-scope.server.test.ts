import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { listCliArtifacts } from './cli-artifacts.server'

const BASE = { baseUrl: 'https://artifactshare.test' }

const MEMBER = {
  id: 'u1',
  email: 'member@example.com',
  emailVerified: true,
  name: 'Member',
  image: null,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  kind: 'human' as const,
  locale: 'en',
}

const EXTERNAL = {
  ...MEMBER,
  id: 'ext1',
  email: 'ext@example2.com',
  name: 'External',
  workspaceId: 'ws2',
  hd: 'example2.com',
}

describe('listCliArtifacts project scope', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('member lists other members artifacts with owner_email and project_id', async () => {
    const result = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'project-a',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const ids = result.data.artifacts.map((a) => a.id)
    expect(ids).toContain('art-other-ws-vis')
    expect(ids).toContain('art-other-project-vis')
    expect(ids).toContain('art-own')
    // Negative controls: private artifacts of others, other projects, and
    // other workspaces never appear in the member listing.
    expect(ids).not.toContain('art-other-private')
    expect(ids).not.toContain('art-project-b')
    expect(ids).not.toContain('art-ws2')
    const item = result.data.artifacts.find((a) => a.id === 'art-other-ws-vis')
    expect(item).toMatchObject({
      owner_email: 'other@example.com',
      project_id: 'project-a',
    })
  })

  test('external audience member sees only project visibility and own grants', async () => {
    const result = await listCliArtifacts(db, EXTERNAL, {
      ...BASE,
      projectId: 'project-a',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const ids = result.data.artifacts.map((a) => a.id)
    expect(ids).toContain('art-other-project-vis')
    expect(ids).toContain('art-granted-to-ext')
    // Negative controls: the other workspace's internal artifacts stay hidden.
    expect(ids).not.toContain('art-other-ws-vis')
    expect(ids).not.toContain('art-other-private')
    expect(ids).not.toContain('art-own')
  })

  test('unknown or inaccessible project id is invalid-project', async () => {
    const unknown = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'nope',
    })
    expect(unknown.kind).toBe('invalid-project')

    const noAudience = await listCliArtifacts(
      db,
      { ...EXTERNAL, email: 'stranger@example3.com' },
      { ...BASE, projectId: 'project-a' },
    )
    expect(noAudience.kind).toBe('invalid-project')
  })

  test('home and unfiltered listings stay owner-scoped without owner_email', async () => {
    const home = await listCliArtifacts(db, MEMBER, { ...BASE, projectId: '' })
    expect(home.kind).toBe('ok')
    if (home.kind !== 'ok') return
    expect(home.data.artifacts.map((a) => a.id)).toEqual(['art-home'])

    const all = await listCliArtifacts(db, MEMBER, { ...BASE })
    expect(all.kind).toBe('ok')
    if (all.kind !== 'ok') return
    const ids = all.data.artifacts.map((a) => a.id)
    expect(ids).toContain('art-own')
    expect(ids).toContain('art-home')
    expect(ids).not.toContain('art-other-ws-vis')
    for (const item of all.data.artifacts) {
      expect(item).not.toHaveProperty('owner_email')
    }
  })

  test('cursor pages through 51+ artifacts with a shared updated_at without gaps', async () => {
    await seedMany(db, 55)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const result = await listCliArtifacts(db, MEMBER, {
        ...BASE,
        projectId: 'project-a',
        cursor,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      seen.push(...result.data.artifacts.map((a) => a.id))
      pages += 1
      if (!result.data.has_more) {
        expect(result.data.next_cursor).toBeNull()
        break
      }
      expect(result.data.next_cursor).toBeTruthy()
      cursor = result.data.next_cursor ?? undefined
    }

    expect(pages).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(seen.length)
    const bulkIds = seen.filter((id) => id.startsWith('bulk-'))
    expect(bulkIds).toHaveLength(55)
  })

  test('corrupt cursors and filter-mismatched cursors are invalid-cursor', async () => {
    const corrupt = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'project-a',
      cursor: 'not-a-cursor',
    })
    expect(corrupt.kind).toBe('invalid-cursor')

    await seedMany(db, 55)
    const first = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'project-a',
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const cursor = first.data.next_cursor
    expect(cursor).toBeTruthy()

    const reused = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'project-a',
      query: 'changed',
      cursor: cursor ?? undefined,
    })
    expect(reused.kind).toBe('invalid-cursor')
  })

  test('cursor pages through a non-Latin-1 query without throwing', async () => {
    const shareables = Array.from({ length: 55 }, (_, i) => ({
      ...shareableRow(
        `jp-${String(i).padStart(3, '0')}`,
        'ws1',
        'u2',
        'project-a',
        'workspace',
      ),
      derived_title: `設計メモ ${i}`,
    }))
    for (let index = 0; index < shareables.length; index += 5) {
      await db
        .insertInto('shareables')
        .values(shareables.slice(index, index + 5))
        .execute()
    }

    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const result = await listCliArtifacts(db, MEMBER, {
        ...BASE,
        projectId: 'project-a',
        query: '設計',
        cursor,
      })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      seen.push(...result.data.artifacts.map((a) => a.id))
      if (!result.data.has_more) break
      cursor = result.data.next_cursor ?? undefined
    }

    expect(seen.filter((id) => id.startsWith('jp-'))).toHaveLength(55)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('matches the complete query beyond the D1 LIKE pattern limit', async () => {
    const prefix = 'a'.repeat(60)
    await db
      .insertInto('shareables')
      .values([
        {
          ...shareableRow(
            'long-query-match',
            'ws1',
            'u2',
            'project-a',
            'workspace',
          ),
          derived_title: `${prefix}z`,
        },
        {
          ...shareableRow(
            'long-query-prefix-only',
            'ws1',
            'u2',
            'project-a',
            'workspace',
          ),
          derived_title: `${prefix}y`,
        },
      ])
      .execute()

    const result = await listCliArtifacts(db, MEMBER, {
      ...BASE,
      projectId: 'project-a',
      query: `${prefix}z`,
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts.map(({ id }) => id)).toEqual([
      'long-query-match',
    ])
  })

  test('owner-scoped listing pages with the same cursor contract', async () => {
    await seedManyOwned(db, 55)

    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const result = await listCliArtifacts(db, MEMBER, { ...BASE, cursor })
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') return
      seen.push(...result.data.artifacts.map((a) => a.id))
      if (!result.data.has_more) break
      cursor = result.data.next_cursor ?? undefined
    }

    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((id) => id.startsWith('mine-'))).toHaveLength(55)
  })
})

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      { id: 'ws1', hd: 'example.com', name: 'One', created_at: T0 },
      { id: 'ws2', hd: 'example2.com', name: 'Two', created_at: T0 },
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      userRow('u1', 'member@example.com', 'ws1'),
      userRow('u2', 'other@example.com', 'ws1'),
      userRow('ext1', 'ext@example2.com', 'ws2'),
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values([
      containerRow('project-a', 'ws1', 'project', 'Project A'),
      containerRow('project-b', 'ws1', 'project', 'Project B'),
      containerRow('project-ws2', 'ws2', 'project', 'Project WS2'),
      {
        ...containerRow('inbox-u1', 'ws1', 'inbox', 'Inbox'),
        owner_user_id: 'u1',
      },
    ])
    .execute()
  await db
    .insertInto('project_share_defaults')
    .values({
      id: 'psd1',
      project_container_id: 'project-a',
      email: 'ext@example2.com',
      role: 'viewer',
      display_name: null,
      created_by_id: 'u2',
      created_at: T0,
      updated_at: T0,
    })
    .execute()
  const shareables = [
    shareableRow('art-own', 'ws1', 'u1', 'project-a', 'workspace'),
    shareableRow('art-other-ws-vis', 'ws1', 'u2', 'project-a', 'workspace'),
    shareableRow('art-other-project-vis', 'ws1', 'u2', 'project-a', 'project'),
    shareableRow('art-other-private', 'ws1', 'u2', 'project-a', 'private'),
    shareableRow('art-granted-to-ext', 'ws1', 'u2', 'project-a', 'private'),
    shareableRow('art-project-b', 'ws1', 'u2', 'project-b', 'workspace'),
    shareableRow('art-ws2', 'ws2', 'ext1', 'project-ws2', 'workspace'),
    shareableRow('art-home', 'ws1', 'u1', 'inbox-u1', 'private'),
  ]
  for (let index = 0; index < shareables.length; index += 4) {
    await db
      .insertInto('shareables')
      .values(shareables.slice(index, index + 4))
      .execute()
  }
  await db
    .insertInto('shareable_grants')
    .values({
      shareable_id: 'art-granted-to-ext',
      granted_email: 'ext@example2.com',
      granted_at: T0,
      granted_by: 'u2',
    })
    .execute()
}

async function seedMany(db: Kysely<DB>, count: number) {
  const shareables = Array.from({ length: count }, (_, i) =>
    shareableRow(
      `bulk-${String(i).padStart(3, '0')}`,
      'ws1',
      'u2',
      'project-a',
      'workspace',
      // Half the rows share one timestamp so pagination must tiebreak on id.
      i < 30
        ? '2026-07-01T00:00:00.000Z'
        : `2026-07-02T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    ),
  )
  for (let index = 0; index < shareables.length; index += 5) {
    await db
      .insertInto('shareables')
      .values(shareables.slice(index, index + 5))
      .execute()
  }
}

async function seedManyOwned(db: Kysely<DB>, count: number) {
  const shareables = Array.from({ length: count }, (_, i) =>
    shareableRow(
      `mine-${String(i).padStart(3, '0')}`,
      'ws1',
      'u1',
      'project-a',
      'private',
      i < 30
        ? '2026-07-01T00:00:00.000Z'
        : `2026-07-02T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    ),
  )
  for (let index = 0; index < shareables.length; index += 5) {
    await db
      .insertInto('shareables')
      .values(shareables.slice(index, index + 5))
      .execute()
  }
}

const T0 = '2026-06-09T00:00:00.000Z'

function userRow(id: string, email: string, workspaceId: string) {
  return {
    id,
    email,
    email_verified: 1,
    name: id,
    image: null,
    created_at: T0,
    updated_at: T0,
    workspace_id: workspaceId,
    locale: null,
  }
}

function containerRow(
  id: string,
  workspaceId: string,
  kind: 'project' | 'inbox',
  name: string,
) {
  return {
    id,
    workspace_id: workspaceId,
    kind,
    owner_user_id: null,
    created_by_id: kind === 'project' ? 'u2' : null,
    name,
    description: null,
    base_visibility: 'workspace' as const,
    archived_at: null,
    created_at: T0,
    updated_at: T0,
  }
}

function shareableRow(
  id: string,
  workspaceId: string,
  ownerId: string,
  containerId: string,
  visibility: 'private' | 'workspace' | 'project' | 'link',
  updatedAt = T0,
) {
  return {
    id,
    workspace_id: workspaceId,
    owner_user_id: ownerId,
    slug: null,
    name: `${id}.md`,
    derived_title: `Title ${id}`,
    title_override: null,
    description: null,
    artifact_kind: 'markdown_page' as const,
    visibility,
    current_version_id: null,
    view_count: 0,
    container_id: containerId,
    created_at: T0,
    updated_at: updatedAt,
    last_accessed_at: null,
  }
}

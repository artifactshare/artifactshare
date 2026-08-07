import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { userContext } from '~/middleware/context'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'

const dbHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))

import { loader } from './recent'

const TS = '2026-06-14T00:00:00.000Z'
const VIEWER = {
  id: 'u-owner',
  email: 'owner@example.com',
  name: 'Owner',
  image: null,
  workspaceId: 'ws-a',
  hd: 'example.com',
  locale: null,
} as SessionUser

/**
 * `url` is what the framework hands the loader; `rawRequestUrl` is the wire URL,
 * which differs on client navigations. Passing both keeps the loader honest
 * about which one it reads.
 */
function load(url: string, rawRequestUrl = url) {
  const context = new Map()
  context.set(userContext, VIEWER)
  return loader({
    request: new Request(rawRequestUrl),
    url: new URL(url),
    context,
  } as never)
}

/** Redirect target, or null when the loader returned data. */
async function redirectTo(
  url: string,
  rawRequestUrl?: string,
): Promise<string | null> {
  try {
    await load(url, rawRequestUrl)
    return null
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.headers.get('location')
    throw thrown
  }
}

describe('/recent loader canonical redirect', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seed(db, 25)
  })
  afterEach(async () => {
    await db.destroy()
  })

  // On a client navigation the wire URL keeps a `.data` suffix and the
  // framework's own search params. Reading it instead of the normalized `url`
  // redirects every time, and the client refetches into an endless loop.
  test.each([
    [
      'https://artifactshare.com/recent',
      'https://artifactshare.com/recent.data',
    ],
    [
      'https://artifactshare.com/recent',
      'https://artifactshare.com/recent.data?_routes=routes%2F_home%2F_protected%2Frecent',
    ],
    [
      'https://artifactshare.com/recent?page=2',
      'https://artifactshare.com/recent.data?page=2',
    ],
  ])('serves %s arriving as %s', async (url, rawRequestUrl) => {
    expect(await redirectTo(url, rawRequestUrl)).toBeNull()
  })

  test.each([
    ['https://artifactshare.com/recent', null],
    ['https://artifactshare.com/recent?page=2', null],
    ['https://artifactshare.com/recent?page=2', null],
    ['https://artifactshare.com/recent?page=1', '/recent'],
    ['https://artifactshare.com/recent?q=%20alpha%20', '/recent'],
    ['https://artifactshare.com/recent?page=nope', '/recent'],
    ['https://artifactshare.com/recent?page=99', '/recent?page=2'],
    ['https://artifactshare.com/recent?q=s-&page=2', '/recent?page=2'],
    // A page past the end clamps to the last page that has rows.
    ['https://artifactshare.com/recent?page=2&q=alpha', '/recent?page=2'],
  ])('normalizes %s', async (url, expected) => {
    expect(await redirectTo(url)).toBe(expected)
  })

  test('a redirect target is itself canonical, so normalizing settles', async () => {
    const first = await redirectTo('https://artifactshare.com/recent?page=1')
    expect(first).toBe('/recent')
    expect(await redirectTo(`https://artifactshare.com${first}`)).toBeNull()
  })

  test('paginates the viewer history', async () => {
    const first = await load('https://artifactshare.com/recent')
    expect(first.total).toBe(25)
    expect(first.page).toBe(1)
    expect(first.recentFiles).toHaveLength(20)

    const second = await load('https://artifactshare.com/recent?page=2')
    expect(second.page).toBe(2)
    expect(second.recentFiles).toHaveLength(5)
  })

  test('pagination and filters remain URL-driven together', async () => {
    const result = await load(
      'https://artifactshare.com/recent?relation=own&unread=1',
    )
    expect(result).toMatchObject({ relation: 'own', unread: true, page: 1 })
  })
})

describe('/recent loader restricted history', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seed(db, 0)
    await db
      .insertInto('users')
      .values({
        id: 'u-other',
        email: 'other@example.com',
        email_verified: 1,
        name: 'Other Owner',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'restricted-1',
        workspace_id: 'ws-a',
        owner_user_id: 'u-other',
        slug: null,
        name: 'secret-file.html',
        derived_title: 'Secret title',
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: 'inbox-owner',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'restricted-1',
        viewer_user_id: 'u-owner',
        first_viewed_at: TS,
        last_viewed_at: TS,
        viewed_title: 'Secret title',
        viewed_owner_name: 'Other Owner',
      })
      .execute()
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns a restricted row with title, ownerName, and lastViewedAt', async () => {
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles).toEqual([
      expect.objectContaining({
        kind: 'restricted',
        title: 'Secret title',
        ownerName: 'Other Owner',
        lastViewedAt: TS,
      }),
    ])
  })

  test('restricted DTO serialization omits file-only fields', async () => {
    const result = await load('https://artifactshare.com/recent')
    const serialized = JSON.stringify(result.recentFiles[0])
    for (const key of [
      'visibility',
      'viewCount',
      'commentCount',
      'projectName',
      'email',
      'artifactKind',
    ]) {
      expect(serialized).not.toContain(`"${key}"`)
    }
  })

  test('returns visible files as file rows while excluding deleted history', async () => {
    await db
      .updateTable('shareables')
      .set({ visibility: 'workspace' })
      .where('id', '=', 'restricted-1')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({ kind: 'file' })
    expect(result.recentFiles).toHaveLength(1)
  })

  test('all-restricted history is not reported as hidden history', async () => {
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles).toHaveLength(1)
    expect(result.hasHiddenHistory).toBe(false)
  })

  test('restricted row keeps snapshot title after shareable title changes', async () => {
    await db
      .updateTable('shareables')
      .set({ derived_title: 'Leaked title' })
      .where('id', '=', 'restricted-1')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({
      kind: 'restricted',
      title: 'Secret title',
    })
  })

  test('restricted row keeps snapshot owner name after owner renames', async () => {
    await db
      .updateTable('users')
      .set({ name: 'Leaked Owner' })
      .where('id', '=', 'u-other')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({
      kind: 'restricted',
      ownerName: 'Other Owner',
    })
  })

  test('visible file rows reflect current title after rename', async () => {
    await db
      .updateTable('shareables')
      .set({ visibility: 'workspace', derived_title: 'Renamed visible' })
      .where('id', '=', 'restricted-1')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({
      kind: 'file',
      file: expect.objectContaining({ derivedTitle: 'Renamed visible' }),
    })
  })

  test('restricted row uses unavailable title when snapshot title is null', async () => {
    await db
      .updateTable('shareable_viewer_recency')
      .set({ viewed_title: null })
      .where('shareable_id', '=', 'restricted-1')
      .execute()
    await db
      .updateTable('shareables')
      .set({ derived_title: 'Leaked title' })
      .where('id', '=', 'restricted-1')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({
      kind: 'restricted',
      title: 'Title unavailable',
    })
  })

  test('restricted row omits owner image', async () => {
    await db
      .updateTable('users')
      .set({ image: 'https://example.com/new-avatar.png' })
      .where('id', '=', 'u-other')
      .execute()
    const result = await load('https://artifactshare.com/recent')
    expect(result.recentFiles[0]).toMatchObject({
      kind: 'restricted',
      ownerImage: null,
    })
  })
})

describe('/recent loader unread columns', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seedUnreadColumns(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns unread version and comment counts on file rows', async () => {
    const result = await load('https://artifactshare.com/recent')
    expect(result.now).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const fileRow = result.recentFiles.find((r) => r.kind === 'file')
    expect(fileRow?.kind).toBe('file')
    if (fileRow?.kind !== 'file') return
    expect(fileRow.file.unreadVersionCount).toBeGreaterThan(0)
    expect(fileRow.file.unreadCommentCount).toBeGreaterThan(0)
    expect(fileRow.file.versionCount).toBeGreaterThan(0)
    expect(fileRow.file.latestPublishedAt).toBeTruthy()
  })
})

async function seedUnreadColumns(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'ws-a',
      created_at: TS,
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: TS,
    })
    .execute()
  await db
    .insertInto('users')
    .values([
      {
        id: 'u-owner',
        email: 'owner@example.com',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
      {
        id: 'u-other',
        email: 'other@example.com',
        email_verified: 1,
        name: 'Other',
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id: 'ws-a',
        locale: null,
      },
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'inbox-owner',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'u-owner',
      created_by_id: 'u-owner',
      name: '未整理',
      description: null,
      base_visibility: 'workspace',
      archived_at: null,
      created_at: TS,
      updated_at: TS,
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 's-flag',
      workspace_id: 'ws-a',
      owner_user_id: 'u-owner',
      slug: null,
      name: 'flag.html',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'workspace',
      current_version_id: null,
      container_id: 'inbox-owner',
      created_at: TS,
      updated_at: TS,
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('shareable_viewer_recency')
    .values({
      shareable_id: 's-flag',
      viewer_user_id: 'u-owner',
      first_viewed_at: '2026-06-14T00:00:00.000Z',
      last_viewed_at: '2026-06-15T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: 'v-flag',
      shareable_id: 's-flag',
      artifact_kind: 'html_page',
      status: 'published',
      entrypoint_path: '/index.html',
      r2_key: 'v-flag',
      size_bytes: 1,
      sha256: 'v-flag',
      // 未読は他者の動きなので、閲覧者 (u-owner) 以外が出した版にする
      created_by_id: 'u-other',
      created_at: '2026-06-16T00:00:00.000Z',
      published_at: '2026-06-16T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('comment_threads')
    .values({
      id: 'thread-flag',
      shareable_id: 's-flag',
      status: 'open',
      created_by_id: 'u-other',
      resolved_by_id: null,
      resolved_at: null,
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('comment_messages')
    .values({
      id: 'm-flag',
      thread_id: 'thread-flag',
      body: 'new',
      agent: null,
      created_by_id: 'u-other',
      created_at: '2026-06-16T00:00:00.000Z',
      updated_at: '2026-06-16T00:00:00.000Z',
    })
    .execute()
}

async function seed(db: Kysely<DB>, files: number) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'ws-a',
      created_at: TS,
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: 0,
      storage_updated_at: TS,
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'u-owner',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: TS,
      updated_at: TS,
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'inbox-owner',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'u-owner',
      created_by_id: 'u-owner',
      name: '未整理',
      description: null,
      base_visibility: 'workspace',
      archived_at: null,
      created_at: TS,
      updated_at: TS,
    })
    .execute()
  for (let index = 0; index < files; index++) {
    const id = `s-${String(index).padStart(2, '0')}`
    const viewedAt = new Date(Date.parse(TS) - index * 3_600_000).toISOString()
    await db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: 'ws-a',
        owner_user_id: 'u-owner',
        slug: null,
        name: index === 0 ? 'alpha.html' : `${id}.html`,
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: 'inbox-owner',
        created_at: TS,
        updated_at: TS,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: id,
        viewer_user_id: 'u-owner',
        first_viewed_at: viewedAt,
        last_viewed_at: viewedAt,
      })
      .execute()
  }
}

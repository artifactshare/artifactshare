import type { Kysely } from 'kysely'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { userContext } from '~/middleware/context'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import { groupByDay } from '~/lib/datetime'

const dbHolder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))

import { loader } from './files'
import { filesDateHeaderKey } from './files'
import en from '~/i18n/en.json'
import {
  listUnopenedOwnedArtifactsLimited,
  listMyArtifactsLimited,
  listRecentArtifactsPage,
  listRecentArtifactsLimited,
} from '~/services/home.server'
import { projectFileRowsQuery } from '~/routes/_protected/+lib/project-subpage.server'
import { listGrants } from '~/services/shareables.server'

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

function load(path: string) {
  const context = new Map()
  context.set(userContext, VIEWER)
  return loader({
    request: new Request(`https://artifactshare.com${path}`),
    url: new URL(`https://artifactshare.com${path}`),
    context,
  } as never)
}

async function redirectTo(path: string) {
  try {
    await load(path)
    return null
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.headers.get('location')
    throw thrown
  }
}

describe('/files loader', () => {
  let db: Kysely<DB>
  let sqlite: DatabaseSync
  beforeEach(async () => {
    ;({ db, sqlite } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns only own files newest first and paginates by 20', async () => {
    const queries = vi.spyOn(sqlite, 'prepare')
    const first = await load('/files')
    const firstPageQueryCount = queries.mock.calls.length
    queries.mockClear()
    expect(first.total).toBe(29)
    expect(first.files).toHaveLength(20)
    expect(first.files[0].id).toBe('own-00')
    expect(first.files.every((f) => f.ownerId === 'u-owner')).toBe(true)
    const second = await load('/files?page=2')
    expect(queries.mock.calls).toHaveLength(firstPageQueryCount)
    expect(firstPageQueryCount).toBe(2)
    queries.mockRestore()
    expect(second.page).toBe(2)
    expect(second.files.map((f) => f.id)).toEqual([
      'own-16',
      'own-17',
      'own-18',
      'own-19',
      'own-20',
      'own-21',
      'own-22',
      'own-23',
      'own-24',
    ])
  })

  test('returns independent published version facts for same-name files', async () => {
    await db
      .updateTable('shareables')
      .set({ name: 'report.html' })
      .where('id', 'in', ['own-00', 'own-01'])
      .execute()
    for (const [id, shareableId, status, publishedAt] of [
      ['v1', 'own-00', 'published', TS],
      ['v2', 'own-00', 'published', '2026-06-15T00:00:00.000Z'],
      ['v3', 'own-00', 'uploading', '2026-06-16T00:00:00.000Z'],
      ['duplicate-v1', 'own-01', 'published', TS],
    ] as const) {
      await db
        .insertInto('versions')
        .values({
          id,
          shareable_id: shareableId,
          artifact_kind: 'html_page',
          status,
          entrypoint_path: '/index.html',
          r2_key: `test/${id}`,
          size_bytes: 1,
          sha256: id,
          created_by_id: VIEWER.id,
          created_at: TS,
          published_at: publishedAt,
        })
        .execute()
    }
    const result = await load('/files')
    expect(result.files.find((f) => f.id === 'own-00')).toMatchObject({
      fileName: 'report.html',
      versionCount: 2,
      latestPublishedAt: '2026-06-15T00:00:00.000Z',
    })
    expect(result.files.find((f) => f.id === 'own-01')).toMatchObject({
      fileName: 'report.html',
      versionCount: 1,
      latestPublishedAt: TS,
    })
    expect(Number.isNaN(Date.parse(result.now))).toBe(false)
  })

  test('marks unopened files across pages using personal history and creation provenance', async () => {
    for (const [id, creator] of [
      ['own-00', VIEWER.id],
      ['own-01', 'u-other'],
      ['own-24', VIEWER.id],
    ]) {
      await db
        .insertInto('versions')
        .values({
          id: `v-${id}`,
          shareable_id: id,
          artifact_kind: 'html_page',
          status: 'published',
          entrypoint_path: '/index.html',
          r2_key: `test/${id}`,
          size_bytes: 1,
          sha256: id,
          created_by_id: creator,
          created_at: TS,
          published_at: TS,
        })
        .execute()
      await db
        .updateTable('shareables')
        .set({ current_version_id: `v-${id}` })
        .where('id', '=', id)
        .execute()
    }
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'own-24',
        viewer_user_id: 'u-other',
        first_viewed_at: TS,
        last_viewed_at: TS,
      })
      .execute()
    const first = await load('/files')
    const second = await load('/files?page=2')
    expect(first.files.find((f) => f.id === 'own-00')?.isUnopened).toBe(true)
    expect(first.files.find((f) => f.id === 'own-01')?.isUnopened).toBe(false)
    expect(first.files.find((f) => f.id === 'own-02')?.isUnopened).toBe(false)
    expect(second.files.find((f) => f.id === 'own-24')?.isUnopened).toBe(true)
    const home = await listUnopenedOwnedArtifactsLimited(
      db,
      VIEWER.id,
      VIEWER.workspaceId,
    )
    expect(
      [...first.files, ...second.files]
        .filter((f) => f.isUnopened)
        .map((f) => f.id),
    ).toEqual(home.rows.map((f) => f.id))
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'own-24',
        viewer_user_id: VIEWER.id,
        first_viewed_at: TS,
        last_viewed_at: TS,
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ updated_at: '2026-06-16T00:00:00.000Z' })
      .where('id', '=', 'own-24')
      .execute()
    expect(
      (await load('/files?page=2')).files.find((f) => f.id === 'own-24')
        ?.isUnopened,
    ).toBe(false)
  })

  test('list surfaces match owner grant results and restore private after last recipient removal', async () => {
    const cases = [
      [],
      ['OWNER@EXAMPLE.COM'],
      ['reader@example.com'],
      ['OWNER@EXAMPLE.COM', 'reader@example.com', 'second@example.com'],
    ]
    for (const [index, emails] of cases.entries()) {
      const id = `own-0${index}`
      for (const email of emails)
        await db
          .insertInto('shareable_grants')
          .values({
            shareable_id: id,
            granted_email: email,
            granted_at: TS,
            granted_by: VIEWER.id,
          })
          .execute()
      await db
        .insertInto('shareable_viewer_recency')
        .values({
          shareable_id: id,
          viewer_user_id: VIEWER.id,
          first_viewed_at: TS,
          last_viewed_at: TS,
        })
        .execute()
    }
    const files = await load('/files')
    const home = await listMyArtifactsLimited(
      db,
      VIEWER.id,
      VIEWER.workspaceId,
      30,
      VIEWER.email,
    )
    const recent = await listRecentArtifactsPage(db, VIEWER, 1)
    const project = await projectFileRowsQuery(db, 'c-owner', VIEWER).execute()
    for (const index of cases.keys()) {
      const id = `own-0${index}`
      const result = await listGrants(db, VIEWER, id)
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected owner grant evidence')
      const expected = result.grants.length > 0
      expect(files.files.find((f) => f.id === id)?.hasDirectGrants).toBe(
        expected,
      )
      for (const rows of [home, recent, project])
        expect(Boolean(rows.find((f) => f.id === id)?.has_direct_grants)).toBe(
          expected,
        )
    }
    await db
      .deleteFrom('shareable_grants')
      .where('shareable_id', '=', 'own-03')
      .where('granted_email', '!=', 'OWNER@EXAMPLE.COM')
      .execute()
    expect(
      (await load('/files')).files.find((f) => f.id === 'own-03')
        ?.hasDirectGrants,
    ).toBe(false)
  })

  test('withholds grant evidence from removed owners who retain direct access', async () => {
    await db
      .insertInto('shareables')
      .values({
        id: 'former-owner',
        workspace_id: 'ws-a',
        owner_user_id: VIEWER.id,
        name: 'Private file',
        artifact_kind: 'html_page',
        visibility: 'private',
        container_id: 'c-owner',
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'former-owner',
        granted_email: VIEWER.email,
        granted_at: TS,
        granted_by: VIEWER.id,
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'former-owner',
        viewer_user_id: VIEWER.id,
        first_viewed_at: TS,
        last_viewed_at: TS,
      })
      .execute()
    expect(
      (await listRecentArtifactsPage(db, VIEWER, 1))[0]?.has_direct_grants,
    ).toBe(0)
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: VIEWER.id,
        role: 'member',
        status: 'removed',
        created_at: TS,
        updated_at: TS,
      })
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'user_id'])
          .doUpdateSet({ status: 'removed' }),
      )
      .execute()
    expect(await listGrants(db, VIEWER, 'former-owner')).toEqual({
      kind: 'not-found',
    })
    for (const rows of [
      await listRecentArtifactsPage(db, VIEWER, 1),
      await listRecentArtifactsLimited(db, VIEWER),
      await projectFileRowsQuery(db, 'c-owner', VIEWER).execute(),
    ]) {
      expect(rows.find((row) => row.id === 'former-owner')).toMatchObject({
        has_direct_grants: null,
      })
    }
  })

  test('normalizes page in one redirect', async () => {
    expect(await redirectTo('/files?page=1')).toBe('/files')
  })
})

test('/files date column uses the creation-time header', () => {
  expect(filesDateHeaderKey).toBe('table.created')
  expect(en[filesDateHeaderKey]).toBe('Created')
})

test('/files date groups have today and yesterday headings', () => {
  const at = new Date('2026-06-15T12:00:00.000Z')
  const groups = groupByDay(
    [
      { modifiedTime: '2026-06-15T09:00:00.000Z' },
      { modifiedTime: '2026-06-14T09:00:00.000Z' },
    ],
    (item) => item.modifiedTime,
    'en',
    at,
  )
  expect(groups.map((group) => group.heading)).toEqual(['Today', 'Yesterday'])
})

async function seed(db: Kysely<DB>) {
  for (const [id, hd, name] of [
    ['ws-a', 'example.com', 'Workspace A'],
    ['ws-b', 'foreign.example.com', 'Workspace B'] as const,
  ]) {
    await db
      .insertInto('workspaces')
      .values({
        id,
        hd,
        name,
        created_at: TS,
        plan: 'free',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 0,
        storage_updated_at: TS,
      })
      .execute()
  }
  for (const [id, email, workspace_id] of [
    ['u-owner', 'owner@example.com', 'ws-a'],
    ['u-other', 'other@example.com', 'ws-a'],
    ['u-foreign', 'foreign@example.com', 'ws-b'] as const,
  ]) {
    await db
      .insertInto('users')
      .values({
        id,
        email,
        email_verified: 1,
        name: id,
        image: null,
        created_at: TS,
        updated_at: TS,
        workspace_id,
        locale: null,
      })
      .execute()
  }
  for (const [id, workspace_id, owner_user_id, name] of [
    ['c-owner', 'ws-a', 'u-owner', 'container-match'],
    ['c-other', 'ws-a', 'u-other', 'Other container'],
    ['c-foreign', 'ws-b', 'u-foreign', 'Foreign container'] as const,
  ]) {
    await db
      .insertInto('artifact_containers')
      .values({
        id,
        workspace_id,
        kind: 'inbox',
        owner_user_id,
        created_by_id: owner_user_id,
        name,
        description: null,
        base_visibility: 'workspace',
        archived_at: null,
        created_at: TS,
        updated_at: TS,
      })
      .execute()
  }
  for (let index = 0; index < 25; index++)
    await insertFile(
      db,
      `own-${String(index).padStart(2, '0')}`,
      'ws-a',
      'u-owner',
      'c-owner',
      `own-${index}.html`,
      new Date(Date.parse(TS) - index * 3600000).toISOString(),
    )
  await insertFile(
    db,
    'other-owner',
    'ws-a',
    'u-other',
    'c-other',
    'outsider.html',
    TS,
  )
  await insertFile(
    db,
    'foreign-workspace',
    'ws-b',
    'u-foreign',
    'c-foreign',
    'other-workspace.html',
    TS,
  )
  await insertFile(
    db,
    'search-name-match',
    'ws-a',
    'u-owner',
    'c-owner',
    'name-match.html',
    TS,
  )
  await insertFile(
    db,
    'search-derived-match',
    'ws-a',
    'u-owner',
    'c-owner',
    'ordinary.html',
    TS,
    'derived-match',
  )
  await insertFile(
    db,
    'search-override-match',
    'ws-a',
    'u-owner',
    'c-owner',
    'ordinary2.html',
    TS,
    null,
    'override-match',
  )
  await insertFile(
    db,
    'search-container-match',
    'ws-a',
    'u-owner',
    'c-owner',
    'ordinary3.html',
    TS,
  )
}

async function insertFile(
  db: Kysely<DB>,
  id: string,
  workspace_id: string,
  owner_user_id: string,
  container_id: string | null,
  name: string,
  created_at: string,
  derived_title: string | null = null,
  title_override: string | null = null,
) {
  await db
    .insertInto('shareables')
    .values({
      id,
      workspace_id,
      owner_user_id,
      slug: null,
      name,
      derived_title,
      title_override,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'private',
      current_version_id: null,
      container_id,
      created_at,
      updated_at: created_at,
      last_accessed_at: null,
    })
    .execute()
}

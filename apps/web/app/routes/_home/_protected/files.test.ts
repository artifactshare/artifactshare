import type { Kysely } from 'kysely'
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
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns only own files newest first and paginates by 20', async () => {
    const first = await load('/files')
    expect(first.total).toBe(29)
    expect(first.files).toHaveLength(20)
    expect(first.files[0].id).toBe('own-00')
    expect(first.files.every((f) => f.ownerId === 'u-owner')).toBe(true)
    const second = await load('/files?page=2')
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

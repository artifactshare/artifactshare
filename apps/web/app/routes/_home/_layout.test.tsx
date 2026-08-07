import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionUser } from '~/lib/user'
import { userContext } from '~/middleware/context'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbState = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
}))

vi.mock('~/services/db.server', () => ({
  createDb: () => {
    if (!dbState.db) throw new Error('missing sqlite fixture')
    return dbState.db
  },
}))

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { loader } from './_layout'
import {
  hasUploadQuery,
  uploadReturnTo,
  withoutUploadQuery,
} from '~/lib/home-upload-query'

describe('/ home layout loader', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    dbState.db = db
  })

  afterEach(async () => {
    dbState.db = null
    await db.destroy()
  })

  test('uses the workspace display name even when a domain exists', async () => {
    await seedWorkspace(db, {
      id: 'ws-a',
      name: 'TechTalk',
      hd: 'techtalk.jp',
    })

    const result = await loadHomeLayout(
      sessionUser({
        id: 'u-a',
        workspaceId: 'ws-a',
        hd: 'techtalk.jp',
      }),
    )

    expect(result).toMatchObject({
      signedIn: true,
      workspaceName: 'TechTalk',
      workspaceHd: 'techtalk.jp',
    })
  })
})

describe('home upload query', () => {
  test('opens the upload dialog only for upload=1', () => {
    expect(hasUploadQuery('?upload=1')).toBe(true)
    expect(hasUploadQuery('?upload=1&tab=recent')).toBe(true)
    expect(hasUploadQuery('?upload=0')).toBe(false)
    expect(hasUploadQuery('')).toBe(false)
  })

  test('removes only upload while preserving other query parameters', () => {
    expect(
      withoutUploadQuery(
        new URL(
          'https://artifactshare.test/?tab=recent&upload=1&project=demo#files',
        ),
      ),
    ).toBe('/?tab=recent&project=demo#files')
  })

  test('removes upload from the viewer return destination', () => {
    expect(
      uploadReturnTo({
        pathname: '/',
        search: '?upload=1&tab=recent',
        hash: '#files',
      }),
    ).toBe('/?tab=recent#files')
  })
})

async function loadHomeLayout(user: SessionUser | null) {
  const context = new Map()
  context.set(userContext, user)
  return await loader({
    request: new Request('https://artifactshare.test/'),
    context,
  } as never)
}

function sessionUser(
  overrides: Partial<SessionUser> & Pick<SessionUser, 'id' | 'workspaceId'>,
): SessionUser {
  const user = {
    email: `${overrides.id}@example.com`,
    emailVerified: true,
    name: overrides.id,
    image: null,
    hd: null,
    locale: null,
    msTenantId: null,
    ...overrides,
  }
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    image: user.image,
    workspaceId: user.workspaceId,
    hd: user.hd,
    msTenantId: user.msTenantId,
    locale: user.locale,
  }
}

async function seedWorkspace(
  db: Kysely<DB>,
  input: { id: string; name: string; hd: string | null },
) {
  const now = '2026-06-28T00:00:00.000Z'
  await db
    .insertInto('workspaces')
    .values({
      id: input.id,
      hd: input.hd,
      ms_tenant_id: null,
      email_domain: null,
      name: input.name,
      created_at: now,
    })
    .execute()
}

import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionUser } from '~/lib/user'
import { userContext } from '~/middleware/context'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const dbState = vi.hoisted(() => ({
  db: null as Kysely<DB> | null,
}))

const joinedReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('~/services/db.server', () => ({
  createDb: () => {
    if (!dbState.db) throw new Error('missing sqlite fixture')
    return dbState.db
  },
}))
vi.mock('~/services/project-membership.server', async (original) => {
  const actual =
    await original<typeof import('~/services/project-membership.server')>()
  return {
    ...actual,
    listJoinedProjectsForDropdown: (
      ...args: Parameters<typeof actual.listJoinedProjectsForDropdown>
    ) => {
      joinedReads.count += 1
      return actual.listJoinedProjectsForDropdown(...args)
    },
  }
})

vi.mock('cloudflare:workers', () => ({ env: {} }))

import { loader } from './_layout'
import { loader as homeLoader } from './index'
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

test('signed-in / reads the joined projects once for the header and the rail', async () => {
  const fixture = createMigratedInMemoryDb()
  dbState.db = fixture.db
  try {
    await seedWorkspace(fixture.db, { id: 'ws-a', name: 'A', hd: null })
    const context = new Map()
    context.set(userContext, sessionUser({ id: 'u-a', workspaceId: 'ws-a' }))
    joinedReads.count = 0
    const request = new Request('https://artifactshare.test/')
    const url = new URL(request.url)
    const [layout, home] = await Promise.all([
      loader({ request, context, params: {}, url } as never),
      homeLoader({ request, context, params: {}, url } as never),
    ])
    expect(layout).toMatchObject({ signedIn: true, joinedProjects: [] })
    expect(home).toMatchObject({ signedIn: true, rail: { projects: [] } })
    expect(joinedReads.count).toBe(1)
  } finally {
    dbState.db = null
    await fixture.db.destroy()
  }
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
    kind: 'human' as const,
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
    kind: 'human' as const,
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

test('search-only navigation avoids layout reload while mutations and unrelated conditions revalidate', async () => {
  const { shouldRevalidate } = await import('./_layout')
  const args = {
    currentUrl: new URL('https://example.com/search?q=alpha'),
    nextUrl: new URL(
      'https://example.com/search?q=beta&owner=owner&period=7&dateField=viewed&includeArchived=true',
    ),
    currentParams: {},
    nextParams: {},
    defaultShouldRevalidate: true,
  }
  expect(shouldRevalidate(args)).toBe(false)
  expect(shouldRevalidate({ ...args, formAction: '/api/files' })).toBe(true)
  expect(
    shouldRevalidate({
      ...args,
      nextUrl: new URL('https://example.com/search?q=beta&workspace=other'),
    }),
  ).toBe(true)
  expect(shouldRevalidate({ ...args, nextUrl: args.currentUrl })).toBe(true)
})

import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionUser } from '~/lib/user'
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

import { action } from './set-locale'

describe('/set-locale action', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    // Load real migrations so the users table schema stays in sync with
    // production. Avoids drift if a later migration touches users.
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    dbState.db = db
  })

  afterEach(async () => {
    dbState.db = null
    await db.destroy()
  })

  test('updates users.locale for authenticated users', async () => {
    seedUser(sqlite, 'u1', 'en')

    await action(actionArgs(requestFor({ locale: 'ja' }), sessionUser('u1')))

    expect(readUserLocale(sqlite, 'u1')).toBe('ja')
  })

  test('sets cookie for authenticated users', async () => {
    seedUser(sqlite, 'u1', 'en')

    const response = await action(
      actionArgs(
        requestFor({ locale: 'ja', next: '/files' }),
        sessionUser('u1'),
      ),
    )

    expect(response.headers.get('Set-Cookie')).toContain('__as_locale=ja')
    expect(response.headers.get('Location')).toBe('/files')
  })

  test('sets cookie only for anonymous users', async () => {
    seedUser(sqlite, 'u1', 'en')

    const response = await action(
      actionArgs(requestFor({ locale: 'ja' }), null),
    )

    expect(response.headers.get('Set-Cookie')).toContain('__as_locale=ja')
    expect(readUserLocale(sqlite, 'u1')).toBe('en')
  })

  test('falls back unsupported locale to en for cookie and users.locale', async () => {
    seedUser(sqlite, 'u1', 'ja')

    const response = await action(
      actionArgs(requestFor({ locale: 'xx' }), sessionUser('u1')),
    )

    expect(response.headers.get('Set-Cookie')).toContain('__as_locale=en')
    expect(readUserLocale(sqlite, 'u1')).toBe('en')
  })

  test('falls back unsupported locale to en for anonymous (cookie only)', async () => {
    seedUser(sqlite, 'u1', 'ja')

    const response = await action(
      actionArgs(requestFor({ locale: 'xx' }), null),
    )

    expect(response.headers.get('Set-Cookie')).toContain('__as_locale=en')
    expect(readUserLocale(sqlite, 'u1')).toBe('ja')
  })
})

function actionArgs(request: Request, user: SessionUser | null) {
  return {
    request,
    context: {
      get: () => user,
    },
  } as never
}

function requestFor(values: { locale: string; next?: string }) {
  const body = new FormData()
  body.set('locale', values.locale)
  if (values.next) body.set('next', values.next)
  return new Request('https://example.com/set-locale', {
    method: 'POST',
    body,
  })
}

function sessionUser(id: string): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    workspaceId: 'ws1',
    hd: 'example.com',
    msTenantId: null,
    locale: null,
  }
}

function seedUser(db: DatabaseSync, id: string, locale: string | null) {
  // workspaces is FK target now that migrations are loaded; idempotent
  // insert keeps multiple seedUser calls in a single test cheap.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, hd, name, created_at)
     VALUES ('ws1', NULL, 'Test', ?)`,
  ).run('2026-05-17T00:00:00Z')
  db.prepare(
    `INSERT INTO users (
      id, email, email_verified, name, image, created_at, updated_at,
      workspace_id, locale
    ) VALUES (?, ?, 1, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.com`,
    '2026-05-17T00:00:00Z',
    '2026-05-17T00:00:00Z',
    'ws1',
    locale,
  )
}

function readUserLocale(db: DatabaseSync, id: string) {
  return (
    db.prepare('SELECT locale FROM users WHERE id = ?').get(id) as {
      locale: string | null
    }
  ).locale
}

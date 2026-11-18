import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {}, waitUntil: undefined }))
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  recordSearchIndexLocation,
  rememberSearchIndexLocation,
  searchIndexLocation,
} from './placement.server'

test.each([
  ['JP', 'AS', undefined, 'apac-ne'],
  ['KR', 'AS', undefined, 'apac-ne'],
  ['TW', 'AS', undefined, 'apac-ne'],
  ['SG', 'AS', undefined, 'apac-se'],
  ['IN', 'AS', undefined, 'apac'],
  ['AU', 'OC', undefined, 'oc'],
  ['US', 'NA', '-122.4', 'wnam'],
  ['US', 'NA', '-74.0', 'enam'],
  ['US', 'NA', undefined, 'enam'],
  ['BR', 'SA', undefined, 'sam'],
  ['GB', 'EU', undefined, 'weur'],
  ['DE', 'EU', undefined, 'weur'],
  ['PL', 'EU', undefined, 'eeur'],
  ['ZA', 'AF', undefined, 'afr'],
  ['AE', 'AS', undefined, 'me'],
  [undefined, undefined, undefined, undefined],
  ['XX', 'T1', undefined, undefined],
])(
  'country %s on continent %s maps to %s',
  (country, continent, longitude, expected) => {
    expect(searchIndexLocation({ country, continent, longitude })).toBe(
      expected,
    )
  },
)

let fixture: ReturnType<typeof createMigratedInMemoryDb>
const now = '2026-11-18T00:00:00.000Z'
beforeEach(() => {
  fixture = createMigratedInMemoryDb()
  fixture.sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES('ws','Workspace','${now}');
    INSERT INTO users(id,email,email_verified,name,workspace_id,created_at,updated_at) VALUES
      ('member','member@example.com',1,'Member','ws','${now}','${now}'),
      ('removed','removed@example.com',1,'Removed','ws','${now}','${now}'),
      ('outsider','outsider@example.com',1,'Outsider','ws','${now}','${now}');
    INSERT INTO workspace_members(workspace_id,user_id,role,status,created_at,updated_at) VALUES
      ('ws','member','member','active','${now}','${now}'),
      ('ws','removed','member','removed','${now}','${now}');
  `)
})
afterEach(async () => {
  await fixture.db.destroy()
})
const recorded = () =>
  fixture.sqlite
    .prepare(
      'SELECT location_hint FROM search_index_workspaces WHERE workspace_id=?',
    )
    .get('ws')

test('only an active member records the location, and only once', async () => {
  const record = (userId: string, location: 'apac-ne' | 'weur') =>
    recordSearchIndexLocation(fixture.db, {
      workspaceId: 'ws',
      userId,
      location,
    })
  expect(await record('removed', 'weur')).toBeNull()
  expect(await record('outsider', 'weur')).toBeNull()
  expect(recorded()).toEqual({ location_hint: null })
  expect(await record('member', 'apac-ne')).toBe('apac-ne')
  expect(await record('member', 'weur')).toBe('apac-ne')
  // Another request finding it already recorded still sees the location.
  expect(await record('removed', 'weur')).toBe('apac-ne')
  expect(recorded()).toEqual({ location_hint: 'apac-ne' })
})

test('an existing dispatch row keeps its schedule and gains the location', async () => {
  fixture.sqlite.exec(
    `INSERT INTO search_index_workspaces(workspace_id,dispatched_at) VALUES('ws','${now}')`,
  )
  await recordSearchIndexLocation(fixture.db, {
    workspaceId: 'ws',
    userId: 'member',
    location: 'apac-ne',
  })
  expect(
    fixture.sqlite
      .prepare(
        'SELECT dispatched_at, location_hint FROM search_index_workspaces WHERE workspace_id=?',
      )
      .get('ws'),
  ).toEqual({ dispatched_at: now, location_hint: 'apac-ne' })
})

const request = (cf: Record<string, string>) =>
  Object.assign(new Request('https://example.test/'), { cf }) as Request
const japan = request({ country: 'JP', continent: 'AS' })

test('a member records after a non-member, and later requests skip the write', async () => {
  const pending: Promise<unknown>[] = []
  const background = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise)
  })
  const options = {
    background,
    open: <T>(run: (db: typeof fixture.db) => Promise<T>) => run(fixture.db),
    now: 0,
  }
  rememberSearchIndexLocation(
    japan,
    { id: 'removed', workspaceId: 'ws', kind: 'human' },
    options,
  )
  await Promise.all(pending)
  expect(recorded()).toEqual({ location_hint: null })
  // The same non-member is not retried for a while.
  rememberSearchIndexLocation(
    japan,
    { id: 'removed', workspaceId: 'ws', kind: 'human' },
    options,
  )
  expect(background).toHaveBeenCalledTimes(1)
  rememberSearchIndexLocation(
    japan,
    { id: 'member', workspaceId: 'ws', kind: 'human' },
    options,
  )
  await Promise.all(pending)
  expect(recorded()).toEqual({ location_hint: 'apac-ne' })
  rememberSearchIndexLocation(
    japan,
    { id: 'member', workspaceId: 'ws', kind: 'human' },
    options,
  )
  expect(background).toHaveBeenCalledTimes(2)
})

test('bots, unmapped regions and missing background work record nothing', () => {
  const background = vi.fn()
  const human = { id: 'member', workspaceId: 'ws-a', kind: 'human' as const }
  rememberSearchIndexLocation(japan, { ...human, kind: 'bot' }, { background })
  rememberSearchIndexLocation(
    request({ country: 'XX', continent: 'T1' }),
    human,
    { background },
  )
  rememberSearchIndexLocation(japan, human, { background: undefined })
  expect(background).not.toHaveBeenCalled()
})

test('a failed write or a refused waitUntil logs once and allows a retry', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const human = { id: 'member', workspaceId: 'ws-c', kind: 'human' as const }
  let release: () => void = () => {}
  const failing = () =>
    new Promise<never>((_, reject) => {
      release = () => reject(new Error('d1 unavailable'))
    })
  rememberSearchIndexLocation(japan, human, {
    background: () => {
      throw new Error('no request context')
    },
    open: failing,
  })
  // While the refused write still runs, the workspace is not retried.
  const background = vi.fn()
  rememberSearchIndexLocation(japan, human, { background, open: failing })
  expect(background).not.toHaveBeenCalled()
  release()
  await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2))
  expect(String(error.mock.calls[0][0])).toContain('no request context')
  expect(String(error.mock.calls[1][0])).toContain('d1 unavailable')
  rememberSearchIndexLocation(japan, human, { background, open: failing })
  expect(background).toHaveBeenCalledTimes(1)
  error.mockRestore()
})

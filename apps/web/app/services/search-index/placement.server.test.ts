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
  expect(await record('removed', 'weur')).toBe(false)
  expect(await record('outsider', 'weur')).toBe(false)
  expect(recorded()).toBeUndefined()
  expect(await record('member', 'apac-ne')).toBe(true)
  expect(recorded()).toEqual({ location_hint: 'apac-ne' })
  expect(await record('member', 'weur')).toBe(true)
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

test('bots, unmapped regions and missing background work record nothing', () => {
  const background = vi.fn()
  const request = (cf: Record<string, string>) =>
    Object.assign(new Request('https://example.test/'), { cf }) as Request
  const human = { id: 'member', workspaceId: 'ws-a', kind: 'human' as const }
  rememberSearchIndexLocation(
    request({ country: 'JP', continent: 'AS' }),
    { ...human, kind: 'bot' },
    background,
  )
  rememberSearchIndexLocation(
    request({ country: 'XX', continent: 'T1' }),
    human,
    background,
  )
  rememberSearchIndexLocation(
    request({ country: 'JP', continent: 'AS' }),
    human,
    undefined,
  )
  expect(background).not.toHaveBeenCalled()
})

test('a failure to start the background write does not fail the request', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const request = Object.assign(new Request('https://example.test/'), {
    cf: { country: 'JP', continent: 'AS' },
  }) as Request
  expect(() =>
    rememberSearchIndexLocation(
      request,
      { id: 'member', workspaceId: 'ws-b', kind: 'human' },
      () => {
        throw new Error('no request context')
      },
    ),
  ).not.toThrow()
  expect(String(error.mock.calls[0][0])).toContain('no request context')
  error.mockRestore()
})

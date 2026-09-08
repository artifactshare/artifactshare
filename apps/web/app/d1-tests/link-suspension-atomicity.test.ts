import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: { ['BETTER_AUTH_' + 'SECRET']: 'd1-test-secret-with-enough-entropy' },
}))

import { createDb } from '../services/db.server'
import {
  appealLinkSuspension,
  resumeLink,
  suspendLink,
} from '../services/link-suspension.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database

const at = '2026-09-08T00:00:00.000Z'
const ops = {
  credentialId: 'credential-atomic-1234567890',
  source: { kind: 'judgment' as const, id: 'judgment-atomic' },
  notify: async () => 'skipped' as const,
}

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  database = (await worker.getEnv()).DB
  await database.batch([
    database
      .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)')
      .bind('atomic-ws', 'Atomic', at),
    database
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at, workspace_id,
          google_sub, kind
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'human')`,
      )
      .bind(
        'atomic-owner',
        'atomic@example.com',
        'Owner',
        at,
        at,
        'atomic-ws',
        'atomic-owner-sub',
      ),
    database
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          created_at, updated_at
        ) VALUES ('atomic-inbox', 'atomic-ws', 'inbox', 'atomic-owner',
          'atomic-owner', 'Inbox', ?, ?)`,
      )
      .bind(at, at),
  ])
})

afterAll(async () => {
  await server.close()
})

async function seedShareable(id: string, suspended = false) {
  await database
    .prepare(
      `INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id, link_suspended_at
      ) VALUES (?, 'atomic-ws', 'atomic-owner', ?, 'html_page', 'link', ?, ?,
        'atomic-inbox', ?)`,
    )
    .bind(id, id, at, at, suspended ? '2026-09-08T01:00:00.000Z' : null)
    .run()
}

async function transitionCounts(shareableId: string) {
  const [event, audit, shareable] = await Promise.all([
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE shareable_id = ? AND type IN ('link_suspended', 'link_resumed')",
      )
      .bind(shareableId)
      .first<{ count: number }>(),
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE subject_id = ? AND action IN ('shareable.link.suspend', 'shareable.link.resume')",
      )
      .bind(shareableId)
      .first<{ count: number }>(),
    database
      .prepare('SELECT link_suspended_at FROM shareables WHERE id = ?')
      .bind(shareableId)
      .first<{ link_suspended_at: string | null }>(),
  ])
  return {
    events: Number(event?.count),
    audits: Number(audit?.count),
    suspendedAt: shareable?.link_suspended_at ?? null,
  }
}

function failStatement(source: D1Database, pattern: RegExp): D1Database {
  return new Proxy(source, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) =>
          pattern.test(query)
            ? target.prepare('INSERT INTO table_that_does_not_exist VALUES (1)')
            : target.prepare(query)
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe.sequential('link suspension D1 atomicity', () => {
  it('commits exactly one event, audit, and flag update under concurrent production transitions', async () => {
    const shareableId = 'atomic001a'
    await seedShareable(shareableId)
    const db = createDb(database)

    const results = await Promise.all([
      suspendLink(db, { ...ops, shareableId, reason: 'review' }),
      suspendLink(db, { ...ops, shareableId, reason: 'review' }),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual([
      'already',
      'suspended',
    ])
    expect(await transitionCounts(shareableId)).toEqual({
      events: 1,
      audits: 1,
      suspendedAt: expect.any(String),
    })
  })

  it.each([
    ['audit insert', /insert into "audit_events"/u],
    ['shareable update', /update "shareables"/u],
  ])(
    'rolls back every production transition statement when the %s fails',
    async (_, pattern) => {
      const shareableId = pattern.source.includes('audit')
        ? 'atomic003a'
        : 'atomic004a'
      await seedShareable(shareableId)
      const db = createDb(failStatement(database, pattern))

      await expect(
        suspendLink(db, { ...ops, shareableId, reason: 'review' }),
      ).rejects.toThrow()

      expect(await transitionCounts(shareableId)).toEqual({
        events: 0,
        audits: 0,
        suspendedAt: null,
      })
    },
  )

  it('serializes an appeal racing a resume through the production batches', async () => {
    const shareableId = 'atomic005a'
    await seedShareable(shareableId, true)
    const db = createDb(database)

    const [appeal, resumed] = await Promise.all([
      appealLinkSuspension(
        db,
        { id: 'atomic-owner' },
        {
          shareableId,
          message: 'Please review',
          now: '2026-09-08T02:00:00.000Z',
        },
      ),
      resumeLink(db, { ...ops, shareableId }),
    ])
    const appealCount = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE shareable_id = ? AND type = 'link_appealed'",
      )
      .bind(shareableId)
      .first<{ count: number }>()

    expect(resumed.kind).toBe('resumed')
    expect(['appealed', 'not-suspended']).toContain(appeal.kind)
    expect(Number(appealCount?.count)).toBe(appeal.kind === 'appealed' ? 1 : 0)
    expect((await transitionCounts(shareableId)).suspendedAt).toBeNull()
  })

  it('classifies concurrent appeals from the production transactional batch', async () => {
    const shareableId = 'atomic002a'
    await seedShareable(shareableId, true)
    const db = createDb(database)
    const appeal = () =>
      appealLinkSuspension(
        db,
        { id: 'atomic-owner' },
        {
          shareableId,
          message: 'Please review',
          now: '2026-09-08T02:00:00.000Z',
        },
      )

    const results = await Promise.all([appeal(), appeal()])
    const count = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE shareable_id = ? AND type = 'link_appealed'",
      )
      .bind(shareableId)
      .first<{ count: number }>()

    expect(results.map((result) => result.kind).sort()).toEqual([
      'appealed',
      'cooldown',
    ])
    expect(Number(count?.count)).toBe(1)
  })
})

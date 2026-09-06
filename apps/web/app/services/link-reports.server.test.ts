import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { recordLinkReport } from './link-reports.server'

describe('recordLinkReport', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws123abcde',
        name: 'Test workspace',
        created_at: '2026-01-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'user123abc',
        email: 'owner@example.test',
        email_verified: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        workspace_id: 'ws123abcde',
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox12345',
        workspace_id: 'ws123abcde',
        kind: 'inbox',
        owner_user_id: 'user123abc',
        created_by_id: 'user123abc',
        name: 'Inbox',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
    vi.restoreAllMocks()
  })

  async function insertShareable(id: string, visibility: 'link' | 'private') {
    await db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: 'ws123abcde',
        owner_user_id: 'user123abc',
        name: 'Shared page',
        artifact_kind: 'html_page',
        visibility,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        container_id: 'inbox12345',
      })
      .execute()
  }

  test('inserts a report event and emits the alert marker for a current link', async () => {
    await insertShareable('abc123def4', 'link')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viewerUrl = 'https://abc123def4.artifactshare.link/'

    await expect(
      recordLinkReport(
        db,
        'abc123def4',
        { reason: 'malware', note: 'Unexpected download', viewerUrl },
        '2026-09-06T00:00:00.000Z',
      ),
    ).resolves.toBe('recorded')

    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('type', '=', 'link_reported')
      .executeTakeFirstOrThrow()
    expect(event.actor_user_id).toBeNull()
    expect(event.shareable_id).toBe('abc123def4')
    expect(event.subject_id).toHaveLength(21)
    expect(JSON.parse(event.payload!)).toEqual({
      reason: 'malware',
      note: 'Unexpected download',
      viewerUrl,
    })
    expect(warn).toHaveBeenCalledWith('artifactshare_link_report', {
      shareableId: 'abc123def4',
      workspaceId: 'ws123abcde',
      reason: 'malware',
      viewerUrl,
    })
  })

  test('does not insert or log for a non-link artifact', async () => {
    await insertShareable('link123abc', 'private')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      recordLinkReport(db, 'link123abc', {
        reason: 'other',
        note: null,
        viewerUrl: 'https://link123abc.artifactshare.link/',
      }),
    ).resolves.toBe('not-found')
    await expect(
      db.selectFrom('events').select('id').execute(),
    ).resolves.toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  test('suppresses the twenty-first report within 24 hours', async () => {
    await insertShareable('site123abc', 'link')
    for (const reportIndex of Array.from(
      { length: 20 },
      (_, itemIndex) => itemIndex,
    )) {
      await db
        .insertInto('events')
        .values({
          id: `report-${reportIndex}`,
          workspace_id: 'ws123abcde',
          type: 'link_reported' as const,
          shareable_id: 'site123abc',
          actor_user_id: null,
          subject_id: `subject-${reportIndex}`,
          payload: JSON.stringify({ reason: 'other' }),
          created_at: `2026-09-06T${String(reportIndex).padStart(2, '0')}:00:00.000Z`,
        })
        .execute()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      recordLinkReport(
        db,
        'site123abc',
        {
          reason: 'phishing',
          note: null,
          viewerUrl: 'https://site123abc.artifactshare.link/',
        },
        '2026-09-07T00:00:00.000Z',
      ),
    ).resolves.toBe('suppressed')
    await expect(
      db
        .selectFrom('events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('type', '=', 'link_reported')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 20 })
    expect(warn).not.toHaveBeenCalled()
  })
})

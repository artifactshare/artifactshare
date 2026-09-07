import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1BatchDbMock({ sqlite: sqliteRef }) },
}))

import { checkAnonymousLinkAccess } from './link-sharing.server'
import {
  appealLinkSuspension,
  linkSuspensionState,
  resumeLink,
  suspendLink,
  type OwnerNotice,
} from './link-suspension.server'

describe('link suspension', () => {
  let db: Kysely<DB>
  const at = '2026-09-07T00:00:00.000Z'

  beforeEach(async () => {
    const fixture = createD1BatchFixture({ sqlite: sqliteRef })
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-free',
        hd: null,
        name: 'Free',
        created_at: at,
        plan: 'free',
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      })
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: 'owner',
          email: 'owner@example.com',
          email_verified: 1,
          name: 'Owner',
          image: null,
          created_at: at,
          updated_at: at,
          workspace_id: 'ws-free',
          locale: null,
        },
        {
          id: 'other',
          email: 'other@example.com',
          email_verified: 1,
          name: 'Other',
          image: null,
          created_at: at,
          updated_at: at,
          workspace_id: 'ws-free',
          locale: null,
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox-free',
        workspace_id: 'ws-free',
        kind: 'inbox',
        owner_user_id: 'owner',
        created_by_id: 'owner',
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: at,
        updated_at: at,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values([
        {
          id: 'linked0001',
          workspace_id: 'ws-free',
          owner_user_id: 'owner',
          name: 'report.html',
          artifact_kind: 'html_page',
          visibility: 'link',
          container_id: 'inbox-free',
          created_at: at,
          updated_at: at,
          link_expires_at: null,
        },
        {
          id: 'private001',
          workspace_id: 'ws-free',
          owner_user_id: 'owner',
          name: 'draft.html',
          artifact_kind: 'html_page',
          visibility: 'private',
          container_id: 'inbox-free',
          created_at: at,
          updated_at: at,
          link_expires_at: null,
        },
      ])
      .execute()
  })

  afterEach(() => {
    sqliteRef.current?.close()
    sqliteRef.current = null
    vi.restoreAllMocks()
  })

  test('an operator pauses and resumes a link; the owner is told and can appeal once an hour', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const notices: OwnerNotice[] = []
    const notify = async (notice: OwnerNotice) => {
      notices.push(notice)
      return 'sent' as const
    }

    expect(
      await suspendLink(db, {
        shareableId: 'private001',
        reason: 'x',
        notify,
      }),
    ).toEqual({ kind: 'not-link' })
    expect(
      await suspendLink(db, { shareableId: 'missing000', reason: 'x', notify }),
    ).toEqual({ kind: 'not-found' })

    expect(
      await suspendLink(db, {
        shareableId: 'linked0001',
        reason: '  Phishing form  ',
        judgmentId: 'judg-1',
        now: '2026-09-07T01:00:00.000Z',
        notify,
      }),
    ).toEqual({ kind: 'suspended', ownerNotice: 'sent' })
    expect(await checkAnonymousLinkAccess(db, 'linked0001')).toEqual({
      kind: 'suspended',
      reason: 'Phishing form',
      expired: false,
    })
    expect(await linkSuspensionState(db, 'linked0001')).toMatchObject({
      suspendedAt: '2026-09-07T01:00:00.000Z',
      suspendedReason: 'Phishing form',
    })
    expect(
      await suspendLink(db, {
        shareableId: 'linked0001',
        reason: 'again',
        notify,
      }),
    ).toEqual({ kind: 'already' })
    expect(notices).toEqual([
      {
        kind: 'suspended',
        shareableId: 'linked0001',
        title: 'report.html',
        ownerEmail: 'owner@example.com',
        reason: 'Phishing form',
      },
    ])

    // Appeals: owner only, once per hour, only while paused.
    expect(
      await appealLinkSuspension(
        db,
        { id: 'other' },
        { shareableId: 'linked0001', message: 'mine' },
      ),
    ).toEqual({ kind: 'forbidden' })
    expect(
      await appealLinkSuspension(
        db,
        { id: 'owner' },
        {
          shareableId: 'linked0001',
          message: 'This is our internal report.',
          now: '2026-09-07T02:00:00.000Z',
        },
      ),
    ).toEqual({ kind: 'appealed' })
    expect(
      await appealLinkSuspension(
        db,
        { id: 'owner' },
        {
          shareableId: 'linked0001',
          message: 'again',
          now: '2026-09-07T02:30:00.000Z',
        },
      ),
    ).toEqual({ kind: 'cooldown' })

    expect(
      await resumeLink(db, {
        shareableId: 'linked0001',
        judgmentId: 'judg-1',
        now: '2026-09-07T03:00:00.000Z',
        notify,
      }),
    ).toEqual({ kind: 'resumed', ownerNotice: 'sent' })
    expect((await checkAnonymousLinkAccess(db, 'linked0001')).kind).toBe(
      'allowed',
    )
    expect(await resumeLink(db, { shareableId: 'linked0001', notify })).toEqual(
      { kind: 'already' },
    )
    expect(
      await appealLinkSuspension(
        db,
        { id: 'owner' },
        { shareableId: 'linked0001', message: 'now?' },
      ),
    ).toEqual({ kind: 'not-suspended' })
    expect(notices.at(-1)).toMatchObject({ kind: 'resumed' })

    const events = await db
      .selectFrom('events')
      .select(['type', 'actor_user_id', 'payload'])
      .where('shareable_id', '=', 'linked0001')
      .orderBy('created_at', 'asc')
      .execute()
    expect(events).toEqual([
      {
        type: 'link_suspended',
        actor_user_id: null,
        payload: JSON.stringify({
          reason: 'Phishing form',
          judgmentId: 'judg-1',
        }),
      },
      {
        type: 'link_appealed',
        actor_user_id: 'owner',
        payload: JSON.stringify({ message: 'This is our internal report.' }),
      },
      {
        type: 'link_resumed',
        actor_user_id: null,
        payload: JSON.stringify({ judgmentId: 'judg-1' }),
      },
    ])
  })
})

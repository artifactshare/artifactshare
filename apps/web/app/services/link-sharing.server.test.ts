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

import {
  checkAnonymousLinkAccess,
  reopenExpiredLink,
  resolveLinkSharingWrite,
  updateWorkspaceExternalAccessPolicy,
} from './link-sharing.server'
import type { startLinkAbuseJudgment } from './link-abuse-signals.server'

const OWNER = { id: 'owner-1', workspaceId: 'ws-team' } as const
const ADMIN = { id: 'admin-1', workspaceId: 'ws-team' } as const

describe('workspace link-sharing service', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createD1BatchFixture({ sqlite: sqliteRef })
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-team',
        hd: 'team.example',
        name: 'Team',
        created_at: '2026-07-20T00:00:00.000Z',
        plan: 'team',
        link_sharing_enabled: 1,
        external_posting_enabled: 1,
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      })
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: OWNER.id,
          email: 'owner@example.com',
          email_verified: 1,
          name: 'Owner',
          image: null,
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
          workspace_id: 'ws-team',
          locale: null,
        },
        {
          id: ADMIN.id,
          email: 'admin@example.com',
          email_verified: 1,
          name: 'Admin',
          image: null,
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
          workspace_id: 'ws-team',
          locale: null,
        },
      ])
      .execute()
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: 'ws-team',
          user_id: OWNER.id,
          role: 'owner',
          status: 'active',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
        },
        {
          workspace_id: 'ws-team',
          user_id: ADMIN.id,
          role: 'admin',
          status: 'active',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox-team',
        workspace_id: 'ws-team',
        kind: 'inbox',
        owner_user_id: OWNER.id,
        created_by_id: OWNER.id,
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: '2026-07-20T00:00:00.000Z',
        updated_at: '2026-07-20T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values([
        {
          id: 'unlimited-link',
          workspace_id: 'ws-team',
          owner_user_id: OWNER.id,
          name: 'unlimited.html',
          artifact_kind: 'html_page',
          visibility: 'link',
          container_id: 'inbox-team',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
          link_expires_at: null,
        },
        {
          id: 'long-link',
          workspace_id: 'ws-team',
          owner_user_id: OWNER.id,
          name: 'long.html',
          artifact_kind: 'html_page',
          visibility: 'link',
          container_id: 'inbox-team',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
          link_expires_at: '2099-01-01T00:00:00.000Z',
        },
        {
          id: 'short-link',
          workspace_id: 'ws-team',
          owner_user_id: OWNER.id,
          name: 'short.html',
          artifact_kind: 'html_page',
          visibility: 'link',
          container_id: 'inbox-team',
          created_at: '2026-07-20T00:00:00.000Z',
          updated_at: '2026-07-20T00:00:00.000Z',
          link_expires_at: '2026-07-25T00:00:00.000Z',
        },
      ])
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('shortens unlimited and over-limit links without extending existing finite links', async () => {
    const result = await updateWorkspaceExternalAccessPolicy(
      db,
      ADMIN,
      { linkExpiryDefaultDays: 30, linkExpiryMaxDays: 30 },
      '2026-07-20T00:00:00.000Z',
    )

    expect(result).toMatchObject({ kind: 'ok', shortenedLinkCount: 2 })
    await expect(
      db
        .selectFrom('shareables')
        .select(['id', 'link_expires_at'])
        .orderBy('id')
        .execute(),
    ).resolves.toEqual([
      { id: 'long-link', link_expires_at: '2026-08-19T00:00:00.000Z' },
      { id: 'short-link', link_expires_at: '2026-07-25T00:00:00.000Z' },
      { id: 'unlimited-link', link_expires_at: '2026-08-19T00:00:00.000Z' },
    ])
    const event = await db
      .selectFrom('audit_events')
      .select(['actor_user_id', 'action', 'detail'])
      .executeTakeFirstOrThrow()
    expect(event.actor_user_id).toBe(ADMIN.id)
    expect(event.action).toBe('workspace.external_access.change')
    expect(event.detail).toContain('"shortened_link_count":2')

    const extension = await updateWorkspaceExternalAccessPolicy(
      db,
      OWNER,
      { linkExpiryMaxDays: 90 },
      '2026-07-20T00:00:00.000Z',
    )
    expect(extension).toMatchObject({ kind: 'ok', shortenedLinkCount: 0 })
    await expect(
      db
        .selectFrom('shareables')
        .select('link_expires_at')
        .where('id', '=', 'long-link')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ link_expires_at: '2026-08-19T00:00:00.000Z' })
  })

  test('Team admins can disable links and the read-time decision follows it', async () => {
    const result = await updateWorkspaceExternalAccessPolicy(
      db,
      ADMIN,
      { linkSharingEnabled: false, externalPostingEnabled: false },
      '2026-07-20T00:00:00.000Z',
    )
    expect(result.kind).toBe('ok')
    await expect(
      checkAnonymousLinkAccess(
        db,
        'unlimited-link',
        '2026-07-20T00:00:00.000Z',
      ),
    ).resolves.toEqual({ kind: 'disabled' })

    await db
      .updateTable('shareables')
      .set({ link_expires_at: '2026-07-19T00:00:00.000Z' })
      .where('id', '=', 'short-link')
      .execute()
    await expect(
      updateWorkspaceExternalAccessPolicy(db, ADMIN, {
        linkSharingEnabled: true,
      }),
    ).resolves.toMatchObject({ kind: 'ok' })
    await expect(
      checkAnonymousLinkAccess(db, 'short-link', '2026-07-20T00:00:00.000Z'),
    ).resolves.toEqual({ kind: 'expired' })
  })

  test('a Plus owner can resume a policy carried from Team but cannot disable it', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 0 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await expect(
      checkAnonymousLinkAccess(
        db,
        'unlimited-link',
        '2026-07-20T00:00:00.000Z',
      ),
    ).resolves.toEqual({ kind: 'disabled' })
    await expect(
      updateWorkspaceExternalAccessPolicy(db, OWNER, {
        linkSharingEnabled: true,
      }),
    ).resolves.toMatchObject({ kind: 'ok' })
    await expect(
      updateWorkspaceExternalAccessPolicy(db, OWNER, {
        linkSharingEnabled: false,
      }),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('a Free owner can resume link sharing but cannot enable external posting', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'free',
        link_sharing_enabled: 0,
        external_posting_enabled: 1,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await expect(
      updateWorkspaceExternalAccessPolicy(db, OWNER, {
        linkSharingEnabled: true,
      }),
    ).resolves.toMatchObject({ kind: 'ok' })
    await expect(
      db
        .selectFrom('workspaces')
        .select(['link_sharing_enabled', 'external_posting_enabled'])
        .where('id', '=', OWNER.workspaceId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ link_sharing_enabled: 1, external_posting_enabled: 1 })
    await expect(
      checkAnonymousLinkAccess(
        db,
        'unlimited-link',
        '2026-07-20T00:00:00.000Z',
      ),
    ).resolves.toMatchObject({ kind: 'allowed' })
    await expect(
      updateWorkspaceExternalAccessPolicy(db, OWNER, {
        externalPostingEnabled: true,
      }),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('rejects policy changes from a non-admin Team member', async () => {
    await expect(
      updateWorkspaceExternalAccessPolicy(
        db,
        { id: 'member-1', workspaceId: 'ws-team' },
        { linkSharingEnabled: false },
      ),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('rejects an unlimited default with a finite maximum', async () => {
    await expect(
      updateWorkspaceExternalAccessPolicy(db, OWNER, {
        linkExpiryDefaultDays: null,
        linkExpiryMaxDays: 30,
      }),
    ).resolves.toEqual({ kind: 'invalid-policy', field: 'relationship' })
  })

  test('lets a Team admin republish an expired link with the policy default', async () => {
    await db
      .updateTable('shareables')
      .set({ link_expires_at: '2026-07-19T00:00:00.000Z' })
      .where('id', '=', 'short-link')
      .execute()

    await expect(
      reopenExpiredLink(db, ADMIN, 'short-link', '2026-07-20T00:00:00.000Z'),
    ).resolves.toEqual({
      kind: 'ok',
      linkExpiresAt: '2026-08-19T00:00:00.000Z',
    })
    await expect(
      db
        .selectFrom('shareables')
        .select('link_expires_at')
        .where('id', '=', 'short-link')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ link_expires_at: '2026-08-19T00:00:00.000Z' })
    await expect(
      db
        .selectFrom('audit_events')
        .select(['actor_user_id', 'action'])
        .where('action', '=', 'shareable.link.reopen')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      actor_user_id: ADMIN.id,
      action: 'shareable.link.reopen',
    })
  })

  test('a new Free workspace is refused its next link after the daily limit and a judgment starts', async () => {
    const now = '2026-09-07T12:00:00.000Z'
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-free',
        hd: null,
        name: 'Free',
        created_at: '2026-09-05T00:00:00.000Z',
        plan: 'free',
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'free-owner',
        email: 'free@example.com',
        email_verified: 1,
        name: 'Free',
        image: null,
        created_at: '2026-09-05T00:00:00.000Z',
        updated_at: '2026-09-05T00:00:00.000Z',
        workspace_id: 'ws-free',
        locale: null,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox-free',
        workspace_id: 'ws-free',
        kind: 'inbox',
        owner_user_id: 'free-owner',
        created_by_id: 'free-owner',
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: '2026-09-05T00:00:00.000Z',
        updated_at: '2026-09-05T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values(
        ['free-a', 'free-b', 'free-c', 'free-d'].map((id) => ({
          id,
          workspace_id: 'ws-free',
          owner_user_id: 'free-owner',
          name: `${id}.html`,
          artifact_kind: 'html_page',
          visibility: 'link',
          container_id: 'inbox-free',
          // free-d was uploaded as a link inside the window (no event).
          created_at:
            id === 'free-d'
              ? '2026-09-07T10:00:00.000Z'
              : '2026-09-05T00:00:00.000Z',
          updated_at: '2026-09-05T00:00:00.000Z',
          link_expires_at: null,
        })),
      )
      .execute()
    // Two link publications by event inside the window, one outside it; with
    // the uploaded free-d that is three publications in the window.
    await db
      .insertInto('events')
      .values([
        {
          id: 'ev-old',
          workspace_id: 'ws-free',
          type: 'visibility_changed',
          shareable_id: 'free-a',
          actor_user_id: 'free-owner',
          subject_id: 'free-a',
          payload: JSON.stringify({ from: 'private', to: 'link' }),
          created_at: '2026-09-05T06:00:00.000Z',
        },
        {
          id: 'ev-1',
          workspace_id: 'ws-free',
          type: 'visibility_changed',
          shareable_id: 'free-b',
          actor_user_id: 'free-owner',
          subject_id: 'free-b',
          payload: JSON.stringify({ from: 'private', to: 'link' }),
          created_at: '2026-09-07T01:00:00.000Z',
        },
        {
          id: 'ev-2',
          workspace_id: 'ws-free',
          type: 'visibility_changed',
          shareable_id: 'free-c',
          actor_user_id: 'free-owner',
          subject_id: 'free-c',
          payload: JSON.stringify({ from: 'private', to: 'link' }),
          created_at: '2026-09-07T09:00:00.000Z',
        },
      ])
      .execute()
    const judge = vi.fn<typeof startLinkAbuseJudgment>(async () => ({
      kind: 'started' as const,
    }))
    const write = (overrides: { dailyLimit?: number; plan?: string } = {}) =>
      resolveLinkSharingWrite(db, {
        workspaceId: 'ws-free',
        currentVisibility: 'private',
        currentLinkExpiresAt: null,
        nextVisibility: 'link',
        now,
        rateLimit: {
          accountAgeDays: 14,
          dailyLimit: overrides.dailyLimit ?? 2,
        },
        judge,
      })

    const refused = await write()
    expect(refused).toEqual({
      kind: 'link-publish-rate-limited',
      limit: 2,
      // Of the three, the two newest count (09:00, 10:00); room returns when
      // the 09:00 publication leaves the window, 21 hours from noon.
      retryAfterSeconds: 21 * 3600,
    })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]?.[2]).toMatchObject({
      shareableId: 'free-d',
      trigger: 'publish_burst',
    })

    // At the limit the write is refused; above it, it proceeds without a judgment.
    expect((await write({ dailyLimit: 3 })).kind).toBe(
      'link-publish-rate-limited',
    )
    expect((await write({ dailyLimit: 4 })).kind).toBe('ok')
    // An upload flipped to link inside the window is one publication, not two.
    await db
      .insertInto('events')
      .values({
        id: 'ev-3',
        workspace_id: 'ws-free',
        type: 'visibility_changed',
        shareable_id: 'free-d',
        actor_user_id: 'free-owner',
        subject_id: 'free-d',
        payload: JSON.stringify({ from: 'private', to: 'link' }),
        created_at: '2026-09-07T11:00:00.000Z',
      })
      .execute()
    expect((await write({ dailyLimit: 4 })).kind).toBe('ok')
    // Re-saving an existing link is not a new publication.
    expect(
      (
        await resolveLinkSharingWrite(db, {
          workspaceId: 'ws-free',
          currentVisibility: 'link',
          currentLinkExpiresAt: null,
          nextVisibility: 'link',
          now,
          rateLimit: { accountAgeDays: 14, dailyLimit: 2 },
          judge,
        })
      ).kind,
    ).toBe('ok')
    // An established workspace is never limited.
    await db
      .updateTable('workspaces')
      .set({ created_at: '2026-08-01T00:00:00.000Z' })
      .where('id', '=', 'ws-free')
      .execute()
    expect((await write()).kind).toBe('ok')
    expect(judge).toHaveBeenCalledTimes(2)
  })
})

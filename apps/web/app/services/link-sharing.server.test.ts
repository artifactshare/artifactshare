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
  updateWorkspaceExternalAccessPolicy,
} from './link-sharing.server'

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
})

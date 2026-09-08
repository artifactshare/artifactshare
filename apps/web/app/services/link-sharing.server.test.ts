import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null,
}))
const runtimeVars = vi.hoisted(() => ({
  accountAgeDays: undefined as string | undefined,
  dailyLimit: undefined as string | undefined,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
    get LINK_LOW_TRUST_ACCOUNT_AGE_DAYS() {
      return runtimeVars.accountAgeDays
    },
    get LINK_NEW_ACCOUNT_LINK_PUBLISH_DAILY_LIMIT() {
      return runtimeVars.dailyLimit
    },
  },
}))

import {
  buildLinkPublishRateLimitFailure,
  checkAnonymousLinkAccess,
  cleanupExpiredLinkPublications,
  linkPublicationAttemptValues,
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
    runtimeVars.accountAgeDays = undefined
    runtimeVars.dailyLimit = undefined
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

  test('publication cleanup retains one millisecond inside and removes the boundary', async () => {
    await db
      .insertInto('link_publications')
      .values([
        {
          workspace_id: 'ws-team',
          shareable_id: 'boundary',
          latest_published_at: '2026-09-07T12:00:00.000Z',
        },
        {
          workspace_id: 'ws-team',
          shareable_id: 'inside',
          latest_published_at: '2026-09-07T12:00:00.001Z',
        },
      ])
      .execute()

    await cleanupExpiredLinkPublications(db, '2026-09-08T12:00:00.000Z')

    await expect(
      db
        .selectFrom('link_publications')
        .select('shareable_id')
        .orderBy('shareable_id')
        .execute(),
    ).resolves.toEqual([{ shareable_id: 'inside' }])
  })

  test.each([
    {
      name: 'an invalid request timestamp',
      workspaceId: 'ws-team',
      now: 'not-a-timestamp',
      plan: 'free',
      createdAt: '2026-09-08T00:00:00.000Z',
      configuredLimit: undefined,
      expectedLimit: 20,
      expectedApplies: 0,
      expectedWindowStart: 'not-a-timestamp',
    },
    {
      name: 'a missing workspace',
      workspaceId: 'missing-workspace',
      now: '2026-09-08T12:00:00.000Z',
      plan: null,
      createdAt: null,
      configuredLimit: undefined,
      expectedLimit: 20,
      expectedApplies: 0,
      expectedWindowStart: '2026-09-07T12:00:00.000Z',
    },
    {
      name: 'a zero configured limit',
      workspaceId: 'ws-team',
      now: '2026-09-08T12:00:00.000Z',
      plan: 'free',
      createdAt: '2026-09-08T00:00:00.000Z',
      configuredLimit: '0',
      expectedLimit: 0,
      expectedApplies: 0,
      expectedWindowStart: '2026-09-07T12:00:00.000Z',
    },
    {
      name: 'an exempt plan',
      workspaceId: 'ws-team',
      now: '2026-09-08T12:00:00.000Z',
      plan: 'team',
      createdAt: '2026-09-08T00:00:00.000Z',
      configuredLimit: undefined,
      expectedLimit: 20,
      expectedApplies: 0,
      expectedWindowStart: '2026-09-07T12:00:00.000Z',
    },
    {
      name: 'an established Free workspace',
      workspaceId: 'ws-team',
      now: '2026-09-08T12:00:00.000Z',
      plan: 'free',
      createdAt: '2026-08-01T00:00:00.000Z',
      configuredLimit: undefined,
      expectedLimit: 20,
      expectedApplies: 0,
      expectedWindowStart: '2026-09-07T12:00:00.000Z',
    },
    {
      name: 'a malformed workspace creation timestamp',
      workspaceId: 'ws-team',
      now: '2026-09-08T12:00:00.000Z',
      plan: 'free',
      createdAt: 'malformed-created-at',
      configuredLimit: undefined,
      expectedLimit: 20,
      expectedApplies: 1,
      expectedWindowStart: '2026-09-07T12:00:00.000Z',
    },
  ])(
    'builds a plain unconsumed publication attempt for $name',
    async ({
      workspaceId,
      now,
      plan,
      createdAt,
      configuredLimit,
      expectedLimit,
      expectedApplies,
      expectedWindowStart,
    }) => {
      runtimeVars.dailyLimit = configuredLimit
      if (plan !== null && createdAt !== null) {
        await db
          .updateTable('workspaces')
          .set({ plan, created_at: createdAt })
          .where('id', '=', workspaceId)
          .execute()
      }

      await expect(
        linkPublicationAttemptValues(db, {
          workspaceId,
          shareableId: 'attempt-candidate',
          now,
        }),
      ).resolves.toEqual({
        workspace_id: workspaceId,
        shareable_id: 'attempt-candidate',
        published_at: now,
        window_start: expectedWindowStart,
        daily_limit: expectedLimit,
        limit_applies: expectedApplies,
        consumed: 0,
      })
    },
  )

  test('uses a one-second retry for an actual short ledger read without judging the refused artifact', async () => {
    await db
      .insertInto('link_publications')
      .values({
        workspace_id: 'ws-team',
        shareable_id: 'unlimited-link',
        latest_published_at: '2026-09-08T11:00:00.000Z',
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'shareable_id']).doUpdateSet({
          latest_published_at: (eb) => eb.ref('excluded.latest_published_at'),
        }),
      )
      .execute()
    const judge = vi.fn<typeof startLinkAbuseJudgment>(async () => ({
      kind: 'started' as const,
    }))

    await expect(
      buildLinkPublishRateLimitFailure(db, {
        workspaceId: 'ws-team',
        refusedShareableId: 'unlimited-link',
        now: '2026-09-08T12:00:00.000Z',
        rateLimit: { accountAgeDays: 14, dailyLimit: 2 },
        judge,
      }),
    ).resolves.toEqual({
      kind: 'link-publish-rate-limited',
      limit: 2,
      retryAfterSeconds: 1,
    })
    expect(judge).not.toHaveBeenCalled()
  })

  test('selects the newest live judgment candidate after excluding and deleting artifacts', async () => {
    await db
      .insertInto('link_publications')
      .values([
        {
          workspace_id: 'ws-team',
          shareable_id: 'short-link',
          latest_published_at: '2026-09-08T11:30:00.000Z',
        },
        {
          workspace_id: 'ws-team',
          shareable_id: 'unlimited-link',
          latest_published_at: '2026-09-08T11:00:00.000Z',
        },
        {
          workspace_id: 'ws-team',
          shareable_id: 'long-link',
          latest_published_at: '2026-09-08T10:00:00.000Z',
        },
      ])
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'shareable_id']).doUpdateSet({
          latest_published_at: (eb) => eb.ref('excluded.latest_published_at'),
        }),
      )
      .execute()
    const judge = vi.fn<typeof startLinkAbuseJudgment>(async () => ({
      kind: 'started' as const,
    }))
    const build = () =>
      buildLinkPublishRateLimitFailure(db, {
        workspaceId: 'ws-team',
        refusedShareableId: 'short-link',
        now: '2026-09-08T12:00:00.000Z',
        rateLimit: { accountAgeDays: 14, dailyLimit: 3 },
        judge,
      })

    await build()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]?.[2]).toMatchObject({
      shareableId: 'unlimited-link',
      trigger: 'publish_burst',
    })

    await db
      .deleteFrom('shareables')
      .where('id', '=', 'unlimited-link')
      .execute()
    await build()
    expect(judge).toHaveBeenCalledTimes(2)
    expect(judge.mock.calls[1]?.[2]).toMatchObject({
      shareableId: 'long-link',
      trigger: 'publish_burst',
    })

    await db.deleteFrom('shareables').where('id', '=', 'long-link').execute()
    await build()
    expect(judge).toHaveBeenCalledTimes(2)
  })

  test('uses distinct retry fallbacks for malformed full windows and post-trigger short reads', async () => {
    const common = {
      workspaceId: 'ws-team',
      refusedShareableId: 'candidate',
      now: '2026-09-08T12:00:00.000Z',
      rateLimit: { accountAgeDays: 14, dailyLimit: 2 },
    }
    await expect(
      buildLinkPublishRateLimitFailure(db, {
        ...common,
        published: [
          {
            shareable_id: 'newest',
            latest_published_at: '2026-09-08T10:00:00.000Z',
          },
          {
            shareable_id: 'malformed-oldest',
            latest_published_at: 'not-a-timestamp',
          },
        ],
      }),
    ).resolves.toMatchObject({ retryAfterSeconds: 24 * 60 * 60 })
    await expect(
      buildLinkPublishRateLimitFailure(db, {
        ...common,
        published: [
          {
            shareable_id: 'only-row-left',
            latest_published_at: '2026-09-08T10:00:00.000Z',
          },
        ],
      }),
    ).resolves.toMatchObject({ retryAfterSeconds: 1 })

    await db
      .insertInto('link_publications')
      .values([
        {
          workspace_id: 'ws-team',
          shareable_id: 'unlimited-link',
          latest_published_at: '2026-09-08T11:00:00.000Z',
        },
        {
          workspace_id: 'ws-team',
          shareable_id: 'long-link',
          latest_published_at: '2026-09-08T10:00:00.000Z',
        },
      ])
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'shareable_id']).doUpdateSet({
          latest_published_at: (eb) => eb.ref('excluded.latest_published_at'),
        }),
      )
      .execute()
    const judge = vi.fn<typeof startLinkAbuseJudgment>(async () => ({
      kind: 'started' as const,
    }))
    await buildLinkPublishRateLimitFailure(db, {
      ...common,
      refusedShareableId: 'unlimited-link',
      judge,
      published: [
        {
          shareable_id: 'unlimited-link',
          latest_published_at: '2026-09-08T11:00:00.000Z',
        },
        {
          shareable_id: 'long-link',
          latest_published_at: '2026-09-08T10:00:00.000Z',
        },
      ],
    })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]?.[2]).toMatchObject({
      shareableId: 'long-link',
      trigger: 'publish_burst',
    })
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
    await db
      .updateTable('shareables')
      .set({ visibility: 'private' })
      .where('id', '=', 'free-d')
      .execute()
    // Legacy events no longer drive the limit. The durable ledger retains one
    // greatest timestamp for each published artifact.
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
    await db
      .insertInto('link_publications')
      .values([
        {
          workspace_id: 'ws-free',
          shareable_id: 'free-b',
          latest_published_at: '2026-09-07T01:00:00.000Z',
        },
        {
          workspace_id: 'ws-free',
          shareable_id: 'free-c',
          latest_published_at: '2026-09-07T09:00:00.000Z',
        },
        {
          workspace_id: 'ws-free',
          shareable_id: 'free-d',
          latest_published_at: '2026-09-07T10:00:00.000Z',
        },
      ])
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'shareable_id']).doUpdateSet({
          latest_published_at: (eb) => eb.ref('excluded.latest_published_at'),
        }),
      )
      .execute()
    const judge = vi.fn<typeof startLinkAbuseJudgment>(async () => ({
      kind: 'started' as const,
    }))
    const write = (overrides: { dailyLimit?: number; plan?: string } = {}) =>
      resolveLinkSharingWrite(db, {
        workspaceId: 'ws-free',
        shareableId: 'free-d',
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
      shareableId: 'free-c',
      trigger: 'publish_burst',
    })

    // Judgment remains advisory: its failure does not lift the refusal.
    judge.mockRejectedValueOnce(new Error('workflow unavailable'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined)
    expect((await write({ dailyLimit: 3 })).kind).toBe(
      'link-publish-rate-limited',
    )
    expect((await write({ dailyLimit: 4 })).kind).toBe('ok')
    // Adding a legacy event does not change the durable count.
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

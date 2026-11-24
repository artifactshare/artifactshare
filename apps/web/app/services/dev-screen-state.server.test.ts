import type { DatabaseSync } from 'node:sqlite'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import scenarioIds from '../../../../scripts/screen-scenarios.json'
import { computeTextSha256Hex } from '~/lib/sha256'
import { INVENTORY_PAGE_SIZE } from '~/lib/team-management'
import { sql } from 'kysely'
import { listProjectPins } from './project-pins.server'
import { devPublisherUserCode } from '~/lib/dev-device-user-code'
import { vi } from 'vitest'
import { BILLING_PRICES } from '~/lib/billing-prices'
import {
  LINK_SHARING_PLAN_DEFAULTS,
  linkExpiryStartingColumns,
} from '~/lib/link-sharing-policy'
import {
  captureStripeVars,
  startCaptureStripe,
} from '../../../../scripts/capture-stripe.mjs'
import {
  createStripeClient,
  loadSubscriptionContract,
  previewPlanChange,
  type BillingEnv,
} from './billing.server'
import {
  createD1BatchFixture,
  type D1BatchSqliteRef,
} from '~/test/d1-batch-mock'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))
vi.mock('cloudflare:workers', async () => {
  const { createD1MockFromSqliteRef } = await import('~/test/sqlite-fixture')
  return {
    env: {
      BUCKET: { delete: vi.fn() },
      DB: createD1MockFromSqliteRef(sqliteRef),
    },
  }
})
// Lets a test choose the IDs `nanoid()` generates, as shareables tests do.
const nanoidControl = vi.hoisted(() => ({
  next: null as ((size?: number) => string) | null,
}))
vi.mock('nanoid', async () => {
  const actual = await vi.importActual<typeof import('nanoid')>('nanoid')
  return {
    ...actual,
    nanoid: (size?: number) =>
      nanoidControl.next?.(size) ?? actual.nanoid(size),
  }
})

import type { Kysely } from 'kysely'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  devShareableId,
  devScreenUserEmail,
  ensureDevScreenState,
  isDevScreenStateRequest,
  isScreenScenario,
  seedDevScreenArtifactBodies,
  seedDevScreenState,
} from './dev-screen-state.server'
import {
  listJoinedProjectsForDropdown,
  listProjectsForIndex,
} from './project-membership.server'
import {
  createProjectContainer,
  getOrCreateInboxContainerId,
  listSharedProjects,
} from './projects.server'
import { editShareableSettings } from './shareables.server'
import { createApiToken, listApiTokens } from './api-tokens.server'
import {
  attachAgentBootstrapAuthority,
  attachPublisherBootstrapAuthority,
  loadDeviceAuthorizationIntent,
  selectAgentApprovalProject,
  selectPublisherApprovalClient,
  storeDeviceAuthorizationIntent,
} from './cli-device-authority.server'
import {
  CLI_DEVICE_SESSION_USER_AGENT,
  issueCliRefreshCredential,
  listCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily,
} from './cli-refresh-credentials.server'
import { updateWorkspaceExternalAccessPolicy } from './link-sharing.server'
import {
  listRecentArtifactsLimited,
  listUnopenedOwnedArtifactsLimited,
  versionCountSelect,
  directGrantsSelect,
  unopenedOwnedPredicate,
  latestPublishedAtSelect,
} from './home.server'
import {
  ensureActiveWorkspaceMembership,
  grantWorkspaceAdmin,
  loadRemovedWorkspaceMembers,
  removeWorkspaceMember,
  transferRemovedMemberAssets,
} from './team-management.server'
import {
  createWorkspaceBot,
  listWorkspaceBots,
  reissueWorkspaceBotCredential,
  stopWorkspaceBot,
  cancelWorkspaceBot,
} from './bot-members.server'
import { updateWorkspaceBotDestinations } from './bot-destinations.server'
import { loadViewerRevisitContext } from './viewer-revisit.server'
import { recordViewerRecency } from './views.server'

/** Dev sign-in provisions the actor and its role before a scenario seeds. */
async function addScenarioOwner(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
  now: string,
) {
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: `${userId}@example.test`,
      email_verified: 1,
      name: 'Owner',
      image: null,
      locale: null,
      workspace_id: workspaceId,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'owner',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
    .execute()
}

async function expectWorkspaceExpiryStarts(db: Kysely<DB>) {
  expect(
    await db
      .selectFrom('workspaces')
      .select(['link_expiry_default_days', 'link_expiry_max_days'])
      .execute(),
  ).toEqual(
    expect.arrayContaining([
      {
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      },
    ]),
  )
  expect(
    await db
      .selectFrom('workspaces')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('link_expiry_default_days', '!=', 30),
          eb('link_expiry_default_days', 'is', null),
          eb('link_expiry_max_days', 'is not', null),
        ]),
      )
      .execute(),
  ).toEqual([])
}

describe('dev screen state requests', () => {
  test('unrestricted captures seed isolated pending requests without approval intent', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-09-09T00:00:00.000Z'
    try {
      const codes = new Set<string>()
      for (const scenario of [
        'device/unrestricted',
        'device/unrestricted-confirmed',
      ]) {
        const { workspaceId } = await ensureDevScreenState(
          db,
          scenario,
          now,
          'team',
        )
        const userId = `${workspaceId}-user`
        await db
          .insertInto('users')
          .values({
            id: userId,
            email: `${scenario.split('/')[1]}@example.test`,
            name: 'Owner',
            email_verified: 1,
            created_at: now,
            updated_at: now,
            workspace_id: workspaceId,
          })
          .execute()
        await seedDevScreenState(db, scenario, workspaceId, userId, now)
        const code = await db
          .selectFrom('deviceCode')
          .selectAll()
          .where('userId', '=', userId)
          .executeTakeFirstOrThrow()
        expect(code).toMatchObject({
          status: 'pending',
          preset: null,
          deviceName: null,
          userCode: devPublisherUserCode(workspaceId),
        })
        codes.add(code.userCode!)
      }
      expect(codes.size).toBe(2)
    } finally {
      await db.destroy()
    }
  })

  test('publisher scenarios seed distinct stable approval codes across workspaces', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-09-09T00:00:00.000Z'
    try {
      for (const plan of ['free', 'plus', 'team'] as const) {
        for (const state of [
          'new',
          'continue',
          'invalid',
          'long-name',
          'expired',
        ]) {
          const scenario = `device/publisher-${state}`
          const { workspaceId } = await ensureDevScreenState(
            db,
            scenario,
            now,
            plan,
          )
          const userId = `${workspaceId}-user`
          await db
            .insertInto('users')
            .values({
              id: userId,
              email: `${plan}-${state}@example.test`,
              name: 'Owner',
              email_verified: 1,
              created_at: now,
              updated_at: now,
              workspace_id: workspaceId,
            })
            .execute()
          await seedDevScreenState(db, scenario, workspaceId, userId, now)
          const before = await db
            .selectFrom('deviceCode')
            .selectAll()
            .where('userId', '=', userId)
            .executeTakeFirstOrThrow()
          expect(before.expiresAt).toBe(
            state === 'expired'
              ? '2000-01-01T00:00:00.000Z'
              : '2099-01-01T00:00:00.000Z',
          )
          const clients = await db
            .selectFrom('publisher_clients')
            .selectAll()
            .where('user_id', '=', userId)
            .execute()
          expect(clients).toHaveLength(state === 'new' ? 0 : 1)
          if (state !== 'new') expect(clients[0].name).toBe(before.deviceName)
          if (state === 'long-name') expect(clients[0].name.length).toBe(99)
          expect(before.userCode).toBe(devPublisherUserCode(workspaceId))
          expect(before.userCode).toMatch(/^[A-Z0-9]{8}$/)
          // Existing dev databases may still contain the former shared code.
          await db
            .updateTable('deviceCode')
            .set({ userCode: 'PUBL1234' })
            .where('id', '=', before.id)
            .execute()
          await seedDevScreenState(db, scenario, workspaceId, userId, now)
          expect(
            await db
              .selectFrom('deviceCode')
              .selectAll()
              .where('userId', '=', userId)
              .execute(),
          ).toEqual([before])
        }
      }
      const codes = await db
        .selectFrom('deviceCode')
        .select('userCode')
        .execute()
      expect(codes).toHaveLength(15)
      expect(new Set(codes.map((row) => row.userCode)).size).toBe(15)
    } finally {
      await db.destroy()
    }
  })

  test('accepts only allowlisted scenarios', () => {
    expect(isScreenScenario('settings-billing/subscribed')).toBe(true)
    expect(isScreenScenario('unknown/scenario')).toBe(false)
  })

  test('matches the requested scenario header exactly', () => {
    const request = new Request('https://example.com/settings/billing', {
      headers: {
        'X-ArtifactShare-Dev-Screen-State': 'settings-billing/subscribed',
      },
    })

    expect(
      isDevScreenStateRequest(request, 'settings-billing/subscribed'),
    ).toBe(true)
    expect(
      isDevScreenStateRequest(request, 'settings-tokens/created-secret'),
    ).toBe(false)
  })

  test('creates scenario workspaces with the product expiry starting policy', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        'home/empty',
        '2026-09-09T00:00:00.000Z',
        'free',
      )
      await expect(
        db
          .selectFrom('workspaces')
          .select(['link_expiry_default_days', 'link_expiry_max_days'])
          .where('id', '=', workspaceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      })

      await db
        .updateTable('workspaces')
        .set({ link_expiry_default_days: null, link_expiry_max_days: null })
        .where('id', '=', workspaceId)
        .execute()
      await ensureDevScreenState(
        db,
        'home/empty',
        '2026-09-09T00:00:00.000Z',
        'free',
      )

      await expect(
        db
          .selectFrom('workspaces')
          .select(['link_expiry_default_days', 'link_expiry_max_days'])
          .where('id', '=', workspaceId)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        link_expiry_default_days: 30,
        link_expiry_max_days: null,
      })
    } finally {
      await db.destroy()
    }
  })
})

describe('viewer revisit-context dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test('restores the returning-reader timeline after acknowledgment and an aged reseed', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-08-17T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'viewer/revisit-context',
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'viewer@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'viewer/revisit-context',
      workspaceId,
      userId,
      now,
    )
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)

    const load = () =>
      loadViewerRevisitContext(db, {
        shareableId,
        viewerUserId: userId,
        currentVersionId: `${shareableId}-v2`,
        versions: [
          { id: `${shareableId}-v2`, ordinal: 2 },
          { id: `${shareableId}-v1`, ordinal: 1 },
        ],
      })
    const expectedContext = {
      entryCurrentVersionId: `${shareableId}-v2`,
      version: { kind: 'ordinal', from: 1, to: 2 },
      commentCount: 2,
      newCommentMessages: [
        {
          messageId: `${shareableId}-thread-1-reply`,
          threadId: `${shareableId}-thread-1`,
        },
        {
          messageId: `${shareableId}-thread-2-opening`,
          threadId: `${shareableId}-thread-2`,
        },
      ],
    }
    const rows = async (artifactId = shareableId) => ({
      artifact: await db
        .selectFrom('shareables')
        .selectAll()
        .where('id', '=', artifactId)
        .executeTakeFirstOrThrow(),
      versions: await db
        .selectFrom('versions')
        .selectAll()
        .where('shareable_id', '=', artifactId)
        .orderBy('id')
        .execute(),
      threads: await db
        .selectFrom('comment_threads')
        .selectAll()
        .where('shareable_id', '=', artifactId)
        .orderBy('id')
        .execute(),
      messages: await db
        .selectFrom('comment_messages')
        .selectAll()
        .where(
          'thread_id',
          'in',
          db
            .selectFrom('comment_threads')
            .select('id')
            .where('shareable_id', '=', artifactId),
        )
        .orderBy('id')
        .execute(),
    })
    const initial = await rows()
    const ownerId = `${workspaceId}-revisit-owner`
    expect(initial.artifact.owner_user_id).toBe(ownerId)
    expect(initial.artifact.version_sequence).toBe(2)
    expect(
      initial.versions.map(({ id, number, status, created_by_id }) => ({
        id,
        number,
        status,
        created_by_id,
      })),
    ).toEqual(
      [1, 2].map((number) => ({
        id: `${shareableId}-v${number}`,
        number,
        status: 'published',
        created_by_id: ownerId,
      })),
    )
    expect(
      initial.threads.map(({ id, status, created_by_id }) => ({
        id,
        status,
        created_by_id,
      })),
    ).toEqual(
      [1, 2, 3].map((index) => ({
        id: `${shareableId}-thread-${index}`,
        status: 'open',
        created_by_id: userId,
      })),
    )
    expect(
      initial.messages.map(({ id, body, created_by_id }) => ({
        id,
        body,
        created_by_id,
      })),
    ).toEqual([
      {
        id: `${shareableId}-thread-1-opening`,
        body: '確認ポイント 1',
        created_by_id: userId,
      },
      {
        id: `${shareableId}-thread-1-reply`,
        body: '反映しました。',
        created_by_id: ownerId,
      },
      {
        id: `${shareableId}-thread-2-opening`,
        body: '確認ポイント 2',
        created_by_id: ownerId,
      },
      {
        id: `${shareableId}-thread-3-opening`,
        body: '確認ポイント 3',
        created_by_id: ownerId,
      },
      {
        id: `${shareableId}-thread-3-reply`,
        body: '確認します。',
        created_by_id: userId,
      },
    ])
    const acknowledge = async (viewedAt: string) => {
      const current = await rows()
      await recordViewerRecency(db, shareableId, userId, {
        now: viewedAt,
        versionSeenThroughAt: current.versions[1].published_at,
        commentSeenThroughAt: current.messages
          .map((message) => message.created_at)
          .sort()
          .at(-1),
      })
      await expect(load()).resolves.toBeNull()
    }
    await expect(load()).resolves.toEqual(expectedContext)
    // Reading context does not acknowledge it.
    await expect(load()).resolves.toEqual(expectedContext)
    await acknowledge(now)

    const unrelatedId = devShareableId('unrelated-revisit-control')
    await db
      .insertInto('shareables')
      .values({
        ...initial.artifact,
        id: unrelatedId,
        current_version_id: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        ...initial.versions[0],
        id: `${unrelatedId}-v1`,
        shareable_id: unrelatedId,
      })
      .execute()
    await db
      .insertInto('comment_threads')
      .values({
        ...initial.threads[0],
        id: `${unrelatedId}-thread`,
        shareable_id: unrelatedId,
      })
      .execute()
    await db
      .insertInto('comment_messages')
      .values({
        ...initial.messages[0],
        id: `${unrelatedId}-message`,
        thread_id: `${unrelatedId}-thread`,
      })
      .execute()
    const unrelated = await rows(unrelatedId)
    await recordViewerRecency(db, shareableId, ownerId, {
      now,
      versionSeenThroughAt: now,
      commentSeenThroughAt: now,
    })
    const otherRecency = () =>
      db
        .selectFrom('shareable_viewer_recency')
        .selectAll()
        .where('shareable_id', '=', shareableId)
        .where('viewer_user_id', '=', ownerId)
        .executeTakeFirstOrThrow()
    const otherBefore = await otherRecency()
    const later = new Date(Date.parse(now) + 6 * 3_600_000).toISOString()
    for (let iteration = 0; iteration < 2; iteration += 1) {
      await seedDevScreenState(
        db,
        'viewer/revisit-context',
        workspaceId,
        userId,
        later,
      )
      await expect(load()).resolves.toEqual(expectedContext)
      const current = await rows()
      // All non-timestamp fields, including IDs, numbering, authors and bodies, survive.
      const withoutTimes = (row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => !key.endsWith('_at')),
        )
      for (const key of ['versions', 'threads', 'messages'] as const) {
        expect(current[key].map(withoutTimes)).toEqual(
          initial[key].map(withoutTimes),
        )
      }
      expect(current.artifact.version_sequence).toBe(2)
      expect(current.artifact.owner_user_id).toBe(ownerId)
      const recency = await db
        .selectFrom('shareable_viewer_recency')
        .selectAll()
        .where('shareable_id', '=', shareableId)
        .where('viewer_user_id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(current.versions[0].published_at).toBe(
        recency.version_seen_through_at,
      )
      expect(
        current.versions[1].published_at! > recency.version_seen_through_at!,
      ).toBe(true)
      for (const version of current.versions)
        expect(version.created_at).toBe(version.published_at)
      for (const thread of current.threads) {
        expect(thread.created_at < recency.comment_seen_through_at!).toBe(true)
        expect(thread.updated_at > recency.comment_seen_through_at!).toBe(true)
        const messages = current.messages.filter(
          (message) => message.thread_id === thread.id,
        )
        expect(thread.updated_at).toBe(
          messages
            .map((message) => message.created_at)
            .sort()
            .at(-1),
        )
        for (const message of messages) {
          expect(message.updated_at).toBe(message.created_at)
          expect(message.created_at >= thread.created_at).toBe(true)
        }
      }
      for (const pair of expectedContext.newCommentMessages) {
        expect(
          current.messages.find((message) => message.id === pair.messageId)!
            .created_at > recency.comment_seen_through_at!,
        ).toBe(true)
      }
      await expect(rows(unrelatedId)).resolves.toEqual(unrelated)
      await expect(otherRecency()).resolves.toEqual(otherBefore)
      await acknowledge(later)
    }
  })
})

describe('recent content-rich dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test('stores viewer bodies only for the successful task artifacts', async () => {
    const put = vi.fn().mockResolvedValue(undefined)

    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'recent/content-rich',
      'workspace',
      'viewer',
    )

    expect(put.mock.calls.map(([key]) => key)).toEqual([
      `dev-screen/${devShareableId('workspace-viewer-file-1')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-21')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-21')}-v2`,
    ])
    expect(put.mock.calls[2][1]).toContain('今回の更新')
    expect(put.mock.calls[2][2]).toEqual({
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    put.mockClear()
    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'home/content-rich',
      'workspace',
      'viewer',
    )
    expect(put).not.toHaveBeenCalled()

    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      'home/unopened-file',
      'workspace',
      'viewer',
    )
    expect(put.mock.calls.map(([key]) => key)).toEqual([
      `dev-screen/${devShareableId('workspace-viewer-file-1')}-v1`,
      `dev-screen/${devShareableId('workspace-viewer-file-6')}-v1`,
    ])
  })

  test('seeds unopened and private sharing labels for the files capture', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const scenario = 'files/unopened-and-sharing'
    expect(isScreenScenario(scenario)).toBe(true)
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'free',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'owner@example.com',
        email_verified: 1,
        name: 'Owner',
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
      })
      .execute()
    for (let attempt = 0; attempt < 2; attempt++) {
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
      const rows = await db
        .selectFrom('shareables')
        .select((eb) => [
          'shareables.name',
          'shareables.visibility',
          unopenedOwnedPredicate(userId).as('unopened'),
          versionCountSelect(eb),
          directGrantsSelect(userId, 'owner@example.com'),
        ])
        .where('owner_user_id', '=', userId)
        .orderBy('name')
        .execute()
      expect(rows).toEqual([
        {
          name: 'Private notes.html',
          visibility: 'private',
          unopened: 0,
          version_count: 1,
          has_direct_grants: 0,
        },
        {
          name: 'Shared with a recipient.html',
          visibility: 'private',
          unopened: 0,
          version_count: 1,
          has_direct_grants: 1,
        },
        {
          name: 'Unopened report.html',
          visibility: 'private',
          unopened: 1,
          version_count: 1,
          has_direct_grants: 0,
        },
        {
          name: 'Updated unopened report.html',
          visibility: 'private',
          unopened: 1,
          version_count: 2,
          has_direct_grants: 0,
        },
      ])
    }
  })

  test('leaves six unopened files with the failure artifact outside the five visible rows', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'home/unopened-file',
      now,
      'free',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    await seedDevScreenState(db, 'home/unopened-file', workspaceId, userId, now)

    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    const shareable = await db
      .selectFrom('shareables')
      .select(['owner_user_id', 'current_version_id'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .select('shareable_id')
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirst()

    expect(shareable).toEqual({
      owner_user_id: userId,
      current_version_id: `${shareableId}-v1`,
    })
    expect(recency).toBeUndefined()
    const unopened = await listUnopenedOwnedArtifactsLimited(
      db,
      userId,
      workspaceId,
    )
    expect(unopened.total).toBe(6)
    expect(unopened.rows).toHaveLength(5)
    expect(unopened.rows.map((row) => row.id)).not.toContain(
      devShareableId(`${workspaceId}-${userId}-file-6`),
    )
  })

  test('distinguishes a working two-version artifact from missing body and source states', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    await expectWorkspaceExpiryStarts(db)

    const shareableIds = [19, 20, 21].map((number) =>
      devShareableId(`${workspaceId}-${userId}-file-${number}`),
    )
    const shareables = await db
      .selectFrom('shareables')
      .select(['id', 'current_version_id'])
      .where('id', 'in', shareableIds)
      .orderBy('id')
      .execute()
    const versions = await db
      .selectFrom('versions')
      .select(['id', 'shareable_id', 'published_at'])
      .where('shareable_id', 'in', shareableIds)
      .orderBy('id')
      .execute()

    expect(shareables).toEqual([
      { id: shareableIds[0], current_version_id: null },
      { id: shareableIds[1], current_version_id: `${shareableIds[1]}-v1` },
      { id: shareableIds[2], current_version_id: `${shareableIds[2]}-v2` },
    ])
    expect(versions.map(({ id }) => id)).toEqual([
      `${shareableIds[1]}-v1`,
      `${shareableIds[2]}-v1`,
      `${shareableIds[2]}-v2`,
    ])
    expect(versions.at(-1)?.published_at).toBe('2026-07-31T11:30:00.000Z')
    const pair = await db
      .selectFrom('shareables')
      .select((eb) => [
        'shareables.id',
        'shareables.name',
        versionCountSelect(eb),
        latestPublishedAtSelect(eb),
      ])
      .where(
        'shareables.id',
        'in',
        [21, 22].map((n) =>
          devShareableId(`${workspaceId}-${userId}-file-${n}`),
        ),
      )
      .orderBy('shareables.created_at', 'desc')
      .execute()
    expect(pair).toHaveLength(2)
    expect(pair[0].name).toBe(pair[1].name)
    expect(pair.map((row) => row.version_count)).toEqual([2, 1])
    expect(pair[0].latest_published_at).toBe('2026-07-31T11:30:00.000Z')
  })

  test('seeds unread comments and resets recency and comment data on reseed', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`

    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
    const version = await db
      .selectFrom('versions')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const shareable = await db
      .selectFrom('shareables')
      .select(['current_version_id', 'retain_versions'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    expect(version).toMatchObject({
      id: `${shareableId}-v1`,
      status: 'published',
      entrypoint_path: '/index.html',
      r2_key: `dev-screen/${shareableId}-v1`,
      sha256: `${shareableId}-v1`,
      created_by_id: userId,
      created_at: '2026-07-31T12:00:00.000Z',
      published_at: '2026-07-31T12:00:00.000Z',
    })
    expect(version.label).toBeNull()
    const updatedId = devShareableId(`${workspaceId}-${userId}-file-21`)
    const history = await db
      .selectFrom('versions')
      .select(['id', 'label'])
      .where('shareable_id', '=', updatedId)
      .orderBy('id')
      .execute()
    expect(history).toEqual([
      { id: `${updatedId}-v1`, label: null },
      { id: `${updatedId}-v2`, label: 'Restructured' },
    ])
    expect(version.size_bytes).toBeGreaterThan(1)
    expect(shareable.current_version_id).toBe(`${shareableId}-v1`)
    expect(shareable.retain_versions).toBe(1)
    const recency = await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirstOrThrow()
    const viewerRecencyRows = await db
      .selectFrom('shareable_viewer_recency')
      .select(['viewer_user_id', 'last_viewed_at'])
      .where('shareable_id', '=', shareableId)
      .orderBy('viewer_user_id')
      .execute()
    expect(viewerRecencyRows).toEqual([
      {
        viewer_user_id: `${workspaceId}-commenter`,
        last_viewed_at: '2026-07-31T11:00:00.000Z',
      },
      { viewer_user_id: userId, last_viewed_at: '2026-07-31T10:00:00.000Z' },
      {
        viewer_user_id: `${workspaceId}-viewer-third`,
        last_viewed_at: '2026-07-31T10:00:00.000Z',
      },
    ])
    const membershipRows = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'status'])
      .where('workspace_id', '=', workspaceId)
      .orderBy('user_id')
      .execute()
    expect(membershipRows).toEqual([
      { user_id: `${workspaceId}-commenter`, status: 'active' },
      { user_id: userId, status: 'active' },
      { user_id: `${workspaceId}-viewer-third`, status: 'removed' },
    ])
    const externalGrant = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', shareableId)
      .where(
        'granted_email',
        '=',
        `dev-viewer-third+${workspaceId}@artifactshare.local`,
      )
      .executeTakeFirst()
    expect(externalGrant).toBeDefined()
    const message = await db
      .selectFrom('comment_messages')
      .selectAll()
      .where('thread_id', '=', `${shareableId}-thread`)
      .executeTakeFirstOrThrow()
    expect(recency.last_viewed_at).toBe('2026-07-31T10:00:00.000Z')
    expect(message.created_at).toBe('2026-07-31T11:00:00.000Z')
    expect(Date.parse(message.created_at)).toBeGreaterThan(
      Date.parse(recency.last_viewed_at),
    )

    await db
      .updateTable('shareable_viewer_recency')
      .set({ last_viewed_at: '2026-08-01T00:00:00.000Z' })
      .where('shareable_id', '=', shareableId)
      .execute()
    await db
      .updateTable('users')
      .set({ name: 'Changed' })
      .where('id', '=', `${workspaceId}-commenter`)
      .execute()
    await db
      .updateTable('comment_messages')
      .set({ body: 'Changed', created_at: '2026-08-01T00:00:00.000Z' })
      .where('id', '=', `${shareableId}-message`)
      .execute()
    await db
      .updateTable('comment_threads')
      .set({
        status: 'resolved',
        resolved_by_id: `${workspaceId}-commenter`,
        resolved_at: '2026-08-01T00:00:00.000Z',
      })
      .where('id', '=', `${shareableId}-thread`)
      .execute()

    await db
      .updateTable('shareables')
      .set({ retain_versions: null })
      .where('id', '=', shareableId)
      .execute()

    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const resetVersion = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', `${shareableId}-v1`)
      .executeTakeFirstOrThrow()
    const resetShareable = await db
      .selectFrom('shareables')
      .select(['current_version_id', 'retain_versions'])
      .where('id', '=', shareableId)
      .executeTakeFirstOrThrow()
    expect(resetVersion).toMatchObject({
      status: 'published',
      created_at: '2026-07-31T12:00:00.000Z',
      published_at: '2026-07-31T12:00:00.000Z',
    })
    expect(resetShareable.current_version_id).toBe(`${shareableId}-v1`)
    expect(resetShareable.retain_versions).toBe(1)

    const resetRecency = await db
      .selectFrom('shareable_viewer_recency')
      .selectAll()
      .where('shareable_id', '=', shareableId)
      .where('viewer_user_id', '=', userId)
      .executeTakeFirstOrThrow()
    const counts = await Promise.all([
      db
        .selectFrom('users')
        .select('id')
        .where('id', '=', `${workspaceId}-commenter`)
        .execute(),
      db
        .selectFrom('comment_threads')
        .select('id')
        .where('shareable_id', '=', shareableId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('comment_messages')
        .select('id')
        .where('id', 'in', [
          `${shareableId}-message`,
          `${shareableId}-message-latest`,
        ])
        .orderBy('id')
        .execute(),
    ])
    const resetMessage = await db
      .selectFrom('comment_messages')
      .selectAll()
      .where('id', '=', `${shareableId}-message`)
      .executeTakeFirstOrThrow()
    const resetThread = await db
      .selectFrom('comment_threads')
      .select(['status', 'resolved_by_id', 'resolved_at'])
      .where('id', '=', `${shareableId}-thread`)
      .executeTakeFirstOrThrow()
    const commenter = await db
      .selectFrom('users')
      .select('name')
      .where('id', '=', `${workspaceId}-commenter`)
      .executeTakeFirstOrThrow()
    expect(resetRecency.last_viewed_at).toBe('2026-07-31T10:00:00.000Z')
    expect(commenter.name).toBe(
      'Mina Kato from the International Research Team',
    )
    expect(resetMessage.body).toBe(
      '確認しました。次回の見通しも追記できますか？',
    )
    expect(resetMessage.created_at).toBe('2026-07-31T11:00:00.000Z')
    expect(resetThread).toEqual({
      status: 'open',
      resolved_by_id: null,
      resolved_at: null,
    })
    expect(counts.map((rows) => rows)).toEqual([
      [{ id: `${workspaceId}-commenter` }],
      [
        { id: `${shareableId}-text-attached` },
        { id: `${shareableId}-text-needs-check` },
        { id: `${shareableId}-thread` },
        { id: `${shareableId}-thread-latest` },
      ],
      [
        { id: `${shareableId}-message` },
        { id: `${shareableId}-message-latest` },
      ],
    ])
  })

  test('includes a joined project file from another workspace in the project filter', async () => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'recent/content-rich',
      now,
      'plus',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-user@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )

    const viewer = {
      id: userId,
      email: 'dev-user@example.com',
      emailVerified: true,
      workspaceId,
    }
    const joinedRows = await listRecentArtifactsLimited(db, viewer, 100, {
      relation: 'project',
    })
    const joinedFile = joinedRows.find(
      (row) => row.id === `${workspaceId}-recent-joined-workspace-project-file`,
    )
    expect(joinedFile).toMatchObject({
      workspace_id: `${workspaceId}-recent-joined-workspace`,
      project_workspace_id: `${workspaceId}-recent-joined-workspace`,
      recent_attribute: 'joined-project',
    })
    expect(joinedRows).toHaveLength(1)

    const allRows = await listRecentArtifactsLimited(db, viewer, 100)
    expect(allRows).toHaveLength(25)
    expect(
      allRows.some((row) => row.id === `${workspaceId}-recent-restricted-file`),
    ).toBe(true)

    const joinedFileId = `${workspaceId}-recent-joined-workspace-project-file`
    await db
      .updateTable('shareable_viewer_recency')
      .set({
        first_viewed_at: '2026-08-01T00:00:00.000Z',
        last_viewed_at: '2026-08-01T00:00:00.000Z',
      })
      .where('shareable_id', '=', joinedFileId)
      .where('viewer_user_id', '=', userId)
      .execute()
    await seedDevScreenState(
      db,
      'recent/content-rich',
      workspaceId,
      userId,
      now,
    )
    expect(
      await db
        .selectFrom('shareable_viewer_recency')
        .select(['first_viewed_at', 'last_viewed_at'])
        .where('shareable_id', '=', joinedFileId)
        .where('viewer_user_id', '=', userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      first_viewed_at: '2026-07-31T11:30:00.000Z',
      last_viewed_at: '2026-07-31T11:30:00.000Z',
    })
  })
})

describe('representative feed events', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test.each([
    ['home/content-rich', 'free'],
    ['project-detail/with-files', 'team'],
  ] as const)('%s seeds all four feed event types', async (scenario, plan) => {
    ;({ db } = createMigratedInMemoryDb())
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(db, scenario, now, plan)
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: `dev-user+${scenario.replaceAll('/', '-')}@artifactshare.local`,
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()

    const { containerId } = await seedDevScreenState(
      db,
      scenario,
      workspaceId,
      userId,
      now,
    )
    const readFeedState = async () => {
      const files = await db
        .selectFrom('shareables')
        .select(['id', 'created_at'])
        .where('container_id', '=', containerId)
        .orderBy('id')
        .execute()
      const fileIds = new Set(files.map((file) => file.id))
      const fileEvents = (
        await db
          .selectFrom('events')
          .select(['type', 'shareable_id', 'subject_id', 'created_at'])
          .where('workspace_id', '=', workspaceId)
          .orderBy('id')
          .execute()
      ).filter((event) => fileIds.has(event.shareable_id))
      const versions = await db
        .selectFrom('versions')
        .select(['id', 'shareable_id', 'created_at', 'published_at'])
        .where(
          'shareable_id',
          'in',
          files.map((file) => file.id),
        )
        .orderBy('id')
        .execute()
      return { files, fileEvents, versions }
    }
    const initialState = await readFeedState()
    await seedDevScreenState(
      db,
      scenario,
      workspaceId,
      userId,
      '2026-08-01T12:00:00.000Z',
    )
    const reseededState = await readFeedState()

    expect(reseededState).toEqual(initialState)
    const { files, fileEvents } = reseededState

    expect(files).toHaveLength(3)
    expect(new Set(fileEvents.map((event) => event.type))).toEqual(
      new Set([
        'artifact_created',
        'artifact_viewed',
        'comment_posted',
        'version_published',
      ]),
    )
    expect(
      files.every((file) =>
        fileEvents.some((event) => event.shareable_id === file.id),
      ),
    ).toBe(true)
    for (const event of fileEvents) {
      const file = files.find(
        (candidate) => candidate.id === event.shareable_id,
      )
      expect(Date.parse(event.created_at)).toBeGreaterThanOrEqual(
        Date.parse(file?.created_at ?? ''),
      )
    }
    expect(
      fileEvents
        .filter((event) => event.shareable_id === files[2]?.id)
        .map((event) => event.type),
    ).toEqual(['artifact_created'])
    const createdEvent = fileEvents.find(
      (event) => event.type === 'artifact_created',
    )
    expect(createdEvent).toMatchObject({
      shareable_id: files[2]?.id,
      created_at: '2026-07-31T11:55:00.000Z',
    })
    const createdVersion = await db
      .selectFrom('versions')
      .select(['shareable_id', 'created_at', 'published_at'])
      .where('id', '=', createdEvent?.subject_id ?? '')
      .executeTakeFirstOrThrow()
    expect(createdVersion).toEqual({
      shareable_id: files[2]?.id,
      created_at: files[2]?.created_at,
      published_at: files[2]?.created_at,
    })
  })
})

describe('home empty-state dev screen state', () => {
  let db: Kysely<DB>

  afterEach(async () => {
    await db?.destroy()
  })

  test.each([
    ['home/empty', 0],
    ['home/first-file', 1],
  ] as const)(
    '%s seeds the representative file count',
    async (scenario, count) => {
      ;({ db } = createMigratedInMemoryDb())
      const now = '2026-07-31T12:00:00.000Z'
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'free',
      )
      const userId = `${workspaceId}-user`

      await db
        .insertInto('users')
        .values({
          id: userId,
          email: `dev-user+${scenario.replaceAll('/', '-')}@artifactshare.local`,
          email_verified: 1,
          name: 'Viewer',
          image: null,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
          locale: null,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)

      await db
        .insertInto('shareables')
        .values({
          id: `${workspaceId}-stale-file`,
          workspace_id: workspaceId,
          owner_user_id: userId,
          slug: null,
          name: 'Stale file.html',
          derived_title: 'Stale file',
          title_override: null,
          description: null,
          artifact_kind: 'html_page',
          visibility: 'private',
          current_version_id: null,
          container_id: `${workspaceId}-${userId}-container`,
          created_at: now,
          updated_at: now,
          last_accessed_at: now,
          link_expires_at: null,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)

      const files = await db
        .selectFrom('shareables')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
      const events = await db
        .selectFrom('events')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
      expect(files).toHaveLength(count)
      expect(events).toHaveLength(0)
    },
  )
})

describe('projects stress dev screen state', () => {
  test('seeds deterministic local, archived, and cross-workspace rows', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'projects/stress-states',
      now,
      'free',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-free-owner+projects-stress-states@artifactshare.local',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(
      db,
      'projects/stress-states',
      workspaceId,
      userId,
      now,
    )
    await expectWorkspaceExpiryStarts(db)

    const projects = await db
      .selectFrom('artifact_containers')
      .select(['id', 'archived_at'])
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'project')
      .execute()
    expect(projects).toHaveLength(14)
    expect(
      projects.filter((project) => project.archived_at !== null),
    ).toHaveLength(1)
    expect(
      await db
        .selectFrom('project_share_defaults')
        .select('project_container_id')
        .where(
          'project_container_id',
          '=',
          `${workspaceId}-shared-source-project`,
        )
        .execute(),
    ).toEqual([
      { project_container_id: `${workspaceId}-shared-source-project` },
    ])

    const viewer = {
      id: userId,
      email: 'dev-free-owner+projects-stress-states@artifactshare.local',
      emailVerified: true,
      name: 'Viewer',
      image: null,
      workspaceId,
      hd: null,
      msTenantId: null,
      kind: 'human' as const,
      locale: null,
    }
    const indexRows = await listProjectsForIndex(db, viewer)
    expect(indexRows).toHaveLength(15)
    expect(
      indexRows.filter((row) => row.workspaceId === workspaceId),
    ).toHaveLength(14)
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-joined')),
    ).toMatchObject({
      joined: true,
      newCount: 1,
      name: 'Long project name that wraps to three lines on mobile screens',
      description:
        'A deliberately long description for checking compact project rows and mobile wrapping behavior.',
    })
    expect(await listJoinedProjectsForDropdown(db, viewer, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${workspaceId}-shared-source-project`,
          name: 'Shared measurement platform with a deliberately long name',
          workspaceName: 'Shared source workspace',
        }),
      ]),
    )
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-joinable')),
    ).toMatchObject({
      name: 'Joinable project with a deliberately long name for mobile wrapping',
      description:
        'A deliberately long joinable project description keeps the Join button beside a realistic multi-line row on narrow screens.',
      joined: false,
    })
    expect(indexRows.some((row) => row.id.endsWith('-stress-extra-11'))).toBe(
      true,
    )
    expect(
      indexRows.find((row) => row.id.endsWith('-stress-archived')),
    ).toMatchObject({
      archivedAt: now,
    })

    await db
      .updateTable('artifact_containers')
      .set({ base_visibility: 'private' })
      .where('id', '=', `${workspaceId}-stress-joinable`)
      .execute()
    await seedDevScreenState(
      db,
      'projects/stress-states',
      workspaceId,
      userId,
      now,
    )

    const reseededIndexRows = await listProjectsForIndex(db, viewer)
    expect(reseededIndexRows).toHaveLength(15)
    expect(
      reseededIndexRows.find((row) => row.id.endsWith('-stress-joinable')),
    ).toMatchObject({
      baseVisibility: 'workspace',
      joined: false,
    })

    const sharedRows = await listSharedProjects(db, viewer)
    expect(sharedRows.map((row) => row.id)).toEqual([
      `${workspaceId}-shared-source-project`,
    ])
    await db.destroy()
  })
})

describe('settings with-bots dev screen state', () => {
  test('seeds active, expired, used-stopped, and unused-stopped bots', async () => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-07-31T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      'settings/with-bots',
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'dev-team-owner+settings-with-bots@artifactshare.local',
        email_verified: 1,
        name: 'Owner',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await addScenarioOwner(db, workspaceId, userId, now)
    await seedDevScreenState(db, 'settings/with-bots', workspaceId, userId, now)
    const actor = { id: userId, workspaceId }
    const botNamed = async (name: string) =>
      (await listWorkspaceBots(db, workspaceId, now)).find(
        (row) => row.name === name,
      )
    const activeId = (await botNamed('Nightly report bot'))!.id
    const destinations = async () =>
      (await botNamed('Nightly report bot'))?.approvedProjects?.map(
        (project) => project.unavailable,
      )
    expect(await destinations()).toEqual([false, false])
    expect(await stopWorkspaceBot(db, actor, activeId)).toEqual({ kind: 'ok' })
    expect(await destinations()).toEqual([true, true])
    await seedDevScreenState(db, 'settings/with-bots', workspaceId, userId, now)

    const bots = await listWorkspaceBots(db, workspaceId, now)
    expect(bots).toHaveLength(4)
    const byName = new Map(bots.map((bot) => [bot.name, bot]))
    const active = byName.get('Nightly report bot')
    expect(active).toMatchObject({
      botStoppedAt: null,
      credentialLive: true,
      projectName: 'Nightly reports',
    })
    const expired = byName.get('Metrics sync bot')
    expect(expired).toMatchObject({
      botStoppedAt: null,
      credentialLive: false,
    })
    const stopped = byName.get('Retired handoff bot')
    expect(stopped?.botStoppedAt).not.toBeNull()
    expect(stopped?.credentialLive).toBe(false)
    expect(stopped?.projectNameSnapshot).toBe('Nightly reports')
    expect(stopped?.cancelable).toBe(false)
    const unusedStopped = byName.get('Setup failed bot')
    expect(unusedStopped?.botStoppedAt).not.toBeNull()
    expect(unusedStopped?.cancelable).toBe(true)
    expect(await destinations()).toEqual([false, false])
    const target = unusedStopped!.id
    expect(await cancelWorkspaceBot(db, actor, target)).toEqual({ kind: 'ok' })
    expect(
      (await listWorkspaceBots(db, workspaceId, now))
        .map((row) => row.id)
        .sort(),
    ).toEqual(
      bots
        .map((row) => row.id)
        .filter((id) => id !== target)
        .sort(),
    )
    expect(await destinations()).toEqual([false, false])
    await db.destroy()
  })
})

test('CSP capture scenario publishes both HTML bodies with matching metadata', async () => {
  const { db } = createMigratedInMemoryDb()
  try {
    const scenario = 'viewer/csp-diagnostics'
    expect(isScreenScenario(scenario)).toBe(true)
    const now = '2026-08-17T12:00:00.000Z'
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'viewer@example.com',
        email_verified: 1,
        name: 'Viewer',
        image: null,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    const put = vi.fn().mockResolvedValue(undefined)
    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      scenario,
      workspaceId,
      userId,
    )
    expect(put).toHaveBeenCalledTimes(2)
    for (const [key, body] of put.mock.calls) {
      const version = await db
        .selectFrom('versions')
        .innerJoin('shareables', 'shareables.current_version_id', 'versions.id')
        .select([
          'versions.artifact_kind',
          'versions.size_bytes',
          'shareables.visibility',
          'shareables.owner_user_id',
        ])
        .where('versions.r2_key', '=', key)
        .executeTakeFirstOrThrow()
      expect(version).toEqual({
        artifact_kind: 'html_page',
        size_bytes: new TextEncoder().encode(body).byteLength,
        visibility: 'link',
        owner_user_id: userId,
      })
    }
  } finally {
    await db.destroy()
  }
})

test('removed-version seeds are idempotent across workspaces and reset only their own tombstones', async () => {
  const { db } = createMigratedInMemoryDb()
  try {
    const now = '2026-09-09T00:00:00.000Z'
    const scenario = 'viewer/retention-removed'
    const seeded = []
    for (const plan of ['team', 'plus'] as const) {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        plan,
      )
      const userId = `${workspaceId}-user`
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: `${plan}@example.com`,
          name: 'Viewer',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      seeded.push({ workspaceId, userId })
    }
    for (let iteration = 0; iteration < 2; iteration++) {
      for (const { workspaceId, userId } of seeded) {
        await seedDevScreenState(db, scenario, workspaceId, userId, now)
      }
      const rows = await db
        .selectFrom('version_retention_tombstones')
        .selectAll()
        .execute()
      expect(rows).toHaveLength(2)
      expect(rows).toEqual(
        expect.arrayContaining(
          seeded.map(({ workspaceId, userId }) => {
            const shareableId = devShareableId(
              `${workspaceId}-${userId}-file-1`,
            )
            return {
              version_id: `${shareableId}-removed-v1`,
              shareable_id: shareableId,
              version_number: 1,
              removed_at: now,
            }
          }),
        ),
      )
    }
    await seedDevScreenState(
      db,
      'recent/content-rich',
      seeded[0].workspaceId,
      seeded[0].userId,
      now,
    )
    const remaining = await db
      .selectFrom('version_retention_tombstones')
      .selectAll()
      .execute()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].shareable_id).toBe(
      devShareableId(`${seeded[1].workspaceId}-${seeded[1].userId}-file-1`),
    )
  } finally {
    await db.destroy()
  }
})

test.each(['viewer/retention-expanded', 'viewer/retention-saved'])(
  '%s seeds a resettable owner setting and its artifact body',
  async (scenario) => {
    const { db } = createMigratedInMemoryDb()
    try {
      expect(isScreenScenario(scenario)).toBe(true)
      const now = '2026-09-09T00:00:00.000Z'
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      const userId = `${workspaceId}-user`
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: 'viewer@example.com',
          name: 'Viewer',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      const shareableId = devShareableId(`${workspaceId}-${userId}-file-1`)
      for (let iteration = 0; iteration < 2; iteration++) {
        await seedDevScreenState(db, scenario, workspaceId, userId, now)
        const artifact = await db
          .selectFrom('shareables')
          .select(['owner_user_id', 'retain_versions'])
          .where('id', '=', shareableId)
          .executeTakeFirstOrThrow()
        expect(artifact).toEqual({ owner_user_id: userId, retain_versions: 1 })
        await db
          .updateTable('shareables')
          .set({ retain_versions: null })
          .where('id', '=', shareableId)
          .execute()
      }
      const put = vi.fn().mockResolvedValue(undefined)
      await seedDevScreenArtifactBodies(
        { put } as unknown as Pick<R2Bucket, 'put'>,
        scenario,
        workspaceId,
        userId,
      )
      expect(
        put.mock.calls.some(([key]) => key === `dev-screen/${shareableId}-v1`),
      ).toBe(true)
    } finally {
      await db.destroy()
    }
  },
)

test('scheduled viewer capture seeds mixed history, fresh data, and matching artifact bodies', async () => {
  const { db } = createMigratedInMemoryDb()
  try {
    const scenario = 'viewer/scheduled-updates'
    const now = '2026-09-09T00:00:00.000Z'
    expect(isScreenScenario(scenario)).toBe(true)
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'viewer@example.com',
        name: 'Viewer',
        email_verified: 1,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
      })
      .execute()
    const shareableId = devShareableId(`${workspaceId}-${userId}-file-21`)
    for (let iteration = 0; iteration < 2; iteration++) {
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
      const versions = await db
        .selectFrom('versions')
        .select([
          'number',
          'created_by_publisher_client_id',
          'published_at',
          'label',
        ])
        .where('shareable_id', '=', shareableId)
        .orderBy('number')
        .execute()
      expect(versions.map((version) => version.number)).toEqual([1, 2, 3])
      expect(
        versions.map((version) =>
          Boolean(version.created_by_publisher_client_id),
        ),
      ).toEqual([false, false, true])
      expect(versions[2]).toMatchObject({
        published_at: now,
        label: 'Hourly data refresh',
      })
      const artifact = await db
        .selectFrom('shareables')
        .select([
          'current_version_id',
          'activity_at',
          'updated_at',
          'created_by_publisher_client_id',
        ])
        .where('id', '=', shareableId)
        .executeTakeFirstOrThrow()
      expect(artifact.created_by_publisher_client_id).toBe(
        `${workspaceId}-scheduled`,
      )
      expect(artifact.current_version_id).toBe(`${shareableId}-v3`)
      expect(artifact.updated_at).toBe(now)
      expect(artifact.activity_at < artifact.updated_at).toBe(true)
    }
    const put = vi.fn().mockResolvedValue(undefined)
    await seedDevScreenArtifactBodies(
      { put } as unknown as Pick<R2Bucket, 'put'>,
      scenario,
      workspaceId,
      userId,
    )
    for (const version of [1, 2, 3]) {
      expect(
        put.mock.calls.some(
          ([key]) => key === `dev-screen/${shareableId}-v${version}`,
        ),
      ).toBe(true)
    }
  } finally {
    await db.destroy()
  }
})

test.each(['with-pins', 'scheduled-pins'] as const)(
  'project capture %s distinguishes human updates from scheduled freshness',
  async (state) => {
    const { db } = createMigratedInMemoryDb()
    try {
      const scenario = `project-detail/${state}`
      const now = '2026-09-09T00:00:00.000Z'
      expect(isScreenScenario(scenario)).toBe(true)
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      const userId = `${workspaceId}-user`
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: 'viewer@example.com',
          name: 'Viewer',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
      const pins = await db
        .selectFrom('project_pins')
        .select('shareable_id')
        .orderBy('shareable_id')
        .execute()
      expect(pins).toHaveLength(2)
      const cards = await listProjectPins(
        db,
        `${workspaceId}-container`,
        sql<boolean>`1 = 1`,
      )
      expect(cards.map((card) => card.dataUpdatedAt)).toEqual(
        state === 'scheduled-pins' ? [now, now] : [null, null],
      )
      for (let index = 0; index < pins.length; index++) {
        const versions = await db
          .selectFrom('versions')
          .select(['number', 'created_by_publisher_client_id'])
          .where('shareable_id', '=', pins[index]!.shareable_id)
          .orderBy('number')
          .execute()
        expect(versions.map((version) => version.number)).toEqual([1, 2, 3])
        expect(
          versions.map((version) =>
            Boolean(version.created_by_publisher_client_id),
          ),
        ).toEqual(
          state === 'with-pins'
            ? [false, false, false]
            : index === 0
              ? [true, true, true]
              : [true, false, true],
        )
      }
    } finally {
      await db.destroy()
    }
  },
)

test.each(['owner', 'readonly', 'unlimited', 'older-current'])(
  'managed retention %s scenario resets history, attribution, access and bodies',
  async (kind) => {
    const batchSqliteRef: D1BatchSqliteRef = { current: null }
    const { db, sqlite } = createD1BatchFixture({ sqlite: batchSqliteRef })
    batchSqliteRef.current = sqlite
    try {
      const scenario = `viewer/retention-managed-${kind}`
      const now = '2026-09-09T00:00:00.000Z'
      expect(isScreenScenario(scenario)).toBe(true)
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      const userId = `${workspaceId}-user`
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: 'viewer@example.com',
          name: 'Viewer',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      const id = devShareableId(
        `${workspaceId}-${userId}-file-${kind === 'readonly' ? 1 : 21}`,
      )
      const { previewRetention, saveRetention } =
        await import('./retention-settings.server')
      for (let iteration = 0; iteration < 2; iteration++) {
        await seedDevScreenState(db, scenario, workspaceId, userId, now)
        const artifact = await db
          .selectFrom('shareables')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
        expect(artifact.created_by_publisher_client_id).toBe(
          `${workspaceId}-scheduled`,
        )
        expect(artifact.assigned_publisher_client_id).toBeNull()
        expect(artifact.current_version_id).toBe(
          `${id}-v${kind === 'older-current' ? 3 : 4}`,
        )
        expect(artifact.retain_versions).toBe(
          kind === 'unlimited' ? null : kind === 'older-current' ? 1 : 2,
        )
        expect(artifact.owner_user_id === userId).toBe(kind !== 'readonly')
        if (kind === 'readonly') expect(artifact.visibility).toBe('workspace')
        const versions = await db
          .selectFrom('versions')
          .selectAll()
          .where('shareable_id', '=', id)
          .orderBy('number')
          .execute()
        expect(versions.map((v) => v.number)).toEqual([1, 2, 3, 4])
        expect(versions.map((v) => v.created_by_publisher_client_id)).toEqual([
          null,
          null,
          `${workspaceId}-scheduled`,
          `${workspaceId}-scheduled`,
        ])
        const preview = await previewRetention(
          db,
          id,
          artifact.owner_user_id,
          1,
        )
        expect(preview!.count).toBe(kind === 'older-current' ? 0 : 1)
        expect(JSON.parse(preview!.snapshot).eligible).toEqual(
          kind === 'older-current' ? [] : [`${id}-v3`],
        )
        const { hasExtraProtectedCurrentVersion } =
          await import('./version-retention.server')
        expect(await hasExtraProtectedCurrentVersion(db, id)).toBe(
          kind === 'older-current',
        )
        const put = vi.fn().mockResolvedValue(undefined)
        await seedDevScreenArtifactBodies(
          { put } as unknown as Pick<R2Bucket, 'put'>,
          scenario,
          workspaceId,
          userId,
        )
        const basePut = vi.fn().mockResolvedValue(undefined)
        await seedDevScreenArtifactBodies(
          { put: basePut } as unknown as Pick<R2Bucket, 'put'>,
          kind === 'readonly'
            ? 'viewer/revisit-context'
            : 'recent/content-rich',
          workspaceId,
          userId,
        )
        expect(basePut.mock.calls.length).toBeGreaterThan(0)
        expect(put.mock.calls.slice(0, basePut.mock.calls.length)).toEqual(
          basePut.mock.calls,
        )
        const bodies = new Map(put.mock.calls.map(([key, body]) => [key, body]))
        for (const version of versions) {
          expect(bodies.has(version.r2_key)).toBe(true)
          expect(
            new TextEncoder().encode(bodies.get(version.r2_key)).byteLength,
          ).toBe(version.size_bytes)
          expect(bodies.get(version.r2_key)).toContain(
            `version ${version.number}.`,
          )
        }
        for (const [key, body] of basePut.mock.calls) {
          if (!versions.some((version) => version.r2_key === key))
            expect(bodies.get(key)).toBe(body)
        }
        if (kind === 'readonly')
          expect(await previewRetention(db, id, userId, 1)).toBeNull()
        expect(
          await saveRetention(
            db,
            id,
            artifact.owner_user_id,
            1,
            preview!.snapshot,
          ),
        ).toEqual({
          retain_versions: 1,
          deleted_versions: kind === 'older-current' ? 0 : 1,
        })
        expect(
          (
            await db
              .selectFrom('versions')
              .select('id')
              .where('shareable_id', '=', id)
              .orderBy('number')
              .execute()
          ).map((version) => version.id),
        ).toEqual(
          kind === 'older-current'
            ? [1, 2, 3, 4].map((n) => `${id}-v${n}`)
            : [`${id}-v1`, `${id}-v2`, `${id}-v4`],
        )
        await db
          .updateTable('shareables')
          .set({
            retain_versions: 1,
            created_by_publisher_client_id: null,
            assigned_publisher_client_id: `${workspaceId}-scheduled`,
          })
          .where('id', '=', id)
          .execute()
        await db
          .updateTable('versions')
          .set({ created_by_publisher_client_id: `${workspaceId}-scheduled` })
          .where('id', '=', `${id}-v1`)
          .execute()
      }
    } finally {
      await db.destroy()
    }
  },
)

test('Slack scenario refresh only disconnects its workspace and restores connection fields', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  try {
    const workspaces: string[] = []
    for (const scenario of [
      'settings-integrations/slack-connected',
      'settings-integrations/slack-reauthorization',
    ]) {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      workspaces.push(workspaceId)
      const userId = workspaceId + '-user'
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: scenario.split('/')[1] + '@example.test',
          name: 'Owner',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
    }
    const [selected, unrelated] = workspaces
    const before = await db
      .selectFrom('slack_workspaces')
      .selectAll()
      .where('workspace_id', '=', unrelated)
      .execute()
    await seedDevScreenState(
      db,
      'settings-integrations/slack-disconnected',
      selected,
      selected + '-user',
      now,
    )
    await seedDevScreenState(
      db,
      'settings-integrations/slack-disconnected',
      selected,
      selected + '-user',
      now,
    )
    expect(
      await db
        .selectFrom('slack_workspaces')
        .selectAll()
        .where('workspace_id', '=', selected)
        .execute(),
    ).toEqual([])
    expect(
      await db
        .selectFrom('slack_workspaces')
        .selectAll()
        .where('workspace_id', '=', unrelated)
        .execute(),
    ).toEqual(before)
    await seedDevScreenState(
      db,
      'settings-integrations/slack-reauthorization',
      selected,
      selected + '-user',
      now,
    )
    await seedDevScreenState(
      db,
      'settings-integrations/slack-connected',
      selected,
      selected + '-user',
      now,
    )
    expect(
      await db
        .selectFrom('slack_workspaces')
        .select(['team_name', 'bot_scopes', 'bot_token'])
        .where('workspace_id', '=', selected)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      team_name: 'Artifact Share Dev',
      bot_scopes:
        'chat:write,links:read,links:write,users:read,users:read.email',
      bot_token: 'dev-screen-fixture',
    })
  } finally {
    await db.destroy()
  }
})

test.each(['finite', 'unlimited', 'zero'])(
  'external access %s fixture survives repeated sign-in',
  async (state) => {
    const { db } = createMigratedInMemoryDb()
    const now = '2026-09-09T00:00:00.000Z'
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(now) })
    const scenario = `settings-external-access/${state}`
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      const userId = workspaceId + '-user'
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: `${state}@example.test`,
          name: 'Owner',
          email_verified: 1,
          created_at: now,
          updated_at: now,
          workspace_id: workspaceId,
        })
        .execute()
      await addScenarioOwner(db, workspaceId, userId, now)
      for (let signIn = 0; signIn < 2; signIn++) {
        await ensureDevScreenState(db, scenario, now, 'team')
        await seedDevScreenState(db, scenario, workspaceId, userId, now)
        expect(
          await db
            .selectFrom('shareables')
            .select(['visibility', 'link_expires_at'])
            .where('id', '=', devShareableId(workspaceId + '-expiry-preview'))
            .executeTakeFirstOrThrow(),
        ).toEqual({
          visibility: 'link',
          link_expires_at:
            state === 'zero'
              ? now
              : state === 'finite'
                ? new Date(Date.parse(now) + 60 * 86_400_000).toISOString()
                : null,
        })
        expect(
          await db
            .selectFrom('workspaces')
            .select([
              'link_sharing_enabled',
              'external_posting_enabled',
              'link_expiry_default_days',
              'link_expiry_max_days',
            ])
            .where('id', '=', workspaceId)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          link_sharing_enabled: 1,
          external_posting_enabled: 1,
          link_expiry_default_days: 30,
          link_expiry_max_days: state === 'unlimited' ? null : 90,
        })
      }
    } finally {
      vi.useRealTimers()
      await db.destroy()
    }
  },
)

test('external access fixture recreates a deleted shareable with retained publication history', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  const scenario = 'settings-external-access/finite'
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(now) })
  try {
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = workspaceId + '-user'
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'expiry-owner@example.test',
        name: 'Owner',
        email_verified: 1,
        created_at: now,
        updated_at: now,
        workspace_id: workspaceId,
      })
      .execute()
    await addScenarioOwner(db, workspaceId, userId, now)
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    const shareableId = devShareableId(workspaceId + '-expiry-preview')
    const publication = await db
      .selectFrom('link_publications')
      .selectAll()
      .where('workspace_id', '=', workspaceId)
      .where('shareable_id', '=', shareableId)
      .executeTakeFirstOrThrow()
    await db.deleteFrom('shareables').where('id', '=', shareableId).execute()
    expect(
      await db
        .selectFrom('shareables')
        .select('id')
        .where('id', '=', shareableId)
        .executeTakeFirst(),
    ).toBeUndefined()
    expect(
      await db
        .selectFrom('link_publications')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('shareable_id', '=', shareableId)
        .executeTakeFirstOrThrow(),
    ).toEqual(publication)
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    expect(
      await db
        .selectFrom('shareables')
        .select(['id', 'visibility', 'link_expires_at'])
        .where('id', '=', shareableId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: shareableId,
      visibility: 'link',
      link_expires_at: new Date(
        Date.parse(now) + 60 * 86_400_000,
      ).toISOString(),
    })
    expect(
      await db
        .selectFrom('link_publications')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('shareable_id', '=', shareableId)
        .executeTakeFirstOrThrow(),
    ).toEqual(publication)
  } finally {
    vi.useRealTimers()
    await db.destroy()
  }
})

test('inventory captures refresh only owned rows and empty states have zero matching rows', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  const {
    loadWorkspaceInventoryProjectsPage,
    loadWorkspaceInventoryArtifactsPage,
  } = await import('./team-management.server')
  /** Each state seeds its own registered anchor, as dev sign-in does. */
  async function anchor(scenario: string) {
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: `${workspaceId}@example.test`,
        email_verified: 1,
        image: null,
        locale: null,
        name: 'Owner',
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    const projects = () =>
      loadWorkspaceInventoryProjectsPage(db, workspaceId, 1)
    const files = (page = 1) =>
      loadWorkspaceInventoryArtifactsPage(db, workspaceId, {
        visibility: 'all',
        sort: 'updated',
        page,
      })
    return { workspaceId, userId, projects, files }
  }
  const insertFile = (
    workspaceId: string,
    userId: string,
    containerId: string,
    id: string,
    name: string,
  ) =>
    db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: workspaceId,
        owner_user_id: userId,
        container_id: containerId,
        name,
        artifact_kind: 'html_page',
        visibility: 'project',
        created_at: '2026-09-08T00:00:00.000Z',
        updated_at: '2026-09-08T00:00:00.000Z',
      })
      .execute()
  try {
    for (const kind of ['projects', 'artifacts']) {
      const prefix = `settings-inventory-${kind}`

      // The empty state owns no rows: a project and file there are left alone.
      const empty = await anchor(`${prefix}/empty`)
      expect((await empty.projects()).total).toBe(0)
      expect((await empty.files()).total).toBe(0)
      const emptyProject = await createProjectContainer(
        db,
        empty.workspaceId,
        empty.userId,
        {
          name: 'Quarterly reports and review materials for the whole workspace',
          description: null,
          baseVisibility: 'workspace',
        },
      )
      if (emptyProject.kind !== 'ok') throw new Error(emptyProject.kind)
      await insertFile(
        empty.workspaceId,
        empty.userId,
        emptyProject.id,
        `${empty.workspaceId}-file`,
        'Quarterly report.html',
      )
      await seedDevScreenState(
        db,
        `${prefix}/empty`,
        empty.workspaceId,
        empty.userId,
        now,
      )
      expect((await empty.projects()).total).toBe(1)
      expect((await empty.files()).total).toBe(1)

      const { workspaceId, userId, projects, files } = await anchor(
        `${prefix}/populated`,
      )
      expect((await projects()).projects[0]).toMatchObject({
        artifactCount: 1,
        name: 'Quarterly reports and review materials for the whole workspace',
      })
      expect((await files()).total).toBe(1)
      await db
        .insertInto('artifact_containers')
        .values({
          id: `${workspaceId}-unrelated`,
          workspace_id: workspaceId,
          kind: 'project',
          created_by_id: userId,
          name: 'User project',
          created_at: now,
          updated_at: now,
        })
        .execute()
      // Another state's title is no fixture of the populated state.
      await insertFile(
        workspaceId,
        userId,
        `${workspaceId}-unrelated`,
        `${workspaceId}-other-state-title`,
        'Quarterly report 1.html',
      )
      await seedDevScreenState(
        db,
        `${prefix}/populated`,
        workspaceId,
        userId,
        now,
      )
      expect(
        (await projects()).projects.find((row) => row.name === 'User project'),
      ).toMatchObject({ artifactCount: 1 })
      // A renamed fixture project no longer has the fixture's identity: it
      // stays with its own file, and the fixture file returns to a new one.
      const fixtureProjectId = (await projects()).projects.find(
        (row) =>
          row.name ===
          'Quarterly reports and review materials for the whole workspace',
      )!.id
      await db
        .updateTable('artifact_containers')
        .set({ name: 'Edited capture' })
        .where('id', '=', fixtureProjectId)
        .execute()
      await db
        .insertInto('shareables')
        .values({
          id: `${workspaceId}-edited-note`,
          workspace_id: workspaceId,
          owner_user_id: userId,
          container_id: fixtureProjectId,
          name: 'Notes.html',
          artifact_kind: 'html_page',
          visibility: 'project',
          created_at: '2026-09-08T00:00:00.000Z',
          updated_at: '2026-09-08T00:00:00.000Z',
        })
        .execute()
      await seedDevScreenState(
        db,
        `${prefix}/populated`,
        workspaceId,
        userId,
        now,
      )
      const byName = new Map(
        (await projects()).projects.map((row) => [row.name, row.artifactCount]),
      )
      expect(byName.get('Edited capture')).toBe(1)
      expect(
        byName.get(
          'Quarterly reports and review materials for the whole workspace',
        ),
      ).toBe(1)
      if (kind === 'artifacts') {
        const paged = await anchor(`${prefix}/paginated`)
        // The report order the captures have always shown (the earlier seed's
        // fixture IDs, tie-broken by the listing), pinned as literal numbers.
        const sequence = [
          2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 13, 12, 11, 18, 17, 16, 15, 20, 19, 1,
          27, 28, 25, 26, 40, 23, 39, 24, 21, 22, 49, 32, 50, 31, 34, 29, 33,
          45, 30, 36, 46, 35, 47, 38, 48, 37, 41, 42, 43, 44, 51,
        ].map((number) => `Quarterly report ${number}.html`)
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt === 2) {
            // A same-title replacement under an ID that sorts first would move
            // the page-2 report onto page 1 if it were kept as found.
            const title = `Quarterly report ${INVENTORY_PAGE_SIZE + 1}.html`
            const replaced = await db
              .selectFrom('shareables')
              .selectAll()
              .where('workspace_id', '=', paged.workspaceId)
              .where('name', '=', title)
              .executeTakeFirstOrThrow()
            await db
              .deleteFrom('shareables')
              .where('id', '=', replaced.id)
              .execute()
            await db
              .insertInto('shareables')
              .values({ ...replaced, id: '0000000000' })
              .execute()
          }
          if (attempt > 0)
            await seedDevScreenState(
              db,
              `${prefix}/paginated`,
              paged.workspaceId,
              paged.userId,
              now,
            )
          const [first, second] = await Promise.all([
            paged.files(1),
            paged.files(2),
          ])
          // The page boundary leaves the last numbered report alone on page 2.
          expect(first.total).toBe(INVENTORY_PAGE_SIZE + 1)
          expect(first.artifacts.map((artifact) => artifact.name)).toEqual(
            sequence.slice(0, INVENTORY_PAGE_SIZE),
          )
          expect(second.artifacts.map((artifact) => artifact.name)).toEqual(
            sequence.slice(INVENTORY_PAGE_SIZE),
          )
        }

        // The fixture is the row at its fixed ID: renamed and moved by a
        // capture, again and again, it returns to its title, project and
        // place in the page order at that same ID.
        const lastTitle = `Quarterly report ${INVENTORY_PAGE_SIZE + 1}.html`
        const fixtureRows = () =>
          db
            .selectFrom('shareables')
            .selectAll()
            .where('workspace_id', '=', paged.workspaceId)
            .where('name', '=', lastTitle)
            .execute()
        const [original] = await fixtureRows()
        expect(original.id).toBe(
          devShareableId(
            `${paged.workspaceId}-inventory-file${INVENTORY_PAGE_SIZE}`,
          ),
        )
        const { id: movedTo } = await db
          .insertInto('artifact_containers')
          .values({
            id: `${paged.workspaceId}-moved-to`,
            workspace_id: paged.workspaceId,
            kind: 'project',
            created_by_id: paged.userId,
            name: 'Moved to',
            created_at: now,
            updated_at: now,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        // A same-title artifact in another workspace is not this fixture.
        await insertFile(
          workspaceId,
          userId,
          `${workspaceId}-unrelated`,
          `${workspaceId}-same-title-elsewhere`,
          lastTitle,
        )
        const elsewhere = () =>
          db
            .selectFrom('shareables')
            .selectAll()
            .where('id', '=', `${workspaceId}-same-title-elsewhere`)
            .executeTakeFirstOrThrow()
        const elsewhereBefore = await elsewhere()
        const pages = async () => {
          const [first, second] = await Promise.all([
            paged.files(1),
            paged.files(2),
          ])
          return [first, second].map((page) =>
            page.artifacts.map((artifact) => artifact.name),
          )
        }
        const otherOwner = `${paged.workspaceId}-other-owner`
        await addScenarioOwner(db, paged.workspaceId, otherOwner, now)
        for (let rename = 1; rename <= 4; rename++) {
          // Each capture edit renames, moves, re-owns and restricts it later.
          const editedAt = new Date(
            Date.parse(now) + rename * 86_400_000,
          ).toISOString()
          await db
            .updateTable('shareables')
            .set({
              // A product rename writes the displayed title override.
              title_override: `Renamed report ${rename}`,
              name: `Renamed report ${rename}.html`,
              container_id: movedTo,
              owner_user_id: otherOwner,
              visibility: 'private',
              created_at: editedAt,
              updated_at: editedAt,
              last_accessed_at: editedAt,
            })
            .where('id', '=', original.id)
            .execute()
          await seedDevScreenState(
            db,
            `${prefix}/paginated`,
            paged.workspaceId,
            paged.userId,
            now,
          )
          expect(await fixtureRows()).toEqual([original])
          expect(await pages()).toEqual([
            sequence.slice(0, INVENTORY_PAGE_SIZE),
            sequence.slice(INVENTORY_PAGE_SIZE),
          ])
        }
        expect(await elsewhere()).toEqual(elsewhereBefore)
      }
      expect(
        await db
          .selectFrom('users')
          .select('name')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Owner' })
    }
  } finally {
    await db.destroy()
  }
})

test('a renamed inventory fixture returns to its fixed ID past a same-title artifact in another workspace', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  const scenario = 'settings-inventory-artifacts/populated'
  try {
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await addScenarioOwner(db, workspaceId, userId, now)
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    const fixtureId = devShareableId(`${workspaceId}-inventory-file`)
    const fixture = () =>
      db
        .selectFrom('shareables')
        .selectAll()
        .where('id', '=', fixtureId)
        .executeTakeFirstOrThrow()
    const original = await fixture()
    expect(original.name).toBe('Quarterly report.html')
    // The ID that sorts right after the fixed ID: the earlier seed's first
    // replacement slot for a renamed fixture.
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
    const chars = [...fixtureId]
    let index = chars.length - 1
    while (chars[index] === 'z') chars[index--] = '0'
    chars[index] = alphabet[alphabet.indexOf(chars[index]) + 1]
    const successorId = chars.join('')
    // Another workspace holds a same-title artifact at that ID.
    const neighbor = await ensureDevScreenState(
      db,
      'settings-inventory-artifacts/empty',
      now,
      'team',
    )
    const neighborUser = `${neighbor.workspaceId}-user`
    await addScenarioOwner(db, neighbor.workspaceId, neighborUser, now)
    const neighborInbox = await getOrCreateInboxContainerId(
      db,
      neighbor.workspaceId,
      neighborUser,
      now,
    )
    await db
      .insertInto('shareables')
      .values({
        id: successorId,
        workspace_id: neighbor.workspaceId,
        owner_user_id: neighborUser,
        container_id: neighborInbox,
        name: 'Quarterly report.html',
        artifact_kind: 'html_page',
        visibility: 'private',
        created_at: now,
        updated_at: now,
      })
      .execute()
    const neighborRow = () =>
      db
        .selectFrom('shareables')
        .selectAll()
        .where('id', '=', successorId)
        .executeTakeFirstOrThrow()
    const neighborBefore = await neighborRow()
    // A capture renames the fixture through the displayed title.
    await db
      .updateTable('shareables')
      .set({
        title_override: 'Renamed report',
        updated_at: '2026-09-10T00:00:00.000Z',
      })
      .where('id', '=', fixtureId)
      .execute()

    await seedDevScreenState(db, scenario, workspaceId, userId, now)

    expect(await fixture()).toEqual(original)
    expect(await neighborRow()).toEqual(neighborBefore)
  } finally {
    await db.destroy()
  }
})

test('responsive capture fixtures restore the long email, initial avatar and purchase state', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  try {
    const { workspaceId } = await ensureDevScreenState(
      db,
      'settings-bots/long-email',
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'owner@example.test',
        email_verified: 1,
        name: 'Owner',
        image: 'https://example.test/avatar.png',
        locale: null,
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await addScenarioOwner(db, workspaceId, userId, now)
    for (let repetition = 0; repetition < 2; repetition++) {
      await seedDevScreenState(
        db,
        'settings-bots/long-email',
        workspaceId,
        userId,
        now,
      )
      const bots = await listWorkspaceBots(db, workspaceId, now)
      expect(bots.find((bot) => bot.name === 'Nightly report bot')?.email).toBe(
        `nightly-report-automation-with-a-long-destination-address-${workspaceId}@bots.artifactshare.invalid`,
      )
      await seedDevScreenState(
        db,
        'settings-general/initial-avatar',
        workspaceId,
        userId,
        now,
      )
      expect(
        await db
          .selectFrom('users')
          .select(['image', 'name'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ image: null, name: 'Owner' })
    }
    // Both Free billing states rebuild the same starting row on a re-seed,
    // whatever the previous seed or an edit left behind.
    for (const [state, used] of [
      ['purchase', 0],
      ['near-limit', Math.round(PLAN_STORAGE_QUOTA_BYTES.free * 0.95)],
    ] as const) {
      const scenario = `settings-billing/${state}`
      const { workspaceId: billingWorkspaceId } = await ensureDevScreenState(
        db,
        scenario,
        now,
        'team',
      )
      await db
        .updateTable('workspaces')
        .set({
          plan: 'team',
          stripe_customer_id: 'cus_stale',
          stripe_subscription_id: 'fixture-subscription',
          stripe_subscription_status: 'active',
          storage_used_bytes: 123,
          storage_quota_bytes: 456,
          link_sharing_enabled: 0,
          external_posting_enabled: 1,
          link_expiry_default_days: 7,
          link_expiry_max_days: 90,
        })
        .where('id', '=', billingWorkspaceId)
        .execute()
      await ensureDevScreenState(db, scenario, now, 'team')
      expect(
        await db
          .selectFrom('workspaces')
          .select([
            'plan',
            'stripe_customer_id',
            'stripe_subscription_id',
            'stripe_subscription_status',
            'storage_used_bytes',
            'storage_quota_bytes',
            'link_sharing_enabled',
            'external_posting_enabled',
            'link_expiry_default_days',
            'link_expiry_max_days',
          ])
          .where('id', '=', billingWorkspaceId)
          .executeTakeFirstOrThrow(),
        state,
      ).toEqual({
        plan: 'free',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        stripe_subscription_status: 'none',
        storage_used_bytes: used,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        ...linkExpiryStartingColumns(),
      })
    }
  } finally {
    await db.destroy()
  }
})

test('long-member capture restores active and removed rows without changing unrelated users', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  const scenario = 'settings/long-member-addresses'
  try {
    expect(isScreenScenario(scenario)).toBe(true)
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const userId = `${workspaceId}-user`
    await db
      .insertInto('users')
      .values({
        id: userId,
        email: 'owner@example.test',
        email_verified: 1,
        image: null,
        locale: null,
        name: 'Owner',
        workspace_id: workspaceId,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await addScenarioOwner(db, workspaceId, userId, now)
    for (let repetition = 0; repetition < 2; repetition++) {
      await seedDevScreenState(db, scenario, workspaceId, userId, now)
      const rows = await db
        .selectFrom('workspace_members')
        .innerJoin('users', 'users.id', 'workspace_members.user_id')
        .select([
          'users.email',
          'users.name',
          'workspace_members.status',
          'workspace_members.role',
        ])
        .where('workspace_members.workspace_id', '=', workspaceId)
        .where('workspace_members.user_id', '!=', userId)
        .orderBy('workspace_members.status')
        .execute()
      expect(rows).toEqual(
        ['active', 'removed'].map((status) => ({
          email: `${status}-member-with-a-long-synthetic-address-${workspaceId}@example.test`,
          name:
            status === 'active'
              ? 'Synthetic active member with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones'
              : 'Synthetic removed member with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
          status,
          role: status === 'active' ? 'admin' : 'member',
        })),
      )
      expect(await loadRemovedWorkspaceMembers(db, workspaceId)).toMatchObject([
        {
          id: `${workspaceId}-long-member-removed`,
          email: `removed-member-with-a-long-synthetic-address-${workspaceId}@example.test`,
        },
      ])
      expect(
        await db
          .selectFrom('users')
          .select(['name', 'email'])
          .where('id', '=', userId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Owner', email: 'owner@example.test' })
      await db
        .updateTable('users')
        .set({ email: 'edited@example.test', name: 'Edited member' })
        .where('id', '=', `${workspaceId}-long-member-active`)
        .execute()
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', `${workspaceId}-long-member-active`)
        .execute()
      await db
        .updateTable('workspace_members')
        .set({ status: 'active' })
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', `${workspaceId}-long-member-removed`)
        .execute()
    }
  } finally {
    await db.destroy()
  }
})

test('long bot email capture can be seeded in two plan workspaces', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  try {
    const emails = []
    for (const plan of ['plus', 'team'] as const) {
      const { workspaceId } = await ensureDevScreenState(
        db,
        'settings-bots/long-email',
        now,
        plan,
      )
      const userId = `${workspaceId}-user`
      await db
        .insertInto('users')
        .values({
          id: userId,
          email: `${userId}@example.test`,
          name: 'Owner',
          email_verified: 1,
          workspace_id: workspaceId,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await addScenarioOwner(db, workspaceId, userId, now)
      await seedDevScreenState(
        db,
        'settings-bots/long-email',
        workspaceId,
        userId,
        now,
      )
      const bots = await listWorkspaceBots(db, workspaceId, now)
      const email = bots.find((bot) => bot.name === 'Nightly report bot')?.email
      emails.push(email)
    }
    expect(new Set(emails).size).toBe(2)
  } finally {
    await db.destroy()
  }
})

test('long-owner capture restores its owner profile without changing other users', async () => {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-09T00:00:00.000Z'
  const scenario = 'settings-general/long-owner'
  try {
    expect(isScreenScenario(scenario)).toBe(true)
    const { workspaceId } = await ensureDevScreenState(
      db,
      scenario,
      now,
      'team',
    )
    const other = await ensureDevScreenState(
      db,
      'settings-general/initial-avatar',
      now,
      'team',
    )
    for (const [id, workspace, role] of [
      ['capture-owner', workspaceId, 'owner'],
      ['capture-member', workspaceId, 'member'],
      ['other-owner', other.workspaceId, 'owner'],
    ] as const) {
      await db
        .insertInto('users')
        .values({
          id,
          workspace_id: workspace,
          name: 'Original name',
          email: `${id}@example.test`,
          email_verified: 1,
          image: null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: workspace,
          user_id: id,
          role,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute()
    }
    for (let repetition = 0; repetition < 2; repetition++) {
      await seedDevScreenState(db, scenario, workspaceId, 'capture-owner', now)
      expect(
        await db
          .selectFrom('users')
          .select(['id', 'name', 'email'])
          .orderBy('id')
          .execute(),
      ).toEqual([
        {
          id: 'capture-member',
          name: 'Original name',
          email: 'capture-member@example.test',
        },
        {
          id: 'capture-owner',
          name: 'Synthetic workspace owner with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
          email:
            'team-owner-with-a-long-synthetic-owner-address-for-phone-layout@example.test',
        },
        {
          id: 'other-owner',
          name: 'Original name',
          email: 'other-owner@example.test',
        },
      ])
      expect(devScreenUserEmail('team-owner', scenario)).toBe(
        'team-owner-with-a-long-synthetic-owner-address-for-phone-layout@example.test',
      )
      await db
        .updateTable('users')
        .set({ name: 'Edited owner', email: 'edited@example.test' })
        .where('id', '=', 'capture-owner')
        .execute()
    }
  } finally {
    await db.destroy()
  }
})

test.each(['team', 'plus'] as const)(
  'new %s scenario workspaces use the production plan quota',
  async (plan) => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        'settings/result-warning',
        '2026-07-31T12:00:00.000Z',
        plan,
      )
      const workspace = await db
        .selectFrom('workspaces')
        .select('storage_quota_bytes')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
      expect(workspace.storage_quota_bytes).toBe(PLAN_STORAGE_QUOTA_BYTES[plan])
    } finally {
      await db.destroy()
    }
  },
)

test('billing capture near-limit puts a Free workspace near its production quota', async () => {
  const { db } = createMigratedInMemoryDb()
  try {
    const { workspaceId } = await ensureDevScreenState(
      db,
      'settings-billing/near-limit',
      '2026-07-31T12:00:00.000Z',
      'team',
    )
    expect(
      await db
        .selectFrom('workspaces')
        .select([
          'plan',
          'stripe_subscription_id',
          'storage_used_bytes',
          'storage_quota_bytes',
        ])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      plan: 'free',
      stripe_subscription_id: null,
      storage_used_bytes: Math.round(PLAN_STORAGE_QUOTA_BYTES.free * 0.95),
      storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
  } finally {
    await db.destroy()
  }
})

test.each([
  'settings-billing/team-unsubscribed',
  'settings-billing/team-unsubscribed-high-usage',
])(
  'retired billing state %s can no longer be selected or seeded',
  async (scenario) => {
    expect(isScreenScenario(scenario)).toBe(false)
    const { db } = createMigratedInMemoryDb()
    try {
      await expect(
        ensureDevScreenState(db, scenario, '2026-07-31T12:00:00.000Z', 'team'),
      ).rejects.toThrow('Unknown screen scenario')
    } finally {
      await db.destroy()
    }
  },
)

describe('paid billing capture states', () => {
  const now = '2026-07-31T12:00:00.000Z'
  let fake: Awaited<ReturnType<typeof startCaptureStripe>>
  let billing: BillingEnv
  beforeAll(async () => {
    fake = await startCaptureStripe({
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    })
    billing = captureStripeVars(fake.origin)
  })
  afterAll(() => fake.close())

  test.each([
    ['subscribed', 'active', null],
    ['past-due', 'past_due', null],
    [
      'continuing-near-limit',
      'active',
      Math.round(PLAN_STORAGE_QUOTA_BYTES.team * 0.95),
    ],
  ] as const)(
    '%s stores the fake Stripe contract through the sync service',
    async (state, status, used) => {
      const { db } = createMigratedInMemoryDb()
      try {
        // Every seed rebuilds the billing state: a repeated sign-in after the
        // billing fields drifted stores the same row the sync stores for a
        // first contract.
        let seeded: unknown
        for (let signIn = 0; signIn < 2; signIn++) {
          if (signIn === 1)
            await db
              .updateTable('workspaces')
              .set({
                plan: 'plus',
                stripe_customer_id: 'cus_stale',
                stripe_subscription_id: 'sub_other',
                stripe_subscription_status: 'canceled',
                storage_quota_bytes: 1,
                storage_used_bytes: 1,
                link_expiry_default_days: 7,
                link_expiry_max_days: 90,
              })
              .execute()
          const { workspaceId } = await ensureDevScreenState(
            db,
            `settings-billing/${state}`,
            now,
            'team',
            billing,
          )
          const row = await db
            .selectFrom('workspaces')
            .selectAll()
            .where('id', '=', workspaceId)
            .executeTakeFirstOrThrow()
          expect(row, `sign-in ${signIn}`).toMatchObject({
            plan: 'team',
            stripe_subscription_id: `sub_capture_${workspaceId}`,
            stripe_subscription_status: status,
            storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.team,
            storage_used_bytes: used ?? 0,
            // The first-contract defaults the sync applies to Team.
            link_sharing_enabled: 1,
            external_posting_enabled: 1,
            ...linkExpiryStartingColumns(),
          })
          if (signIn === 0) seeded = row
          else expect(row).toEqual(seeded)
          const stripe = createStripeClient(billing)
          expect(
            await loadSubscriptionContract(
              stripe,
              billing,
              row.stripe_subscription_id!,
            ),
          ).toEqual({
            plan: 'team',
            interval: 'monthly',
            currency: 'usd',
            amount: BILLING_PRICES.team.usd.month,
            renewsAt: '2026-08-01T00:00:00.000Z',
            cancelAtPeriodEnd: false,
          })
          // The two changes the page offers: the preview decodes the price
          // difference the fake invoice reports, in display units.
          for (const [plan, interval, amount] of [
            [
              'plus',
              'monthly',
              BILLING_PRICES.plus.usd.month - BILLING_PRICES.team.usd.month,
            ],
            [
              'team',
              'yearly',
              BILLING_PRICES.team.usd.year - BILLING_PRICES.team.usd.month,
            ],
          ] as const)
            expect(
              await previewPlanChange(stripe, billing, row, plan, interval),
            ).toEqual({
              kind: 'ok',
              currency: 'usd',
              prorationAmount: amount,
              nextInvoiceAt: '2026-08-01T00:00:00.000Z',
            })
        }
        // Seeding again after the row changed rebuilds the same row: the
        // capture shows what the sync stores for a first paid contract.
        await db
          .updateTable('workspaces')
          .set({ external_posting_enabled: 0, storage_used_bytes: 1 })
          .execute()
        const { workspaceId } = await ensureDevScreenState(
          db,
          `settings-billing/${state}`,
          now,
          'team',
          billing,
        )
        expect(
          await db
            .selectFrom('workspaces')
            .selectAll()
            .where('id', '=', workspaceId)
            .executeTakeFirstOrThrow(),
        ).toEqual(seeded)
      } finally {
        await db.destroy()
      }
    },
  )

  test('setup fails without the fake Stripe or a successful sync, recording no paid state', async () => {
    const { db } = createMigratedInMemoryDb()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const [env, failure] of [
        [undefined, 'fake Stripe'],
        [{ ...billing, STRIPE_API_ORIGIN: undefined }, 'fake Stripe'],
        [
          { ...billing, STRIPE_API_ORIGIN: 'http://stripe.example.test:4242' },
          'fake Stripe',
        ],
        [{ ...billing, STRIPE_SECRET_KEY: 'not-the-capture-key' }, 'API key'],
        [
          { ...billing, STRIPE_PRICE_TEAM_MONTHLY: 'price_other_team' },
          'unknown-price',
        ],
      ] as const)
        await expect(
          ensureDevScreenState(
            db,
            'settings-billing/subscribed',
            now,
            'team',
            env,
          ),
        ).rejects.toThrow(failure)
      expect(
        await db
          .selectFrom('workspaces')
          .select('id')
          .where('stripe_subscription_id', 'is not', null)
          .execute(),
      ).toEqual([])
    } finally {
      log.mockRestore()
      await db.destroy()
    }
  })
})

describe('Settings seeds write through production services', () => {
  const clock = '2026-09-09T00:00:00.000Z'
  const later = (ms: number, from = clock) =>
    new Date(Date.parse(from) + ms).toISOString()
  const DAY = 86_400_000

  async function signIn(
    db: Kysely<DB>,
    scenario: string,
    plan: 'free' | 'plus' | 'team' = 'team',
    now = clock,
  ) {
    const { workspaceId } = await ensureDevScreenState(db, scenario, now, plan)
    const userId = `${workspaceId}-user`
    await addScenarioOwner(db, workspaceId, userId, now)
    await seedDevScreenState(db, scenario, workspaceId, userId, now)
    return { workspaceId, userId }
  }

  function dumpRows(sqlite: DatabaseSync) {
    return Object.fromEntries(
      [
        'workspaces',
        'users',
        'workspace_members',
        'artifact_containers',
        'project_members',
        'shareables',
        'link_publications',
        'api_tokens',
        'agent_profiles',
        'publisher_clients',
        'sessions',
        'cli_refresh_credentials',
        'cli_family_authorities',
        'cli_session_authorities',
        'cli_refresh_sessions',
        'bot_destination_projects',
        'audit_events',
        'slack_workspaces',
        'deviceCode',
        'search_index_changes',
      ].map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
      ]),
    )
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(clock) })
  })
  afterEach(() => {
    vi.useRealTimers()
    sqliteRef.current = null
  })

  test.each(
    (scenarioIds as string[]).filter(
      (scenario) =>
        (scenario.startsWith('settings/') ||
          scenario.startsWith('settings-')) &&
        ![
          'settings-billing/subscribed',
          'settings-billing/past-due',
          'settings-billing/continuing-near-limit',
        ].includes(scenario),
    ),
  )('%s stores identical rows when seeded twice', async (scenario) => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const first = dumpRows(sqlite)
      await ensureDevScreenState(db, scenario, clock, 'team')
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(dumpRows(sqlite)).toEqual(first)
    } finally {
      await db.destroy()
    }
  })

  test.each(['free', 'plus', 'team'] as const)(
    '%s Settings anchors hold the production plan values, fresh and reseeded',
    async (plan) => {
      const { db } = createMigratedInMemoryDb()
      const expected = {
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES[plan],
        link_sharing_enabled: LINK_SHARING_PLAN_DEFAULTS[plan]
          .linkSharingEnabled
          ? 1
          : 0,
      }
      const anchor = (id: string) =>
        db
          .selectFrom('workspaces')
          .select(['storage_quota_bytes', 'link_sharing_enabled'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      try {
        const { workspaceId } = await ensureDevScreenState(
          db,
          'settings/with-bots',
          clock,
          plan,
        )
        expect(await anchor(workspaceId)).toEqual(expected)
        await db
          .updateTable('workspaces')
          .set({
            storage_quota_bytes: 5_000_000_000,
            link_sharing_enabled: plan === 'team' ? 1 : 0,
          })
          .where('id', '=', workspaceId)
          .execute()
        await ensureDevScreenState(db, 'settings/with-bots', clock, plan)
        expect(await anchor(workspaceId)).toEqual(expected)
        const control = await ensureDevScreenState(
          db,
          'home/content-rich',
          clock,
          plan,
        )
        expect(await anchor(control.workspaceId)).toEqual({
          storage_quota_bytes:
            plan === 'free' ? 5_000_000_000 : PLAN_STORAGE_QUOTA_BYTES[plan],
          link_sharing_enabled: 1,
        })
      } finally {
        await db.destroy()
      }
    },
  )

  /** Persisted fields a bot's service writes, without generated values. */
  async function botShape(db: Kysely<DB>, workspaceId: string, botId: string) {
    const row = await db
      .selectFrom('users')
      .innerJoin('workspace_members as m', 'm.user_id', 'users.id')
      .innerJoin('agent_profiles as p', 'p.user_id', 'users.id')
      .innerJoin('cli_family_authorities as f', 'f.user_id', 'users.id')
      .innerJoin('cli_refresh_credentials as c', 'c.family_id', 'f.family_id')
      .select([
        'users.kind',
        'users.email',
        'users.email_verified',
        'users.image',
        'users.locale',
        'users.bot_stopped_at',
        'm.role',
        'm.status',
        'm.removed_by',
        'f.preset',
        'f.status as familyStatus',
        'f.workspace_id as familyWorkspaceId',
        'f.device_name',
        'f.agent_profile_id',
        'p.id as profileId',
        'c.id as credentialId',
        'c.family_id as credentialFamilyId',
        'c.token_hash',
        'c.revoked_at',
        'c.device_id',
      ])
      .where('users.id', '=', botId)
      .where('m.workspace_id', '=', workspaceId)
      .executeTakeFirstOrThrow()
    const audits = await db
      .selectFrom('audit_events')
      .select('action')
      .where('workspace_id', '=', workspaceId)
      .where('subject_id', '=', botId)
      .orderBy('action')
      .execute()
    return {
      kind: row.kind,
      // The shape `generateBotEmail` produces, not just its reserved domain.
      generatedAddress: /^bot-[a-z0-9]{20}@bots\.artifactshare\.invalid$/.test(
        row.email,
      ),
      emailVerified: row.email_verified,
      image: row.image,
      locale: row.locale,
      stopped: row.bot_stopped_at !== null,
      role: row.role,
      status: row.status,
      removedBy: row.removed_by,
      preset: row.preset,
      familyStatus: row.familyStatus,
      familyWorkspaceId: row.familyWorkspaceId,
      deviceName: row.device_name,
      profileLinked: row.agent_profile_id === row.profileId,
      credentialIsFamily: row.credentialId === row.credentialFamilyId,
      realHash: /^[0-9a-f]{64}$/.test(row.token_hash),
      revoked: row.revoked_at !== null,
      deviceId: row.device_id,
      audits: audits.map((audit) => audit.action),
    }
  }

  test('every bot variant matches a service-created control and keeps destination order', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        'settings/with-bots',
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      // Fresh setup generates every ID in descending sort order, so the
      // destination project created later sorts first.
      let counter = 9_000_000
      const generated: string[] = []
      nanoidControl.next = (size = 21) => {
        const id = `z${String(counter--).padStart(size - 1, '0')}`
        generated.push(id)
        return id
      }
      try {
        await seedDevScreenState(
          db,
          'settings/with-bots',
          workspaceId,
          userId,
          clock,
        )
      } finally {
        nanoidControl.next = null
      }
      const destinations = await db
        .selectFrom('artifact_containers')
        .select(['id', 'name'])
        .where('workspace_id', '=', workspaceId)
        .where('name', 'in', ['Nightly reports', 'Management reports'])
        .orderBy('id')
        .execute()
      // Both came from fresh creation with controlled IDs.
      expect(destinations.every((row) => generated.includes(row.id))).toBe(true)
      expect(destinations.map((row) => row.name)).toEqual([
        'Management reports',
        'Nightly reports',
      ])
      const bots = await listWorkspaceBots(db, workspaceId, clock)
      const named = (name: string) => bots.find((bot) => bot.name === name)!
      const active = named('Nightly report bot')
      expect(
        active.approvedProjects?.map((project) => [
          project.name,
          project.unavailable,
        ]),
      ).toEqual([
        ['Management reports', false],
        ['Nightly reports', false],
      ])
      expect(active.projectId).toBe(destinations[1].id)
      expect(active.projectName).toBe('Nightly reports')
      expect(bots.map((bot) => bot.approvedProjects?.length)).toEqual([
        2, 1, 1, 1,
      ])
      // Both created projects have the creator membership creation writes.
      expect(
        await db
          .selectFrom('project_members')
          .select(['container_id', 'user_id'])
          .where(
            'container_id',
            'in',
            destinations.map((row) => row.id),
          )
          .orderBy('container_id')
          .execute(),
      ).toEqual(
        destinations.map((row) => ({ container_id: row.id, user_id: userId })),
      )

      const actor = { id: userId, workspaceId }
      const live = await createWorkspaceBot(db, actor, {
        name: 'Control live',
        projectId: active.projectId!,
      })
      const stopped = await createWorkspaceBot(db, actor, {
        name: 'Control stopped',
        projectId: active.projectId!,
      })
      if (live.kind !== 'ok' || stopped.kind !== 'ok')
        throw new Error('control bot failed')
      for (const control of [live, stopped])
        expect(
          await db
            .selectFrom('cli_refresh_credentials')
            .select('token_hash')
            .where('user_id', '=', control.botUserId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ token_hash: await computeTextSha256Hex(control.token) })
      await stopWorkspaceBot(db, actor, stopped.botUserId)
      const liveShape = await botShape(db, workspaceId, live.botUserId)
      const stoppedShape = await botShape(db, workspaceId, stopped.botUserId)
      expect(stoppedShape).toMatchObject({
        status: 'removed',
        familyStatus: 'revoked',
        revoked: true,
      })
      for (const [name, control] of [
        ['Nightly report bot', liveShape],
        ['Metrics sync bot', liveShape],
        ['Retired handoff bot', stoppedShape],
        ['Setup failed bot', stoppedShape],
      ] as const)
        expect(await botShape(db, workspaceId, named(name).id), name).toEqual(
          control,
        )
      // Creation precedes the use and stop each row shows.
      const times = await db
        .selectFrom('users')
        .innerJoin('cli_refresh_credentials as c', 'c.user_id', 'users.id')
        .select(['users.created_at', 'users.bot_stopped_at', 'c.last_used_at'])
        .where(
          'users.id',
          'in',
          bots.map((bot) => bot.id),
        )
        .execute()
      for (const row of times)
        for (const event of [row.bot_stopped_at, row.last_used_at])
          if (event) expect(row.created_at < event).toBe(true)
    } finally {
      await db.destroy()
    }
  })

  test.each(['settings/with-bots', 'settings-bots/long-email'] as const)(
    '%s bots recover from cancel and reissue',
    async (scenario) => {
      const { db } = createMigratedInMemoryDb()
      try {
        const { workspaceId, userId } = await signIn(db, scenario)
        const actor = { id: userId, workspaceId }
        const summary = async () =>
          (await listWorkspaceBots(db, workspaceId, clock)).map((bot) => ({
            name: bot.name,
            stopped: bot.botStoppedAt !== null,
            live: bot.credentialLive,
            cancelable: bot.cancelable,
            destinations: bot.approvedProjects?.map((project) => [
              project.name,
              project.unavailable,
            ]),
          }))
        const healthy = await summary()
        const initial = await listWorkspaceBots(db, workspaceId, clock)
        const idOf = (name: string) =>
          initial.find((bot) => bot.name === name)!.id

        expect(
          await cancelWorkspaceBot(db, actor, idOf('Setup failed bot')),
        ).toEqual({ kind: 'ok' })
        for (const name of ['Nightly report bot', 'Metrics sync bot'])
          expect(
            await reissueWorkspaceBotCredential(db, actor, idOf(name)),
          ).toMatchObject({ kind: 'ok' })
        expect(await summary()).not.toEqual(healthy)
        // The reissued bot's address also holds grants on projects that are
        // not its destinations: one here and one in another workspace.
        const { email: botEmail } = await db
          .selectFrom('users')
          .select('email')
          .where('id', '=', idOf('Nightly report bot'))
          .executeTakeFirstOrThrow()
        const other = await ensureDevScreenState(db, scenario, clock, 'plus')
        await addScenarioOwner(
          db,
          other.workspaceId,
          `${other.workspaceId}-user`,
          clock,
        )
        const neighborIds: string[] = []
        for (const [ws, owner] of [
          [workspaceId, userId],
          [other.workspaceId, `${other.workspaceId}-user`],
        ]) {
          const project = await createProjectContainer(db, ws, owner, {
            name: 'Neighbor project',
            description: null,
            baseVisibility: 'private',
          })
          if (project.kind !== 'ok') throw new Error(project.kind)
          neighborIds.push(project.id)
          await db
            .insertInto('project_share_defaults')
            .values({
              id: `grant-${project.id}`,
              project_container_id: project.id,
              email: botEmail,
              role: 'contributor',
              display_name: null,
              created_by_id: owner,
              created_at: clock,
              updated_at: clock,
            })
            .execute()
        }
        const grants = () =>
          db
            .selectFrom('project_share_defaults')
            .select('project_container_id')
            .where('project_container_id', 'in', neighborIds)
            .orderBy('project_container_id')
            .execute()
        const grantsBefore = await grants()
        expect(grantsBefore).toHaveLength(2)
        // The owner also adds the granted neighbor here as a destination; the
        // product keeps its existing grant.
        const nightlyBot = (
          await listWorkspaceBots(db, workspaceId, clock)
        ).find((bot) => bot.name === 'Nightly report bot')!
        const { updated_at: revision } = await db
          .selectFrom('users')
          .select('updated_at')
          .where('id', '=', nightlyBot.id)
          .executeTakeFirstOrThrow()
        expect(
          await updateWorkspaceBotDestinations(db, actor, {
            botUserId: nightlyBot.id,
            projectId: nightlyBot.projectId!,
            projectIds: [
              ...nightlyBot.approvedProjects!.map((project) => project.id),
              neighborIds[0],
            ],
            revision,
          }),
        ).toEqual({ kind: 'ok' })
        expect(
          (await listWorkspaceBots(db, workspaceId, clock))
            .find((bot) => bot.id === nightlyBot.id)!
            .approvedProjects?.map((project) => project.id),
        ).toContain(neighborIds[0])
        expect(await grants()).toEqual(grantsBefore)

        await seedDevScreenState(db, scenario, workspaceId, userId, clock)

        expect(await summary()).toEqual(healthy)
        // The reissued bot was rebuilt, and the neighbors' grants stayed.
        expect(
          (await listWorkspaceBots(db, workspaceId, clock)).find(
            (bot) => bot.name === 'Nightly report bot',
          )!.id,
        ).not.toBe(idOf('Nightly report bot'))
        // The rebuilt bot keeps the state's address cue: the long address only
        // in long-email, a generated one otherwise.
        const rebuiltEmail = (
          await listWorkspaceBots(db, workspaceId, clock)
        ).find((bot) => bot.name === 'Nightly report bot')!.email
        expect(
          rebuiltEmail.startsWith(
            'nightly-report-automation-with-a-long-destination-address-',
          ),
        ).toBe(scenario === 'settings-bots/long-email')
        expect(await grants()).toEqual(grantsBefore)
        expect(
          await db
            .selectFrom('audit_events')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .where('action', '=', 'bot.cancel')
            .execute(),
        ).toEqual([])
      } finally {
        await db.destroy()
      }
    },
  )

  test.each([
    ['settings/with-bots', 'published'],
    ['settings/with-bots', 'reissued'],
    ['settings-bots/long-email', 'reissued'],
    ['settings/with-bots', 'audited'],
    ['settings/with-bots', 'legacy'],
  ] as const)(
    '%s refuses a %s fixture bot that has authored records, changing nothing',
    async (scenario, kind) => {
      const { db, sqlite } = createMigratedInMemoryDb()
      try {
        const { workspaceId, userId } = await signIn(db, scenario)
        const actor = { id: userId, workspaceId }
        const initial = await listWorkspaceBots(db, workspaceId, clock)
        const active = initial.find((bot) => bot.name === 'Nightly report bot')!
        let used = active.id
        if (kind === 'legacy') {
          // An earlier seed's row at its fixed ID still carries a fixture name.
          used = `${workspaceId}-bot-active`
          await db
            .insertInto('users')
            .values({
              id: used,
              email: `${used}@bots.artifactshare.invalid`,
              email_verified: 1,
              name: 'Nightly report bot',
              image: null,
              locale: null,
              workspace_id: workspaceId,
              kind: 'bot',
              bot_stopped_at: clock,
              created_at: clock,
              updated_at: clock,
            })
            .execute()
        }
        // The bot publishes; it also holds a grant on a differently named
        // project. Then, as a capture can, its credential is reissued.
        const unrelated = await createProjectContainer(
          db,
          workspaceId,
          userId,
          {
            name: 'Unrelated project',
            description: null,
            baseVisibility: 'private',
          },
        )
        if (unrelated.kind !== 'ok') throw new Error(unrelated.kind)
        const { email } = await db
          .selectFrom('users')
          .select('email')
          .where('id', '=', used)
          .executeTakeFirstOrThrow()
        await db
          .insertInto('project_share_defaults')
          .values({
            id: `grant-${unrelated.id}`,
            project_container_id: unrelated.id,
            email,
            role: 'contributor',
            display_name: null,
            created_by_id: userId,
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        if (kind === 'audited') {
          // The bot's only authored record: the rotation audit a credential
          // refresh by the bot leaves. Like production, its subject is the
          // bot's credential, so the bot appears only as the actor.
          const credential = await db
            .selectFrom('cli_refresh_credentials')
            .select('id')
            .where('user_id', '=', used)
            .executeTakeFirstOrThrow()
          expect(credential.id).not.toBe(used)
          await db
            .insertInto('audit_events')
            .values({
              id: `${workspaceId}-bot-rotation`,
              workspace_id: workspaceId,
              actor_user_id: used,
              action: 'cli.refresh_credential.rotate',
              subject_type: 'cli_refresh_credential',
              subject_id: credential.id,
              detail: JSON.stringify({ credential_kind: 'cli_refresh' }),
              created_at: clock,
            })
            .execute()
        } else
          await db
            .insertInto('shareables')
            .values({
              id: `${workspaceId}-bot-upload`,
              workspace_id: workspaceId,
              owner_user_id: used,
              container_id: active.projectId!,
              name: 'Bot upload.html',
              artifact_kind: 'html_page',
              visibility: 'project',
              created_at: clock,
              updated_at: clock,
            })
            .execute()
        if (kind === 'reissued' || kind === 'audited') {
          expect(
            await reissueWorkspaceBotCredential(db, actor, used),
          ).toMatchObject({ kind: 'ok' })
          // A drifted destination would otherwise be repaired before any bot
          // is looked at.
          await db
            .updateTable('artifact_containers')
            .set({ description: 'Edited during a capture' })
            .where('id', '=', active.projectId!)
            .execute()
        }
        const before = {
          ...dumpRows(sqlite),
          grants: sqlite.prepare('SELECT * FROM project_share_defaults').all(),
        }
        const bots = await listWorkspaceBots(db, workspaceId, clock)

        // Deleting the bot would take its artifact with it, and stopping and
        // replacing it would add a second same-name row and strip the grant.
        // Neither the anchor setup nor the row seed writes before refusing.
        // SQLite's change counter also catches a write of unchanged values.
        const refusal = `Settings seed cannot reset fixture bot Nightly report bot in ${scenario}`
        const changes = () =>
          sqlite.prepare('SELECT total_changes() AS n').get()
        const changesBefore = changes()
        await expect(
          ensureDevScreenState(db, scenario, clock, 'team'),
        ).rejects.toThrow(refusal)
        expect(changes()).toEqual(changesBefore)
        await expect(
          seedDevScreenState(db, scenario, workspaceId, userId, clock),
        ).rejects.toThrow(refusal)
        expect(changes()).toEqual(changesBefore)
        expect({
          ...dumpRows(sqlite),
          grants: sqlite.prepare('SELECT * FROM project_share_defaults').all(),
        }).toEqual(before)
        expect(await listWorkspaceBots(db, workspaceId, clock)).toEqual(bots)
      } finally {
        await db.destroy()
      }
    },
  )

  test('a primary destination edited through the product is reset by bot name', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const view = async () =>
        (await listWorkspaceBots(db, workspaceId, clock)).map((bot) => ({
          name: bot.name,
          primary: bot.projectName,
          destinations: bot.approvedProjects?.map((project) => project.name),
        }))
      const healthy = await view()
      const active = (await listWorkspaceBots(db, workspaceId, clock)).find(
        (bot) => bot.name === 'Nightly report bot',
      )!
      const management = active.approvedProjects!.find(
        (project) => project.name === 'Management reports',
      )!
      const { updated_at } = await db
        .selectFrom('users')
        .select('updated_at')
        .where('id', '=', active.id)
        .executeTakeFirstOrThrow()
      expect(
        await updateWorkspaceBotDestinations(
          db,
          { id: userId, workspaceId },
          {
            botUserId: active.id,
            projectId: management.id,
            projectIds: active.approvedProjects!.map((project) => project.id),
            revision: updated_at,
          },
        ),
      ).toEqual({ kind: 'ok' })
      expect(await view()).not.toEqual(healthy)

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      expect(await view()).toEqual(healthy)
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('kind', '=', 'bot')
          .execute(),
      ).toHaveLength(4)
    } finally {
      await db.destroy()
    }
  })

  test('a legacy destination pair is rebuilt with its creator memberships', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      const legacyIds = [
        `${workspaceId}-bot-management`,
        `${workspaceId}-bot-project`,
      ]
      for (const [index, name] of [
        'Management reports',
        'Nightly reports',
      ].entries())
        await db
          .insertInto('artifact_containers')
          .values({
            id: legacyIds[index],
            workspace_id: workspaceId,
            kind: 'project',
            created_by_id: userId,
            name,
            base_visibility: 'workspace',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      const projects = await db
        .selectFrom('artifact_containers as project')
        .leftJoin(
          'project_members as member',
          'member.container_id',
          'project.id',
        )
        .select(['project.id', 'project.name', 'member.user_id'])
        .where('project.workspace_id', '=', workspaceId)
        .where('project.kind', '=', 'project')
        .orderBy('project.id')
        .execute()
      expect(projects.map(({ name, user_id }) => [name, user_id])).toEqual([
        ['Management reports', userId],
        ['Nightly reports', userId],
      ])
      for (const project of projects)
        expect(legacyIds).not.toContain(project.id)
    } finally {
      await db.destroy()
    }
  })

  test('an already-ordered destination pair gains its creator memberships', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      // Named, described and ordered as the fixture, but with no members.
      for (const [id, name, description] of [
        [
          'a-first-id',
          'Management reports',
          'Screen capture fixture: management destination',
        ],
        [
          'z-second-id',
          'Nightly reports',
          'Screen capture fixture: destination project for bot uploads',
        ],
      ])
        await db
          .insertInto('artifact_containers')
          .values({
            id,
            workspace_id: workspaceId,
            kind: 'project',
            created_by_id: userId,
            name,
            description,
            base_visibility: 'workspace',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
      const projects = () =>
        db
          .selectFrom('artifact_containers')
          .select(['id', 'name', 'description', 'base_visibility'])
          .where('id', 'in', ['a-first-id', 'z-second-id'])
          .orderBy('id')
          .execute()
      const before = await projects()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      // The pair is reused as it is, and its creator joins both projects.
      expect(await projects()).toEqual(before)
      expect(
        await db
          .selectFrom('project_members')
          .select(['container_id', 'user_id'])
          .where('container_id', 'in', ['a-first-id', 'z-second-id'])
          .orderBy('container_id')
          .execute(),
      ).toEqual([
        { container_id: 'a-first-id', user_id: userId },
        { container_id: 'z-second-id', user_id: userId },
      ])
    } finally {
      await db.destroy()
    }
  })

  test('a differently named project with a fixture description is left alone', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      // Neither fixture destination exists yet; this project only looks like
      // a temporary name from an earlier setup.
      const lookalike = await createProjectContainer(db, workspaceId, userId, {
        name: 'Bot destination setup leftover',
        description:
          'Screen capture fixture: destination project for bot uploads',
        baseVisibility: 'workspace',
      })
      if (lookalike.kind !== 'ok') throw new Error(lookalike.kind)
      const row = () =>
        db
          .selectFrom('artifact_containers')
          .selectAll()
          .where('id', '=', lookalike.id)
          .executeTakeFirstOrThrow()
      const before = await row()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(await row()).toEqual(before)
      const bots = await listWorkspaceBots(db, workspaceId, clock)
      expect(bots).toHaveLength(4)
      for (const bot of bots)
        expect(
          bot.approvedProjects?.map((project) => project.id),
          bot.name ?? '',
        ).not.toContain(lookalike.id)
    } finally {
      await db.destroy()
    }
  })

  test('an occupied legacy destination keeps its artifact while the fixture moves on', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      const legacyId = `${workspaceId}-bot-project`
      await db
        .insertInto('artifact_containers')
        .values({
          id: legacyId,
          workspace_id: workspaceId,
          kind: 'project',
          created_by_id: userId,
          name: 'Nightly reports',
          base_visibility: 'workspace',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      await db
        .insertInto('shareables')
        .values({
          id: 'legacy-neighbor',
          workspace_id: workspaceId,
          owner_user_id: userId,
          container_id: legacyId,
          name: 'Neighbor.html',
          artifact_kind: 'html_page',
          visibility: 'project',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(
        await db
          .selectFrom('shareables')
          .select('container_id')
          .where('id', '=', 'legacy-neighbor')
          .executeTakeFirstOrThrow(),
      ).toEqual({ container_id: legacyId })
      const active = (await listWorkspaceBots(db, workspaceId, clock)).find(
        (bot) => bot.name === 'Nightly report bot',
      )!
      expect(active.projectName).toBe('Nightly reports')
      expect(active.projectId).not.toBe(legacyId)
    } finally {
      await db.destroy()
    }
  })

  test('a case-variant destination name is reused without temporary projects', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/with-bots'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      const variant = await createProjectContainer(db, workspaceId, userId, {
        name: 'nightly reports',
        description: null,
        baseVisibility: 'private',
      })
      if (variant.kind !== 'ok') throw new Error(variant.kind)
      // An earlier seed's destination someone renamed is no longer a fixture.
      const renamedLegacyId = `${workspaceId}-bot-management`
      await db
        .insertInto('artifact_containers')
        .values({
          id: renamedLegacyId,
          workspace_id: workspaceId,
          kind: 'project',
          created_by_id: userId,
          name: 'Archive drop',
          base_visibility: 'workspace',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      // An archived earlier-seed destination holds no live name; it and its
      // file stay, and the seed does not pass it to the live-project updater.
      const archivedLegacyId = `${workspaceId}-bot-project`
      await db
        .insertInto('artifact_containers')
        .values({
          id: archivedLegacyId,
          workspace_id: workspaceId,
          kind: 'project',
          created_by_id: userId,
          name: 'Nightly reports',
          base_visibility: 'workspace',
          archived_at: clock,
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      await db
        .insertInto('shareables')
        .values({
          id: 'archived-legacy-file',
          workspace_id: workspaceId,
          owner_user_id: userId,
          container_id: archivedLegacyId,
          name: 'Old report.html',
          artifact_kind: 'html_page',
          visibility: 'project',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      const archivedBefore = await db
        .selectFrom('artifact_containers')
        .selectAll()
        .where('id', '=', archivedLegacyId)
        .executeTakeFirstOrThrow()
      const projects = () =>
        db
          .selectFrom('artifact_containers')
          .select(['id', 'name', 'base_visibility'])
          .where('workspace_id', '=', workspaceId)
          .where('kind', '=', 'project')
          .where('archived_at', 'is', null)
          .where('id', '!=', renamedLegacyId)
          .orderBy('id')
          .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(
        await db
          .selectFrom('artifact_containers')
          .selectAll()
          .where('id', '=', archivedLegacyId)
          .executeTakeFirstOrThrow(),
      ).toEqual(archivedBefore)
      expect(
        await db
          .selectFrom('shareables')
          .select('container_id')
          .where('id', '=', 'archived-legacy-file')
          .executeTakeFirstOrThrow(),
      ).toEqual({ container_id: archivedLegacyId })
      expect(
        await db
          .selectFrom('artifact_containers')
          .select('name')
          .where('id', '=', renamedLegacyId)
          .executeTakeFirst(),
      ).toEqual({ name: 'Archive drop' })
      const seeded = await projects()
      expect(
        seeded.map((project) => [project.name, project.base_visibility]),
      ).toEqual([
        ['Management reports', 'workspace'],
        ['Nightly reports', 'workspace'],
      ])
      expect(seeded.map((project) => project.id)).toContain(variant.id)
      const active = (await listWorkspaceBots(db, workspaceId, clock)).find(
        (bot) => bot.name === 'Nightly report bot',
      )!
      expect(active.projectName).toBe('Nightly reports')
      expect(active.approvedProjects?.map((project) => project.name)).toEqual([
        'Management reports',
        'Nightly reports',
      ])
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(await projects()).toEqual(seeded)
    } finally {
      await db.destroy()
    }
  })

  test('both member scenarios match rows written by the member services', async () => {
    const { db } = createMigratedInMemoryDb()
    const memberShape = async (workspaceId: string, memberId: string) => {
      const row = await db
        .selectFrom('workspace_members as m')
        .innerJoin('users', 'users.id', 'm.user_id')
        .select([
          'm.role',
          'm.status',
          'm.removed_by',
          'm.pending_uploads',
          'users.kind',
          'users.email_verified',
          'users.workspace_id as homeWorkspaceId',
        ])
        .where('m.workspace_id', '=', workspaceId)
        .where('m.user_id', '=', memberId)
        .executeTakeFirstOrThrow()
      const audits = await db
        .selectFrom('audit_events')
        .select('action')
        .where('workspace_id', '=', workspaceId)
        .where('subject_id', '=', memberId)
        .orderBy('action')
        .execute()
      return {
        ...row,
        homeIsWorkspace: row.homeWorkspaceId === workspaceId,
        homeWorkspaceId: undefined,
        audits: audits.map((audit) => audit.action),
      }
    }
    try {
      const long = await signIn(db, 'settings/long-member-addresses')
      const actor = { id: long.userId, workspaceId: long.workspaceId }
      for (const id of ['control-admin', 'control-removed']) {
        await db
          .insertInto('users')
          .values({
            id,
            email: `${id}@example.test`,
            email_verified: 1,
            name: id,
            workspace_id: long.workspaceId,
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        await ensureActiveWorkspaceMembership(db, id, long.workspaceId, clock)
      }
      await grantWorkspaceAdmin(db, actor, 'control-admin')
      await removeWorkspaceMember(db, actor, 'control-removed')
      expect(
        await memberShape(
          long.workspaceId,
          `${long.workspaceId}-long-member-active`,
        ),
      ).toEqual(await memberShape(long.workspaceId, 'control-admin'))
      const removed = await memberShape(
        long.workspaceId,
        `${long.workspaceId}-long-member-removed`,
      )
      expect(removed).toMatchObject({
        status: 'removed',
        homeIsWorkspace: false,
      })
      expect(removed).toEqual(
        await memberShape(long.workspaceId, 'control-removed'),
      )

      const warning = await signIn(db, 'settings/result-warning')
      await db
        .insertInto('users')
        .values({
          id: 'control-member',
          email: 'control-member@example.test',
          email_verified: 1,
          name: 'Control',
          workspace_id: warning.workspaceId,
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      await ensureActiveWorkspaceMembership(
        db,
        'control-member',
        warning.workspaceId,
        clock,
      )
      expect(
        await memberShape(
          warning.workspaceId,
          `${warning.workspaceId}-removed-member`,
        ),
      ).toEqual(await memberShape(warning.workspaceId, 'control-member'))
    } finally {
      await db.destroy()
    }
  })

  test.each(['projects', 'artifacts'])(
    '%s inventory matches a service project and leaves moved-to projects alone',
    async (kind) => {
      const { db } = createMigratedInMemoryDb()
      const scenario = `settings-inventory-${kind}/populated`
      const projectShape = async (id: string) => {
        const project = await db
          .selectFrom('artifact_containers')
          .select([
            'kind',
            'owner_user_id',
            'created_by_id',
            'base_visibility',
            'archived_at',
          ])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
        const members = await db
          .selectFrom('project_members')
          .select('user_id')
          .where('container_id', '=', id)
          .execute()
        return { project, members }
      }
      try {
        const { workspaceId, userId } = await signIn(db, scenario)
        const fileId = devShareableId(`${workspaceId}-inventory-file`)
        const fixtureProject = async () =>
          (
            await db
              .selectFrom('shareables')
              .select('container_id')
              .where('id', '=', fileId)
              .executeTakeFirstOrThrow()
          ).container_id
        const originalId = await fixtureProject()
        if (!originalId) throw new Error('fixture file has no project')
        const control = await createProjectContainer(db, workspaceId, userId, {
          name: 'Control project',
          description: null,
          baseVisibility: 'workspace',
        })
        if (control.kind !== 'ok') throw new Error(control.kind)
        expect(await projectShape(originalId)).toEqual(
          await projectShape(control.id),
        )
        expect((await projectShape(originalId)).members).toEqual([
          { user_id: userId },
        ])

        // The fixture file moves into someone's project holding their file.
        await db
          .insertInto('shareables')
          .values({
            id: 'neighbor-file',
            workspace_id: workspaceId,
            owner_user_id: userId,
            container_id: control.id,
            name: 'Neighbor.html',
            artifact_kind: 'html_page',
            visibility: 'project',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        const neighborFile = () =>
          db
            .selectFrom('shareables')
            .selectAll()
            .where('id', '=', 'neighbor-file')
            .executeTakeFirstOrThrow()
        const neighborBefore = await neighborFile()
        await db
          .updateTable('shareables')
          .set({ container_id: control.id })
          .where('id', '=', fileId)
          .execute()
        await seedDevScreenState(db, scenario, workspaceId, userId, clock)
        expect(await fixtureProject()).toBe(originalId)
        const unrelated = () =>
          db
            .selectFrom('artifact_containers')
            .select('name')
            .where('id', '=', control.id)
            .executeTakeFirstOrThrow()
        expect(await unrelated()).toEqual({ name: 'Control project' })
        expect(await neighborFile()).toEqual(neighborBefore)

        // Renamed, the original is someone's project. An earlier seed's row
        // with the fixture name in another case, inserted without the creator
        // membership, is the fixture's: it is reused and matches the control.
        await db
          .updateTable('artifact_containers')
          .set({ name: 'Last quarter' })
          .where('id', '=', originalId)
          .execute()
        const legacyId = `${workspaceId}-inventory-project`
        await db
          .insertInto('artifact_containers')
          .values({
            id: legacyId,
            workspace_id: workspaceId,
            kind: 'project',
            created_by_id: userId,
            name: 'quarterly reports and review materials for the whole workspace',
            base_visibility: 'private',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        await seedDevScreenState(db, scenario, workspaceId, userId, clock)
        expect(await fixtureProject()).toBe(legacyId)
        expect(
          await db
            .selectFrom('artifact_containers')
            .select('name')
            .where('id', '=', legacyId)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          name: 'Quarterly reports and review materials for the whole workspace',
        })
        expect(await projectShape(legacyId)).toEqual(
          await projectShape(control.id),
        )
        expect(
          await db
            .selectFrom('artifact_containers')
            .select('name')
            .where('id', '=', originalId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ name: 'Last quarter' })
        expect(await unrelated()).toEqual({ name: 'Control project' })
        expect(await neighborFile()).toEqual(neighborBefore)
      } finally {
        await db.destroy()
      }
    },
  )

  test('the API token matches a service token and tokens are reset by label', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId, userId } = await signIn(
        db,
        'settings-tokens/created-secret',
      )
      const control = await createApiToken(db, userId, 'Local deployment')
      // Every Release automation token is a capture's, whatever its use or age.
      const captured = await createApiToken(db, userId, 'Release automation')
      const used = await createApiToken(db, userId, 'Release automation')
      await db
        .updateTable('api_tokens')
        .set({ last_used_at: clock })
        .where('id', '=', used.id)
        .execute()
      const earlier = await createApiToken(db, userId, 'Release automation')
      await db
        .updateTable('api_tokens')
        .set({ created_at: later(-DAY) })
        .where('id', '=', earlier.id)
        .execute()
      const row = (id: string) =>
        db
          .selectFrom('api_tokens')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      const controlRow = await row(control.id)
      expect(controlRow.token_hash).toBe(
        await computeTextSha256Hex(control.token),
      )
      const seededId = (await listApiTokens(db, userId)).find(
        (token) => token.name === 'CLI deploy',
      )!.id
      const seeded = await row(seededId)
      expect(seeded.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(seeded.token_hash).not.toContain(seeded.id)
      expect({
        ...seeded,
        id: '',
        name: '',
        token_hash: '',
      }).toEqual({ ...controlRow, id: '', name: '', token_hash: '' })
      // A second live baseline is a same-label copy; only one stays.
      vi.setSystemTime(Date.parse(later(1_000)))
      const extraBaseline = await createApiToken(db, userId, 'CLI deploy')

      await seedDevScreenState(
        db,
        'settings-tokens/created-secret',
        workspaceId,
        userId,
        clock,
      )
      const remaining = await listApiTokens(db, userId)
      expect(remaining.map((token) => token.id).sort()).toEqual(
        [seededId, control.id].sort(),
      )
      for (const removed of [captured, used, earlier, extraBaseline])
        expect(remaining.map((token) => token.id)).not.toContain(removed.id)

      // A live same-label row with a placeholder hash is no healthy baseline,
      // whatever its ID: it gives way to a service-issued token.
      await db.deleteFrom('api_tokens').where('id', '=', seededId).execute()
      await db
        .insertInto('api_tokens')
        .values({
          ...seeded,
          id: 'placeholder-token',
          token_hash: 'placeholder-token-hash',
        })
        .execute()
      await seedDevScreenState(
        db,
        'settings-tokens/created-secret',
        workspaceId,
        userId,
        clock,
      )
      const baselines = (await listApiTokens(db, userId)).filter(
        (token) => token.name === 'CLI deploy',
      )
      expect(baselines.map((token) => token.id)).not.toContain(
        'placeholder-token',
      )
      expect(baselines).toHaveLength(1)
      expect((await row(baselines[0].id)).token_hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await db.destroy()
    }
  })

  /** Joins every record of a CLI family, without generated values. */
  async function cliFamilyShape(db: Kysely<DB>, familyId: string) {
    const row = await db
      .selectFrom('cli_family_authorities as family')
      .innerJoin(
        'cli_refresh_credentials as credential',
        'credential.family_id',
        'family.family_id',
      )
      .leftJoin(
        'cli_refresh_sessions as link',
        'link.family_id',
        'family.family_id',
      )
      .leftJoin('sessions as session', 'session.id', 'link.session_id')
      .leftJoin(
        'cli_session_authorities as authority',
        'authority.session_id',
        'link.session_id',
      )
      .leftJoin(
        'agent_profiles as profile',
        'profile.id',
        'family.agent_profile_id',
      )
      .leftJoin(
        'publisher_clients as client',
        'client.id',
        'family.publisher_client_id',
      )
      .leftJoin(
        'artifact_containers as project',
        'project.id',
        'family.project_id',
      )
      .leftJoin('users as owner', 'owner.id', 'family.user_id')
      .select([
        'family.preset',
        'family.status',
        'family.user_id as familyUser',
        'family.workspace_id as familyWorkspace',
        'family.project_id as familyProject',
        'family.project_name_snapshot as snapshot',
        'family.agent_profile_id as familyProfile',
        'family.publisher_client_id as familyClient',
        'credential.id as credentialId',
        'credential.user_id as credentialUser',
        'credential.token_hash',
        'credential.revoked_at',
        'link.credential_id as linkedCredential',
        'session.user_id as sessionUser',
        'session.user_agent',
        'authority.kind as authorityKind',
        'authority.family_id as authorityFamily',
        'authority.preset as authorityPreset',
        'authority.workspace_id as authorityWorkspace',
        'authority.project_id as authorityProject',
        'authority.agent_profile_id as authorityProfile',
        'authority.publisher_client_id as authorityClient',
        'authority.bearer_only',
        'authority.expires_at as authorityExpires',
        'profile.user_id as profileUser',
        'profile.workspace_id as profileWorkspace',
        'client.user_id as clientUser',
        'client.workspace_id as clientWorkspace',
        'project.name as projectName',
        'project.kind as projectKind',
        'project.base_visibility',
        'project.archived_at',
        'owner.workspace_id as ownerWorkspace',
      ])
      .where('family.family_id', '=', familyId)
      .executeTakeFirstOrThrow()
    const scoped = row.preset !== 'unrestricted'
    return {
      preset: row.preset,
      status: row.status,
      credentialIsFamily: row.credentialId === familyId,
      credentialUserMatches: row.credentialUser === row.familyUser,
      realHash: /^[0-9a-f]{64}$/.test(row.token_hash),
      revoked: row.revoked_at !== null,
      linked: row.linkedCredential === row.credentialId,
      sessionUserMatches: row.sessionUser === row.familyUser,
      userAgent: row.user_agent,
      authorityKind: row.authorityKind,
      authorityFamilyMatches: row.authorityFamily === familyId,
      authorityPresetMatches: row.authorityPreset === row.preset,
      authorityWorkspaceMatches: row.authorityWorkspace === row.familyWorkspace,
      authorityProjectMatches: row.authorityProject === row.familyProject,
      authorityProfileMatches: row.authorityProfile === row.familyProfile,
      authorityClientMatches: row.authorityClient === row.familyClient,
      bearerOnly: row.bearer_only,
      authorityExpires: row.authorityExpires,
      familyInOwnerWorkspace:
        !scoped || row.familyWorkspace === row.ownerWorkspace,
      profileOwned:
        row.preset !== 'agent' ||
        (row.profileUser === row.familyUser &&
          row.profileWorkspace === row.familyWorkspace),
      clientOwned:
        row.preset !== 'publisher' ||
        (row.clientUser === row.familyUser &&
          row.clientWorkspace === row.familyWorkspace),
      projectEligible:
        row.preset !== 'agent' ||
        (row.projectKind === 'project' &&
          row.base_visibility === 'workspace' &&
          row.archived_at === null &&
          row.snapshot === row.projectName),
    }
  }

  async function addControlMember(
    db: Kysely<DB>,
    workspaceId: string,
    id: string,
  ) {
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@example.test`,
        email_verified: 1,
        name: id,
        workspace_id: workspaceId,
        created_at: clock,
        updated_at: clock,
      })
      .execute()
    await ensureActiveWorkspaceMembership(db, id, workspaceId, clock)
  }

  async function expectFamilyHash(
    db: Kysely<DB>,
    familyId: string,
    secret: string,
  ) {
    expect(
      await db
        .selectFrom('cli_refresh_credentials')
        .select('token_hash')
        .where('family_id', '=', familyId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ token_hash: await computeTextSha256Hex(secret) })
  }

  async function insertCliSession(db: Kysely<DB>, id: string, userId: string) {
    await db
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        token: `${id}-token`,
        expires_at: '2099-01-01T00:00:00.000Z',
        ip_address: null,
        user_agent: CLI_DEVICE_SESSION_USER_AGENT,
        created_at: clock,
        updated_at: clock,
      })
      .execute()
    return `${id}-token`
  }

  /** Runs the real approval, attachment and issuance for a scoped preset. */
  async function issueScopedControl(
    db: Kysely<DB>,
    preset: 'agent' | 'publisher',
    user: { id: string; email: string; workspaceId: string },
    projectId: string,
    publisherClientName = 'Control client',
  ) {
    const deviceCode = `control-${preset}-device`
    const userCode = `CTRL${preset.slice(0, 4).toUpperCase()}`
    await db
      .insertInto('deviceCode')
      .values({
        id: `control-${preset}`,
        deviceCode,
        userCode,
        userId: user.id,
        expiresAt: later(600_000),
        status: 'pending',
        lastPolledAt: null,
        pollingInterval: 5,
        clientId: 'artifactshare-cli',
        scope: null,
        preset: null,
        deviceName: null,
        approvalNonce: null,
        selectedProjectId: null,
        requestedProjectSelector: null,
      })
      .execute()
    await storeDeviceAuthorizationIntent(deviceCode, {
      preset,
      deviceName: preset === 'publisher' ? publisherClientName : null,
      projectSelector: null,
    })
    const selected =
      preset === 'agent'
        ? await selectAgentApprovalProject({
            userCode,
            userId: user.id,
            workspaceId: user.workspaceId,
            email: user.email,
            projectId,
          })
        : await selectPublisherApprovalClient({
            userCode,
            userId: user.id,
            workspaceId: user.workspaceId,
            choice: { mode: 'create-new' },
          })
    expect(selected).toBe(true)
    const intent = await loadDeviceAuthorizationIntent(deviceCode)
    const token = await insertCliSession(db, `control-${preset}`, user.id)
    const attached =
      preset === 'agent'
        ? await attachAgentBootstrapAuthority(token, intent!)
        : await attachPublisherBootstrapAuthority(token, intent!)
    expect(attached).toBe(true)
    const issued = await issueCliRefreshCredential(db, user.id, token)
    if (!issued) throw new Error('control issuance failed')
    const { family_id } = await db
      .selectFrom('cli_refresh_sessions')
      .select('family_id')
      .where('session_id', '=', `control-${preset}`)
      .executeTakeFirstOrThrow()
    await expectFamilyHash(db, family_id, issued.refreshToken)
    return family_id
  }

  test('active CLI matches a real issuance and records last use', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/active-cli'
    try {
      const earlierSeed = later(-3_600_000)
      const { workspaceId, userId } = await signIn(
        db,
        scenario,
        'team',
        earlierSeed,
      )
      const [family] = await listCliRefreshCredentialFamilies(db, userId)
      expect(family).toMatchObject({
        preset: 'unrestricted',
        deviceName: 'Artifact Share CLI on darwin arm64 (default, a1b2c3d4)',
        createdAt: clock,
        lastUsedAt: clock,
      })
      expect(
        await db
          .selectFrom('cli_refresh_credentials')
          .select(['device_id', 'last_used_at'])
          .where('family_id', '=', family.familyId)
          .execute(),
      ).toEqual([
        { device_id: 'a1b2c3d4-example-device-id', last_used_at: clock },
      ])
      expect(
        await db
          .selectFrom('cli_session_authorities')
          .select(['kind', 'family_id'])
          .execute(),
      ).toEqual([{ kind: 'family', family_id: family.familyId }])

      await addControlMember(db, workspaceId, 'control-cli')
      const token = await insertCliSession(db, 'control-cli', 'control-cli')
      const issued = await issueCliRefreshCredential(
        db,
        'control-cli',
        token,
        'Control device',
        'control-device-id',
      )
      if (!issued) throw new Error('control issuance failed')
      const [controlFamily] = await listCliRefreshCredentialFamilies(
        db,
        'control-cli',
      )
      await expectFamilyHash(db, controlFamily.familyId, issued.refreshToken)
      expect(await cliFamilyShape(db, family.familyId)).toEqual(
        await cliFamilyShape(db, controlFamily.familyId),
      )

      // A retained credential keeps its last use on a later reseed.
      await seedDevScreenState(db, scenario, workspaceId, userId, later(DAY))
      expect((await listCliRefreshCredentialFamilies(db, userId))[0]).toEqual(
        family,
      )

      await db
        .updateTable('cli_refresh_credentials')
        .set({ revoked_at: clock })
        .where('family_id', '=', family.familyId)
        .execute()
      const laterSeed = later(3_600_000)
      await seedDevScreenState(db, scenario, workspaceId, userId, laterSeed)
      const [recreated] = await listCliRefreshCredentialFamilies(db, userId)
      expect(recreated.familyId).not.toBe(family.familyId)
      expect(recreated.lastUsedAt).toBe(laterSeed)
    } finally {
      await db.destroy()
    }
  })

  test('mixed-preset authorities match real controls and detect a wrong binding', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    try {
      const { workspaceId, userId } = await signIn(
        db,
        'settings-tokens/mixed-presets',
      )
      const families = await listCliRefreshCredentialFamilies(db, userId)
      const idOf = (preset: string) =>
        families.find((row) => row.preset === preset)!.familyId
      await addControlMember(db, workspaceId, 'control-user')
      const control = {
        id: 'control-user',
        email: 'control-user@example.test',
        workspaceId,
      }
      const project = await createProjectContainer(
        db,
        workspaceId,
        control.id,
        {
          name: 'Control reports',
          description: null,
          baseVisibility: 'workspace',
        },
      )
      if (project.kind !== 'ok') throw new Error(project.kind)
      for (const preset of ['agent', 'publisher'] as const) {
        const familyId = await issueScopedControl(
          db,
          preset,
          control,
          project.id,
        )
        const controlShape = await cliFamilyShape(db, familyId)
        expect(controlShape).toMatchObject({
          linked: true,
          authorityKind: 'family',
          authorityClientMatches: true,
          authorityProfileMatches: true,
          authorityProjectMatches: true,
          clientOwned: true,
          profileOwned: true,
          projectEligible: true,
        })
        expect(await cliFamilyShape(db, idOf(preset)), preset).toEqual(
          controlShape,
        )
      }
      const unrestrictedControl = await issueCliRefreshCredential(
        db,
        control.id,
      )
      const unrestrictedControlId = (
        await listCliRefreshCredentialFamilies(db, control.id)
      ).find((row) => row.preset === 'unrestricted')!.familyId
      await expectFamilyHash(
        db,
        unrestrictedControlId,
        unrestrictedControl.refreshToken,
      )
      expect(await cliFamilyShape(db, idOf('unrestricted'))).toEqual(
        await cliFamilyShape(db, unrestrictedControlId),
      )
      expect(
        await db
          .selectFrom('cli_family_authorities as family')
          .innerJoin(
            'artifact_containers as project',
            'project.id',
            'family.project_id',
          )
          .innerJoin(
            'cli_session_authorities as authority',
            'authority.family_id',
            'family.family_id',
          )
          .select([
            'project.name',
            'project.workspace_id',
            'family.project_name_snapshot',
            'authority.project_id as authorityProject',
            'family.project_id as familyProject',
          ])
          .where('family.family_id', '=', idOf('agent'))
          .executeTakeFirstOrThrow(),
      ).toEqual({
        name: 'Reports',
        workspace_id: workspaceId,
        project_name_snapshot: 'Reports',
        authorityProject: expect.any(String),
        familyProject: expect.any(String),
      })

      const otherClient = 'other-client'
      await db
        .insertInto('publisher_clients')
        .values({
          id: otherClient,
          user_id: userId,
          workspace_id: workspaceId,
          name: 'Other client',
          created_at: clock,
        })
        .execute()
      await db
        .updateTable('cli_session_authorities')
        .set({ publisher_client_id: otherClient })
        .where('family_id', '=', idOf('publisher'))
        .execute()
      expect(
        (await cliFamilyShape(db, idOf('publisher'))).authorityClientMatches,
      ).toBe(false)
    } finally {
      await db.destroy()
    }
  })

  test('mixed presets keep offsets, last use and order through recreation', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/mixed-presets'
    try {
      const seedClock = later(-1_500)
      const { workspaceId, userId } = await signIn(
        db,
        scenario,
        'team',
        seedClock,
      )
      const expected = [
        { preset: 'unrestricted', createdAt: clock, lastUsedAt: clock },
        {
          preset: 'publisher',
          createdAt: later(-1_000),
          lastUsedAt: later(-1_000),
        },
        { preset: 'agent', createdAt: later(-2_000), lastUsedAt: seedClock },
      ]
      const list = () => listCliRefreshCredentialFamilies(db, userId)
      const expectStoredLastUse = async (
        rows: Awaited<ReturnType<typeof list>>,
      ) => {
        for (const row of rows)
          expect(
            await db
              .selectFrom('cli_refresh_credentials')
              .select('last_used_at')
              .where('family_id', '=', row.familyId)
              .executeTakeFirstOrThrow(),
            row.preset,
          ).toEqual({ last_used_at: row.lastUsedAt })
      }
      expect(await list()).toMatchObject(expected)
      expect((await list())[1].publisherClientName).toBe('Employee dashboard')
      expect(
        await db
          .selectFrom('cli_session_authorities')
          .select('kind')
          .where('kind', '=', 'bootstrap')
          .execute(),
      ).toEqual([])
      expect(await db.selectFrom('deviceCode').select('id').execute()).toEqual(
        [],
      )

      for (const [index, preset] of [
        'unrestricted',
        'publisher',
        'agent',
      ].entries()) {
        const target = (await list()).find((row) => row.preset === preset)!
        expect(
          await revokeCliRefreshCredentialFamily(db, userId, target.familyId),
        ).toBe('ok')
        vi.setSystemTime(Date.parse(later((index + 1) * 60_000)))
        await seedDevScreenState(db, scenario, workspaceId, userId, seedClock)
        const rows = await list()
        expect(rows).toMatchObject(expected)
        await expectStoredLastUse(rows)
        expect(rows.find((row) => row.preset === preset)?.familyId).not.toBe(
          target.familyId,
        )
        // The revoked family leaves no credential or authority behind.
        for (const table of [
          'cli_refresh_credentials',
          'cli_family_authorities',
          'cli_session_authorities',
        ] as const)
          expect(
            await db
              .selectFrom(table)
              .select('family_id')
              .where('family_id', '=', target.familyId)
              .execute(),
            `${preset} ${table}`,
          ).toEqual([])
      }

      // A later reseed leaves retained credentials; only a replacement moves.
      const retained = await list()
      const laterSeed = later(DAY)
      await seedDevScreenState(db, scenario, workspaceId, userId, laterSeed)
      expect(await list()).toEqual(retained)
      const agent = retained.find((row) => row.preset === 'agent')!
      expect(
        await revokeCliRefreshCredentialFamily(db, userId, agent.familyId),
      ).toBe('ok')
      await seedDevScreenState(db, scenario, workspaceId, userId, laterSeed)
      const rows = await list()
      expect(rows.map((row) => row.lastUsedAt)).toEqual([
        retained[0].lastUsedAt,
        retained[1].lastUsedAt,
        laterSeed,
      ])
      await expectStoredLastUse(rows)
    } finally {
      await db.destroy()
    }
  })

  test('active CLI owns its family by label and checks the device on retain', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/active-cli'
    const label = 'Artifact Share CLI on darwin arm64 (default, a1b2c3d4)'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const [original] = await listCliRefreshCredentialFamilies(db, userId)
      vi.setSystemTime(Date.parse(later(60_000)))
      const sameLabel = await insertCliSession(db, 'same-label', userId)
      await issueCliRefreshCredential(
        db,
        userId,
        sameLabel,
        label,
        'another-device-id',
      )
      const otherLabel = await insertCliSession(db, 'other-label', userId)
      await issueCliRefreshCredential(
        db,
        userId,
        otherLabel,
        'Work laptop',
        'work-laptop-device-id',
      )
      const workLaptop = (await listCliRefreshCredentialFamilies(db, userId))
        .filter((row) => row.deviceName === 'Work laptop')
        .map((row) => row.familyId)
      expect(workLaptop).toHaveLength(1)

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      // The same-label copy on another device goes; the original is kept.
      const rows = await listCliRefreshCredentialFamilies(db, userId)
      expect(rows.filter((row) => row.deviceName === label)).toEqual([original])
      expect(
        rows
          .filter((row) => row.deviceName === 'Work laptop')
          .map((row) => row.familyId),
      ).toEqual(workLaptop)

      // The CLI signs in again on the fixture device: production supersedes
      // the original with an unused family, which is not the capture state.
      const again = await insertCliSession(db, 'signed-in-again', userId)
      await issueCliRefreshCredential(
        db,
        userId,
        again,
        label,
        'a1b2c3d4-example-device-id',
      )
      const reissued = (
        await listCliRefreshCredentialFamilies(db, userId)
      ).find((row) => row.deviceName === label)!
      expect(reissued.lastUsedAt).toBeNull()
      // The different device's credential and its linked session, as they
      // stand before the reseed that issues a replacement fixture family.
      const workLaptopRows = async () => ({
        credentials: await db
          .selectFrom('cli_refresh_credentials')
          .selectAll()
          .where('family_id', 'in', workLaptop)
          .execute(),
        links: await db
          .selectFrom('cli_refresh_sessions')
          .selectAll()
          .where('family_id', 'in', workLaptop)
          .execute(),
        sessions: await db
          .selectFrom('sessions')
          .selectAll()
          .where('id', '=', 'other-label')
          .execute(),
      })
      const workLaptopBefore = await workLaptopRows()
      expect(workLaptopBefore.credentials).toMatchObject([{ revoked_at: null }])
      expect(workLaptopBefore.links).toMatchObject([
        { session_id: 'other-label' },
      ])
      expect(workLaptopBefore.sessions).toHaveLength(1)
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      const fixture = (
        await listCliRefreshCredentialFamilies(db, userId)
      ).filter((row) => row.deviceName === label)
      expect(fixture).toHaveLength(1)
      expect(fixture[0].familyId).not.toBe(reissued.familyId)
      expect(fixture[0].lastUsedAt).not.toBeNull()
      expect(await workLaptopRows()).toEqual(workLaptopBefore)
    } finally {
      await db.destroy()
    }
  })

  test('mixed presets replace a same-label family that is not in the fixture state', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/mixed-presets'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const list = () => listCliRefreshCredentialFamilies(db, userId)
      const initial = await list()
      const fixtureView = (rows: typeof initial) =>
        rows.map(({ preset, createdAt, lastUsedAt, publisherClientName }) => ({
          preset,
          createdAt,
          lastUsedAt,
          publisherClientName,
        }))
      const unrestricted = initial.find((row) => row.preset === 'unrestricted')!
      // A same-identity family issued normally, before the original is revoked.
      vi.setSystemTime(Date.parse(later(5 * 60_000)))
      await issueCliRefreshCredential(db, userId)
      const fresh = (await list()).find(
        (row) =>
          row.preset === 'unrestricted' &&
          row.familyId !== unrestricted.familyId,
      )!
      expect(fresh.lastUsedAt).toBeNull()
      expect(
        await revokeCliRefreshCredentialFamily(
          db,
          userId,
          unrestricted.familyId,
        ),
      ).toBe('ok')

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      const rows = await list()
      expect(fixtureView(rows)).toEqual(fixtureView(initial))
      for (const familyId of [unrestricted.familyId, fresh.familyId])
        expect(
          await db
            .selectFrom('cli_family_authorities')
            .select('family_id')
            .where('family_id', '=', familyId)
            .execute(),
        ).toEqual([])
    } finally {
      await db.destroy()
    }
  })

  test('mixed presets judge earlier-seed family IDs by identity and health', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/mixed-presets'
    try {
      const { workspaceId } = await ensureDevScreenState(
        db,
        scenario,
        clock,
        'team',
      )
      const userId = `${workspaceId}-user`
      await addScenarioOwner(db, workspaceId, userId, clock)
      // Hand-written rows at the earlier seed's IDs: one still carries the
      // fixture's identity with a placeholder hash, one now has another label.
      for (const [familyId, deviceName] of [
        [`${workspaceId}-unrestricted`, null],
        [`${workspaceId}-agent`, 'Old laptop'],
      ] as const) {
        await db
          .insertInto('cli_family_authorities')
          .values({
            family_id: familyId,
            user_id: userId,
            preset: 'unrestricted',
            workspace_id: null,
            project_id: null,
            project_name_snapshot: null,
            agent_profile_id: null,
            approved_at: clock,
            device_name: deviceName,
            status: 'active',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        await db
          .insertInto('cli_refresh_credentials')
          .values({
            id: familyId,
            user_id: userId,
            token_hash: `${familyId}-hash`,
            expires_at: later(30 * DAY),
            created_at: clock,
            last_used_at: clock,
            family_id: familyId,
            device_name: deviceName,
          })
          .execute()
      }
      // The same user's Publisher family with the fixture's client name, but
      // approved in another workspace, is not the fixture's.
      const other = await ensureDevScreenState(
        db,
        'settings-tokens/active-cli',
        clock,
        'team',
      )
      await ensureActiveWorkspaceMembership(
        db,
        userId,
        other.workspaceId,
        clock,
      )
      // Approval happens in the user's active workspace.
      const switchTo = (id: string) =>
        db
          .updateTable('users')
          .set({ workspace_id: id })
          .where('id', '=', userId)
          .execute()
      await switchTo(other.workspaceId)
      const otherFamilyId = await issueScopedControl(
        db,
        'publisher',
        {
          id: userId,
          email: `${userId}@example.test`,
          workspaceId: other.workspaceId,
        },
        '',
        'Employee dashboard',
      )
      await switchTo(workspaceId)
      const otherFamilyRows = async () => ({
        credentials: await db
          .selectFrom('cli_refresh_credentials')
          .selectAll()
          .where('family_id', '=', otherFamilyId)
          .execute(),
        family: await db
          .selectFrom('cli_family_authorities')
          .selectAll()
          .where('family_id', '=', otherFamilyId)
          .execute(),
        session: await db
          .selectFrom('cli_session_authorities')
          .selectAll()
          .where('family_id', '=', otherFamilyId)
          .execute(),
      })
      const otherBefore = await otherFamilyRows()
      expect(otherBefore.credentials).toHaveLength(1)
      expect(otherBefore.family).toMatchObject([
        {
          preset: 'publisher',
          workspace_id: other.workspaceId,
          status: 'active',
        },
      ])
      expect(otherBefore.session).toHaveLength(1)
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(await otherFamilyRows()).toEqual(otherBefore)
      const rows = (await listCliRefreshCredentialFamilies(db, userId)).filter(
        (row) => row.familyId !== otherFamilyId,
      )
      expect(
        rows.map(({ familyId, preset, deviceName }) => ({
          familyId,
          preset,
          deviceName,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            familyId: `${workspaceId}-agent`,
            preset: 'unrestricted',
            deviceName: 'Old laptop',
          },
        ]),
      )
      expect(rows.map((row) => row.familyId)).not.toContain(
        `${workspaceId}-unrestricted`,
      )
      expect(
        rows
          .filter((row) => row.familyId !== `${workspaceId}-agent`)
          .map((row) => row.preset),
      ).toEqual(['unrestricted', 'publisher', 'agent'])
    } finally {
      await db.destroy()
    }
  })

  test('mixed-preset reseeds leave unrelated CLI sessions and projects alone', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    const scenario = 'settings-tokens/mixed-presets'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const token = await insertCliSession(db, 'personal-cli', userId)
      await issueCliRefreshCredential(db, userId, token, 'Personal laptop')
      const personal = (
        await listCliRefreshCredentialFamilies(db, userId)
      ).find((row) => row.deviceName === 'Personal laptop')!
      const fixture = (await listCliRefreshCredentialFamilies(db, userId)).find(
        (row) => row.preset === 'unrestricted' && row.deviceName === null,
      )!
      await db
        .updateTable('cli_refresh_credentials')
        .set({ revoked_at: clock })
        .where('family_id', '=', fixture.familyId)
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      const rows = await listCliRefreshCredentialFamilies(db, userId)
      expect(rows.find((row) => row.familyId === personal.familyId)).toEqual(
        personal,
      )
      expect(
        await db
          .selectFrom('sessions')
          .select('id')
          .where('id', '=', 'personal-cli')
          .execute(),
      ).toEqual([{ id: 'personal-cli' }])
      const replacement = rows.find(
        (row) => row.preset === 'unrestricted' && row.deviceName === null,
      )!
      expect(replacement.familyId).not.toBe(fixture.familyId)
      expect(replacement.createdAt).toBe(fixture.createdAt)

      // A same-name Reports made through the product is the fixture's and is
      // restored as the eligible destination; another project keeps its file.
      const other = await ensureDevScreenState(db, scenario, clock, 'plus')
      const otherUser = `${other.workspaceId}-user`
      await addScenarioOwner(db, other.workspaceId, otherUser, clock)
      const privateReports = await createProjectContainer(
        db,
        other.workspaceId,
        otherUser,
        { name: 'reports', description: null, baseVisibility: 'private' },
      )
      if (privateReports.kind !== 'ok') throw new Error(privateReports.kind)
      const teamNotes = await createProjectContainer(
        db,
        other.workspaceId,
        otherUser,
        {
          name: 'Team notes',
          description: 'Screen capture fixture: Agent destination',
          baseVisibility: 'private',
        },
      )
      if (teamNotes.kind !== 'ok') throw new Error(teamNotes.kind)
      await db
        .insertInto('shareables')
        .values({
          id: 'team-notes-file',
          workspace_id: other.workspaceId,
          owner_user_id: otherUser,
          container_id: teamNotes.id,
          name: 'Plan.html',
          artifact_kind: 'html_page',
          visibility: 'project',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      const neighbor = () =>
        db
          .selectFrom('artifact_containers')
          .leftJoin(
            'shareables',
            'shareables.container_id',
            'artifact_containers.id',
          )
          .select([
            'artifact_containers.name',
            'artifact_containers.base_visibility',
            'shareables.id as fileId',
          ])
          .where('artifact_containers.id', '=', teamNotes.id)
          .execute()
      const neighborBefore = await neighbor()
      await seedDevScreenState(
        db,
        scenario,
        other.workspaceId,
        otherUser,
        clock,
      )
      expect(
        await db
          .selectFrom('artifact_containers')
          .select(['name', 'base_visibility'])
          .where('id', '=', privateReports.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ name: 'Reports', base_visibility: 'workspace' })
      const agent = (
        await listCliRefreshCredentialFamilies(db, otherUser)
      ).find((row) => row.preset === 'agent')!
      expect(
        await db
          .selectFrom('cli_family_authorities')
          .select('project_id')
          .where('family_id', '=', agent.familyId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ project_id: privateReports.id })
      expect(await neighbor()).toEqual(neighborBefore)
    } finally {
      await db.destroy()
    }
  })

  test.each(['finite', 'unlimited', 'zero'])(
    'external %s matches the edit service and republishes a legacy direct link',
    async (state) => {
      const { db } = createMigratedInMemoryDb()
      const scenario = `settings-external-access/${state}`
      const legacyAt = later(-DAY)
      try {
        const { workspaceId } = await ensureDevScreenState(
          db,
          scenario,
          clock,
          'team',
        )
        const userId = `${workspaceId}-user`
        await addScenarioOwner(db, workspaceId, userId, clock)
        const inbox = await getOrCreateInboxContainerId(
          db,
          workspaceId,
          userId,
          clock,
        )
        const shareableId = devShareableId(`${workspaceId}-expiry-preview`)
        await db
          .insertInto('shareables')
          .values({
            id: shareableId,
            workspace_id: workspaceId,
            owner_user_id: userId,
            container_id: inbox,
            name: 'Shared report.html',
            artifact_kind: 'html_page',
            visibility: 'link',
            link_expires_at: null,
            created_at: legacyAt,
            updated_at: legacyAt,
          })
          .execute()
        await seedDevScreenState(db, scenario, workspaceId, userId, clock)
        const publication = (id: string) =>
          db
            .selectFrom('link_publications')
            .select('latest_published_at')
            .where('shareable_id', '=', id)
            .executeTakeFirstOrThrow()
        expect(await publication(shareableId)).toEqual({
          latest_published_at: clock,
        })

        await db
          .insertInto('shareables')
          .values({
            id: 'control-link',
            workspace_id: workspaceId,
            owner_user_id: userId,
            container_id: inbox,
            name: 'Control.html',
            artifact_kind: 'html_page',
            visibility: 'private',
            created_at: clock,
            updated_at: clock,
          })
          .execute()
        expect(
          await editShareableSettings(
            db,
            {
              id: userId,
              email: `${userId}@example.test`,
              workspaceId,
              hd: null,
            },
            'control-link',
            {
              visibility: 'link',
              linkExpiresAt: state === 'unlimited' ? null : later(60 * DAY),
            },
          ),
        ).toMatchObject({ kind: 'ok' })
        const shape = (id: string) =>
          db
            .selectFrom('shareables')
            .select(['visibility', 'owner_user_id', 'container_id'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        expect(await shape(shareableId)).toEqual(await shape('control-link'))
        expect(await publication(shareableId)).toEqual(
          await publication('control-link'),
        )
        const expiry = (
          await db
            .selectFrom('shareables')
            .select('link_expires_at')
            .where('id', '=', shareableId)
            .executeTakeFirstOrThrow()
        ).link_expires_at
        expect(expiry).toBe(
          state === 'zero'
            ? clock
            : state === 'finite'
              ? later(60 * DAY)
              : null,
        )
      } finally {
        await db.destroy()
      }
    },
  )

  test.each([
    ['settings/result-warning', 'Review notes.html'],
    ['settings-external-access/finite', 'Shared report.html'],
  ])(
    '%s owns its artifact by its fixed ID and removes same-title copies',
    async (scenario, title) => {
      const { db } = createMigratedInMemoryDb()
      try {
        const { workspaceId, userId } = await signIn(db, scenario)
        const byTitle = () =>
          db
            .selectFrom('shareables')
            .select([
              'id',
              'owner_user_id',
              'container_id',
              'visibility',
              'link_expires_at',
              'created_at',
              'updated_at',
              'activity_at',
            ])
            .where('workspace_id', '=', workspaceId)
            .where('name', '=', title)
            .execute()
        await addControlMember(db, workspaceId, `${workspaceId}-other`)
        const otherInbox = await getOrCreateInboxContainerId(
          db,
          workspaceId,
          `${workspaceId}-other`,
          clock,
        )
        const [original] = await byTitle()
        expect(original.id).toBe(
          devShareableId(
            `${workspaceId}-${scenario.startsWith('settings-external-access') ? 'expiry-preview' : 'transfer-file'}`,
          ),
        )
        expect(otherInbox).not.toBe(original.container_id)
        // A day after the seed, someone takes over, renames and moves the
        // seeded artifact, and adds a same-title copy: another member's, in
        // that member's inbox and shared by link.
        await db
          .updateTable('shareables')
          .set({
            name: 'Renamed.html',
            owner_user_id: userId,
            container_id: otherInbox,
            updated_at: later(DAY),
          })
          .where('id', '=', original.id)
          .execute()
        await db
          .insertInto('shareables')
          .values({
            id: 'same-title-copy',
            workspace_id: workspaceId,
            owner_user_id: `${workspaceId}-other`,
            container_id: otherInbox,
            name: title,
            artifact_kind: 'html_page',
            visibility: 'link',
            link_expires_at: later(10 * DAY),
            created_at: later(-DAY),
            updated_at: later(-DAY),
          })
          .execute()
        await seedDevScreenState(db, scenario, workspaceId, userId, clock)
        // The renamed row at the fixed ID is the fixture again; the
        // different-ID copy is gone.
        expect(await byTitle()).toEqual([original])
        await seedDevScreenState(db, scenario, workspaceId, userId, clock)
        expect(await byTitle()).toEqual([original])
      } finally {
        await db.destroy()
      }
    },
  )

  test('the Agent bootstrap refuses an inbox, archived or restricted destination', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    sqliteRef.current = sqlite
    try {
      const { workspaceId, userId } = await signIn(
        db,
        'settings-tokens/mixed-presets',
      )
      const inbox = await getOrCreateInboxContainerId(
        db,
        workspaceId,
        userId,
        clock,
      )
      for (const [id, archivedAt, visibility] of [
        ['archived-project', clock, 'workspace'],
        ['restricted-project', null, 'private'],
      ] as const)
        await db
          .insertInto('artifact_containers')
          .values({
            id,
            workspace_id: workspaceId,
            kind: 'project',
            created_by_id: userId,
            name: id,
            base_visibility: visibility,
            archived_at: archivedAt,
            created_at: clock,
            updated_at: clock,
          })
          .execute()
      await db
        .insertInto('sessions')
        .values({
          id: 'probe-session',
          user_id: userId,
          token: 'probe-token',
          expires_at: '2099-01-01T00:00:00.000Z',
          ip_address: null,
          user_agent: CLI_DEVICE_SESSION_USER_AGENT,
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      for (const selectedProjectId of [
        inbox,
        'archived-project',
        'restricted-project',
      ])
        expect(
          await attachAgentBootstrapAuthority('probe-token', {
            preset: 'agent',
            deviceName: null,
            projectSelector: null,
            selectedProjectId,
          }),
          selectedProjectId,
        ).toBe(false)
    } finally {
      await db.destroy()
    }
  })

  test('external access publishes only its fixture link through the edit service', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings-external-access/finite'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const shareableId = devShareableId(workspaceId + '-expiry-preview')
      await db
        .insertInto('shareables')
        .values({
          id: 'neighbor-file',
          workspace_id: workspaceId,
          owner_user_id: userId,
          container_id: await getOrCreateInboxContainerId(
            db,
            workspaceId,
            userId,
            clock,
          ),
          name: 'Neighbor.html',
          artifact_kind: 'html_page',
          visibility: 'link',
          link_expires_at: later(10 * DAY),
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      const expiry = (id: string) =>
        db
          .selectFrom('shareables')
          .select('link_expires_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      expect(await expiry(shareableId)).toEqual({
        link_expires_at: later(60 * DAY),
      })
      // The capture's policy edit shortens the link; the next seed restores it.
      expect(
        await updateWorkspaceExternalAccessPolicy(
          db,
          { id: userId, workspaceId },
          { linkExpiryMaxDays: 30 },
        ),
      ).toMatchObject({ kind: 'ok', shortenedLinkCount: 1 })
      await ensureDevScreenState(db, scenario, clock, 'team')
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(await expiry(shareableId)).toEqual({
        link_expires_at: later(60 * DAY),
      })
      expect(await expiry('neighbor-file')).toEqual({
        link_expires_at: later(10 * DAY),
      })
    } finally {
      await db.destroy()
    }
  })

  test('external access returns an owner-moved fixture link to the inbox', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings-external-access/finite'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const shareableId = devShareableId(workspaceId + '-expiry-preview')
      const fixture = () =>
        db
          .selectFrom('shareables')
          .select([
            'id',
            'owner_user_id',
            'container_id',
            'visibility',
            'link_expires_at',
          ])
          .where('id', '=', shareableId)
          .executeTakeFirstOrThrow()
      const healthy = await fixture()
      expect(healthy.container_id).toBe(
        await getOrCreateInboxContainerId(db, workspaceId, userId, clock),
      )
      // The owner moves the live link into a project that has its own file.
      const project = await createProjectContainer(db, workspaceId, userId, {
        name: 'Owner project',
        description: null,
        baseVisibility: 'workspace',
      })
      if (project.kind !== 'ok') throw new Error(project.kind)
      await db
        .insertInto('shareables')
        .values({
          id: 'project-file',
          workspace_id: workspaceId,
          owner_user_id: userId,
          container_id: project.id,
          name: 'Other.html',
          artifact_kind: 'html_page',
          visibility: 'project',
          created_at: clock,
          updated_at: clock,
        })
        .execute()
      await db
        .updateTable('shareables')
        .set({ container_id: project.id })
        .where('id', '=', shareableId)
        .execute()
      const projectFile = () =>
        db
          .selectFrom('shareables')
          .selectAll()
          .where('id', '=', 'project-file')
          .executeTakeFirstOrThrow()
      const projectFileBefore = await projectFile()

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      expect(await fixture()).toEqual(healthy)
      expect(await projectFile()).toEqual(projectFileBefore)
    } finally {
      await db.destroy()
    }
  })

  test('settings-external-access/finite restores its link times after an expiry edit', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings-external-access/finite'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const linkId = devShareableId(`${workspaceId}-expiry-preview`)
      const link = () =>
        db
          .selectFrom('shareables')
          .select([
            'name',
            'container_id',
            'link_expires_at',
            'updated_at',
            'activity_at',
          ])
          .where('id', '=', linkId)
          .executeTakeFirstOrThrow()
      const original = await link()
      expect(original.link_expires_at).toBe(later(60 * DAY))
      const { email } = await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
      // A day later the owner edits only the expiry through the product, to
      // a date that still counts as shortenable.
      vi.setSystemTime(Date.parse(later(DAY)))
      expect(
        await editShareableSettings(
          db,
          { id: userId, email, workspaceId, hd: null },
          linkId,
          { visibility: 'link', linkExpiresAt: later(51 * DAY) },
        ),
      ).toMatchObject({ kind: 'ok' })
      expect(await link()).toEqual({
        ...original,
        link_expires_at: later(51 * DAY),
        updated_at: later(DAY),
        activity_at: later(DAY),
      })

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      expect(await link()).toEqual(original)
    } finally {
      await db.destroy()
    }
  })

  test('settings-activity/with-activity restores drifted fixture events at their IDs', async () => {
    const { db, sqlite } = createMigratedInMemoryDb()
    const scenario = 'settings-activity/with-activity'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const events = () =>
        db
          .selectFrom('audit_events')
          .selectAll()
          .where('workspace_id', '=', workspaceId)
          .where('id', 'in', [
            ...[1, 2, 3, 4, 5].map((n) => `${workspaceId}-event-${n}`),
            ...['created', 'email', 'slack', 'approved'].map(
              (step) => `${workspaceId}-access-${step}`,
            ),
          ])
          .orderBy('id')
          .execute()
      const original = await events()
      expect(original).toHaveLength(9)
      // One event of each group drifts in detail, actor and time.
      await db
        .updateTable('audit_events')
        .set({
          detail: JSON.stringify({ from: 'free', to: 'plus' }),
          created_at: later(DAY),
          actor_user_id: null,
        })
        .where('id', 'in', [
          `${workspaceId}-event-1`,
          `${workspaceId}-access-approved`,
        ])
        .execute()
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(await events()).toEqual(original)
      // Once converged, a reseed writes none of them again.
      sqlite.exec(`
        CREATE TEMP TABLE audit_writes (id TEXT);
        CREATE TEMP TRIGGER audit_write_probe AFTER UPDATE ON audit_events
        BEGIN INSERT INTO audit_writes VALUES (NEW.id); END;
      `)
      await seedDevScreenState(db, scenario, workspaceId, userId, clock)
      expect(sqlite.prepare('SELECT id FROM audit_writes').all()).toEqual([])
      expect(await events()).toEqual(original)
    } finally {
      await db.destroy()
    }
  })

  test('a separate removal and transfer resets to the active member and original file', async () => {
    const { db } = createMigratedInMemoryDb()
    const scenario = 'settings/result-warning'
    try {
      const { workspaceId, userId } = await signIn(db, scenario)
      const neighbor = await signIn(db, scenario, 'plus')
      const neighborRows = () =>
        db
          .selectFrom('shareables')
          .selectAll()
          .where('workspace_id', '=', neighbor.workspaceId)
          .execute()
      const neighborBefore = await neighborRows()
      const memberId = `${workspaceId}-removed-member`
      const fileId = devShareableId(`${workspaceId}-transfer-file`)
      const file = () =>
        db
          .selectFrom('shareables')
          .select([
            'owner_user_id',
            'container_id',
            'created_at',
            'updated_at',
            'activity_at',
          ])
          .where('id', '=', fileId)
          .executeTakeFirstOrThrow()
      const original = await file()
      const actor = { id: userId, workspaceId }
      // The interactions run a day after the seed clock.
      vi.setSystemTime(Date.parse(later(DAY)))
      expect(await removeWorkspaceMember(db, actor, memberId)).toEqual({
        kind: 'ok',
      })
      expect(
        await transferRemovedMemberAssets(db, actor, memberId, userId),
      ).toEqual({ kind: 'ok' })
      expect(await file()).toMatchObject({
        owner_user_id: userId,
        updated_at: later(DAY),
        activity_at: later(DAY),
      })
      expect(
        (await loadRemovedWorkspaceMembers(db, workspaceId)).map((m) => m.id),
      ).toEqual([memberId])

      await seedDevScreenState(db, scenario, workspaceId, userId, clock)

      expect(await file()).toEqual(original)
      expect(await loadRemovedWorkspaceMembers(db, workspaceId)).toEqual([])
      expect(
        await db
          .selectFrom('users')
          .select('workspace_id')
          .where('id', '=', memberId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ workspace_id: workspaceId })
      expect(await neighborRows()).toEqual(neighborBefore)
    } finally {
      await db.destroy()
    }
  })
})

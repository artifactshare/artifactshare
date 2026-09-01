import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null as (() => void | Promise<void>) | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1BatchDbMock({ sqlite: sqliteRef }) },
}))

import {
  countReceivedAccessRequests,
  createAccessRequest,
  getReceivedAccessRequestTarget,
  getRequesterAccessRequestStatus,
  listReceivedAccessRequests,
  processAccessRequest,
} from './access-requests.server'

const OWNER: SessionUser = {
  id: 'owner',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Owner',
  image: null,
  workspaceId: 'owner-workspace',
  hd: null,
  msTenantId: null,
  locale: null,
  kind: 'human',
}
const REQUESTER: SessionUser = {
  ...OWNER,
  id: 'requester',
  email: 'requester@example.org',
  name: 'Requester',
  workspaceId: 'requester-workspace',
}
const ADMIN: SessionUser = {
  ...OWNER,
  id: 'admin',
  email: 'admin@example.com',
  name: 'Admin',
}
const PROJECT_CREATOR: SessionUser = {
  ...OWNER,
  id: 'project-creator',
  email: 'project-creator@example.com',
  name: 'Project creator',
}

describe('access request service', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createD1BatchFixture({ sqlite: sqliteRef })
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.beforeNextBatch = null
    await db
      .insertInto('workspaces')
      .values([
        {
          id: OWNER.workspaceId,
          name: 'Owner workspace',
          created_at: '2026-09-01T00:00:00.000Z',
          plan: 'free',
        },
        {
          id: REQUESTER.workspaceId,
          name: 'Requester workspace',
          created_at: '2026-09-01T00:00:00.000Z',
          plan: 'free',
        },
      ])
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: OWNER.id,
          email: OWNER.email,
          email_verified: 1,
          name: OWNER.name,
          image: null,
          workspace_id: OWNER.workspaceId,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: REQUESTER.id,
          email: REQUESTER.email,
          email_verified: 1,
          name: REQUESTER.name,
          image: null,
          workspace_id: REQUESTER.workspaceId,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'inbox',
        workspace_id: OWNER.workspaceId,
        kind: 'inbox',
        owner_user_id: OWNER.id,
        created_by_id: OWNER.id,
        name: 'Inbox',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'artifact',
        workspace_id: OWNER.workspaceId,
        owner_user_id: OWNER.id,
        name: 'Roadmap.html',
        artifact_kind: 'html_page',
        visibility: 'private',
        container_id: 'inbox',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'artifact-v1',
        shareable_id: 'artifact',
        artifact_kind: 'html_page',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'owner-workspace/artifact/v1/index.html',
        size_bytes: 1,
        sha256: 'artifact-v1-sha',
        created_by_id: OWNER.id,
        created_at: '2026-09-01T00:00:00.000Z',
        published_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ current_version_id: 'artifact-v1' })
      .where('id', '=', 'artifact')
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('assigns a human-owned request only to the artifact owner', async () => {
    await db
      .insertInto('users')
      .values({
        id: ADMIN.id,
        email: ADMIN.email,
        email_verified: 1,
        name: ADMIN.name,
        image: null,
        workspace_id: ADMIN.workspaceId,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: OWNER.workspaceId,
        user_id: ADMIN.id,
        role: 'admin',
        status: 'active',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [OWNER.email],
    })
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      createAccessRequest(db, 'artifact', REQUESTER),
    ).resolves.toMatchObject({
      kind: 'pending',
    })
    await expect(countReceivedAccessRequests(db, OWNER)).resolves.toBe(1)
    await expect(
      getReceivedAccessRequestTarget(db, created.requestId, OWNER),
    ).resolves.toEqual({ shareableId: 'artifact', canView: true })
    await expect(
      getReceivedAccessRequestTarget(db, created.requestId, ADMIN),
    ).resolves.toBeNull()
    await expect(countReceivedAccessRequests(db, ADMIN)).resolves.toBe(0)
    await expect(countReceivedAccessRequests(db, REQUESTER)).resolves.toBe(0)
    await expect(
      processAccessRequest(db, created.requestId, ADMIN, { kind: 'reject' }),
    ).resolves.toEqual({ kind: 'forbidden' })
    await expect(
      db
        .selectFrom('access_requests')
        .select('handler_user_id')
        .where('id', '=', created.requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ handler_user_id: OWNER.id })
    await db
      .updateTable('shareables')
      .set({ current_version_id: null })
      .where('id', '=', 'artifact')
      .execute()
    await expect(
      getReceivedAccessRequestTarget(db, created.requestId, OWNER),
    ).resolves.toEqual({ shareableId: 'artifact', canView: false })
  })

  test('includes a linked pending request beyond the first page', async () => {
    const now = '2026-09-01T00:00:00.000Z'
    const indexes = Array.from({ length: 51 }, (_, index) => index)
    for (let offset = 0; offset < indexes.length; offset += 10) {
      const chunk = indexes.slice(offset, offset + 10)
      await db
        .insertInto('users')
        .values(
          chunk.map((index) => ({
            id: `bulk-requester-${index.toString().padStart(2, '0')}`,
            email: `bulk-${index}@example.org`,
            email_verified: 1,
            name: `Bulk ${index}`,
            image: null,
            workspace_id: REQUESTER.workspaceId,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute()
      await db
        .insertInto('access_requests')
        .values(
          chunk.map((index) => ({
            id: `bulk-request-${index.toString().padStart(2, '0')}`,
            shareable_id: 'artifact',
            requester_user_id: `bulk-requester-${index.toString().padStart(2, '0')}`,
            handler_user_id: OWNER.id,
            status: 'pending' as const,
            resolved_by_user_id: null,
            resolution_scope: null,
            created_at: now,
            updated_at: now,
            resolved_at: null,
          })),
        )
        .execute()
    }

    const defaultPage = await listReceivedAccessRequests(db, OWNER)
    expect(defaultPage).toHaveLength(50)
    expect(defaultPage.some((item) => item.id === 'bulk-request-50')).toBe(
      false,
    )

    const linkedPage = await listReceivedAccessRequests(
      db,
      OWNER,
      'bulk-request-50',
    )
    expect(linkedPage).toHaveLength(50)
    expect(linkedPage[0]?.id).toBe('bulk-request-50')
  })

  test('records creation and approval snapshots with the request state changes', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')

    const createdEvent = await db
      .selectFrom('audit_events')
      .select(['workspace_id', 'actor_user_id', 'action', 'detail'])
      .where('id', '=', `access-request-created:${created.requestId}`)
      .executeTakeFirstOrThrow()
    expect(createdEvent).toMatchObject({
      workspace_id: OWNER.workspaceId,
      actor_user_id: REQUESTER.id,
      action: 'access_request.created',
    })
    expect(JSON.parse(createdEvent.detail!)).toMatchObject({
      access_request_id: created.requestId,
      artifact_id: 'artifact',
      artifact_title: 'Roadmap.html',
      requester_name: REQUESTER.name,
      requester_email: REQUESTER.email,
      handler_name: OWNER.name,
      handler_email: OWNER.email,
    })

    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
    const decisionEvent = await db
      .selectFrom('audit_events')
      .select(['actor_user_id', 'action', 'detail'])
      .where('id', '=', `access-request-decision:${created.requestId}`)
      .executeTakeFirstOrThrow()
    expect(decisionEvent).toMatchObject({
      actor_user_id: OWNER.id,
      action: 'access_request.approved',
    })
    expect(JSON.parse(decisionEvent.detail!)).toMatchObject({
      actor_name: OWNER.name,
      actor_email: OWNER.email,
      resolution_scope: 'artifact',
      decision_status: 'approved',
    })

    await db.deleteFrom('shareables').where('id', '=', 'artifact').execute()
    await expect(
      db
        .selectFrom('audit_events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('subject_id', '=', created.requestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 2 })
  })

  test('uses a Plus project creator who is also an admin when its human owner is unverified', async () => {
    await addHuman(db, ADMIN)
    await addWorkspaceMember(db, ADMIN.id, 'admin')
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus' })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await db
      .updateTable('users')
      .set({ email_verified: 0 })
      .where('id', '=', OWNER.id)
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'admin-project',
        workspace_id: OWNER.workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: ADMIN.id,
        name: 'Admin project',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ container_id: 'admin-project', visibility: 'project' })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [ADMIN.email],
    })
    await expect(countReceivedAccessRequests(db, ADMIN)).resolves.toBe(1)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      processAccessRequest(db, created.requestId, ADMIN, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'admin-project',
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
  })

  test('assigns a bot-owned project request to its active creator, not workspace admins', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: ADMIN.id,
          email: ADMIN.email,
          email_verified: 1,
          name: ADMIN.name,
          image: null,
          workspace_id: ADMIN.workspaceId,
          kind: 'human',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: PROJECT_CREATOR.id,
          email: PROJECT_CREATOR.email,
          email_verified: 1,
          name: PROJECT_CREATOR.name,
          image: null,
          workspace_id: PROJECT_CREATOR.workspaceId,
          kind: 'human',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'project-bot',
          email: 'project-bot@example.com',
          email_verified: 1,
          name: 'Project bot',
          image: null,
          workspace_id: OWNER.workspaceId,
          kind: 'bot',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: OWNER.workspaceId,
          user_id: OWNER.id,
          role: 'owner',
          status: 'active',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          workspace_id: OWNER.workspaceId,
          user_id: ADMIN.id,
          role: 'admin',
          status: 'active',
          created_at: '2026-09-01T00:01:00.000Z',
          updated_at: '2026-09-01T00:01:00.000Z',
        },
        {
          workspace_id: OWNER.workspaceId,
          user_id: PROJECT_CREATOR.id,
          role: 'member',
          status: 'active',
          created_at: '2026-09-01T00:02:00.000Z',
          updated_at: '2026-09-01T00:02:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'bot-project',
        workspace_id: OWNER.workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: PROJECT_CREATOR.id,
        name: 'Bot project',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({
        owner_user_id: 'project-bot',
        container_id: 'bot-project',
        visibility: 'project',
      })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [PROJECT_CREATOR.email],
    })
    await expect(
      countReceivedAccessRequests(db, PROJECT_CREATOR),
    ).resolves.toBe(1)
    await expect(countReceivedAccessRequests(db, OWNER)).resolves.toBe(0)
    await expect(countReceivedAccessRequests(db, ADMIN)).resolves.toBe(0)
  })

  test('falls back from a bot-owned inbox to the workspace owner only', async () => {
    await db
      .insertInto('users')
      .values([
        {
          id: ADMIN.id,
          email: ADMIN.email,
          email_verified: 1,
          name: ADMIN.name,
          image: null,
          workspace_id: ADMIN.workspaceId,
          kind: 'human',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'inbox-bot',
          email: 'inbox-bot@example.com',
          email_verified: 1,
          name: 'Inbox bot',
          image: null,
          workspace_id: OWNER.workspaceId,
          kind: 'bot',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: OWNER.workspaceId,
          user_id: OWNER.id,
          role: 'owner',
          status: 'active',
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          workspace_id: OWNER.workspaceId,
          user_id: ADMIN.id,
          role: 'admin',
          status: 'active',
          created_at: '2026-09-01T00:01:00.000Z',
          updated_at: '2026-09-01T00:01:00.000Z',
        },
      ])
      .execute()
    await db
      .updateTable('shareables')
      .set({ owner_user_id: 'inbox-bot' })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [OWNER.email],
    })
    await expect(countReceivedAccessRequests(db, OWNER)).resolves.toBe(1)
    await expect(countReceivedAccessRequests(db, ADMIN)).resolves.toBe(0)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      getReceivedAccessRequestTarget(db, created.requestId, OWNER),
    ).resolves.toEqual({ shareableId: 'artifact', canView: false })
    await expect(
      processAccessRequest(db, created.requestId, OWNER, { kind: 'reject' }),
    ).resolves.toEqual({ kind: 'processed', status: 'rejected' })
    await expect(
      processAccessRequest(db, created.requestId, ADMIN, { kind: 'reject' }),
    ).resolves.toEqual({ kind: 'already-processed', status: 'rejected' })
  })

  test('reassigns a pending bot inbox request when the original handler is removed', async () => {
    await addHuman(db, ADMIN)
    await addBot(db, 'inbox-bot')
    await addWorkspaceMember(db, OWNER.id, 'owner')
    await addWorkspaceMember(db, ADMIN.id, 'admin')
    await db
      .updateTable('shareables')
      .set({ owner_user_id: 'inbox-bot' })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [OWNER.email],
    })
    await db
      .updateTable('workspace_members')
      .set({ status: 'removed', removed_at: '2026-09-01T01:00:00.000Z' })
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .execute()

    await expect(countReceivedAccessRequests(db, OWNER)).resolves.toBe(0)
    await expect(countReceivedAccessRequests(db, ADMIN)).resolves.toBe(1)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      processAccessRequest(db, created.requestId, ADMIN, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
  })

  test('moves a pending bot project request to the new project creator', async () => {
    const creatorA = { ...PROJECT_CREATOR, id: 'creator-a' }
    const creatorB = {
      ...PROJECT_CREATOR,
      id: 'creator-b',
      email: 'creator-b@example.com',
    }
    await addHuman(db, creatorA)
    await addHuman(db, creatorB)
    await addBot(db, 'project-bot')
    await addWorkspaceMember(db, creatorA.id, 'member')
    await addWorkspaceMember(db, creatorB.id, 'member')
    for (const [id, creator] of [
      ['project-a', creatorA.id],
      ['project-b', creatorB.id],
    ] as const) {
      await db
        .insertInto('artifact_containers')
        .values({
          id,
          workspace_id: OWNER.workspaceId,
          kind: 'project',
          owner_user_id: null,
          created_by_id: creator,
          name: id,
          description: null,
          archived_at: null,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        })
        .execute()
    }
    await db
      .updateTable('shareables')
      .set({
        owner_user_id: 'project-bot',
        container_id: 'project-a',
        visibility: 'project',
      })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [creatorA.email],
    })
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-b' })
      .where('id', '=', 'artifact')
      .execute()

    await expect(countReceivedAccessRequests(db, creatorA)).resolves.toBe(0)
    await expect(countReceivedAccessRequests(db, creatorB)).resolves.toBe(1)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      processAccessRequest(db, created.requestId, creatorB, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'project-b',
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
  })

  test('rejects a stale handler when project priority changes during approval', async () => {
    const creatorA = {
      ...PROJECT_CREATOR,
      id: 'race-creator-a',
      email: 'race-a@example.com',
    }
    const creatorB = {
      ...PROJECT_CREATOR,
      id: 'race-creator-b',
      email: 'race-b@example.com',
    }
    await addHuman(db, creatorA)
    await addHuman(db, creatorB)
    await addBot(db, 'race-project-bot')
    await addWorkspaceMember(db, creatorA.id, 'admin')
    await addWorkspaceMember(db, creatorB.id, 'member')
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'race-project',
        workspace_id: OWNER.workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: creatorA.id,
        name: 'Race project',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({
        owner_user_id: 'race-project-bot',
        container_id: 'race-project',
        visibility: 'project',
      })
      .where('id', '=', 'artifact')
      .execute()
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')

    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          'UPDATE artifact_containers SET created_by_id = ? WHERE id = ?',
        )
        .run(creatorB.id, 'race-project')
    }
    await expect(
      processAccessRequest(db, created.requestId, creatorA, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'race-project',
      }),
    ).resolves.toEqual({ kind: 'forbidden' })
    await expect(
      getRequesterAccessRequestStatus(db, 'artifact', REQUESTER.id),
    ).resolves.toBe('pending')
  })

  test('uses an external project manager when no workspace handler can approve', async () => {
    const manager: SessionUser = {
      ...PROJECT_CREATOR,
      id: 'external-manager',
      email: 'external-manager@example.org',
      workspaceId: REQUESTER.workspaceId,
    }
    await addHuman(db, manager)
    await addBot(db, 'project-bot')
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', external_posting_enabled: 1 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'managed-project',
        workspace_id: OWNER.workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: null,
        name: 'Managed project',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'manager-grant',
        project_container_id: 'managed-project',
        email: manager.email,
        role: 'manager',
        display_name: manager.name,
        created_by_id: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({
        owner_user_id: 'project-bot',
        container_id: 'managed-project',
        visibility: 'project',
      })
      .where('id', '=', 'artifact')
      .execute()

    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [manager.email],
    })
    await expect(countReceivedAccessRequests(db, manager)).resolves.toBe(1)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      processAccessRequest(db, created.requestId, manager, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'managed-project',
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
  })

  test('requires a verified requester email at submission time', async () => {
    await expect(
      createAccessRequest(db, 'artifact', {
        ...REQUESTER,
        emailVerified: false,
      }),
    ).resolves.toEqual({ kind: 'email-unverified' })
  })

  test('approves atomically and grants only the requested artifact', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
    await expect(
      db
        .selectFrom('shareable_grants')
        .select(['shareable_id', 'granted_email'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      shareable_id: 'artifact',
      granted_email: REQUESTER.email,
    })
    await expect(
      getRequesterAccessRequestStatus(db, 'artifact', REQUESTER.id),
    ).resolves.toBe('approved')
    await expect(
      processAccessRequest(db, created.requestId, REQUESTER, {
        kind: 'reject',
      }),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('rolls back a losing approval when another decision wins first', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          "UPDATE access_requests SET status = 'rejected', resolved_by_user_id = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          OWNER.id,
          '2026-09-01T01:00:00.000Z',
          '2026-09-01T01:00:00.000Z',
          created.requestId,
        )
    }
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'already-processed', status: 'rejected' })
    await expect(
      db.selectFrom('shareable_grants').select('shareable_id').execute(),
    ).resolves.toEqual([])
  })

  test('allows a new request after rejection', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await processAccessRequest(db, created.requestId, OWNER, { kind: 'reject' })
    await expect(
      createAccessRequest(db, 'artifact', REQUESTER),
    ).resolves.toMatchObject({
      kind: 'created',
    })
  })

  test('keeps a processed request idempotent after its ownership changes', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await processAccessRequest(db, created.requestId, OWNER, { kind: 'reject' })
    const newOwner: SessionUser = {
      ...OWNER,
      id: 'resolved-new-owner',
      email: 'resolved-new-owner@example.com',
    }
    await addHuman(db, newOwner)
    await db
      .updateTable('shareables')
      .set({ owner_user_id: newOwner.id })
      .where('id', '=', 'artifact')
      .execute()
    await db
      .updateTable('access_requests')
      .set({ handler_user_id: null })
      .where('id', '=', created.requestId)
      .execute()

    await expect(
      processAccessRequest(db, created.requestId, OWNER, { kind: 'reject' }),
    ).resolves.toEqual({ kind: 'already-processed', status: 'rejected' })
  })

  test('offers project scope to its creator and binds approval to that project', async () => {
    await db
      .insertInto('artifact_containers')
      .values([
        {
          id: 'project-a',
          workspace_id: OWNER.workspaceId,
          kind: 'project',
          owner_user_id: null,
          created_by_id: OWNER.id,
          name: 'Launch',
          description: null,
          archived_at: null,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'project-b',
          workspace_id: OWNER.workspaceId,
          kind: 'project',
          owner_user_id: null,
          created_by_id: OWNER.id,
          name: 'Later',
          description: null,
          archived_at: null,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ])
      .execute()
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a', visibility: 'project' })
      .where('id', '=', 'artifact')
      .execute()
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')

    await db
      .updateTable('shareables')
      .set({ container_id: 'project-b' })
      .where('id', '=', 'artifact')
      .execute()
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'project-a',
      }),
    ).resolves.toEqual({ kind: 'location-changed' })
    await expect(
      getRequesterAccessRequestStatus(db, 'artifact', REQUESTER.id),
    ).resolves.toBe('pending')

    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare('UPDATE shareables SET container_id = ? WHERE id = ?')
        .run('project-a', 'artifact')
    }
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'project-b',
      }),
    ).resolves.toEqual({ kind: 'location-changed' })
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'project-a',
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
    await expect(
      db
        .selectFrom('project_share_defaults')
        .select(['project_container_id', 'email', 'role'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      project_container_id: 'project-a',
      email: REQUESTER.email,
      role: 'viewer',
    })
  })

  test('does not expose project scope for a private artifact in a project', async () => {
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'private-project',
        workspace_id: OWNER.workspaceId,
        kind: 'project',
        owner_user_id: null,
        created_by_id: OWNER.id,
        name: 'Private project',
        description: null,
        archived_at: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ container_id: 'private-project', visibility: 'private' })
      .where('id', '=', 'artifact')
      .execute()
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    await expect(listReceivedAccessRequests(db, OWNER)).resolves.toMatchObject([
      { canGrantArtifact: true, canGrantProject: false },
    ])
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'project',
        expectedProjectId: 'private-project',
      }),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  test('does not count a stale grant for the current owner toward the artifact limit', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    const newOwner: SessionUser = {
      ...OWNER,
      id: 'new-owner',
      email: 'new-owner@example.com',
      name: 'New owner',
    }
    await db
      .insertInto('users')
      .values({
        id: newOwner.id,
        email: newOwner.email,
        email_verified: 1,
        name: newOwner.name,
        image: null,
        workspace_id: newOwner.workspaceId,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      })
      .execute()
    const grants = [
      {
        shareable_id: 'artifact',
        granted_email: newOwner.email,
        granted_at: '2026-09-01T00:00:00.000Z',
        granted_by: OWNER.id,
      },
      ...Array.from({ length: 49 }, (_, index) => ({
        shareable_id: 'artifact',
        granted_email: `viewer-${index}@example.test`,
        granted_at: '2026-09-01T00:00:00.000Z',
        granted_by: OWNER.id,
      })),
    ]
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        db
          .insertInto('shareable_grants')
          .values(grants.slice(index * 10, index * 10 + 10))
          .execute(),
      ),
    )
    await db
      .updateTable('shareables')
      .set({ owner_user_id: newOwner.id })
      .where('id', '=', 'artifact')
      .execute()
    await db
      .updateTable('access_requests')
      .set({ handler_user_id: newOwner.id })
      .where('id', '=', created.requestId)
      .execute()

    await expect(
      processAccessRequest(db, created.requestId, newOwner, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'processed', status: 'approved' })
  })

  test('leaves a request pending when the artifact audience is full', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    if (created.kind !== 'created') throw new Error('request setup failed')
    const grants = Array.from({ length: 50 }, (_, index) => ({
      shareable_id: 'artifact',
      granted_email: `viewer-${index}@example.test`,
      granted_at: '2026-09-01T00:00:00.000Z',
      granted_by: OWNER.id,
    }))
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        db
          .insertInto('shareable_grants')
          .values(grants.slice(index * 10, index * 10 + 10))
          .execute(),
      ),
    )
    await expect(
      processAccessRequest(db, created.requestId, OWNER, {
        kind: 'approve',
        scope: 'artifact',
        expectedProjectId: null,
      }),
    ).resolves.toEqual({ kind: 'too-many-grants' })
    await expect(
      getRequesterAccessRequestStatus(db, 'artifact', REQUESTER.id),
    ).resolves.toBe('pending')
  })
})

async function addHuman(db: Kysely<DB>, user: SessionUser) {
  await db
    .insertInto('users')
    .values({
      id: user.id,
      email: user.email,
      email_verified: 1,
      name: user.name,
      image: user.image,
      workspace_id: user.workspaceId,
      kind: 'human',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    })
    .execute()
}

async function addBot(db: Kysely<DB>, id: string) {
  await db
    .insertInto('users')
    .values({
      id,
      email: `${id}@example.com`,
      email_verified: 1,
      name: id,
      image: null,
      workspace_id: OWNER.workspaceId,
      kind: 'bot',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    })
    .execute()
}

async function addWorkspaceMember(
  db: Kysely<DB>,
  userId: string,
  role: 'owner' | 'admin' | 'member',
) {
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: OWNER.workspaceId,
      user_id: userId,
      role,
      status: 'active',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    })
    .execute()
}

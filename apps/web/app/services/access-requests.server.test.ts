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
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('creates one pending request and exposes it only to an approver', async () => {
    const created = await createAccessRequest(db, 'artifact', REQUESTER)
    expect(created).toMatchObject({
      kind: 'created',
      approverEmails: [OWNER.email],
    })
    await expect(
      createAccessRequest(db, 'artifact', REQUESTER),
    ).resolves.toMatchObject({
      kind: 'pending',
    })
    await expect(countReceivedAccessRequests(db, OWNER)).resolves.toBe(1)
    await expect(countReceivedAccessRequests(db, REQUESTER)).resolves.toBe(0)
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

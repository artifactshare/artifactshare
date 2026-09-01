import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import { viewerDisplayCheck } from './access.server'
import { issueCliRefreshCredential } from './cli-refresh-credentials.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))
const batchHookRef = vi.hoisted(() => ({
  current: null as ((batchIndex: number) => void) | null,
}))
const batchCountRef = vi.hoisted(() => ({ current: 0 }))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({
      sqlite: sqliteRef,
      beforeBatch: batchHookRef,
      batchCount: batchCountRef,
    }),
  },
}))

import {
  countWorkspaceContributors,
  ensureWorkspaceAdmin,
  grantWorkspaceAdmin,
  loadMembersPageData,
  loadAuditEventsPage,
  loadRemovedWorkspaceMembers,
  loadSettingsShell,
  loadWorkspaceOwner,
  loadWorkspaceInventoryArtifactsPage,
  loadWorkspaceMembersPage,
  loadWorkspaceInventoryProjectsPage,
  parseInventoryArtifactsFilters,
  removeWorkspaceMember,
  searchAssetTransferRecipients,
  requireWorkspaceAdmin,
  requireWorkspaceBillingOwner,
  revokeWorkspaceAdmin,
  restoreWorkspaceMember,
  transferWorkspaceOwner,
  transferRemovedMemberAssets,
  updateWorkspaceName,
  WORKSPACE_NAME_MAX_LENGTH,
} from './team-management.server'

describe('team-management service', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createD1BatchFixture({
      sqlite: sqliteRef,
      beforeBatch: batchHookRef,
      batchCount: batchCountRef,
    })
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    batchHookRef.current = null
    batchCountRef.current = 0
  })

  test('parses inventory artifact filters and falls back for invalid values', () => {
    expect(
      parseInventoryArtifactsFilters(
        new URLSearchParams('visibility=link&sort=size&page=3'),
      ),
    ).toEqual({ visibility: 'link', sort: 'size', page: 3 })
    expect(
      parseInventoryArtifactsFilters(
        new URLSearchParams('visibility=unknown&sort=bad&page=0'),
      ),
    ).toEqual({ visibility: 'all', sort: 'updated', page: 1 })
  })

  test('loads inventory projects with stable paging, workspace boundaries, and published sizes', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    for (let i = 0; i < 51; i++) {
      seedContainer(
        sqlite,
        `project-${String(i).padStart(3, '0')}`,
        'project',
        null,
      )
    }
    seedContainer(sqlite, 'inbox', 'inbox', 'u1')
    seedArtifact(sqlite, 'a-project-0', 'u1', 'project-000')
    seedArtifact(sqlite, 'a-project-1', 'u1', 'project-001')
    seedVersion(sqlite, 'v-project-0a', 'a-project-0', 10, 'published')
    seedVersion(sqlite, 'v-project-0b', 'a-project-0', 20, 'published')
    seedVersion(sqlite, 'v-project-0draft', 'a-project-0', 999, 'uploading')
    seedVersion(sqlite, 'v-project-1', 'a-project-1', 0, 'published')

    seedWorkspace(sqlite, 'team', 'ws2')
    seedUserInWorkspace(sqlite, 'other-user', 'ws2')
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('other-project', 'ws2', 'project', 'other-user', 'other-user', 'Other', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`,
      )
      .run()
    seedArtifact(sqlite, 'other-artifact', 'other-user', 'other-project')
    sqlite
      .prepare(
        `UPDATE shareables SET workspace_id = 'ws2' WHERE id = 'other-artifact'`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('broken-project-artifact', 'ws1', 'u1', 'Broken', 'markdown_page', 'workspace', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z', 'other-project')`,
      )
      .run()

    const first = await loadWorkspaceInventoryProjectsPage(db, 'ws1', 1)
    expect(first.total).toBe(51)
    expect(first.projects).toHaveLength(50)
    expect(
      first.projects.find((project) => project.id === 'project-000'),
    ).toMatchObject({
      artifactCount: 1,
      sizeBytes: 30,
    })
    expect(
      first.projects.find((project) => project.id === 'project-001')?.sizeBytes,
    ).toBe(0)
    expect(
      (await loadWorkspaceInventoryProjectsPage(db, 'ws1', 2)).projects,
    ).toHaveLength(1)
    expect(
      (await loadWorkspaceInventoryProjectsPage(db, 'ws1', 999)).page,
    ).toBe(2)
    expect(
      first.projects.every((project) => project.id !== 'other-project'),
    ).toBe(true)

    const sameSize = first.projects.filter(
      (project) => project.sizeBytes === null,
    )
    expect(sameSize.slice(0, 2).map((project) => project.id)).toEqual([
      'project-002',
      'project-003',
    ])
  })

  test('loads inventory artifacts with filters, locations, owners, titles, sizes, and boundaries', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedContainer(sqlite, 'project-1', 'project', null)
    seedContainer(sqlite, 'inbox-1', 'inbox', 'u1')
    seedArtifact(sqlite, 'a-title', 'u1', 'project-1', 'link')
    seedArtifact(sqlite, 'a-derived', 'u1', 'inbox-1', 'link')
    seedArtifact(sqlite, 'a-name', 'u1', 'inbox-1', 'workspace')
    sqlite
      .prepare(
        `UPDATE shareables SET title_override = 'Override', derived_title = 'Derived' WHERE id = 'a-title'`,
      )
      .run()
    sqlite
      .prepare(
        `UPDATE shareables SET derived_title = 'Derived only' WHERE id = 'a-derived'`,
      )
      .run()
    sqlite
      .prepare(
        `UPDATE shareables SET updated_at = '2026-07-13T00:00:00.000Z' WHERE id = 'a-name'`,
      )
      .run()
    seedVersion(sqlite, 'v-title-1', 'a-title', 100, 'published')
    seedVersion(sqlite, 'v-title-2', 'a-title', 50, 'published')
    seedVersion(sqlite, 'v-title-draft', 'a-title', 1000, 'scanning')
    seedVersion(sqlite, 'v-derived', 'a-derived', 20, 'published')

    const linkBySize = await loadWorkspaceInventoryArtifactsPage(db, 'ws1', {
      visibility: 'link',
      sort: 'size',
      page: 1,
    })
    expect(linkBySize.total).toBe(2)
    expect(linkBySize.artifacts.map((artifact) => artifact.id)).toEqual([
      'a-title',
      'a-derived',
    ])
    expect(linkBySize.artifacts[0]).toMatchObject({
      name: 'Override',
      owner: { name: 'User u1', email: 'u1@example.com' },
      location: { kind: 'project', name: 'project-1' },
      sizeBytes: 150,
    })
    expect(linkBySize.artifacts[1]).toMatchObject({
      name: 'Derived only',
      location: { kind: 'inbox', name: 'inbox-1' },
      sizeBytes: 20,
    })
    expect(
      (
        await loadWorkspaceInventoryArtifactsPage(db, 'ws1', {
          visibility: 'all',
          sort: 'updated',
          page: 1,
        })
      ).artifacts[0]?.id,
    ).toBe('a-name')

    seedWorkspace(sqlite, 'team', 'ws2')
    seedUserInWorkspace(sqlite, 'other-user', 'ws2')
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES ('other-container', 'ws2', 'inbox', 'other-user', 'other-user', 'Other inbox', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('broken', 'ws1', 'u1', 'Broken', 'markdown_page', 'workspace', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z', 'other-container')`,
      )
      .run()
    const scoped = await loadWorkspaceInventoryArtifactsPage(db, 'ws1', {
      visibility: 'all',
      sort: 'updated',
      page: 1,
    })
    expect(scoped.total).toBe(3)
    expect(scoped.artifacts.some((artifact) => artifact.id === 'broken')).toBe(
      false,
    )
  })

  test('loads audit events with clamped paging, joins, and tolerant details', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'actor')
    seedUser(sqlite, 'subject')
    const insert = sqlite.prepare(
      `INSERT INTO audit_events
       (id, workspace_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
       VALUES (?, 'ws1', ?, ?, 'user', ?, ?, ?)`,
    )
    const details = [
      JSON.stringify({ name: 'Removed', email: 'removed@example.com' }),
      JSON.stringify({ name: 'Restored', email: 'restored@example.com' }),
      JSON.stringify({ from_role: 'member', to_role: 'admin' }),
      JSON.stringify({ from_role: 'admin', to_role: 'member' }),
      JSON.stringify({
        recipient_email: 'recipient@example.com',
        artifact_count: 8,
      }),
      JSON.stringify({ from: 'free', to: 'team' }),
      JSON.stringify({ name: 'Deleted artifact' }),
      null,
      '{not json',
    ]
    const actions = [
      'member.remove',
      'member.restore',
      'admin.grant',
      'admin.revoke',
      'assets.transfer',
      'plan.change',
      'artifact.delete',
      'owner.transfer',
      'unknown.action',
    ]
    for (let i = 0; i < 59; i++) {
      const index = i % actions.length
      insert.run(
        `audit-${String(i).padStart(3, '0')}`,
        i % 3 === 0 ? 'actor' : null,
        actions[index],
        i % 2 === 0 ? 'subject' : 'missing-subject',
        details[index],
        `2026-07-${String(1 + Math.floor(i / 3)).padStart(2, '0')}T00:00:00.000Z`,
      )
    }

    const first = await loadAuditEventsPage(db, 'ws1', 0)
    expect(first.page).toBe(1)
    expect(first.events).toHaveLength(50)
    expect(first.events[0]?.id).toBe('audit-058')
    expect(first.events[0]?.actor).toBeNull()
    expect(first.events[0]?.subject).toMatchObject({ id: 'subject' })
    expect(first.events[0]?.detail).toMatchObject({
      recipientEmail: 'recipient@example.com',
      artifactCount: 8,
    })
    expect(first.events.some((event) => event.detail.name === null)).toBe(true)
    expect((await loadAuditEventsPage(db, 'ws1', Number.NaN)).page).toBe(1)
    expect((await loadAuditEventsPage(db, 'ws1', 999)).page).toBe(2)
    expect((await loadAuditEventsPage(db, 'ws1', 2)).events[0]?.id).toBe(
      'audit-008',
    )
  })

  test('loads access request snapshots without crossing workspace boundaries', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'team', 'ws2')
    const detail = JSON.stringify({
      access_request_id: 'request-1',
      artifact_id: 'artifact-1',
      artifact_title: 'Roadmap',
      project_id: 'project-1',
      project_name: 'Planning',
      requester_id: 'deleted-requester',
      requester_name: 'Original requester',
      requester_email: 'original@example.com',
      handler_id: 'handler',
      handler_name: 'Handler',
      handler_email: 'handler@example.com',
      actor_id: 'deleted-requester',
      actor_name: 'Original requester',
      actor_email: 'original@example.com',
    })
    sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, workspace_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, NULL, 'access_request.created', 'access_request', 'request-1', ?, ?)`,
      )
      .run('request-event', 'ws1', detail, '2026-09-01T00:00:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, workspace_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, NULL, 'access_request.created', 'access_request', 'request-2', ?, ?)`,
      )
      .run('foreign-event', 'ws2', detail, '2026-09-01T00:01:00.000Z')
    sqlite
      .prepare(
        `INSERT INTO audit_events
         (id, workspace_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
         VALUES (?, ?, NULL, 'access_request.email.succeeded', 'access_request', 'request-1', ?, ?)`,
      )
      .run('notification-event', 'ws1', detail, '2026-09-01T00:02:00.000Z')

    const page = await loadAuditEventsPage(db, 'ws1', 1)
    expect(page.total).toBe(2)
    expect(page.events[0]).toMatchObject({
      id: 'notification-event',
      actor: null,
    })
    expect(page.events[1]).toMatchObject({
      id: 'request-event',
      actor: {
        id: 'deleted-requester',
        name: 'Original requester',
        email: 'original@example.com',
      },
      detail: {
        accessRequestId: 'request-1',
        artifactTitle: 'Roadmap',
        projectName: 'Planning',
      },
    })
  })

  test('authorizes each active owner and admin membership directly', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedAdmin(sqlite, 'u1')
    seedOwner(sqlite, 'u2')
    seedMember(sqlite, 'u3')

    await expect(requireWorkspaceAdmin(db, user('u1'))).resolves.toEqual({
      kind: 'ok',
    })
    await expect(requireWorkspaceAdmin(db, user('u2'))).resolves.toEqual({
      kind: 'ok',
    })
    await expect(requireWorkspaceAdmin(db, user('u3'))).resolves.toEqual({
      kind: 'forbidden',
    })
  })

  test('billing authorization is owner-only once an owner exists', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedOwner(sqlite, 'u2')

    await expect(requireWorkspaceBillingOwner(db, user('u2'))).resolves.toEqual(
      { kind: 'ok' },
    )
    await expect(requireWorkspaceBillingOwner(db, user('u1'))).resolves.toEqual(
      { kind: 'forbidden' },
    )
  })

  test('billing authorization rejects an admin without an owner', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedAdmin(sqlite, 'u1')

    await expect(requireWorkspaceBillingOwner(db, user('u1'))).resolves.toEqual(
      { kind: 'forbidden' },
    )
  })

  test('owner can grant and revoke multiple admins with idempotent audit writes', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')
    seedMember(sqlite, 'u3')

    await expect(grantWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'ok',
    })
    await expect(grantWorkspaceAdmin(db, user('u1'), 'u3')).resolves.toEqual({
      kind: 'ok',
    })
    await expect(revokeWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'ok',
    })
    await expect(revokeWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'ok',
    })
    expect(readRole(sqlite, 'u2')).toBe('member')
    expect(readRole(sqlite, 'u3')).toBe('admin')
    const audits = readAuditEvents(sqlite, 'ws1')
    expect(audits.map((event) => event.action)).toEqual([
      'admin.grant',
      'admin.grant',
      'admin.revoke',
    ])
    expect(
      audits.map((event) => ({
        action: event.action,
        actor: event.actor_user_id,
        target: event.subject_id,
        detail: JSON.parse(event.detail!),
      })),
    ).toEqual([
      {
        action: 'admin.grant',
        actor: 'u1',
        target: 'u2',
        detail: {
          from_role: 'member',
          to_role: 'admin',
          target_user_id: 'u2',
        },
      },
      {
        action: 'admin.grant',
        actor: 'u1',
        target: 'u3',
        detail: {
          from_role: 'member',
          to_role: 'admin',
          target_user_id: 'u3',
        },
      },
      {
        action: 'admin.revoke',
        actor: 'u1',
        target: 'u2',
        detail: {
          from_role: 'admin',
          to_role: 'member',
          target_user_id: 'u2',
        },
      },
    ])
  })

  test('grant reports forbidden when the owner is revoked before its batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')
    batchHookRef.current = () => demoteAdmin(sqlite, 'u1')

    await expect(grantWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'forbidden',
    })
    expect(readRole(sqlite, 'u1')).toBe('member')
    expect(readRole(sqlite, 'u2')).toBe('member')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('grant rejects a stale membership after the user moves workspaces', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'ws2')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')
    batchHookRef.current = () => {
      sqlite
        .prepare('UPDATE users SET workspace_id = ? WHERE id = ?')
        .run('ws2', 'u2')
    }

    await expect(grantWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'not-found',
    })
    expect(readRole(sqlite, 'u2')).toBe('member')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('revoke reports forbidden when the owner is revoked before its batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedAdmin(sqlite, 'u2')
    batchHookRef.current = () => demoteAdmin(sqlite, 'u1')

    await expect(revokeWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'forbidden',
    })
    expect(readRole(sqlite, 'u1')).toBe('member')
    expect(readRole(sqlite, 'u2')).toBe('admin')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('admin cannot grant or revoke roles', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedMember(sqlite, 'u2')

    await expect(grantWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'forbidden',
    })
    await expect(revokeWorkspaceAdmin(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'forbidden',
    })
  })

  afterEach(async () => {
    sqliteRef.current = null
    batchHookRef.current = null
    batchCountRef.current = 0
    await db.destroy()
  })

  test('ensureWorkspaceAdmin leaves an existing admin unchanged', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1', '2026-05-25T00:00:00.000Z')
    seedUser(sqlite, 'u2', '2026-05-26T00:00:00.000Z')
    seedAdmin(sqlite, 'u1')

    const adminId = await ensureWorkspaceAdmin(
      db,
      'ws1',
      '2026-06-28T00:00:00.000Z',
    )

    expect(adminId).toBe('u1')
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('loadWorkspaceOwner repairs a workspace without an owner', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')

    const owner = await loadWorkspaceOwner(db, 'ws1')

    expect(owner?.id).toBe('u1')
    expect(owner?.email).toBe('u1@example.com')
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('free workspace shows upgrade state and bootstraps an admin', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')

    const data = await loadMembersPageData(db, user('u1'), filters())
    const shell = await loadSettingsShell(db, user('u1'))

    expect(shell.kind).toBe('upgrade')
    expect(data.currentUserIsAdmin).toBe(true)
    expect(data.membersPage.members).toHaveLength(2)
    expect(data.membersPage.members.map((member) => member.id).sort()).toEqual([
      'u1',
      'u2',
    ])
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('plus workspace returns admin and workspace members', async () => {
    seedWorkspace(sqlite, 'plus')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u2')

    const data = await loadMembersPageData(db, user('u1'), filters())
    const shell = await loadSettingsShell(db, user('u1'))

    expect(shell.kind).toBe('upgrade')
    expect(data.currentUserIsAdmin).toBe(false)
    expect(data.membersPage.members).toHaveLength(2)
    expect(data.removedMembers).toEqual([])
  })

  test('free admin can transfer admin role to another workspace user', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readRole(sqlite, 'u1')).toBe('admin')
    expect(readRole(sqlite, 'u2')).toBe('owner')
  })

  test('free admin cannot transfer admin role to another workspace user', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedWorkspace(sqlite, 'free', 'ws2')
    seedUserInWorkspace(sqlite, 'u3', 'ws2')
    seedOwner(sqlite, 'u1')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u3')

    expect(result).toEqual({ kind: 'not-found' })
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('admin can update workspace name', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedOwner(sqlite, 'u1')

    const result = await updateWorkspaceName(db, user('u1'), '  New Name  ')

    expect(result).toEqual({ kind: 'ok' })
    expect(readWorkspaceName(sqlite)).toBe('New Name')
  })

  test('non-admin cannot update workspace name', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')

    const result = await updateWorkspaceName(db, user('u2'), 'New Name')

    expect(result).toEqual({ kind: 'forbidden' })
    expect(readWorkspaceName(sqlite)).toBe('Example')
  })

  test('admin cannot save blank or too long workspace name', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedAdmin(sqlite, 'u1')

    await expect(updateWorkspaceName(db, user('u1'), '   ')).resolves.toEqual({
      kind: 'invalid',
    })
    await expect(
      updateWorkspaceName(
        db,
        user('u1'),
        'x'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1),
      ),
    ).resolves.toEqual({ kind: 'invalid' })
    expect(readWorkspaceName(sqlite)).toBe('Example')
  })

  test('team workspace bootstraps the earliest contributor as admin when missing', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1', '2026-05-26T00:00:00.000Z')
    seedUser(sqlite, 'u2', '2026-05-25T00:00:00.000Z')
    seedContributor(sqlite, 'u1', '2026-05-26T00:00:00.000Z')
    seedContributor(sqlite, 'u2', '2026-05-25T00:00:00.000Z')

    const data = await loadMembersPageData(db, user('u1'), filters())
    const shell = await loadSettingsShell(db, user('u1'))

    expect(shell.kind).toBe('team')
    expect(data.currentUserIsAdmin).toBe(false)
    expect(data.membersPage.members).toHaveLength(2)
  })

  test('team workspace lists members without contribution history', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedMember(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')

    const data = await loadMembersPageData(db, user('u1'), filters())

    expect(data.membersPage.members).toHaveLength(2)
    const nonContributor = data.membersPage.members.find(
      (member) => member.id === 'u2',
    )
    expect(nonContributor?.firstContributedAt).toBeNull()
  })

  test('removed members are excluded from the member list', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    sqlite.exec(`
      UPDATE workspace_members
      SET status = 'removed'
      WHERE workspace_id = 'ws1' AND user_id = 'u2';
    `)

    const data = await loadMembersPageData(db, user('u1'), filters())

    expect(data.membersPage.members.map((member) => member.id)).toEqual(['u1'])
  })

  test('team workspace falls back to earliest user when no contributor exists', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1', '2026-05-26T00:00:00.000Z')
    seedUser(sqlite, 'u2', '2026-05-25T00:00:00.000Z')

    const data = await loadMembersPageData(db, user('u1'), filters())

    expect(data.currentUserIsAdmin).toBe(false)
    expect(data.membersPage.members).toHaveLength(2)
    expect(
      data.membersPage.members.every(
        (member) => member.firstContributedAt === null,
      ),
    ).toBe(true)
  })

  test('admin can transfer admin role to another contributor', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedOwner(sqlite, 'u1')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readRole(sqlite, 'u2')).toBe('owner')
    const audits = readAuditEvents(sqlite, 'ws1')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'owner.transfer',
      subject_type: 'user',
      subject_id: 'u2',
      actor_user_id: 'u1',
    })
  })

  test('owner transfer makes the former owner an admin and records owner.transfer', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readRole(sqlite, 'u1')).toBe('admin')
    expect(readRole(sqlite, 'u2')).toBe('owner')
    expect(readAuditEvents(sqlite, 'ws1')[0]).toMatchObject({
      action: 'owner.transfer',
      actor_user_id: 'u1',
      subject_id: 'u2',
    })
  })

  test('owner can transfer to an existing admin', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedAdmin(sqlite, 'u2')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readRole(sqlite, 'u1')).toBe('admin')
    expect(readRole(sqlite, 'u2')).toBe('owner')
    expect(
      readAuditEvents(sqlite, 'ws1').filter(
        (event) => event.action === 'owner.transfer',
      ),
    ).toHaveLength(1)
  })

  test('owner transfer cannot complete after the actor is demoted before its batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')
    batchHookRef.current = (batchIndex) => {
      if (batchIndex === 0) {
        sqlite
          .prepare(
            `UPDATE workspace_members SET role = 'admin'
             WHERE workspace_id = 'ws1' AND user_id = 'u1'`,
          )
          .run()
      }
    }

    await expect(transferWorkspaceOwner(db, user('u1'), 'u2')).resolves.toEqual(
      {
        kind: 'forbidden',
      },
    )
    expect(readRole(sqlite, 'u1')).toBe('admin')
    expect(readRole(sqlite, 'u2')).toBe('member')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('owner transfer does not demote an existing admin after the actor loses ownership before its batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedAdmin(sqlite, 'u2')
    batchHookRef.current = (batchIndex) => {
      if (batchIndex === 0) {
        demoteAdmin(sqlite, 'u1')
      }
    }

    await expect(transferWorkspaceOwner(db, user('u1'), 'u2')).resolves.toEqual(
      {
        kind: 'forbidden',
      },
    )
    expect(readRole(sqlite, 'u1')).toBe('member')
    expect(readRole(sqlite, 'u2')).toBe('admin')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('admin cannot transfer an owner role', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedAdmin(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedMember(sqlite, 'u3')

    const result = await transferWorkspaceOwner(db, user('u2'), 'u3')

    expect(result).toEqual({ kind: 'forbidden' })
    expect(readRole(sqlite, 'u1')).toBe('owner')
    expect(readRole(sqlite, 'u2')).toBe('admin')
    expect(readRole(sqlite, 'u3')).toBe('member')
  })

  test('admin cannot transfer admin role to themselves', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedContributor(sqlite, 'u1')
    seedOwner(sqlite, 'u1')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u1')

    expect(result).toEqual({ kind: 'self-forbidden' })
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('admin mutation bootstraps missing admin before checking authorization', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1', '2026-05-25T00:00:00.000Z')
    seedUser(sqlite, 'u2', '2026-05-26T00:00:00.000Z')
    seedContributor(sqlite, 'u1', '2026-05-25T00:00:00.000Z')
    seedContributor(sqlite, 'u2', '2026-05-26T00:00:00.000Z')

    const result = await transferWorkspaceOwner(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'forbidden' })
  })

  test('non-admin cannot transfer admin role', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedOwner(sqlite, 'u1')

    const result = await transferWorkspaceOwner(db, user('u2'), 'u1')

    expect(result).toEqual({ kind: 'forbidden' })
    expect(readRole(sqlite, 'u1')).toBe('owner')
  })

  test('admin can remove a member', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedSession(sqlite, 'u2', 'sess-1')

    const result = await removeWorkspaceMember(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('removed')
    expect(readUserWorkspaceId(sqlite, 'u2')).not.toBe('ws1')
    expect(readSessionCount(sqlite, 'u2')).toBe(0)

    const newWorkspaceId = readUserWorkspaceId(sqlite, 'u2')
    expect(readOwnerForWorkspace(sqlite, newWorkspaceId)).toBe('u2')

    const audits = readAuditEvents(sqlite, 'ws1')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      action: 'member.remove',
      subject_type: 'user',
      subject_id: 'u2',
      actor_user_id: 'u1',
    })
    expect(JSON.parse(audits[0]!.detail!)).toEqual({
      email: 'u2@example.com',
      name: 'User u2',
    })
  })

  test('member removal revokes CLI families and audits them in the old workspace', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    await issueCliRefreshCredential(db, 'u2')
    await issueCliRefreshCredential(db, 'u2')
    batchHookRef.current = (batchIndex) => {
      if (batchIndex !== 3) return
      sqlite
        .prepare(
          `INSERT INTO cli_refresh_credentials (
             id, user_id, token_hash, expires_at, created_at, family_id
           ) VALUES (?, 'u2', ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
        )
        .run(
          'racing-credential',
          'racing-token-hash',
          '2026-01-01T00:00:00.000Z',
          'racing-family',
        )
    }

    expect(await removeWorkspaceMember(db, user('u1'), 'u2')).toEqual({
      kind: 'ok',
    })

    expect(
      sqlite
        .prepare(
          `SELECT COUNT(DISTINCT family_id) AS count
           FROM cli_refresh_credentials
           WHERE user_id = 'u2' AND revoked_at IS NULL`,
        )
        .get(),
    ).toEqual({ count: 0 })
    const credentialAudits = readAuditEvents(sqlite, 'ws1').filter(
      (event) => event.action === 'cli.refresh_credential.revoke',
    )
    expect(credentialAudits).toHaveLength(3)
    for (const audit of credentialAudits) {
      expect(audit.actor_user_id).toBe('u1')
      expect(JSON.parse(audit.detail!)).toEqual(
        expect.objectContaining({
          reason: 'member_removal',
          target_user_id: 'u2',
        }),
      )
    }
  })

  test('admin cannot remove themselves', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedContributor(sqlite, 'u1')
    seedAdmin(sqlite, 'u1')

    const result = await removeWorkspaceMember(db, user('u1'), 'u1')

    expect(result).toEqual({ kind: 'self-forbidden' })
  })

  test('admin cannot remove the current admin', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedOwner(sqlite, 'u1')

    await transferWorkspaceOwner(db, user('u1'), 'u2')
    const result = await removeWorkspaceMember(db, user('u2'), 'u2')

    expect(result).toEqual({ kind: 'self-forbidden' })
    expect(readRole(sqlite, 'u2')).toBe('owner')
  })

  test('non-admin cannot remove a member', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')

    const result = await removeWorkspaceMember(db, user('u2'), 'u1')

    expect(result).toEqual({ kind: 'forbidden' })
  })

  test('removeWorkspaceMember does not move the target when the actor lost admin during stage 2', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedSession(sqlite, 'u2', 'sess-1')

    const workspaceCountBefore = readWorkspaceCount(sqlite)
    batchHookRef.current = (batchIndex) => {
      if (batchIndex === 0) {
        demoteAdmin(sqlite, 'u1')
      }
    }

    const result = await removeWorkspaceMember(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'not-found' })
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe('ws1')
    expect(readWorkspaceCount(sqlite)).toBe(workspaceCountBefore)
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('active')
    expect(readSessionCount(sqlite, 'u2')).toBe(1)
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('removeWorkspaceMember does not remove a target that becomes owner before its batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedSession(sqlite, 'u2', 'sess-1')
    batchHookRef.current = (batchIndex) => {
      if (batchIndex === 0) {
        seedOwner(sqlite, 'u2')
      }
    }

    await expect(removeWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'not-found',
    })
    expect(readRole(sqlite, 'u2')).toBe('owner')
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('active')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('removeWorkspaceMember converges after stage 2 completes', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedSession(sqlite, 'u2', 'sess-1')

    const newWorkspaceId = 'ws-personal-u2'
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
        storage_updated_at, self_upload_enabled
      ) VALUES (
        '${newWorkspaceId}', NULL, 'u2@example.com''s workspace',
        '2026-05-26T00:00:00.000Z', 'free', 104857600, 0,
        '1970-01-01T00:00:00.000Z', 1
      );
      INSERT INTO workspace_members (
        workspace_id, user_id, role, status, created_at, updated_at
      ) VALUES (
        '${newWorkspaceId}', 'u2', 'owner', 'active',
        '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z'
      );
      UPDATE users
      SET workspace_id = '${newWorkspaceId}'
      WHERE id = 'u2';
    `)
    const workspaceCountBefore = readWorkspaceCount(sqlite)

    const result = await removeWorkspaceMember(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readWorkspaceCount(sqlite)).toBe(workspaceCountBefore)
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(1)
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('removed')
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe(newWorkspaceId)
    expect(readSessionCount(sqlite, 'u2')).toBe(1)
  })

  test('removeWorkspaceMember keeps sessions when target users.workspace_id is elsewhere', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    seedSession(sqlite, 'u2', 'sess-1')

    const otherWorkspaceId = 'ws-other'
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
        storage_updated_at, self_upload_enabled
      ) VALUES (
        '${otherWorkspaceId}', NULL, 'Other workspace',
        '2026-05-26T00:00:00.000Z', 'free', 104857600, 0,
        '1970-01-01T00:00:00.000Z', 1
      );
      UPDATE users
      SET workspace_id = '${otherWorkspaceId}'
      WHERE id = 'u2';
    `)

    const result = await removeWorkspaceMember(db, user('u1'), 'u2')

    expect(result).toEqual({ kind: 'ok' })
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('removed')
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe(otherWorkspaceId)
    expect(readSessionCount(sqlite, 'u2')).toBe(1)
  })

  test('duplicate removeWorkspaceMember calls record one audit event', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedContributor(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')

    await expect(removeWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'ok',
    })
    await expect(removeWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual({
      kind: 'not-found',
    })
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(1)
  })

  test('member page is capped at the page size for large workspaces', async () => {
    seedWorkspace(sqlite, 'team')
    for (let i = 0; i < 1000; i++) {
      seedUser(sqlite, `u${String(i).padStart(4, '0')}`)
    }
    seedOwner(sqlite, 'u0000')

    const page1 = await loadWorkspaceMembersPage(db, 'ws1', 'u0000', filters())
    expect(page1.total).toBe(1000)
    expect(page1.members).toHaveLength(50)

    const page3 = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u0000',
      filters({ page: 3 }),
    )
    expect(page3.members).toHaveLength(50)
    expect(page3.members[0]?.id).not.toBe(page1.members[0]?.id)

    const overflow = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u0000',
      filters({ page: 999 }),
    )
    expect(overflow.members).toHaveLength(50)
  })

  test('member page searches by name and email with literal patterns and Unicode-folded queries', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedUser(sqlite, 'u4')
    sqlite
      .prepare(`UPDATE users SET name = 'Alice Example' WHERE id = 'u1'`)
      .run()
    sqlite.prepare(`UPDATE users SET name = '100% Match' WHERE id = 'u3'`).run()
    sqlite
      .prepare(`UPDATE users SET name = 'älice Example' WHERE id = 'u4'`)
      .run()
    seedOwner(sqlite, 'u1')

    const byName = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ query: 'alice' }),
    )
    expect(byName.members.map((member) => member.id)).toEqual(['u1'])

    const byEmail = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ query: 'u2@example' }),
    )
    expect(byEmail.members.map((member) => member.id)).toEqual(['u2'])

    const escaped = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ query: '100%' }),
    )
    expect(escaped.members.map((member) => member.id)).toEqual(['u3'])
    expect(escaped.total).toBe(1)

    const unicodeFolded = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ query: 'ÄLICE' }),
    )
    expect(unicodeFolded.members.map((member) => member.id)).toEqual(['u4'])
  })

  test('member page filters by role and activity', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedOwner(sqlite, 'u1')
    seedAdmin(sqlite, 'u2')
    seedContributor(sqlite, 'u3')

    const admins = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ role: 'admin' }),
    )
    expect(admins.members.map((member) => member.id)).toEqual(['u2'])

    const active = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ activity: 'active' }),
    )
    expect(active.members.map((member) => member.id)).toEqual(['u3'])

    const inactive = await loadWorkspaceMembersPage(
      db,
      'ws1',
      'u1',
      filters({ activity: 'inactive' }),
    )
    expect(inactive.members.map((member) => member.id).sort()).toEqual([
      'u1',
      'u2',
    ])
  })

  test('recipient search is capped, reports totals, and honors query and exclusion', async () => {
    seedWorkspace(sqlite, 'team')
    for (let i = 0; i < 30; i++) {
      seedUser(sqlite, `u${String(i).padStart(2, '0')}`)
    }
    seedOwner(sqlite, 'u00')

    const all = await searchAssetTransferRecipients(db, 'ws1', { query: '' })
    expect(all.total).toBe(30)
    expect(all.recipients).toHaveLength(20)

    const excluded = await searchAssetTransferRecipients(db, 'ws1', {
      query: 'u05',
      excludeUserIds: ['u05'],
    })
    expect(excluded.recipients).toEqual([])
    expect(excluded.total).toBe(0)

    const multiExcluded = await searchAssetTransferRecipients(db, 'ws1', {
      query: '',
      excludeUserIds: ['u00', 'u01'],
    })
    expect(multiExcluded.total).toBe(28)
    expect(
      multiExcluded.recipients.some(
        (recipient) => recipient.id === 'u00' || recipient.id === 'u01',
      ),
    ).toBe(false)

    const byQuery = await searchAssetTransferRecipients(db, 'ws1', {
      query: 'u07@',
    })
    expect(byQuery.recipients.map((recipient) => recipient.id)).toEqual(['u07'])
  })

  test('contributor count matches members with uploads or pending uploads', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedOwner(sqlite, 'u1')
    seedContributor(sqlite, 'u2')
    sqlite
      .prepare(
        `UPDATE workspace_members SET pending_uploads = 2
         WHERE workspace_id = 'ws1' AND user_id = 'u3'`,
      )
      .run()

    await expect(countWorkspaceContributors(db, 'ws1')).resolves.toBe(2)
  })

  test('removed member readers include owned counts and exclude external recipients', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'ws2')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUserInWorkspace(sqlite, 'u3', 'ws2')
    seedAdmin(sqlite, 'u1')
    seedMember(sqlite, 'u3')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u2', 'inbox', 'u2')
    seedArtifact(sqlite, 'a1', 'u2', 'inbox-u2')

    await expect(loadRemovedWorkspaceMembers(db, 'ws1')).resolves.toEqual([
      expect.objectContaining({ id: 'u2', ownedArtifactCount: 1 }),
    ])
    const { recipients } = await searchAssetTransferRecipients(db, 'ws1', {
      query: '',
    })
    expect(recipients.map((recipient) => recipient.id)).toEqual(['u1'])
  })

  test('transfers inbox and project artifacts, deletes keys, and records the exact count', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u2', 'inbox', 'u2')
    seedContainer(sqlite, 'project-1', 'project', null)
    seedArtifact(sqlite, 'a-inbox', 'u2', 'inbox-u2', 'private')
    seedArtifact(sqlite, 'a-project', 'u2', 'project-1')
    seedArtifactKey(sqlite, 'key-1', 'u2', 'inbox-u2', 'a-inbox')
    seedArtifactAuthorship(sqlite, 'a-inbox', 'u2')
    sqlite
      .prepare(
        `INSERT INTO access_requests
          (id, shareable_id, requester_user_id, handler_user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        'request-1',
        'a-inbox',
        'u3',
        'u2',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      )

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ).resolves.toEqual({ kind: 'ok' })

    const artifacts = sqlite
      .prepare(
        `SELECT id, owner_user_id, container_id, visibility FROM shareables ORDER BY id`,
      )
      .all() as Array<Record<string, string>>
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'a-inbox',
        owner_user_id: 'u1',
        visibility: 'private',
      }),
      expect.objectContaining({
        id: 'a-project',
        owner_user_id: 'u1',
        container_id: 'project-1',
      }),
    ])
    expect(artifacts[0]!.container_id).not.toBe('inbox-u2')
    expect(readCount(sqlite, 'artifact_keys')).toBe(0)
    expect(
      sqlite
        .prepare(
          `SELECT handler_user_id FROM access_requests WHERE id = 'request-1'`,
        )
        .get(),
    ).toEqual({ handler_user_id: 'u1' })
    const audits = readAuditEvents(sqlite, 'ws1').filter(
      (event) => event.action === 'assets.transfer',
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]!.action).toBe('assets.transfer')
    expect(JSON.parse(audits[0]!.detail!).artifact_count).toBe(2)

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ).resolves.toEqual({ kind: 'ok' })
    expect(
      readAuditEvents(sqlite, 'ws1').filter(
        (event) => event.action === 'assets.transfer',
      ),
    ).toHaveLength(1)
    expect(readInboxCount(sqlite, 'ws1', 'u1')).toBe(1)
    expect(readArtifactAuthorship(sqlite)).toEqual(['u2', 'u2', 'u2'])
  })

  test('returns ok without an audit when the removed member owns no artifacts', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ).resolves.toEqual({ kind: 'ok' })
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('transferred private artifacts become viewable by the recipient as owner', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u2', 'inbox', 'u2')
    seedArtifact(sqlite, 'a1', 'u2', 'inbox-u2', 'private')
    const meta = {
      id: 'a1',
      modifiedTime: '2026-07-12T00:00:00.000Z',
      name: 'a1',
      mimeType: 'text/markdown',
      ownerEmail: 'u2@example.com',
    }
    const accessContext = {
      shareableId: 'a1',
      artifactWorkspaceId: 'ws1',
      viewerWorkspaceId: 'ws1',
      viewerEmail: 'u1@example.com',
      viewerEmailVerified: true,
      containerKind: 'inbox' as const,
      containerBaseVisibility: 'workspace' as const,
    }

    await expect(
      viewerDisplayCheck(db, 'private', 'u1', meta, {
        ...accessContext,
        ownerUserId: 'u2',
        containerId: 'inbox-u2',
      }),
    ).resolves.toEqual({ kind: 'access-denied' })

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ).resolves.toEqual({ kind: 'ok' })
    const artifact = sqlite
      .prepare(
        `SELECT owner_user_id, container_id FROM shareables WHERE id = ?`,
      )
      .get('a1') as { owner_user_id: string; container_id: string }

    await expect(
      viewerDisplayCheck(db, 'private', 'u1', meta, {
        ...accessContext,
        ownerUserId: artifact.owner_user_id,
        containerId: artifact.container_id,
      }),
    ).resolves.toEqual({ kind: 'access-granted', meta })
  })

  test("transfers ownership without moving artifacts from another member's inbox", async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u3', 'inbox', 'u3')
    seedArtifact(sqlite, 'a1', 'u2', 'inbox-u3')

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ).resolves.toEqual({ kind: 'ok' })

    expect(readArtifactOwner(sqlite, 'a1')).toBe('u1')
    expect(
      sqlite
        .prepare(`SELECT container_id FROM shareables WHERE id = 'a1'`)
        .get()?.container_id,
    ).toBe('inbox-u3')
    expect(readInboxCount(sqlite, 'ws1', 'u1')).toBe(0)
  })

  test('rejects an active external asset recipient', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'ws2')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedUserInWorkspace(sqlite, 'u3', 'ws2')
    seedAdmin(sqlite, 'u1')
    seedMember(sqlite, 'u3')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u2', 'inbox', 'u2')
    seedArtifact(sqlite, 'a1', 'u2', 'inbox-u2')

    await expect(
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u3'),
    ).resolves.toEqual({ kind: 'not-found' })
    expect(readArtifactOwner(sqlite, 'a1')).toBe('u2')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('parallel asset transfers converge without duplicate audit or inbox rows', async () => {
    seedWorkspace(sqlite, 'team')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    seedContainer(sqlite, 'inbox-u2', 'inbox', 'u2')
    seedArtifact(sqlite, 'a1', 'u2', 'inbox-u2')

    const results = await Promise.all([
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
      transferRemovedMemberAssets(db, user('u1'), 'u2', 'u1'),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual(['ok', 'ok'])
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(1)
    expect(readInboxCount(sqlite, 'ws1', 'u1')).toBe(1)
  })

  test('restores a removed member with one atomic batch and converges on retry', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'personal-u2')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    sqlite
      .prepare(`UPDATE users SET workspace_id = 'personal-u2' WHERE id = 'u2'`)
      .run()

    await expect(restoreWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual(
      { kind: 'ok' },
    )
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe('ws1')
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('active')
    expect(readAuditEvents(sqlite, 'ws1').map((event) => event.action)).toEqual(
      ['member.restore'],
    )
    await expect(restoreWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual(
      { kind: 'ok' },
    )
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(1)
  })

  test('restore leaves no partial update when membership changes to a third workspace before batch', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'personal-u2')
    seedWorkspace(sqlite, 'free', 'third')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    sqlite
      .prepare(`UPDATE users SET workspace_id = 'personal-u2' WHERE id = 'u2'`)
      .run()
    batchHookRef.current = () => {
      sqlite
        .prepare(`UPDATE users SET workspace_id = 'third' WHERE id = 'u2'`)
        .run()
    }

    await expect(restoreWorkspaceMember(db, user('u1'), 'u2')).resolves.toEqual(
      { kind: 'not-found' },
    )
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe('third')
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('removed')
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(0)
  })

  test('parallel restores converge without duplicate audit rows', async () => {
    seedWorkspace(sqlite, 'team')
    seedWorkspace(sqlite, 'free', 'personal-u2')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedAdmin(sqlite, 'u1')
    markRemoved(sqlite, 'u2')
    sqlite
      .prepare(`UPDATE users SET workspace_id = 'personal-u2' WHERE id = 'u2'`)
      .run()

    const results = await Promise.all([
      restoreWorkspaceMember(db, user('u1'), 'u2'),
      restoreWorkspaceMember(db, user('u1'), 'u2'),
    ])

    expect(results.map((result) => result.kind).sort()).toEqual(['ok', 'ok'])
    expect(readAuditEvents(sqlite, 'ws1')).toHaveLength(1)
    expect(readMembershipStatus(sqlite, 'u2', 'ws1')).toBe('active')
    expect(readUserWorkspaceId(sqlite, 'u2')).toBe('ws1')
  })

  test('ensureWorkspaceAdmin skips removed fallback candidates', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1', '2026-05-25T00:00:00.000Z')
    seedUser(sqlite, 'u2', '2026-05-26T00:00:00.000Z')
    seedUser(sqlite, 'u3', '2026-05-27T00:00:00.000Z')
    sqlite.exec(`
      UPDATE workspace_members
      SET role = 'member', status = 'removed', updated_at = '2026-06-28T00:00:00.000Z'
      WHERE workspace_id = 'ws1' AND user_id = 'u1';
      UPDATE workspace_members
      SET role = 'member', status = 'removed',
          updated_at = '2026-06-28T00:00:00.000Z'
      WHERE workspace_id = 'ws1' AND user_id = 'u2';
    `)

    const adminId = await ensureWorkspaceAdmin(
      db,
      'ws1',
      '2026-06-28T00:00:00.000Z',
    )

    expect(adminId).toBe('u3')
    expect(readAdmin(sqlite)).toBe('u3')
  })

  test('ensureWorkspaceAdmin reuses an active owner without changing roles', async () => {
    seedWorkspace(sqlite, 'free')
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    seedOwner(sqlite, 'u1')
    seedMember(sqlite, 'u2')

    const adminId = await ensureWorkspaceAdmin(
      db,
      'ws1',
      '2026-06-28T00:00:00.000Z',
    )

    expect(adminId).toBe('u1')
    expect(readRole(sqlite, 'u1')).toBe('owner')
    expect(readRole(sqlite, 'u2')).toBe('member')
  })
})

function user(id: string) {
  return { id, workspaceId: 'ws1' }
}

function filters(
  overrides: Partial<{
    query: string
    role: 'all' | 'owner' | 'admin' | 'member'
    activity: 'all' | 'active' | 'inactive'
    page: number
  }> = {},
) {
  return {
    query: '',
    role: 'all' as const,
    activity: 'all' as const,
    page: 1,
    ...overrides,
  }
}

function seedWorkspace(db: DatabaseSync, plan: string, workspaceId = 'ws1') {
  db.prepare(
    `INSERT INTO workspaces (
      id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
      storage_updated_at
    ) VALUES (?, ?, 'Example', ?, ?, 53687091200, 1024, ?)`,
  ).run(
    workspaceId,
    workspaceId === 'ws1' ? 'example.com' : null,
    '2026-05-26T00:00:00.000Z',
    plan,
    '2026-05-26T00:00:00.000Z',
  )
}

function seedUser(
  db: DatabaseSync,
  id: string,
  createdAt = '2026-05-26T00:00:00.000Z',
  workspaceId = 'ws1',
) {
  db.prepare(
    `INSERT INTO users (
      id, email, email_verified, name, image, created_at, updated_at,
      workspace_id, locale
    ) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    `${id}@example.com`,
    `User ${id}`,
    createdAt,
    createdAt,
    workspaceId,
  )
  db.prepare(
    `INSERT INTO workspace_members (
      workspace_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)
    ON CONFLICT(workspace_id, user_id) DO NOTHING`,
  ).run(workspaceId, id, createdAt, createdAt)
}

function seedUserInWorkspace(
  db: DatabaseSync,
  id: string,
  workspaceId: string,
) {
  seedUser(db, id, '2026-05-26T00:00:00.000Z', workspaceId)
}

function seedMember(
  db: DatabaseSync,
  userId: string,
  workspaceId = 'ws1',
  contributedAt = '2026-05-26T00:00:00.000Z',
) {
  const existing = db
    .prepare(
      `SELECT 1 FROM workspace_members
       WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(workspaceId, userId)
  if (existing) {
    db.prepare(
      `UPDATE workspace_members
       SET role = 'member', status = 'active', updated_at = ?
       WHERE workspace_id = ? AND user_id = ?`,
    ).run(contributedAt, workspaceId, userId)
    return
  }
  db.prepare(
    `INSERT INTO workspace_members (
      workspace_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, 'member', 'active', ?, ?)`,
  ).run(workspaceId, userId, contributedAt, contributedAt)
}

function seedContributor(
  db: DatabaseSync,
  userId: string,
  contributedAt = '2026-05-26T00:00:00.000Z',
) {
  const existing = db
    .prepare(
      `SELECT 1 FROM workspace_members
       WHERE workspace_id = 'ws1' AND user_id = ?`,
    )
    .get(userId)
  if (existing) {
    db.prepare(
      `UPDATE workspace_members
       SET role = 'member', status = 'active',
           first_contributed_at = ?, last_contributed_at = ?,
           pending_uploads = 0, updated_at = ?
       WHERE workspace_id = 'ws1' AND user_id = ?`,
    ).run(contributedAt, contributedAt, contributedAt, userId)
    return
  }
  db.prepare(
    `INSERT INTO workspace_members (
      workspace_id, user_id, role, status, first_contributed_at,
      last_contributed_at, pending_uploads, created_at, updated_at
    ) VALUES ('ws1', ?, 'member', 'active', ?, ?, 0, ?, ?)`,
  ).run(userId, contributedAt, contributedAt, contributedAt, contributedAt)
}

function demoteAdmin(db: DatabaseSync, userId: string) {
  db.prepare(
    `UPDATE workspace_members
     SET role = 'member'
     WHERE workspace_id = 'ws1' AND user_id = ?`,
  ).run(userId)
}

function seedAdmin(db: DatabaseSync, userId: string) {
  const existing = db
    .prepare(
      `SELECT 1 FROM workspace_members
       WHERE workspace_id = 'ws1' AND user_id = ?`,
    )
    .get(userId)
  if (existing) {
    db.prepare(
      `UPDATE workspace_members
       SET role = 'admin', status = 'active', updated_at = ?
       WHERE workspace_id = 'ws1' AND user_id = ?`,
    ).run('2026-05-26T00:00:00.000Z', userId)
    return
  }
  db.prepare(
    `INSERT INTO workspace_members (
      workspace_id, user_id, role, status, created_at, updated_at
    ) VALUES ('ws1', ?, 'admin', 'active', ?, ?)`,
  ).run(userId, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')
}

function seedOwner(db: DatabaseSync, userId: string) {
  db.prepare(
    `UPDATE workspace_members
     SET role = 'owner', status = 'active', updated_at = ?
     WHERE workspace_id = 'ws1' AND user_id = ?`,
  ).run('2026-05-26T00:00:00.000Z', userId)
}

function readRole(db: DatabaseSync, userId: string) {
  return (
    db
      .prepare(
        `SELECT role FROM workspace_members
         WHERE workspace_id = 'ws1' AND user_id = ?`,
      )
      .get(userId) as { role: string }
  ).role
}

function readAdmin(db: DatabaseSync) {
  return (
    db
      .prepare(
        `SELECT user_id FROM workspace_members
         WHERE workspace_id = ? AND role IN ('owner', 'admin') AND status = 'active'
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END`,
      )
      .get('ws1') as { user_id: string }
  ).user_id
}

function readWorkspaceName(db: DatabaseSync, workspaceId = 'ws1') {
  return (
    db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId) as {
      name: string
    }
  ).name
}

function seedSession(db: DatabaseSync, userId: string, sessionId: string) {
  db.prepare(
    `INSERT INTO sessions (
      id, user_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    `token-${sessionId}`,
    '2026-12-31T00:00:00.000Z',
    '2026-05-26T00:00:00.000Z',
    '2026-05-26T00:00:00.000Z',
  )
}

function readSessionCount(db: DatabaseSync, userId: string) {
  return (
    db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?')
      .get(userId) as { count: number }
  ).count
}

function readUserWorkspaceId(db: DatabaseSync, userId: string) {
  return (
    db.prepare('SELECT workspace_id FROM users WHERE id = ?').get(userId) as {
      workspace_id: string
    }
  ).workspace_id
}

function readMembershipStatus(
  db: DatabaseSync,
  userId: string,
  workspaceId: string,
) {
  return (
    db
      .prepare(
        `SELECT status FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId) as { status: string }
  ).status
}

function readOwnerForWorkspace(db: DatabaseSync, workspaceId: string) {
  return (
    db
      .prepare(
        `SELECT user_id FROM workspace_members
         WHERE workspace_id = ? AND role = 'owner' AND status = 'active'`,
      )
      .get(workspaceId) as { user_id: string }
  ).user_id
}

function readWorkspaceCount(db: DatabaseSync) {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as {
      count: number
    }
  ).count
}

function readAuditEvents(db: DatabaseSync, workspaceId: string) {
  return db
    .prepare(
      `SELECT action, subject_type, subject_id, actor_user_id, detail
       FROM audit_events
       WHERE workspace_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(workspaceId) as Array<{
    action: string
    subject_type: string
    subject_id: string
    actor_user_id: string | null
    detail: string | null
  }>
}

function markRemoved(db: DatabaseSync, userId: string) {
  db.prepare(
    `UPDATE workspace_members SET status = 'removed', removed_at = ?, removed_by = 'u1' WHERE workspace_id = 'ws1' AND user_id = ?`,
  ).run('2026-07-12T00:00:00.000Z', userId)
}

function seedContainer(
  db: DatabaseSync,
  id: string,
  kind: 'inbox' | 'project',
  ownerUserId: string | null,
) {
  db.prepare(
    `INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at) VALUES (?, 'ws1', ?, ?, 'u1', ?, ?, ?)`,
  ).run(
    id,
    kind,
    ownerUserId,
    id,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
  )
}

function seedArtifact(
  db: DatabaseSync,
  id: string,
  ownerUserId: string,
  containerId: string,
  visibility = 'workspace',
) {
  db.prepare(
    `INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES (?, 'ws1', ?, ?, 'markdown_page', ?, ?, ?, ?)`,
  ).run(
    id,
    ownerUserId,
    id,
    visibility,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
    containerId,
  )
}

function seedVersion(
  db: DatabaseSync,
  id: string,
  shareableId: string,
  sizeBytes: number,
  status: string,
) {
  db.prepare(
    `INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at) VALUES (?, ?, 'markdown_page', ?, '/note.md', ?, ?, 'sha', 'u1', '2026-07-12T00:00:00.000Z')`,
  ).run(id, shareableId, status, `r2-${id}`, sizeBytes)
}

function seedArtifactKey(
  db: DatabaseSync,
  id: string,
  ownerUserId: string,
  containerId: string,
  shareableId: string,
) {
  db.prepare(
    `INSERT INTO artifact_keys (id, workspace_id, owner_user_id, container_id, stable_key, shareable_id, created_at, updated_at) VALUES (?, 'ws1', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ownerUserId,
    containerId,
    id,
    shareableId,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
  )
}

function readCount(db: DatabaseSync, table: string) {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
  ).count
}

function readInboxCount(
  db: DatabaseSync,
  workspaceId: string,
  ownerUserId: string,
) {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_containers WHERE workspace_id = ? AND owner_user_id = ? AND kind = 'inbox'`,
      )
      .get(workspaceId, ownerUserId) as { count: number }
  ).count
}

function readArtifactOwner(db: DatabaseSync, artifactId: string) {
  return (
    db
      .prepare(`SELECT owner_user_id FROM shareables WHERE id = ?`)
      .get(artifactId) as { owner_user_id: string }
  ).owner_user_id
}

function seedArtifactAuthorship(
  db: DatabaseSync,
  shareableId: string,
  creatorUserId: string,
) {
  const now = '2026-07-12T00:00:00.000Z'
  db.prepare(
    `INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at) VALUES ('v1', ?, 'markdown_page', 'published', '/note.md', 'r2-key', 1, 'sha', ?, ?)`,
  ).run(shareableId, creatorUserId, now)
  db.prepare(
    `INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at) VALUES ('t1', ?, 'open', ?, ?, ?)`,
  ).run(shareableId, creatorUserId, now, now)
  db.prepare(
    `INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('m1', 't1', 'body', ?, ?, ?)`,
  ).run(creatorUserId, now, now)
}

function readArtifactAuthorship(db: DatabaseSync) {
  const version = db
    .prepare(`SELECT created_by_id FROM versions WHERE id = 'v1'`)
    .get() as { created_by_id: string }
  const thread = db
    .prepare(`SELECT created_by_id FROM comment_threads WHERE id = 't1'`)
    .get() as { created_by_id: string }
  const message = db
    .prepare(`SELECT created_by_id FROM comment_messages WHERE id = 'm1'`)
    .get() as { created_by_id: string }
  return [version.created_by_id, thread.created_by_id, message.created_by_id]
}

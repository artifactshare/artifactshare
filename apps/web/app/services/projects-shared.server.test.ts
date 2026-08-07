import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  findSharedProjectForViewer,
  listSharedProjects,
} from './projects.server'

const TS = '2026-05-22T00:00:00.000Z'

// 別組織 (ws-a) のプロジェクトに、自分 (ws-b の viewer) が関係者として
// 入っているときの、組織をまたいだ閲覧専用の解決を検証する。
describe('shared projects across workspaces', () => {
  let db: Kysely<DB>
  const viewer = {
    email: 'viewer@b-org.example',
    emailVerified: true,
    workspaceId: 'ws-b',
  }

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('lists projects shared from another workspace as an audience member', async () => {
    const shared = await listSharedProjects(db, viewer)
    expect(shared.map((p) => p.id)).toEqual(['p-shared'])
    expect(shared[0].sourceWorkspaceName).toBe('A Org')
  })

  test('counts only project-visibility and individually granted files', async () => {
    const shared = await listSharedProjects(db, viewer)
    // s-proj (project) と s-priv-granted (個別共有) の 2 件だけ。
    // s-ws (workspace、別組織の社内向け) と s-priv (個別共有なし) は数えない。
    expect(shared[0].fileCount).toBe(2)
  })

  test('excludes unrelated, archived, and own-workspace projects', async () => {
    const shared = await listSharedProjects(db, viewer)
    const ids = shared.map((p) => p.id)
    expect(ids).not.toContain('p-unrelated') // 関係者でない
    expect(ids).not.toContain('p-archived') // アーカイブ済み
    expect(ids).not.toContain('p-own') // 自分のワークスペース (二重表示しない)
  })

  test('findSharedProjectForViewer resolves a project for an audience member', async () => {
    const resolved = await findSharedProjectForViewer(db, 'p-shared', viewer)
    expect(resolved?.id).toBe('p-shared')
    expect(resolved?.fileCount).toBe(2)
  })

  test('findSharedProjectForViewer returns null for a non-member', async () => {
    await expect(
      findSharedProjectForViewer(db, 'p-shared', {
        email: 'stranger@b-org.example',
        emailVerified: true,
      }),
    ).resolves.toBeNull()
  })

  test('findSharedProjectForViewer does not resolve unrelated or archived projects', async () => {
    await expect(
      findSharedProjectForViewer(db, 'p-unrelated', viewer),
    ).resolves.toBeNull()
    await expect(
      findSharedProjectForViewer(db, 'p-archived', viewer),
    ).resolves.toBeNull()
  })
})

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      workspace('ws-a', 'A Org', 'a-org.example'),
      workspace('ws-b', 'B Org', 'b-org.example'),
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      user('u-owner', 'owner@a-org.example', 'ws-a'),
      user('u-viewer', 'viewer@b-org.example', 'ws-b'),
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values([
      project('p-shared', 'ws-a'),
      project('p-unrelated', 'ws-a'),
      { ...project('p-archived', 'ws-a'), archived_at: TS },
      project('p-own', 'ws-b'),
    ])
    .execute()
  await db
    .insertInto('project_share_defaults')
    .values([
      audience('d1', 'p-shared', 'viewer@b-org.example'),
      audience('d2', 'p-archived', 'viewer@b-org.example'),
      audience('d3', 'p-own', 'viewer@b-org.example'),
    ])
    .execute()
  await db
    .insertInto('shareables')
    .values([
      shareable('s-proj', 'p-shared', 'project'),
      shareable('s-ws', 'p-shared', 'workspace'),
      shareable('s-priv-granted', 'p-shared', 'private'),
      shareable('s-priv', 'p-shared', 'private'),
    ])
    .execute()
  await db
    .insertInto('shareable_grants')
    .values({
      shareable_id: 's-priv-granted',
      granted_email: 'viewer@b-org.example',
      granted_at: TS,
      granted_by: 'u-owner',
    })
    .execute()
}

function workspace(id: string, name: string, hd: string) {
  return {
    id,
    hd,
    name,
    created_at: TS,
    plan: 'free' as const,
    storage_quota_bytes: 104857600,
    storage_used_bytes: 0,
    storage_updated_at: TS,
  }
}

function user(id: string, email: string, workspaceId: string) {
  return {
    id,
    email,
    email_verified: 1,
    name: id,
    image: null,
    created_at: TS,
    updated_at: TS,
    workspace_id: workspaceId,
    locale: null,
  }
}

function project(id: string, workspaceId: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'project' as const,
    owner_user_id: null,
    created_by_id: 'u-owner',
    name: id,
    description: null,
    base_visibility: 'private' as const,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function audience(id: string, projectId: string, email: string) {
  return {
    id,
    project_container_id: projectId,
    email,
    role: 'viewer' as const,
    display_name: null,
    created_by_id: 'u-owner',
    created_at: TS,
    updated_at: TS,
  }
}

function shareable(
  id: string,
  containerId: string,
  visibility: 'private' | 'workspace' | 'project',
) {
  return {
    id,
    workspace_id: 'ws-a',
    owner_user_id: 'u-owner',
    slug: null,
    name: id,
    derived_title: null,
    title_override: null,
    description: null,
    artifact_kind: 'html_page' as const,
    visibility,
    current_version_id: null,
    container_id: containerId,
    created_at: TS,
    updated_at: TS,
    last_accessed_at: null,
  }
}

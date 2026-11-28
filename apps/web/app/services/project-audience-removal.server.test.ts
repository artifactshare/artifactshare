import { vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

import type { Kysely } from 'kysely'
import { describe, expect, test } from 'vitest'
import { facts } from '~/modules/access'
import type { SessionUser } from '~/lib/user'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { viewerAccessAllowed } from './access.server'
import { listFeedEvents } from './events.server'
import { listRecentArtifactsLimited } from './home.server'
import { joinProject } from './project-membership.server'
import { searchPalette } from './search-palette.server'
import { recordViewerRecency } from './views.server'

// A guest from another workspace joins a project through its audience, then
// the host removes them from the audience. The project_members row stays, but
// every list must follow the same rule as opening the artifact. Recents keeps
// the guest's own history by design, so there the artifact turns restricted.

const T = '2026-07-01T10:00:00.000Z'
const ADDED_AT = '2026-07-02T10:00:00.000Z'
const NOW = '2026-07-03T00:00:00.000Z'
const guest = {
  id: 'guest',
  workspaceId: 'w-guest',
  email: 'guest@partner.example',
  emailVerified: true,
} as SessionUser

async function seed() {
  const { db } = createMigratedInMemoryDb()
  for (const id of ['w-guest', 'w-host'])
    await db
      .insertInto('workspaces')
      .values({
        id,
        name: id,
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: T,
      })
      .execute()
  for (const [id, email, workspaceId] of [
    ['guest', guest.email, 'w-guest'],
    ['host', 'host@host.example', 'w-host'],
  ] as const)
    await db
      .insertInto('users')
      .values({
        id,
        email,
        name: id,
        email_verified: 1,
        image: null,
        created_at: T,
        updated_at: T,
        workspace_id: workspaceId,
        locale: null,
      })
      .execute()
  await db
    .insertInto('workspace_members')
    .values([
      {
        workspace_id: 'w-guest',
        user_id: 'guest',
        role: 'member',
        status: 'active',
        created_at: T,
        updated_at: T,
      },
      {
        workspace_id: 'w-host',
        user_id: 'host',
        role: 'owner',
        status: 'active',
        created_at: T,
        updated_at: T,
      },
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'p',
      workspace_id: 'w-host',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'host',
      name: 'Host project',
      base_visibility: 'private',
      created_at: T,
      updated_at: T,
    })
    .execute()
  await db
    .insertInto('project_share_defaults')
    .values({
      id: 'audience',
      project_container_id: 'p',
      email: guest.email,
      created_by_id: 'host',
      created_at: T,
      updated_at: T,
    })
    .execute()
  for (const [id, name, visibility] of [
    ['memo', 'Board memo', 'project'],
    ['plan', 'Board plan', 'project'],
    ['brief', 'Board brief', 'private'],
  ] as const) {
    await db
      .insertInto('shareables')
      .values({
        id,
        workspace_id: 'w-host',
        owner_user_id: 'host',
        name,
        artifact_kind: 'markdown_page',
        visibility,
        container_id: 'p',
        created_at: T,
        updated_at: T,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: `${id}-v1`,
        shareable_id: id,
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: '/index.md',
        r2_key: `${id}-key`,
        size_bytes: 1,
        sha256: 'x',
        created_by_id: 'host',
        created_at: T,
        published_at: T,
      })
      .execute()
    await db
      .insertInto('events')
      .values({
        id: `${id}-created`,
        workspace_id: 'w-host',
        type: 'artifact_created',
        shareable_id: id,
        actor_user_id: 'host',
        subject_id: `${id}-v1`,
        created_at: ADDED_AT,
      })
      .execute()
  }
  await db
    .insertInto('comment_threads')
    .values({
      id: 'memo-thread',
      shareable_id: 'memo',
      status: 'open',
      created_by_id: 'host',
      created_at: ADDED_AT,
      updated_at: ADDED_AT,
      message_count: 1,
    })
    .execute()
  await db
    .insertInto('comment_messages')
    .values({
      id: 'memo-comment',
      thread_id: 'memo-thread',
      body: 'Numbers for the board',
      created_by_id: 'host',
      created_at: ADDED_AT,
      updated_at: ADDED_AT,
    })
    .execute()
  await db
    .insertInto('events')
    .values({
      id: 'memo-commented',
      workspace_id: 'w-host',
      type: 'comment_posted',
      shareable_id: 'memo',
      actor_user_id: 'host',
      subject_id: 'memo-comment',
      created_at: ADDED_AT,
    })
    .execute()
  // The brief stays shared with the guest directly, so it must stay listed.
  await db
    .insertInto('shareable_grants')
    .values({
      shareable_id: 'brief',
      granted_email: guest.email,
      granted_by: 'host',
      granted_at: T,
    })
    .execute()
  return db
}

async function canOpen(db: Kysely<DB>, shareableId: string) {
  const loaded = await facts(db, {
    shareableId,
    viewerUserId: guest.id,
    now: NOW,
  })
  return Boolean(loaded && viewerAccessAllowed(loaded))
}

async function lists(db: Kysely<DB>) {
  const feed = await listFeedEvents(db, {
    user: guest,
    timeZone: 'UTC',
    slice: 'mine',
    targetRows: 20,
    maxRawEvents: 100,
  })
  const recent = await listRecentArtifactsLimited(db, guest, 10)
  const palette = await searchPalette(db, guest, 'Board', NOW)
  return {
    feed: feed.rows.map((row) => ({
      type: row.type,
      shareableId: row.shareableId,
      addCount: row.addCount,
      commentBody: row.commentBody,
    })),
    recent: recent.map((row) => [row.id, Boolean(row.visible)] as const).sort(),
    palette: palette.recent.map((row) => row.id).sort(),
  }
}

describe('a guest removed from a project audience', () => {
  test('no longer sees the project artifacts in the activity feed, search palette, or as openable recents', async () => {
    const db = await seed()
    expect(await joinProject(db, { containerId: 'p', user: guest })).toBe(
      'joined',
    )
    for (const id of ['memo', 'plan', 'brief'])
      await recordViewerRecency(db, id, guest.id, { now: ADDED_AT })

    const before = await lists(db)
    expect(
      before.feed.map((row) => [row.type, row.addCount, row.commentBody]),
    ).toEqual([
      ['artifact_created', 3, null],
      ['comment_posted', null, 'Numbers for the board'],
    ])
    expect(before.recent).toEqual([
      ['brief', true],
      ['memo', true],
      ['plan', true],
    ])
    expect(before.palette).toEqual(['brief', 'memo', 'plan'])

    await db
      .deleteFrom('project_share_defaults')
      .where('id', '=', 'audience')
      .execute()

    expect(await canOpen(db, 'memo')).toBe(false)
    expect(await canOpen(db, 'plan')).toBe(false)
    expect(await canOpen(db, 'brief')).toBe(true)
    expect(await lists(db)).toEqual({
      feed: [
        {
          type: 'artifact_created',
          shareableId: 'brief',
          addCount: null,
          commentBody: null,
        },
      ],
      recent: [
        ['brief', true],
        ['memo', false],
        ['plan', false],
      ],
      palette: ['brief'],
    })
  })

  test('still sees activity on an artifact they own in the project', async () => {
    const db = await seed()
    expect(await joinProject(db, { containerId: 'p', user: guest })).toBe(
      'joined',
    )
    await db
      .insertInto('shareables')
      .values({
        id: 'post',
        workspace_id: 'w-host',
        owner_user_id: 'guest',
        name: 'Guest post',
        artifact_kind: 'markdown_page',
        visibility: 'project',
        container_id: 'p',
        created_at: T,
        updated_at: T,
      })
      .execute()
    await db
      .insertInto('comment_threads')
      .values({
        id: 'thread',
        shareable_id: 'post',
        status: 'open',
        created_by_id: 'host',
        created_at: ADDED_AT,
        updated_at: ADDED_AT,
        message_count: 1,
      })
      .execute()
    await db
      .insertInto('comment_messages')
      .values({
        id: 'reply',
        thread_id: 'thread',
        body: 'Looks good',
        created_by_id: 'host',
        created_at: ADDED_AT,
        updated_at: ADDED_AT,
      })
      .execute()
    await db
      .insertInto('events')
      .values({
        id: 'reply-posted',
        workspace_id: 'w-host',
        type: 'comment_posted',
        shareable_id: 'post',
        actor_user_id: 'host',
        subject_id: 'reply',
        created_at: ADDED_AT,
      })
      .execute()
    await db
      .deleteFrom('project_share_defaults')
      .where('id', '=', 'audience')
      .execute()

    expect(await canOpen(db, 'post')).toBe(true)
    const feed = await listFeedEvents(db, {
      user: guest,
      timeZone: 'UTC',
      slice: 'mine',
      targetRows: 20,
      maxRawEvents: 100,
    })
    expect(
      feed.rows
        .filter((row) => row.shareableId === 'post')
        .map((row) => row.type),
    ).toEqual(['comment_posted'])
  })
})

import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { bindTrustedBridgeRequest } from './bridge-conversation-binding.server'
import type { TrustedBridgeContext } from './bridge-request-validation.server'
import { deleteProjectContainer } from './projects.server'

const bucketState = vi.hoisted(() => new Map<string, Uint8Array>())
const notifyVersionChanged = vi.hoisted(() => vi.fn())
const bucket = vi.hoisted(() => ({
  put: vi.fn(async (key: string, body: ArrayBuffer | Uint8Array | Blob) => {
    const buffer =
      body instanceof Blob
        ? await body.arrayBuffer()
        : body instanceof ArrayBuffer
          ? body
          : new Uint8Array(body).buffer
    bucketState.set(key, new Uint8Array(buffer))
  }),
  get: vi.fn(async (key: string) => {
    const bytes = bucketState.get(key)
    if (!bytes) return null
    const blob = new Blob([new Uint8Array(bytes)])
    return {
      body: blob.stream(),
      text: () => blob.text(),
      size: bytes.byteLength,
      uploaded: new Date(),
    }
  }),
  delete: vi.fn(async (key: string) => {
    bucketState.delete(key)
  }),
  list: vi.fn(async () => ({ objects: [], truncated: false })),
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: bucket,
    ARTIFACT_LIVE: {
      getByName: () => ({ notifyVersionChanged }),
    },
  },
}))

const authority = {
  kind: 'bridge' as const,
  familyId: 'family-1',
  bridgeAuthorityId: 'bridge-1',
  workspaceId: 'ws1',
  fallbackProjectId: 'fallback-1',
  agentProfileId: 'agent-1',
  sourceKind: 'qm',
  sourceInstallationId: 'install-1',
  externalWorkspaceId: 'slack-ws-1',
}

let sqlite: DatabaseSync
let db: Kysely<DB>

function context(
  overrides: Partial<TrustedBridgeContext> = {},
): TrustedBridgeContext {
  return {
    requestId: 'request-1',
    source: {
      kind: 'qm',
      installationId: 'install-1',
      externalWorkspaceId: 'slack-ws-1',
    },
    conversation: {
      currentId: 'channel-1',
      ids: ['channel-1'],
      kind: 'public_channel',
      name: 'design',
      privacyCheckedAt: '2026-08-26T00:00:00.000Z',
    },
    requester: {
      stableId: 'person-1',
      verifiedEmail: 'person@example.com',
      displayName: 'Person',
    },
    ...overrides,
  }
}

function seedProject(id: string, name: string, visibility = 'workspace') {
  sqlite
    .prepare(
      `INSERT INTO artifact_containers (
        id, workspace_id, kind, created_by_id, name, base_visibility,
        created_at, updated_at
      ) VALUES (?, 'ws1', 'project', 'bot1', ?, ?,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, name, visibility)
}

function seedMapping(
  id: string,
  projectId: string,
  conversationId: string,
  visibility: 'workspace' | 'private' = 'workspace',
) {
  sqlite
    .prepare(
      `INSERT INTO bridge_conversations (
        id, bridge_authority_id, project_id, conversation_kind,
        privacy_ceiling, privacy_epoch, created_at, updated_at
      ) VALUES (?, 'bridge-1', ?, 'public_channel', ?, ?,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, projectId, visibility, visibility === 'private' ? 1 : 0)
  sqlite
    .prepare(
      `INSERT INTO bridge_conversation_ids (
        mapping_id, bridge_authority_id, external_conversation_id, created_at
      ) VALUES (?, 'bridge-1', ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, conversationId)
}

beforeEach(() => {
  bucketState.clear()
  notifyVersionChanged.mockReset()
  const fixture = createMigratedInMemoryDb()
  sqlite = fixture.sqlite
  db = fixture.db
  seedWorkspace(sqlite)
  seedUser(sqlite, 'admin')
  sqlite
    .prepare(
      `INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at,
        workspace_id, kind
      ) VALUES ('bot1', 'bot@bots.artifactshare.invalid', 1, 'Bridge bot',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        'ws1', 'bot')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, role, status, created_at, updated_at
      ) VALUES ('ws1', 'bot1', 'member', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  seedProject('fallback-1', 'Fallback')
  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
       VALUES ('agent-1', 'bot1', 'ws1', '2026-01-01T00:00:00.000Z')`,
    )
    .run()
  sqlite
    .prepare(
      `INSERT INTO bridge_authorities (
        id, workspace_id, bot_user_id, agent_profile_id, source_kind,
        source_installation_id, external_workspace_id, fallback_project_id,
        created_at, updated_at
      ) VALUES ('bridge-1', 'ws1', 'bot1', 'agent-1', 'qm', 'install-1',
        'slack-ws-1', 'fallback-1', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z')`,
    )
    .run()
})

afterEach(async () => {
  await db.destroy()
})

describe('trusted bridge conversation binding', () => {
  test('resolves an existing mapping and records only the request binding', async () => {
    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')

    const result = await bindTrustedBridgeRequest(db, authority, context())

    expect(result).toMatchObject({
      kind: 'ok',
      binding: {
        mapping: { id: 'mapping-1', projectId: 'project-1' },
        mappingCreated: false,
        projectCreated: false,
      },
    })
    expect(
      sqlite
        .prepare(
          `SELECT status, mapping_id FROM bridge_requests
           WHERE bridge_authority_id = 'bridge-1' AND request_id = 'request-1'`,
        )
        .get(),
    ).toEqual({ status: 'binding', mapping_id: 'mapping-1' })
  })

  test('creates a private project and mapping before later intent processing', async () => {
    const privateContext = context({
      conversation: {
        ...context().conversation,
        kind: 'private_channel',
        privacyCheckedAt: null,
      },
    })

    const result = await bindTrustedBridgeRequest(db, authority, privateContext)

    expect(result).toMatchObject({
      kind: 'ok',
      binding: {
        mapping: { privacyCeiling: 'private' },
        mappingCreated: true,
        projectCreated: true,
      },
    })
    const project = sqlite
      .prepare(
        `SELECT base_visibility FROM artifact_containers
         WHERE id = (SELECT project_id FROM bridge_conversations
           WHERE bridge_authority_id = 'bridge-1')`,
      )
      .get()
    expect(project).toEqual({ base_visibility: 'private' })
  })

  test('adopts a mapping created after the request was first bound', async () => {
    const first = await bindTrustedBridgeRequest(db, authority, context())
    expect(first).toMatchObject({ kind: 'ok', binding: { mapping: null } })

    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')
    const retried = await bindTrustedBridgeRequest(db, authority, context())

    expect(retried).toMatchObject({
      kind: 'ok',
      binding: { mapping: { id: 'mapping-1', projectId: 'project-1' } },
    })
    expect(
      sqlite
        .prepare(
          `SELECT mapping_id FROM bridge_requests
           WHERE bridge_authority_id = 'bridge-1' AND request_id = 'request-1'`,
        )
        .get(),
    ).toEqual({ mapping_id: 'mapping-1' })
  })

  test('allows an empty mapped project to be deleted after request binding', async () => {
    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')
    await bindTrustedBridgeRequest(db, authority, context())

    await expect(
      deleteProjectContainer(db, 'ws1', 'project-1', 'bot1'),
    ).resolves.toBe('ok')
    expect(
      sqlite
        .prepare(
          `SELECT mapping_id FROM bridge_requests
           WHERE bridge_authority_id = 'bridge-1' AND request_id = 'request-1'`,
        )
        .get(),
    ).toEqual({ mapping_id: null })
  })

  test('narrows an existing mapping and its artifacts before requester mismatch', async () => {
    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')
    sqlite
      .prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          created_at, updated_at, container_id
        ) VALUES ('artifact-1', 'ws1', 'bot1', 'Draft', 'markdown_page',
          'workspace', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', 'project-1')`,
      )
      .run()
    await bindTrustedBridgeRequest(db, authority, context())

    const changedRequester = context({
      conversation: {
        ...context().conversation,
        kind: 'private_channel',
        privacyCheckedAt: null,
      },
      requester: {
        stableId: 'person-2',
        verifiedEmail: 'other@example.com',
        displayName: 'Other',
      },
    })
    const result = await bindTrustedBridgeRequest(
      db,
      authority,
      changedRequester,
    )

    expect(result).toEqual({ kind: 'requester-mismatch' })
    expect(
      sqlite
        .prepare(
          `SELECT privacy_ceiling FROM bridge_conversations
           WHERE id = 'mapping-1'`,
        )
        .get(),
    ).toEqual({ privacy_ceiling: 'private' })
    expect(
      sqlite
        .prepare(`SELECT visibility FROM shareables WHERE id = 'artifact-1'`)
        .get(),
    ).toEqual({ visibility: 'private' })
  })

  test('rejects aliases that resolve to different mappings', async () => {
    seedProject('project-1', 'One')
    seedProject('project-2', 'Two')
    seedMapping('mapping-1', 'project-1', 'channel-old')
    seedMapping('mapping-2', 'project-2', 'channel-1')

    const result = await bindTrustedBridgeRequest(
      db,
      authority,
      context({
        conversation: {
          ...context().conversation,
          ids: ['channel-old', 'channel-1'],
        },
      }),
    )

    expect(result).toEqual({ kind: 'conversation-identity-conflict' })
  })

  test('isolates the same conversation id in different source namespaces', async () => {
    sqlite
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at,
          workspace_id, kind
        ) VALUES ('bot2', 'bot2@bots.artifactshare.invalid', 1, 'Second bot',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          'ws1', 'bot')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES ('ws1', 'bot2', 'member', 'active',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
         VALUES ('agent-2', 'bot2', 'ws1', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO bridge_authorities (
          id, workspace_id, bot_user_id, agent_profile_id, source_kind,
          source_installation_id, external_workspace_id, fallback_project_id,
          created_at, updated_at
        ) VALUES ('bridge-2', 'ws1', 'bot2', 'agent-2', 'cloudflare-os',
          'install-2', 'cf-ws-1', 'fallback-1',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const privateConversation = {
      ...context().conversation,
      kind: 'private_channel' as const,
      privacyCheckedAt: null,
    }
    const first = await bindTrustedBridgeRequest(
      db,
      authority,
      context({ conversation: privateConversation }),
    )
    const secondAuthority = {
      ...authority,
      bridgeAuthorityId: 'bridge-2',
      sourceKind: 'cloudflare-os',
      sourceInstallationId: 'install-2',
      externalWorkspaceId: 'cf-ws-1',
    }
    const second = await bindTrustedBridgeRequest(
      db,
      secondAuthority,
      context({
        requestId: 'request-2',
        source: {
          kind: 'cloudflare-os',
          installationId: 'install-2',
          externalWorkspaceId: 'cf-ws-1',
        },
        conversation: privateConversation,
      }),
    )

    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS count FROM bridge_conversations`)
        .get(),
    ).toEqual({ count: 2 })
  })
})

describe('bridge file publishing', () => {
  test('publishes once and replays the same completed request', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const body = new TextEncoder().encode('# Hello')
    const sha256 = await sha256Hex(body)
    const value = {
      schema_version: 1,
      request_id: 'request-publish',
      operation: 'publish',
      requested_audience: 'private',
      title: 'Reviewed title',
      source: {
        kind: 'qm',
        installation_id: 'install-1',
        external_workspace_id: 'slack-ws-1',
      },
      conversation: {
        current_id: 'channel-1',
        ids: ['channel-1'],
        kind: 'private_channel',
        name: 'design',
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
        display_name: 'Person',
      },
      content: {
        kind: 'file',
        files: [
          {
            index: 0,
            path: 'note.md',
            media_type: 'text/markdown',
            size: body.byteLength,
            sha256,
          },
        ],
      },
    }
    const file = new File([body], 'file-0', { type: 'text/markdown' })
    const user = {
      id: 'bot1',
      email: 'bot@bots.artifactshare.invalid',
      emailVerified: true,
      workspaceId: 'ws1',
      hd: 'example.com',
    }
    const { executeBridgeRequest } = await import('./bridge-publishing.server')

    const first = await executeBridgeRequest(
      db,
      authority,
      user,
      value,
      [file],
      'https://artifactshare.com',
      new Date('2026-08-26T00:00:30.000Z'),
    )
    expect(first).toMatchObject({
      kind: 'ok',
      result: {
        artifact: { title: 'Reviewed title' },
        project: { id: 'project-1' },
        visibility: 'private',
        replayed: false,
      },
    })
    const second = await executeBridgeRequest(
      db,
      authority,
      user,
      value,
      [file],
      'https://artifactshare.com',
      new Date('2026-08-26T00:00:31.000Z'),
    )
    expect(second).toMatchObject({
      kind: 'ok',
      result: { replayed: true },
    })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM shareables`).get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM bridge_conversation_ids
           WHERE bridge_authority_id = 'bridge-1'`,
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM bridge_operations`).get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT granted_email FROM shareable_grants
           WHERE granted_email = 'person@example.com'`,
        )
        .get(),
    ).toEqual({ granted_email: 'person@example.com' })
    if (first.kind !== 'ok') return
    sqlite
      .prepare(`DELETE FROM shareables WHERE id = ?`)
      .run(first.result.artifact.id)
    expect(
      sqlite
        .prepare(
          `SELECT result_artifact_id FROM bridge_requests
           WHERE bridge_authority_id = 'bridge-1' AND request_id = 'request-publish'`,
        )
        .get(),
    ).toEqual({ result_artifact_id: first.result.artifact.id })
  })

  test('creates a public conversation project only with the staged publish commit', async () => {
    const body = new TextEncoder().encode('# Public')
    const sha256 = await sha256Hex(body)
    const checkedAt = new Date().toISOString()
    const value = {
      schema_version: 1,
      request_id: 'request-public',
      operation: 'publish',
      requested_audience: 'workspace',
      source: {
        kind: 'qm',
        installation_id: 'install-1',
        external_workspace_id: 'slack-ws-1',
      },
      conversation: {
        current_id: 'channel-public',
        ids: ['channel-public'],
        kind: 'public_channel',
        name: 'announcements',
        privacy_checked_at: checkedAt,
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
      },
      content: {
        kind: 'file',
        files: [
          {
            index: 0,
            path: 'note.md',
            media_type: 'text/markdown',
            size: body.byteLength,
            sha256,
          },
        ],
      },
    }
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const result = await executeBridgeRequest(
      db,
      authority,
      {
        id: 'bot1',
        email: 'bot@bots.artifactshare.invalid',
        emailVerified: true,
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      value,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
      new Date(checkedAt),
    )

    expect(result).toMatchObject({
      kind: 'ok',
      result: {
        visibility: 'workspace',
        mappingCreated: true,
        projectCreated: true,
      },
    })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM bridge_conversations
           WHERE bridge_authority_id = 'bridge-1'`,
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM artifact_containers
           WHERE kind = 'project'`,
        )
        .get(),
    ).toEqual({ count: 2 })

    if (result.kind !== 'ok') return
    sqlite
      .prepare(
        `UPDATE bridge_conversations
         SET privacy_ceiling = 'private', privacy_epoch = 1
         WHERE bridge_authority_id = 'bridge-1'`,
      )
      .run()
    sqlite
      .prepare(
        `UPDATE artifact_containers SET base_visibility = 'private'
         WHERE id = ?`,
      )
      .run(result.result.project.id)
    sqlite
      .prepare(`UPDATE shareables SET visibility = 'private' WHERE id = ?`)
      .run(result.result.artifact.id)
    const replayed = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      value,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
      new Date(checkedAt),
    )
    expect(replayed).toMatchObject({
      kind: 'ok',
      result: { visibility: 'private', replayed: true },
    })

    const renamed = structuredClone(value)
    renamed.request_id = 'request-public-renamed'
    renamed.conversation.current_id = 'channel-public-new'
    renamed.conversation.ids = ['channel-public', 'channel-public-new']
    renamed.conversation.name = 'company announcements'
    renamed.conversation.privacy_checked_at = new Date().toISOString()
    const repeated = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      renamed,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
      new Date(renamed.conversation.privacy_checked_at),
    )
    expect(repeated).toMatchObject({
      kind: 'ok',
      result: {
        project: { id: result.result.project.id },
        mappingCreated: false,
        projectCreated: false,
      },
    })
  })

  test('bounds a filename fallback title to the bridge response contract', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const body = new TextEncoder().encode('\n')
    const fileName = `${'a'.repeat(217)}.md`
    const { executeBridgeRequest } = await import('./bridge-publishing.server')

    const result = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'long-fallback-title',
        body,
        conversationKind: 'private_channel',
        path: fileName,
        mediaType: 'text/markdown',
      }),
      [new File([body], fileName, { type: 'text/markdown' })],
      'https://artifactshare.com',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.result.artifact.title).toHaveLength(200)
  })

  test('converges concurrent first shares on one project and mapping', async () => {
    const body = new TextEncoder().encode('# Concurrent')
    const checkedAt = new Date().toISOString()
    const base = {
      schema_version: 1,
      operation: 'publish' as const,
      requested_audience: 'workspace' as const,
      source: {
        kind: 'qm',
        installation_id: 'install-1',
        external_workspace_id: 'slack-ws-1',
      },
      conversation: {
        current_id: 'channel-concurrent',
        ids: ['channel-concurrent'],
        kind: 'public_channel' as const,
        name: 'concurrent',
        privacy_checked_at: checkedAt,
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
      },
      content: {
        kind: 'file' as const,
        files: [
          {
            index: 0,
            path: 'note.md',
            media_type: 'text/markdown',
            size: body.byteLength,
            sha256: await sha256Hex(body),
          },
        ],
      },
    }
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const results = await Promise.all(
      ['concurrent-1', 'concurrent-2'].map((requestId) =>
        executeBridgeRequest(
          db,
          authority,
          bridgeUser(),
          { ...base, request_id: requestId },
          [new File([body], 'file-0', { type: 'text/markdown' })],
          'https://artifactshare.com',
          new Date(checkedAt),
        ),
      ),
    )

    expect(results.every((result) => result.kind === 'ok')).toBe(true)
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM bridge_conversations
           WHERE bridge_authority_id = 'bridge-1'`,
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM artifact_containers
           WHERE kind = 'project'`,
        )
        .get(),
    ).toEqual({ count: 2 })
  })

  test('cleans its staged file when another lease generation completes first', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    sqlite
      .prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          current_version_id, created_at, updated_at, container_id
        ) VALUES ('winner', 'ws1', 'bot1', 'Winner', 'markdown_page',
          'private', 'winner-v1', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', 'project-1')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO versions (
          id, shareable_id, artifact_kind, status, entrypoint_path, r2_key,
          size_bytes, sha256, created_by_id, created_at, published_at
        ) VALUES ('winner-v1', 'winner', 'markdown_page', 'published',
          '/note.md', 'winner-key', 1, ?, 'bot1',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run('0'.repeat(64))
    sqlite
      .prepare(
        `INSERT INTO shareable_grants (
          shareable_id, granted_email, granted_at, granted_by
        ) VALUES ('winner', 'person@example.com',
          '2026-01-01T00:00:00.000Z', 'bot1')`,
      )
      .run()
    bucket.put.mockImplementationOnce(async (key, body) => {
      bucketState.set(key, new Uint8Array(body as ArrayBuffer))
      sqlite
        .prepare(
          `UPDATE bridge_requests
           SET status = 'completed', result_artifact_id = 'winner',
             result_version_id = 'winner-v1'
           WHERE bridge_authority_id = 'bridge-1'
             AND request_id = 'lease-loser'`,
        )
        .run()
    })
    const body = new TextEncoder().encode('# Losing generation')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')

    const result = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'lease-loser',
        body,
        conversationKind: 'private_channel',
      }),
      [new File([body], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )

    expect(result).toMatchObject({
      kind: 'ok',
      result: { artifact: { id: 'winner' }, replayed: true },
    })
    expect(bucketState.size).toBe(0)
    expect(
      sqlite
        .prepare(`SELECT storage_used_bytes FROM workspaces WHERE id = 'ws1'`)
        .get(),
    ).toEqual({ storage_used_bytes: 1024 })
  })

  test('updates a bridge-created artifact without changing its URL', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const user = bridgeUser()
    const firstBody = new TextEncoder().encode('# First')
    const first = await executeBridgeRequest(
      db,
      authority,
      user,
      await fileMetadata({
        requestId: 'publish-first',
        body: firstBody,
        conversationKind: 'private_channel',
      }),
      [new File([firstBody], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return

    const nextBody = new TextEncoder().encode('# Second')
    const updated = await executeBridgeRequest(
      db,
      authority,
      user,
      await fileMetadata({
        requestId: 'update-second',
        operation: 'update',
        targetArtifactId: first.result.artifact.id,
        body: nextBody,
        conversationKind: 'private_channel',
      }),
      [new File([nextBody], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(updated).toMatchObject({
      kind: 'ok',
      result: { artifact: { id: first.result.artifact.id }, replayed: false },
    })
    expect(notifyVersionChanged).toHaveBeenLastCalledWith(
      updated.kind === 'ok' ? updated.result.versionId : 'unreachable',
    )
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM versions WHERE shareable_id = ?`,
        )
        .get(first.result.artifact.id),
    ).toEqual({ count: 2 })
  })

  test('keeps the committed version intact when the requester grant limit is reached', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const firstBody = new TextEncoder().encode('# First')
    const first = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'grant-limit-base',
        body: firstBody,
        conversationKind: 'private_channel',
      }),
      [new File([firstBody], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    const originalVersionId = first.result.versionId
    const insertGrant = sqlite.prepare(
      `INSERT INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'bot1')`,
    )
    for (let index = 0; index < 49; index += 1) {
      insertGrant.run(first.result.artifact.id, `viewer-${index}@example.com`)
    }
    const nextBody = new TextEncoder().encode('# Second')
    const updated = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'grant-limit-update',
        operation: 'update',
        targetArtifactId: first.result.artifact.id,
        body: nextBody,
        conversationKind: 'private_channel',
        requesterStableId: 'person-2',
        requesterEmail: 'person-2@example.com',
      }),
      [new File([nextBody], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )

    expect(updated).toEqual({ kind: 'artifact-viewer-limit-reached' })
    expect(
      sqlite
        .prepare(`SELECT current_version_id FROM shareables WHERE id = ?`)
        .get(first.result.artifact.id),
    ).toEqual({ current_version_id: originalVersionId })
    expect(bucketState.size).toBe(1)
  })

  test('recognizes a legacy mixed-case requester grant at the viewer limit', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const firstBody = new TextEncoder().encode('# First')
    const first = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'mixed-case-base',
        body: firstBody,
        conversationKind: 'private_channel',
      }),
      [new File([firstBody], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    sqlite
      .prepare(
        `UPDATE shareable_grants SET granted_email = 'Person@Example.com'
         WHERE shareable_id = ? AND granted_email = 'person@example.com'`,
      )
      .run(first.result.artifact.id)
    const insertGrant = sqlite.prepare(
      `INSERT INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'bot1')`,
    )
    for (let index = 0; index < 49; index += 1) {
      insertGrant.run(first.result.artifact.id, `viewer-${index}@example.com`)
    }
    const nextBody = new TextEncoder().encode('# Second')
    const updated = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'mixed-case-update',
        operation: 'update',
        targetArtifactId: first.result.artifact.id,
        body: nextBody,
        conversationKind: 'private_channel',
      }),
      [new File([nextBody], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )

    expect(updated.kind).toBe('ok')
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM shareable_grants
           WHERE shareable_id = ? AND lower(granted_email) = 'person@example.com'`,
        )
        .get(first.result.artifact.id),
    ).toEqual({ count: 1 })
  })

  test('appends after multibyte HTML content without corrupting UTF-8', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const firstBody = new TextEncoder().encode(
      '<html><body><p>日本語</p></body></html>',
    )
    const published = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'append-base',
        body: firstBody,
        conversationKind: 'private_channel',
        path: 'index.html',
        mediaType: 'text/html',
      }),
      [new File([firstBody], 'index.html', { type: 'text/html' })],
      'https://artifactshare.com',
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    const addition = new TextEncoder().encode('<p>追記</p>')
    const appended = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'append-next',
        operation: 'append',
        targetArtifactId: published.result.artifact.id,
        body: addition,
        conversationKind: 'private_channel',
        path: 'append.html',
        mediaType: 'text/html',
      }),
      [new File([addition], 'append.html', { type: 'text/html' })],
      'https://artifactshare.com',
    )
    expect(appended).toMatchObject({
      kind: 'ok',
      result: { artifact: { id: published.result.artifact.id } },
    })
    const current = sqlite
      .prepare(
        `SELECT versions.r2_key
         FROM shareables JOIN versions ON versions.id = shareables.current_version_id
         WHERE shareables.id = ?`,
      )
      .get(published.result.artifact.id) as { r2_key: string }
    expect(new TextDecoder().decode(bucketState.get(current.r2_key))).toBe(
      '<html><body><p>日本語</p><p>追記</p></body></html>',
    )
  })

  test('promotes a requester-owned DM draft on the same URL', async () => {
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const user = bridgeUser()
    const body = new TextEncoder().encode('# DM draft')
    const published = await executeBridgeRequest(
      db,
      authority,
      user,
      await fileMetadata({
        requestId: 'dm-publish',
        body,
        conversationKind: 'dm',
        conversationId: 'dm-1',
      }),
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(published).toMatchObject({
      kind: 'ok',
      result: { visibility: 'private', project: { id: 'fallback-1' } },
    })
    if (published.kind !== 'ok') return
    const visibilityMetadata = {
      schema_version: 1,
      request_id: 'dm-promote',
      operation: 'set_visibility',
      requested_audience: 'workspace',
      target_artifact_id: published.result.artifact.id,
      source: {
        kind: 'qm',
        installation_id: 'install-1',
        external_workspace_id: 'slack-ws-1',
      },
      conversation: {
        current_id: 'dm-1',
        ids: ['dm-1'],
        kind: 'dm',
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
      },
    }
    const promoted = await executeBridgeRequest(
      db,
      authority,
      user,
      visibilityMetadata,
      [],
      'https://artifactshare.com',
    )
    expect(promoted).toMatchObject({
      kind: 'ok',
      result: {
        artifact: { id: published.result.artifact.id },
        visibility: 'workspace',
        versionId: null,
      },
    })
  })

  test('does not complete a private visibility change without requester access', async () => {
    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const body = new TextEncoder().encode('# Workspace artifact')
    const published = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      await fileMetadata({
        requestId: 'visibility-cap-base',
        body,
        requestedAudience: 'workspace',
        conversationKind: 'public_channel',
      }),
      [new File([body], 'note.md', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(published.kind).toBe('ok')
    if (published.kind !== 'ok') return
    const insertGrant = sqlite.prepare(
      `INSERT INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'bot1')`,
    )
    for (let index = 0; index < 50; index += 1) {
      insertGrant.run(
        published.result.artifact.id,
        `viewer-${index}@example.com`,
      )
    }
    const changed = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      {
        schema_version: 1,
        request_id: 'visibility-cap-private',
        operation: 'set_visibility',
        requested_audience: 'private',
        target_artifact_id: published.result.artifact.id,
        source: {
          kind: 'qm',
          installation_id: 'install-1',
          external_workspace_id: 'slack-ws-1',
        },
        conversation: {
          current_id: 'channel-1',
          ids: ['channel-1'],
          kind: 'public_channel',
          name: 'design',
          privacy_checked_at: new Date().toISOString(),
        },
        requester: {
          stable_id: 'person-2',
          verified_email: 'person-2@example.com',
        },
      },
      [],
      'https://artifactshare.com',
    )

    expect(changed).toEqual({ kind: 'artifact-viewer-limit-reached' })
    expect(
      sqlite
        .prepare(`SELECT visibility FROM shareables WHERE id = ?`)
        .get(published.result.artifact.id),
    ).toEqual({ visibility: 'project' })
    expect(
      sqlite
        .prepare(
          `SELECT status FROM bridge_requests
           WHERE bridge_authority_id = 'bridge-1'
             AND request_id = 'visibility-cap-private'`,
        )
        .get(),
    ).toEqual({ status: 'binding' })
  })

  test('publishes a static-site bundle with one immutable bridge operation', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    const html = new TextEncoder().encode('<title>Site</title><h1>Hello</h1>')
    const bundle = [
      { path: 'index.html', mediaType: 'text/html', body: html },
      ...Array.from({ length: 11 }, (_, index) => ({
        path: `styles-${index}.css`,
        mediaType: 'text/css',
        body: new TextEncoder().encode(`.item-${index} { color: red }`),
      })),
    ]
    const metadata = {
      schema_version: 1,
      request_id: 'static-publish',
      operation: 'publish',
      requested_audience: 'private',
      source: {
        kind: 'qm',
        installation_id: 'install-1',
        external_workspace_id: 'slack-ws-1',
      },
      conversation: {
        current_id: 'channel-1',
        ids: ['channel-1'],
        kind: 'private_channel',
      },
      requester: {
        stable_id: 'person-1',
        verified_email: 'person@example.com',
      },
      content: {
        kind: 'static_site',
        files: await Promise.all(
          bundle.map(async (file, index) => ({
            index,
            path: file.path,
            media_type: file.mediaType,
            size: file.body.byteLength,
            sha256: await sha256Hex(file.body),
          })),
        ),
      },
    }
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const result = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      metadata,
      bundle.map(
        (file) => new File([file.body], file.path, { type: file.mediaType }),
      ),
      'https://artifactshare.com',
    )

    expect(result).toMatchObject({
      kind: 'ok',
      result: { artifact: { title: 'Site' }, visibility: 'private' },
    })
    expect(
      sqlite.prepare(`SELECT artifact_kind FROM shareables`).get(),
    ).toEqual({ artifact_kind: 'static_site' })
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM version_files`).get(),
    ).toEqual({ count: 12 })
  })

  test('uses the narrowed mapping at final commit instead of stale public context', async () => {
    seedProject('project-1', 'Design')
    seedMapping('mapping-1', 'project-1', 'channel-1')
    const body = new TextEncoder().encode('# Race')
    const checkedAt = new Date().toISOString()
    bucket.put.mockImplementationOnce(async () => {
      sqlite
        .prepare(
          `UPDATE bridge_conversations
           SET privacy_ceiling = 'private', privacy_epoch = 1
           WHERE id = 'mapping-1'`,
        )
        .run()
      sqlite
        .prepare(
          `UPDATE artifact_containers SET base_visibility = 'private'
           WHERE id = 'project-1'`,
        )
        .run()
    })
    const privateMetadata = await fileMetadata({
      requestId: 'privacy-race',
      body,
      conversationKind: 'private_channel',
    })
    const metadata = {
      ...privateMetadata,
      requested_audience: 'workspace' as const,
      conversation: {
        ...privateMetadata.conversation,
        kind: 'public_channel' as const,
        privacy_checked_at: checkedAt,
      },
    }
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const result = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      metadata,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
      new Date(checkedAt),
    )
    expect(result).toMatchObject({
      kind: 'ok',
      result: { visibility: 'private' },
    })
  })

  test('denies a manually created artifact and releases the failed lease', async () => {
    seedProject('project-1', 'Private design', 'private')
    seedMapping('mapping-1', 'project-1', 'channel-1', 'private')
    sqlite
      .prepare(
        `INSERT INTO shareables (
          id, workspace_id, owner_user_id, name, artifact_kind, visibility,
          current_version_id, created_at, updated_at, container_id,
          created_by_agent_profile_id
        ) VALUES ('manual-1', 'ws1', 'bot1', 'Manual', 'markdown_page',
          'private', 'manual-v1', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z', 'project-1', 'agent-1')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO versions (
          id, shareable_id, artifact_kind, status, entrypoint_path, r2_key,
          size_bytes, sha256, created_by_id, created_at, published_at
        ) VALUES ('manual-v1', 'manual-1', 'markdown_page', 'published',
          '/note.md', 'manual/key', 1, 'sha', 'bot1',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const body = new TextEncoder().encode('# Changed')
    const metadata = await fileMetadata({
      requestId: 'manual-update',
      operation: 'update',
      targetArtifactId: 'manual-1',
      body,
      conversationKind: 'private_channel',
    })
    const { executeBridgeRequest } = await import('./bridge-publishing.server')
    const first = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      metadata,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    const second = await executeBridgeRequest(
      db,
      authority,
      bridgeUser(),
      metadata,
      [new File([body], 'file-0', { type: 'text/markdown' })],
      'https://artifactshare.com',
    )
    expect(first).toEqual({ kind: 'forbidden-target' })
    expect(second).toEqual({ kind: 'forbidden-target' })
    expect(
      sqlite
        .prepare(
          `SELECT status, stable_digest FROM bridge_requests
           WHERE request_id = 'manual-update'`,
        )
        .get(),
    ).toEqual({ status: 'binding', stable_digest: null })
  })
})

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes).buffer,
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function bridgeUser() {
  return {
    id: 'bot1',
    email: 'bot@bots.artifactshare.invalid',
    emailVerified: true,
    workspaceId: 'ws1',
    hd: 'example.com',
  }
}

async function fileMetadata(input: {
  requestId: string
  body: Uint8Array
  operation?: 'publish' | 'update' | 'append'
  targetArtifactId?: string
  conversationKind: 'public_channel' | 'private_channel' | 'dm'
  requestedAudience?: 'workspace' | 'private'
  conversationId?: string
  path?: string
  mediaType?: string
  requesterStableId?: string
  requesterEmail?: string
}) {
  const conversationId = input.conversationId ?? 'channel-1'
  return {
    schema_version: 1,
    request_id: input.requestId,
    operation: input.operation ?? 'publish',
    requested_audience: input.requestedAudience ?? 'private',
    ...(input.targetArtifactId
      ? { target_artifact_id: input.targetArtifactId }
      : {}),
    source: {
      kind: 'qm',
      installation_id: 'install-1',
      external_workspace_id: 'slack-ws-1',
    },
    conversation: {
      current_id: conversationId,
      ids: [conversationId],
      kind: input.conversationKind,
      ...(input.conversationKind === 'public_channel'
        ? { privacy_checked_at: new Date().toISOString() }
        : {}),
    },
    requester: {
      stable_id: input.requesterStableId ?? 'person-1',
      verified_email: input.requesterEmail ?? 'person@example.com',
    },
    content: {
      kind: 'file',
      files: [
        {
          index: 0,
          path: input.path ?? 'note.md',
          media_type: input.mediaType ?? 'text/markdown',
          size: input.body.byteLength,
          sha256: await sha256Hex(input.body),
        },
      ],
    },
  }
}

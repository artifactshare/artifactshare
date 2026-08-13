import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock } from '~/test/d1-batch-mock'
import {
  loadStaticSiteFixture,
  loadStaticSiteFixtureFiles,
} from '~/test/static-site-fixtures'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'

const storageMock = vi.hoisted(() => ({
  putArtifact: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  deleteArtifactsByPrefix: vi.fn(),
  headArtifact: vi.fn(),
  artifactR2Key: vi.fn(
    (args: { shareableId: string; versionId: string; renderType: string }) =>
      `artifacts/${args.shareableId}/${args.versionId}/index.${args.renderType}`,
  ),
  artifactContentType: vi.fn((rt: string) =>
    rt === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
  ),
}))

// alphabet をキーに queue を分ける。同一モジュール内に複数の customAlphabet
// generator が共存しても、それぞれ独立して seed できる。
const nanoidMock = vi.hoisted(() => ({
  queues: new Map<string, string[]>(),
  push(alphabet: string, ...ids: string[]) {
    const queue = this.queues.get(alphabet) ?? []
    queue.push(...ids)
    this.queues.set(alphabet, queue)
  },
  reset() {
    this.queues.clear()
  },
}))

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  failNextBatch: false,
  beforeNextBatch: null as
    | ((stmts: Array<{ sql: string; params: unknown[] }>) => Promise<void>)
    | null,
}))
const artifactLiveMock = vi.hoisted(() => ({
  notifyVersionChanged: vi.fn(),
  getByName: vi.fn(),
}))

artifactLiveMock.getByName.mockImplementation(() => ({
  notifyVersionChanged: artifactLiveMock.notifyVersionChanged,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    BUCKET: {},
    ARTIFACT_LIVE: artifactLiveMock,
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
  },
}))

vi.mock('./storage.server', () => storageMock)
vi.mock('nanoid', async () => {
  const actual = await vi.importActual<typeof import('nanoid')>('nanoid')
  return {
    ...actual,
    customAlphabet: vi.fn((alphabet: string, size: number) => {
      const generateActual = actual.customAlphabet(alphabet, size)
      return () => {
        const queue = nanoidMock.queues.get(alphabet)
        return queue?.shift() ?? generateActual()
      }
    }),
  }
})

import { listCliArtifacts } from './cli-artifacts.server'
import {
  appendShareable,
  beginStaticSiteBundleVersionUploadSession,
  beginStaticSiteBundleUploadSession,
  commitDialogChanges,
  createVersion,
  deleteShareable,
  generateUniqueShareableId,
  getOwnedArtifactRef,
  getOwnedShareableSummary,
  listGrants,
  lookupGrantUsers,
  updateShareableMetadata,
  uploadShareable,
} from './shareables.server'
import {
  normalizeArtifactKey,
  resolveArtifactKey,
} from './artifact-keys.server'
import { loadCommentAccess } from './comments.server'
import { createApiToken, findUserByApiToken } from './api-tokens.server'
import { resolveUploadContainer } from './projects.server'
import { removeWorkspaceMember } from './team-management.server'

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  emailVerified: true,
  workspaceId: 'ws-a',
  hd: 'example.com',
} as const

async function seed(db: Kysely<DB>, opts: { storageUsedBytes?: number } = {}) {
  await db
    .insertInto('workspaces')
    .values({
      id: 'ws-a',
      hd: 'example.com',
      name: 'Owner workspace',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: opts.storageUsedBytes ?? 0,
      storage_updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'owner-1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
}

async function seedUser(db: Kysely<DB>, id: string) {
  await db
    .insertInto('users')
    .values({
      id,
      email: `${id}@example.com`,
      email_verified: 1,
      name: id,
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
}

async function seedProjectContainer(db: Kysely<DB>) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'project-a',
      workspace_id: 'ws-a',
      kind: 'project',
      owner_user_id: null,
      created_by_id: OWNER.id,
      name: 'Project A',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
}

async function seedSlackChannel(db: Kysely<DB>, containerId: string) {
  await db
    .insertInto('slack_workspaces')
    .values({
      id: 'slack-workspace-a',
      team_id: 'slack-team-a',
      team_name: 'Slack workspace A',
      bot_user_id: 'bot-a',
      bot_token: 'token-a',
      installed_by_user_id: OWNER.id,
      installed_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
    })
    .execute()
  await db
    .insertInto('container_slack_channels')
    .values({
      container_id: containerId,
      webhook_url: 'https://hooks.slack.com/services/T0/B0/secret',
      channel_id: 'channel-a',
      channel_name: 'project-a',
      slack_team_id: 'T0',
      slack_team_name: 'Team A',
      configuration_url: null,
      created_by: OWNER.id,
      updated_by: OWNER.id,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedInboxContainer(db: Kysely<DB>, id = 'owner-inbox') {
  const existing = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('workspace_id', '=', 'ws-a')
    .where('kind', '=', 'inbox')
    .where('owner_user_id', '=', OWNER.id)
    .executeTakeFirst()
  if (existing) return existing.id

  await db
    .insertInto('artifact_containers')
    .values({
      id,
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: OWNER.id,
      created_by_id: OWNER.id,
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
  return id
}

async function seedProjectShareDefault(
  db: Kysely<DB>,
  id: string,
  email: string,
) {
  await seedProjectContainer(db)
  await db
    .insertInto('project_share_defaults')
    .values({
      id,
      project_container_id: 'project-a',
      email,
      role: 'viewer',
      display_name: null,
      created_by_id: OWNER.id,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

// A separate workspace that owns a project the OWNER is invited into as an
// external contributor. Cross-workspace posting must bill THIS workspace.
const EXT_WS = 'ws-ext'
const EXT_PROJECT = 'project-ext'

async function seedExternalProject(
  db: Kysely<DB>,
  opts: {
    posterEmail?: string
    role?: 'viewer' | 'contributor' | 'manager'
    storageQuotaBytes?: number
    storageUsedBytes?: number
    plan?: 'free' | 'plus' | 'team'
    externalPostingEnabled?: boolean
    stripeSubscriptionStatus?: string
  } = {},
) {
  await db
    .insertInto('workspaces')
    .values({
      id: EXT_WS,
      hd: 'client.example',
      name: 'External workspace',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: opts.plan ?? 'plus',
      external_posting_enabled:
        opts.externalPostingEnabled === undefined
          ? opts.plan === 'free'
            ? 0
            : 1
          : opts.externalPostingEnabled
            ? 1
            : 0,
      stripe_subscription_status: opts.stripeSubscriptionStatus ?? 'none',
      storage_quota_bytes: opts.storageQuotaBytes ?? 104857600,
      storage_used_bytes: opts.storageUsedBytes ?? 0,
      storage_updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'ext-admin-1',
      email: 'admin@client.example',
      email_verified: 1,
      name: 'Ext Admin',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: EXT_WS,
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: EXT_PROJECT,
      workspace_id: EXT_WS,
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'ext-admin-1',
      name: 'External Project',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('project_share_defaults')
    .values({
      id: 'psd-ext-1',
      project_container_id: EXT_PROJECT,
      email: opts.posterEmail ?? OWNER.email,
      role: opts.role ?? 'contributor',
      display_name: null,
      created_by_id: 'ext-admin-1',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedExternalContributorFiller(db: Kysely<DB>, userId: string) {
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: `${userId}@client.example`,
      email_verified: 1,
      name: userId,
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: EXT_WS,
      locale: null,
    })
    .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: EXT_WS,
      user_id: userId,
      role: 'member',
      status: 'active',
      first_contributed_at: '2026-05-22T00:00:00.000Z',
      last_contributed_at: '2026-05-22T00:00:00.000Z',
      pending_uploads: 0,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedContributor(db: Kysely<DB>, userId: string) {
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: 'ws-a',
      user_id: userId,
      role: 'member',
      status: 'active',
      first_contributed_at: '2026-05-22T00:00:00.000Z',
      last_contributed_at: '2026-05-22T00:00:00.000Z',
      pending_uploads: 0,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedProjectShareableWithVersions(
  db: Kysely<DB>,
  args: {
    shareableId: string
    ownerUserId: string
    visibility: 'private' | 'project' | 'workspace'
    name?: string
    sizeBytes?: number
    storageUsedBytes?: number
  },
) {
  const sizeBytes = args.sizeBytes ?? 1200
  await db
    .updateTable('workspaces')
    .set({
      storage_used_bytes: args.storageUsedBytes ?? sizeBytes,
      storage_updated_at: '2026-05-22T00:00:00.000Z',
    })
    .where('id', '=', EXT_WS)
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: args.shareableId,
      workspace_id: EXT_WS,
      owner_user_id: args.ownerUserId,
      slug: null,
      name: args.name ?? 'poster.html',
      derived_title: 'Poster doc',
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: args.visibility,
      current_version_id: `${args.shareableId}-v1`,
      view_count: 0,
      container_id: EXT_PROJECT,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
  await db
    .insertInto('versions')
    .values({
      id: `${args.shareableId}-v1`,
      shareable_id: args.shareableId,
      artifact_kind: 'html_page',
      status: 'published',
      entrypoint_path: '/poster.html',
      r2_key: `${EXT_WS}/${args.shareableId}/v1/poster.html`,
      size_bytes: sizeBytes,
      sha256: 'sha-poster',
      created_by_id: args.ownerUserId,
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

async function seedShareableWithVersions(
  db: Kysely<DB>,
  args: {
    shareableId: string
    artifactKind?: 'html_page' | 'markdown_page' | 'static_site'
    name?: string
    derivedTitle?: string | null
    versions: Array<{ id: string; r2Key: string; sizeBytes: number }>
  },
) {
  const containerId = await seedInboxContainer(db)
  await db
    .insertInto('shareables')
    .values({
      id: args.shareableId,
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: args.name ?? 'doc.html',
      derived_title: args.derivedTitle ?? 'Doc',
      title_override: null,
      description: null,
      artifact_kind: args.artifactKind ?? 'html_page',
      visibility: 'private',
      current_version_id: args.versions[0]?.id ?? null,
      view_count: 0,
      container_id: containerId,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()

  for (const v of args.versions) {
    await db
      .insertInto('versions')
      .values({
        id: v.id,
        shareable_id: args.shareableId,
        artifact_kind: args.artifactKind ?? 'html_page',
        status: 'published',
        entrypoint_path: '/doc.html',
        r2_key: v.r2Key,
        size_bytes: v.sizeBytes,
        sha256: 'sha-fake',
        created_by_id: 'owner-1',
        created_at: '2026-05-22T00:00:00.000Z',
        published_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
  }
}

function numberedEmails(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `person-${index + 1}@example.com`,
  )
}

async function insertGrants(
  db: Kysely<DB>,
  shareableId: string,
  emails: ReadonlyArray<string>,
) {
  await db
    .insertInto('shareable_grants')
    .values(
      emails.map((email) => ({
        shareable_id: shareableId,
        granted_email: email,
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: OWNER.id,
      })),
    )
    .execute()
}

function htmlFile(name: string, body: string): File {
  return new File([body], name, { type: 'text/html' })
}

function siteFile(path: string, size: number, type = 'text/plain'): File {
  return new File([new Uint8Array(size)], path, { type })
}

function siteTextFile(path: string, body: string, type = 'text/plain'): File {
  return new File([body], path, { type })
}

function fakeSiteFile(path: string, size: number, type = 'text/plain'): File {
  return {
    name: path,
    size,
    type,
    arrayBuffer: vi.fn(async () => {
      throw new Error('arrayBuffer should not be called')
    }),
  } as unknown as File
}

async function withMutedConsoleWarn<T>(fn: () => Promise<T>): Promise<T> {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    return await fn()
  } finally {
    warnSpy.mockRestore()
  }
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const MB = 1024 * 1024

describe('uploadShareable', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    artifactLiveMock.getByName.mockClear()
    artifactLiveMock.notifyVersionChanged.mockClear()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('returns quota-exceeded and short-circuits before file.arrayBuffer / putArtifact when over quota', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 104857600 - 10 })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const file = htmlFile('big.html', '<p>'.repeat(100))
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer')

    const result = await uploadShareable(db, OWNER, file, 'private')

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('uses the workspace team quota instead of the free user quota', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'team',
        storage_quota_bytes: 53687091200,
        storage_used_bytes: 104857600 - 10,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('team.html', '<p>'.repeat(100)),
      'private',
    )

    expect(result.kind).toBe('ok')
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
  })

  test('allows team workspaces with active subscriptions to exceed quota', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'team',
        stripe_subscription_status: 'active',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 104857600 - 10,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('team-overage.html', '<p>'.repeat(100)),
      'private',
    )

    expect(result.kind).toBe('ok')
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirst()
    expect(workspaceRow?.storage_used_bytes).toBeGreaterThan(104857600)
  })

  test('allows plus workspaces with active subscriptions to exceed quota', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'plus',
        stripe_subscription_status: 'active',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 104857600 - 10,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('plus-overage.html', '<p>'.repeat(100)),
      'private',
    )

    expect(result.kind).toBe('ok')
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
  })

  test('rejects plus workspaces without active subscriptions at quota', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'plus',
        stripe_subscription_status: 'none',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 104857600 - 10,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('inactive-plus-full.html', '<p>'.repeat(100)),
      'private',
    )

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('rejects team workspaces without active subscription at storage quota', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'team',
        stripe_subscription_status: 'none',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 104857600 - 10,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('team-no-sub.html', '<p>'.repeat(100)),
      'private',
    )

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('rejects the fourth contributor at an injected guardrail before writing to R2', async () => {
    for (const id of ['u2', 'u3', 'u4']) {
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'u5')

    const result = await uploadShareable(
      db,
      { id: 'u5', emailVerified: true, workspaceId: 'ws-a', hd: 'example.com' },
      htmlFile('fourth.html', '<p>blocked</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )

    expect(result).toEqual({ kind: 'contributor-limit-exceeded' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('bots bypass the contributor guardrail and never enter the denominator', async () => {
    for (const id of ['u2', 'u3', 'u4']) {
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await db
      .insertInto('users')
      .values({
        id: 'bot1',
        email: 'bot-abc@bots.artifactshare.invalid',
        email_verified: 1,
        name: 'Bot',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        kind: 'bot',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'bot1',
        role: 'member',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    // The guardrail limit is already saturated by three humans; the bot's
    // upload still succeeds and neither reserves nor finalizes a slot.
    const result = await uploadShareable(
      db,
      {
        id: 'bot1',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('bot.html', '<p>bot upload</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(result.kind).toBe('ok')

    const botMember = await db
      .selectFrom('workspace_members')
      .select(['first_contributed_at', 'pending_uploads'])
      .where('user_id', '=', 'bot1')
      .executeTakeFirstOrThrow()
    expect(botMember.first_contributed_at).toBeNull()
    expect(botMember.pending_uploads).toBe(0)

    // A manually seeded bot contributor row is still excluded from the
    // denominator: a fourth human keeps hitting the guardrail.
    await db
      .updateTable('workspace_members')
      .set({ first_contributed_at: '2026-05-22T00:00:00.000Z' })
      .where('user_id', '=', 'bot1')
      .execute()
    await seedUser(db, 'u5')
    const human = await uploadShareable(
      db,
      { id: 'u5', emailVerified: true, workspaceId: 'ws-a', hd: 'example.com' },
      htmlFile('human.html', '<p>blocked</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(human).toEqual({ kind: 'contributor-limit-exceeded' })
  })

  test('a stopped bot is rejected before any R2 write', async () => {
    await db
      .insertInto('users')
      .values({
        id: 'bot1',
        email: 'bot-abc@bots.artifactshare.invalid',
        email_verified: 1,
        name: 'Bot',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        kind: 'bot',
        bot_stopped_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'bot1',
        role: 'member',
        status: 'removed',
        removed_at: '2026-06-01T00:00:00.000Z',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      })
      .execute()

    const result = await uploadShareable(
      db,
      {
        id: 'bot1',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('stopped-bot.html', '<p>rejected</p>'),
      'private',
    )
    expect(result).toEqual({ kind: 'workspace-access-revoked' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('allows the fourth free contributor with the production guardrail default', async () => {
    for (const id of ['u2', 'u3', 'u4']) {
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'u5')

    const result = await uploadShareable(
      db,
      { id: 'u5', emailVerified: true, workspaceId: 'ws-a', hd: 'example.com' },
      htmlFile('fourth-default.html', '<p>ok</p>'),
      'private',
    )

    expect(result.kind).toBe('ok')
  })

  test('allows the 101st non-free contributor with the production guardrail default', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    for (let index = 1; index <= 100; index++) {
      const id = `u-filler-${index}`
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'u-101')

    const result = await uploadShareable(
      db,
      {
        id: 'u-101',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('one-hundred-first-default.html', '<p>ok</p>'),
      'private',
    )

    expect(result.kind).toBe('ok')
  })

  test('rejects removed members as workspace-access-revoked instead of contributor-limit-exceeded', async () => {
    await seedUser(db, 'u-removed')
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'u-removed',
        role: 'member',
        status: 'removed',
        removed_at: '2026-06-26T00:00:00.000Z',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    const result = await uploadShareable(
      db,
      {
        id: 'u-removed',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('removed.html', '<p>blocked</p>'),
      'private',
    )

    expect(result).toEqual({ kind: 'workspace-access-revoked' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('returns workspace-access-revoked when removal races the contributor insert', async () => {
    await seedUser(db, 'u-raced')
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'u-raced',
        role: 'member',
        status: 'active',
        removed_at: null,
        removed_by: null,
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()
    const executor = db.getExecutor()
    const executeQuery = executor.executeQuery.bind(executor)
    let raced = false
    vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
      if (
        !raced &&
        query.sql.toLowerCase().includes('insert into') &&
        query.sql.toLowerCase().includes('workspace_members')
      ) {
        raced = true
        sqliteRef.current
          ?.prepare(
            "UPDATE workspace_members SET status = 'removed', removed_at = '2026-06-27T00:00:00.000Z', updated_at = '2026-06-27T00:00:00.000Z' WHERE workspace_id = 'ws-a' AND user_id = 'u-raced'",
          )
          .run()
      }
      return executeQuery(query)
    })

    const result = await uploadShareable(
      db,
      {
        id: 'u-raced',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('raced-removal.html', '<p>blocked</p>'),
      'private',
    )

    expect(raced).toBe(true)
    expect(result).toEqual({ kind: 'workspace-access-revoked' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
    await expect(
      db
        .selectFrom('shareables')
        .select('id')
        .where('owner_user_id', '=', 'u-raced')
        .execute(),
    ).resolves.toEqual([])
  })

  test('cleans stale pending contributors before enforcing the contributor guardrail', async () => {
    for (const id of ['u2', 'u3']) {
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'stale-pending')
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'stale-pending',
        role: 'member',
        status: 'active',
        first_contributed_at: null,
        last_contributed_at: null,
        pending_uploads: 1,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await seedUser(db, 'u5')

    const result = await uploadShareable(
      db,
      { id: 'u5', emailVerified: true, workspaceId: 'ws-a', hd: 'example.com' },
      htmlFile('third.html', '<p>ok</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )

    expect(result.kind).toBe('ok')
    const stale = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads', 'first_contributed_at'])
      .where('workspace_id', '=', 'ws-a')
      .where('user_id', '=', 'stale-pending')
      .executeTakeFirstOrThrow()
    expect(stale).toEqual({
      user_id: 'stale-pending',
      pending_uploads: 0,
      first_contributed_at: null,
    })
  })

  test('allows an existing contributor without increasing the contributor guardrail count', async () => {
    for (const id of ['owner-1', 'u2', 'u3']) {
      if (id !== 'owner-1') await seedUser(db, id)
      await seedContributor(db, id)
    }

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('again.html', '<p>again</p>'),
      'private',
    )

    expect(result.kind).toBe('ok')
    const contributors = await db
      .selectFrom('workspace_members')
      .select(db.fn.count<number>('user_id').as('c'))
      .where('workspace_id', '=', 'ws-a')
      .executeTakeFirstOrThrow()
    expect(contributors.c).toBe(3)
  })

  test('uses an injected guardrail independently of the workspace plan', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    for (let i = 2; i <= 100; i++) {
      const id = `u${i}`
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'u101')
    await seedUser(db, 'u102')

    const hundredth = await uploadShareable(
      db,
      {
        id: 'u101',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('hundredth.html', '<p>ok</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 100 },
    )
    const hundredFirst = await uploadShareable(
      db,
      {
        id: 'u102',
        emailVerified: true,
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
      htmlFile('hundred-first.html', '<p>blocked</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 100 },
    )

    expect(hundredth.kind).toBe('ok')
    expect(hundredFirst).toEqual({ kind: 'contributor-limit-exceeded' })
  })

  test('rejects URL-unsafe single-file names before reading the file body', async () => {
    const file = {
      name: 'report?v=2.html',
      type: 'text/html',
      size: 12,
      arrayBuffer: vi.fn(async () => {
        throw new Error('arrayBuffer should not be called')
      }),
    } as unknown as File

    const result = await uploadShareable(db, OWNER, file, 'private')

    expect(result).toEqual({ kind: 'invalid-path' })
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('normalizes single-file index entrypoint casing', async () => {
    nanoidMock.push(
      '0123456789abcdefghijklmnopqrstuvwxyz',
      'abc123def4',
      'v-index',
    )
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('INDEX.html', '<!doctype html>'),
      'private',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.id).toBe('abc123def4')
    const version = await db
      .selectFrom('versions')
      .select(['id', 'entrypoint_path'])
      .where('shareable_id', '=', 'abc123def4')
      .executeTakeFirstOrThrow()
    expect(result.versionId).toBe(version.id)
    expect(version.entrypoint_path).toBe('/index.html')
    const shareable = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', 'abc123def4')
      .executeTakeFirstOrThrow()
    const container = await db
      .selectFrom('artifact_containers')
      .select(['kind', 'owner_user_id'])
      .where('id', '=', shareable.container_id)
      .executeTakeFirstOrThrow()
    expect(container).toEqual({
      kind: 'inbox',
      owner_user_id: OWNER.id,
    })
  })

  test('accepts upload at the exact-equality boundary (used + size === quota)', async () => {
    const body = 'x'.repeat(100)
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 104857600 - body.length })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('edge.html', body),
      'private',
    )

    expect(result.kind).toBe('ok')
    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspaceRow.storage_used_bytes).toBe(104857600)
  })

  test('happy path puts to R2 and increments storage_used_bytes', async () => {
    const body = '<p>hello</p>'

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', body),
      'private',
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.id).toMatch(/^[0-9a-z]{10}$/)
    }
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)

    const versionRow = await db
      .selectFrom('versions')
      .select(['id', 'r2_key', 'size_bytes'])
      .executeTakeFirstOrThrow()
    expect(versionRow.size_bytes).toBe(body.length)
    expect(versionRow.r2_key).toMatch(/^artifacts\/.+\/.+\/index\.html$/)

    const events = await db.selectFrom('events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'artifact_created',
      actor_user_id: OWNER.id,
      subject_id: versionRow.id,
    })

    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspaceRow.storage_used_bytes).toBe(body.length)
    const contributor = await db
      .selectFrom('workspace_members')
      .select([
        'first_contributed_at',
        'last_contributed_at',
        'pending_uploads',
      ])
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(contributor.first_contributed_at).not.toBeNull()
    expect(contributor.last_contributed_at).toBe(
      contributor.first_contributed_at,
    )
    expect(contributor.pending_uploads).toBe(0)
  })

  test('applies link expiry policy for finite, unlimited, and default uploads', async () => {
    const finite = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const finiteResult = await uploadShareable(
      db,
      OWNER,
      htmlFile('finite.html', '<p>finite</p>'),
      'link',
      [],
      null,
      null,
      { linkExpiresAt: finite },
    )
    expect(finiteResult.kind).toBe('ok')
    if (finiteResult.kind !== 'ok') return
    expect(finiteResult.linkExpiresAt).toBe(finite)

    const defaultResult = await uploadShareable(
      db,
      OWNER,
      htmlFile('default.html', '<p>default</p>'),
      'link',
    )
    expect(defaultResult.kind).toBe('ok')
    if (defaultResult.kind !== 'ok') return
    expect(defaultResult.linkExpiresAt).not.toBeNull()

    await db
      .updateTable('workspaces')
      .set({ link_expiry_default_days: null, link_expiry_max_days: null })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const unlimitedResult = await uploadShareable(
      db,
      OWNER,
      htmlFile('unlimited.html', '<p>unlimited</p>'),
      'link',
      [],
      null,
      null,
      { linkExpiresAt: null },
    )
    expect(unlimitedResult.kind).toBe('ok')
    if (unlimitedResult.kind !== 'ok') return
    expect(unlimitedResult.linkExpiresAt).toBeNull()
  })

  test('returns distinct link write failures before storage work', async () => {
    const free = await uploadShareable(
      db,
      OWNER,
      htmlFile('free-link.html', '<p>free</p>'),
      'link',
    )
    expect(free).toEqual({ kind: 'link-sharing-plan-required' })

    await db
      .updateTable('workspaces')
      .set({ plan: 'team', link_sharing_enabled: 0 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const disabled = await uploadShareable(
      db,
      OWNER,
      htmlFile('disabled-link.html', '<p>disabled</p>'),
      'link',
    )
    expect(disabled).toEqual({ kind: 'link-sharing-disabled' })

    const invalid = await uploadShareable(
      db,
      OWNER,
      htmlFile('invalid-link.html', '<p>invalid</p>'),
      'private',
      [],
      null,
      null,
      { linkExpiresAt: '2026-01-01T00:00:00Z' },
    )
    expect(invalid).toEqual({ kind: 'link-expiry-invalid' })
  })

  test('external posting bills the project workspace for storage, contributor, and ownership', async () => {
    await seedExternalProject(db)
    const body = '<p>external</p>'

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', body),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select(['workspace_id', 'owner_user_id', 'container_id'])
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(shareable.workspace_id).toBe(EXT_WS)
    expect(shareable.owner_user_id).toBe(OWNER.id)
    expect(shareable.container_id).toBe(EXT_PROJECT)

    // Storage and contributor land on the project workspace, never the poster's.
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(body.length)
    const posterWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(posterWs.storage_used_bytes).toBe(0)

    const projectContributor = await db
      .selectFrom('workspace_members')
      .select(['first_contributed_at', 'pending_uploads'])
      .where('workspace_id', '=', EXT_WS)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(projectContributor.first_contributed_at).not.toBeNull()
    expect(projectContributor.pending_uploads).toBe(0)
    const posterContributor = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirst()
    expect(posterContributor).toBeUndefined()
  })

  test('external posting to plus workspace is rejected when over storage quota', async () => {
    await seedExternalProject(db, {
      plan: 'plus',
      storageQuotaBytes: 100,
      storageUsedBytes: 100,
    })
    const body = '<p>over quota</p>'

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', body),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result).toEqual({ kind: 'quota-exceeded' })
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(100)
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('external posting to contracted team workspace succeeds over storage quota and still accounts', async () => {
    await seedExternalProject(db, {
      plan: 'team',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: 100,
      storageUsedBytes: 100,
    })
    const body = '<p>over quota</p>'

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', body),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result.kind).toBe('ok')
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(100 + body.length)
  })

  test('external posting blocks new contributors at the upload guardrail while existing contributors continue', async () => {
    await seedExternalProject(db)
    for (let i = 0; i < 3; i++) {
      await seedExternalContributorFiller(db, `ext-c-${i}`)
    }

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>x</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
      { contributorGuardrailLimit: 3 },
    )

    expect(result).toEqual({ kind: 'contributor-limit-exceeded' })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: EXT_WS,
        user_id: OWNER.id,
        role: 'member',
        status: 'active',
        first_contributed_at: '2026-05-22T00:00:00.000Z',
        last_contributed_at: '2026-05-22T00:00:00.000Z',
        pending_uploads: 0,
        removed_at: null,
        removed_by: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    const existing = await uploadShareable(
      db,
      OWNER,
      htmlFile('existing.html', '<p>existing</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(existing.kind).toBe('ok')
  })

  test('cross-workspace posting is rejected when the workspace policy is disabled', async () => {
    await seedExternalProject(db, {
      plan: 'team',
      externalPostingEnabled: false,
    })

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>x</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result).toEqual({ kind: 'invalid-container' })
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(0)
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('cross-workspace posting is rejected for a viewer-only relationship', async () => {
    await seedExternalProject(db, { role: 'viewer' })

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>x</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result).toEqual({ kind: 'invalid-container' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('external posting batch failure releases the project workspace slot and quota', async () => {
    await seedExternalProject(db)
    sqliteRef.failNextBatch = true

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>x</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(0)
    const projectContributor = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads', 'first_contributed_at'])
      .where('workspace_id', '=', EXT_WS)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(projectContributor).toEqual({
      user_id: OWNER.id,
      pending_uploads: 0,
      first_contributed_at: null,
    })
  })

  test('saves initial grants in the same create batch', async () => {
    const result = await uploadShareable(
      db,
      { ...OWNER, email: 'Owner@Example.com' },
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [
        'A@example.com',
        ' a@example.com ',
        'OWNER@example.com',
        'b@example.com',
      ],
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const grants = await db
      .selectFrom('shareable_grants')
      .select(['shareable_id', 'granted_email', 'granted_by'])
      .where('shareable_id', '=', result.id)
      .orderBy('granted_email', 'asc')
      .execute()

    expect(grants).toEqual([
      {
        shareable_id: result.id,
        granted_email: 'a@example.com',
        granted_by: OWNER.id,
      },
      {
        shareable_id: result.id,
        granted_email: 'b@example.com',
        granted_by: OWNER.id,
      },
    ])
  })

  test('stores only the manual grant emails for an inbox upload', async () => {
    await seedProjectShareDefault(db, 'pg-1', 'Project@example.com')
    await seedProjectShareDefault(db, 'pg-2', 'owner@example.com')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      ['Manual@example.com', 'project@example.com'],
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const grants = await db
      .selectFrom('shareable_grants')
      .select(['granted_email', 'granted_by'])
      .where('shareable_id', '=', result.id)
      .orderBy('granted_email', 'asc')
      .execute()

    expect(grants).toEqual([
      { granted_email: 'manual@example.com', granted_by: OWNER.id },
      { granted_email: 'project@example.com', granted_by: OWNER.id },
    ])
  })

  test('stores a single file shareable in an explicit project container', async () => {
    await seedProjectContainer(db)

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [],
      'project-a',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()

    expect(shareable).toEqual({ container_id: 'project-a' })
  })

  test('a project upload inherits the audience live without copying defaults into grants', async () => {
    await seedProjectShareDefault(db, 'pg-1', 'Project@example.com')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'project',
      ['Manual@example.com'],
      'project-a',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select(['visibility', 'container_id'])
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', result.id)
      .orderBy('granted_email', 'asc')
      .execute()

    // visibility='project' で関係者を参照するだけ。コピーしないので grants は
    // 明示した個別共有だけになる。
    expect(shareable).toEqual({
      visibility: 'project',
      container_id: 'project-a',
    })
    expect(grants.map((grant) => grant.granted_email)).toEqual([
      'manual@example.com',
    ])
  })

  test('a private project upload does not inherit the audience', async () => {
    await seedProjectShareDefault(db, 'pg-1', 'project@example.com')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [],
      'project-a',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', result.id)
      .execute()

    expect(shareable).toEqual({ visibility: 'private' })
    expect(grants).toEqual([])
  })

  test('coerces project visibility to private when the container is not a project', async () => {
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'project',
      [],
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()

    expect(shareable).toEqual({ visibility: 'private' })
  })

  test('rejects a single file upload when the requested container is not a project', async () => {
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [],
      'missing-project',
    )

    expect(result).toEqual({ kind: 'invalid-container' })
    const count = await db
      .selectFrom('shareables')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow()
    expect(Number(count.count)).toBe(0)
  })

  test('rejects a single file upload when the requested container is an inbox', async () => {
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'owner-inbox',
        workspace_id: 'ws-a',
        kind: 'inbox',
        owner_user_id: OWNER.id,
        created_by_id: OWNER.id,
        name: '未整理',
        description: null,
        archived_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [],
      'owner-inbox',
    )

    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('rejects a single file upload when the requested project belongs to another workspace', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-b',
        hd: 'other.example.com',
        name: 'Other',
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-other-workspace',
        workspace_id: 'ws-b',
        kind: 'project',
        owner_user_id: null,
        created_by_id: null,
        name: 'Other Project',
        description: null,
        archived_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      [],
      'project-other-workspace',
    )

    expect(result).toEqual({ kind: 'invalid-container' })
  })

  test('accepts exactly 50 normalized initial grants', async () => {
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      numberedEmails(50),
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const grantsCount = await db
      .selectFrom('shareable_grants')
      .select(db.fn.count<number>('granted_email').as('c'))
      .where('shareable_id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(grantsCount.c).toBe(50)
  })

  test('rejects more than 50 normalized initial grants before storage write', async () => {
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      numberedEmails(51),
    )

    expect(result).toEqual({ kind: 'too-many-grants', limit: 50 })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('does not count project share defaults toward unspecified upload grants', async () => {
    for (let index = 0; index < 50; index++) {
      await seedProjectShareDefault(
        db,
        `pg-${index}`,
        `project-${index}@example.com`,
      )
    }

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      ['manual@example.com'],
    )

    expect(result.kind).toBe('ok')
  })

  test('D1 batch failure triggers R2 compensation (deleteArtifact)', async () => {
    sqliteRef.failNextBatch = true

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
    )

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)
    // The compensation should reference the same R2 key that was put.
    expect(storageMock.deleteArtifact.mock.calls[0]?.[0]).toBe(
      storageMock.putArtifact.mock.calls[0]?.[0],
    )

    const versionsCount = await db
      .selectFrom('versions')
      .select(db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow()
    expect(versionsCount.c).toBe(0)
    const contributor = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads', 'first_contributed_at'])
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(contributor).toEqual({
      user_id: OWNER.id,
      pending_uploads: 0,
      first_contributed_at: null,
    })
  })

  test('D1 batch failure with initial grants leaves no shareable or grants', async () => {
    sqliteRef.failNextBatch = true

    const result = await uploadShareable(
      db,
      { ...OWNER, email: 'owner@example.com' },
      htmlFile('hello.html', '<p>hello</p>'),
      'private',
      ['viewer@example.com'],
    )

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)

    const shareablesCount = await db
      .selectFrom('shareables')
      .select(db.fn.count<number>('id').as('c'))
      .executeTakeFirstOrThrow()
    const grantsCount = await db
      .selectFrom('shareable_grants')
      .select(db.fn.count<number>('shareable_id').as('c'))
      .executeTakeFirstOrThrow()
    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    const contributor = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads', 'first_contributed_at'])
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(shareablesCount.c).toBe(0)
    expect(grantsCount.c).toBe(0)
    expect(workspaceRow.storage_used_bytes).toBe(0)
    expect(contributor).toEqual({
      user_id: OWNER.id,
      pending_uploads: 0,
      first_contributed_at: null,
    })
  })

  test('retries the whole upload when shareable id collides at D1 insert time', async () => {
    nanoidMock.push(ID_ALPHABET, 'raceid0001', 'nextid0001')
    sqliteRef.beforeNextBatch = async () => {
      await seedShareableWithVersions(db, {
        shareableId: 'raceid0001',
        versions: [],
      })
    }

    const body = '<p>race</p>'
    const result = await withMutedConsoleWarn(() =>
      uploadShareable(db, OWNER, htmlFile('race.html', body), 'private'),
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.id).toBe('nextid0001')
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(2)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)
    expect(storageMock.deleteArtifact.mock.calls[0]?.[1]).toBe(
      storageMock.putArtifact.mock.calls[0]?.[1],
    )

    const uploaded = await db
      .selectFrom('shareables')
      .select(['id', 'current_version_id'])
      .where('id', '=', 'nextid0001')
      .executeTakeFirstOrThrow()
    expect(uploaded.current_version_id).toBe(result.versionId)

    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspaceRow.storage_used_bytes).toBe(body.length)
  })

  test('keeps non-constraint D1 errors as storage-failed even if the id now exists', async () => {
    nanoidMock.push(ID_ALPHABET, 'raceid0001')
    sqliteRef.beforeNextBatch = async () => {
      await seedShareableWithVersions(db, {
        shareableId: 'raceid0001',
        versions: [],
      })
      sqliteRef.failNextBatch = true
    }

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('non-constraint.html', '<p>fail</p>'),
      'private',
    )

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)

    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspaceRow.storage_used_bytes).toBe(0)
  })

  test('returns id-exhausted when D1 insert-time id collisions exhaust retry attempts', async () => {
    const collidingIds = [
      'raceid0001',
      'raceid0002',
      'raceid0003',
      'raceid0004',
      'raceid0005',
    ]
    nanoidMock.push(ID_ALPHABET, ...collidingIds)
    const collideNextId = async () => {
      const shareableId = collidingIds.shift()
      if (!shareableId) return
      await seedShareableWithVersions(db, { shareableId, versions: [] })
      if (collidingIds.length > 0) sqliteRef.beforeNextBatch = collideNextId
    }
    sqliteRef.beforeNextBatch = collideNextId

    const result = await withMutedConsoleWarn(() =>
      uploadShareable(
        db,
        OWNER,
        htmlFile('exhaust-late.html', '<p>race</p>'),
        'private',
      ),
    )

    expect(result).toEqual({ kind: 'id-exhausted' })
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(5)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(5)

    const workspaceRow = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspaceRow.storage_used_bytes).toBe(0)
  })
})

describe('commitDialogChanges', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    await seed(db)
    await seedShareableWithVersions(db, {
      shareableId: 'share1',
      versions: [
        {
          id: 'v1',
          r2Key: 'artifacts/share1/v1/index.html',
          sizeBytes: 12,
        },
      ],
    })
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('does not save the owner email as a grant', async () => {
    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'Owner@Example.com' },
      'share1',
      {
        addEmails: [' viewer@example.com ', 'OWNER@example.com'],
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.grants.map((grant) => grant.email)).toEqual([
      'viewer@example.com',
    ])

    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', 'share1')
      .orderBy('granted_email', 'asc')
      .execute()
    expect(grants.map((grant) => grant.granted_email)).toEqual([
      'viewer@example.com',
    ])
  })

  test('switches an artifact to project visibility from the dialog', async () => {
    await seedProjectShareDefault(db, 'pg-1', 'viewer@example.com')
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a' })
      .where('id', '=', 'share1')
      .execute()

    const result = await commitDialogChanges(db, OWNER, 'share1', {
      visibility: 'project',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.visibility).toBe('project')
  })

  test('coerces project visibility to private when the artifact is not in a project', async () => {
    const result = await commitDialogChanges(db, OWNER, 'share1', {
      visibility: 'project',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.visibility).toBe('private')
  })

  test('preserves omitted expiry on an existing link and clears it for non-link visibility', async () => {
    const currentExpiry = '2026-08-01T00:00:00.000Z'
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    await db
      .updateTable('shareables')
      .set({ visibility: 'link', link_expires_at: currentExpiry })
      .where('id', '=', 'share1')
      .execute()

    const preserved = await commitDialogChanges(db, OWNER, 'share1', {})
    expect(preserved.kind).toBe('ok')
    if (preserved.kind !== 'ok') return
    expect(preserved.linkExpiresAt).toBe(currentExpiry)

    const cleared = await commitDialogChanges(db, OWNER, 'share1', {
      visibility: 'private',
    })
    expect(cleared.kind).toBe('ok')
    const row = await db
      .selectFrom('shareables')
      .select(['visibility', 'link_expires_at'])
      .where('id', '=', 'share1')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ visibility: 'private', link_expires_at: null })
  })

  test('uses the workspace default when changing a non-link artifact to link', async () => {
    await db
      .updateTable('workspaces')
      .set({
        plan: 'plus',
        link_sharing_enabled: 1,
        link_expiry_default_days: 30,
      })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const result = await commitDialogChanges(db, OWNER, 'share1', {
      visibility: 'link',
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.linkExpiresAt).not.toBeNull()
  })

  test('removes existing owner grants when saving dialog changes', async () => {
    await db
      .insertInto('shareable_grants')
      .values([
        {
          shareable_id: 'share1',
          granted_email: 'Owner@Example.com',
          granted_at: '2026-05-22T00:00:00.000Z',
          granted_by: OWNER.id,
        },
        {
          shareable_id: 'share1',
          granted_email: 'viewer@example.com',
          granted_at: '2026-05-22T00:00:00.000Z',
          granted_by: OWNER.id,
        },
      ])
      .execute()

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      { visibility: 'workspace' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.grants.map((grant) => grant.email)).toEqual([
      'viewer@example.com',
    ])

    const ownerGrant = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', 'share1')
      .where('granted_email', '=', 'Owner@Example.com')
      .executeTakeFirst()
    expect(ownerGrant).toBeUndefined()
  })

  test('listGrants hides existing owner grants', async () => {
    await db
      .insertInto('shareable_grants')
      .values([
        {
          shareable_id: 'share1',
          granted_email: 'Owner@Example.com',
          granted_at: '2026-05-22T00:00:00.000Z',
          granted_by: OWNER.id,
        },
        {
          shareable_id: 'share1',
          granted_email: 'viewer@example.com',
          granted_at: '2026-05-22T00:00:00.000Z',
          granted_by: OWNER.id,
        },
      ])
      .execute()

    const result = await listGrants(
      db,
      { ...OWNER, email: 'OWNER@example.com' },
      'share1',
    )

    expect(result).toMatchObject({
      kind: 'ok',
      grants: [{ email: 'viewer@example.com' }],
    })
  })

  test('listGrants resolves the user profile for a mixed-case stored grant', async () => {
    await seedUser(db, 'viewer')
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share1',
        granted_email: 'Viewer@Example.com',
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: OWNER.id,
      })
      .execute()

    const result = await listGrants(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
    )

    expect(result).toMatchObject({
      kind: 'ok',
      grants: [
        {
          email: 'Viewer@Example.com',
          user: { id: 'viewer', name: 'viewer', image: null, kind: 'human' },
        },
      ],
    })
  })

  test('lookupGrantUsers excludes the owner email', async () => {
    await seedUser(db, 'viewer')

    const result = await lookupGrantUsers(
      db,
      { ...OWNER, email: 'OWNER@example.com' },
      'share1',
      ['viewer@example.com', 'owner@example.com'],
    )

    expect(result).toEqual({
      kind: 'ok',
      entries: [
        {
          email: 'viewer@example.com',
          user: { id: 'viewer', name: 'viewer', image: null, kind: 'human' },
        },
      ],
    })
  })

  test('allows dialog grants up to exactly 50 entries', async () => {
    await insertGrants(db, 'share1', numberedEmails(49))

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      {
        addEmails: ['person-50@example.com'],
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.grants).toHaveLength(50)
  })

  test('rejects dialog additions beyond 50 entries', async () => {
    await insertGrants(db, 'share1', numberedEmails(50))

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      {
        addEmails: ['person-51@example.com'],
      },
    )

    expect(result).toEqual({ kind: 'too-many-grants', limit: 50 })
  })

  test('rolls back its own dialog additions if a concurrent save reaches the limit first', async () => {
    await insertGrants(db, 'share1', numberedEmails(49))
    sqliteRef.beforeNextBatch = async () => {
      await db
        .insertInto('shareable_grants')
        .values({
          shareable_id: 'share1',
          granted_email: 'person-50@example.com',
          granted_at: '2026-05-22T00:00:00.000Z',
          granted_by: OWNER.id,
        })
        .execute()
    }

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      {
        addEmails: ['person-51@example.com'],
      },
    )

    expect(result).toEqual({ kind: 'too-many-grants', limit: 50 })
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', 'share1')
      .orderBy('granted_email', 'asc')
      .execute()
    expect(grants.map((grant) => grant.granted_email)).toHaveLength(50)
    expect(grants.map((grant) => grant.granted_email)).not.toContain(
      'person-51@example.com',
    )
  })

  test('allows replacing a grant when existing data is already over the limit', async () => {
    await insertGrants(db, 'share1', numberedEmails(51))

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      {
        addEmails: ['replacement@example.com'],
        removeEmails: ['person-51@example.com'],
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.grants).toHaveLength(51)
    expect(result.grants.map((grant) => grant.email)).toContain(
      'replacement@example.com',
    )
    expect(result.grants.map((grant) => grant.email)).not.toContain(
      'person-51@example.com',
    )
  })

  test('allows existing over-limit grants to be removed without dropping access', async () => {
    await insertGrants(db, 'share1', numberedEmails(51))

    const result = await commitDialogChanges(
      db,
      { ...OWNER, email: 'owner@example.com' },
      'share1',
      {
        removeEmails: ['person-51@example.com'],
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.grants).toHaveLength(50)
  })
})

describe('StaticSiteBundleUploadSession', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('stores each file as it is accepted, then commits manifest rows', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/style.css', 8, 'text/css')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/favicon.ico', 4, 'image/x-icon')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/assets/app.js.map', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(4)

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select([
        'artifact_kind',
        'visibility',
        'current_version_id',
        'name',
        'derived_title',
        'container_id',
      ])
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    expect(shareable.artifact_kind).toBe('static_site')
    expect(shareable.visibility).toBe('private')

    const events = await db.selectFrom('events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'artifact_created',
      shareable_id: begun.session.shareableId,
      subject_id: begun.session.versionId,
    })
    expect(shareable.current_version_id).toBe(begun.session.versionId)
    expect(shareable.name).toBe('index.html')
    expect(shareable.derived_title).toBeNull()
    const container = await db
      .selectFrom('artifact_containers')
      .select(['kind', 'owner_user_id'])
      .where('id', '=', shareable.container_id)
      .executeTakeFirstOrThrow()
    expect(container).toEqual({
      kind: 'inbox',
      owner_user_id: OWNER.id,
    })
    const versionFiles = await db
      .selectFrom('version_files')
      .select(['path', 'size_bytes'])
      .where('version_id', '=', begun.session.versionId)
      .orderBy('path', 'asc')
      .execute()
    expect(versionFiles).toEqual([
      { path: '/assets/app.js.map', size_bytes: 12 },
      { path: '/favicon.ico', size_bytes: 4 },
      { path: '/index.html', size_bytes: 16 },
      { path: '/style.css', size_bytes: 8 },
    ])
    const version = await db
      .selectFrom('versions')
      .select('fallback_to_index')
      .where('id', '=', begun.session.versionId)
      .executeTakeFirstOrThrow()
    expect(version.fallback_to_index).toBe(1)
    const contributor = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads'])
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(contributor).toEqual({ user_id: OWNER.id, pending_uploads: 0 })
  })

  test('applies link expiry policy when committing a static site', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await begun.session.addFile(siteFile('/index.html', 16, 'text/html'))

    const result = await begun.session.commit(
      'link',
      [],
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.linkExpiresAt).not.toBeNull()
    const row = await db
      .selectFrom('shareables')
      .select(['visibility', 'link_expires_at'])
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    expect(row.visibility).toBe('link')
    expect(row.link_expires_at).toBe(result.linkExpiresAt)
  })

  test('commits initial grants with static site rows', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, {
      ...OWNER,
      email: 'owner@example.com',
    })

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('workspace', [
      'viewer@example.com',
      'OWNER@example.com',
    ])

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'workspace',
    })
    const grants = await db
      .selectFrom('shareable_grants')
      .select(['shareable_id', 'granted_email', 'granted_by'])
      .where('shareable_id', '=', begun.session.shareableId)
      .execute()
    expect(grants).toEqual([
      {
        shareable_id: begun.session.shareableId,
        granted_email: 'viewer@example.com',
        granted_by: OWNER.id,
      },
    ])
  })

  test('stores only the manual grant emails for an inbox static site upload', async () => {
    await seedProjectShareDefault(
      db,
      'pg-static-1',
      'project-static@example.com',
    )
    const begun = await beginStaticSiteBundleUploadSession(db, {
      ...OWNER,
      email: 'owner@example.com',
    })

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private', [
      'manual-static@example.com',
    ])

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', begun.session.shareableId)
      .orderBy('granted_email', 'asc')
      .execute()
    expect(grants.map((grant) => grant.granted_email)).toEqual([
      'manual-static@example.com',
    ])
  })

  test('stores a static site shareable in an explicit project container', async () => {
    await seedProjectContainer(db)
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      {
        ...OWNER,
        email: 'owner@example.com',
      },
      'project-a',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select('container_id')
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({ container_id: 'project-a' })
  })

  test('a static site project upload inherits the audience live without copying defaults', async () => {
    await seedProjectShareDefault(db, 'pg-static-include', 'static@example.com')
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      {
        ...OWNER,
        email: 'owner@example.com',
      },
      'project-a',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('project', [
      'manual-static@example.com',
    ])

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'project',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select(['visibility', 'container_id'])
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', begun.session.shareableId)
      .orderBy('granted_email', 'asc')
      .execute()

    expect(shareable).toEqual({
      visibility: 'project',
      container_id: 'project-a',
    })
    expect(grants.map((grant) => grant.granted_email)).toEqual([
      'manual-static@example.com',
    ])
  })

  test('rejects static site initial grants beyond 50 and removes uploaded files', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, {
      ...OWNER,
      email: 'owner@example.com',
    })

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private', numberedEmails(51))

    expect(result).toEqual({ kind: 'too-many-grants', limit: 50 })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/`,
    )
    const grantsCount = await db
      .selectFrom('shareable_grants')
      .select(db.fn.count<number>('granted_email').as('c'))
      .executeTakeFirstOrThrow()
    expect(grantsCount.c).toBe(0)
  })

  test('rejects a static site commit when the contributor guardrail is reached', async () => {
    for (const id of ['u2', 'u3', 'u4']) {
      await seedUser(db, id)
      await seedContributor(db, id)
    }
    await seedUser(db, 'u5')

    const begun = await beginStaticSiteBundleUploadSession(
      db,
      {
        id: 'u5',
        emailVerified: true,
        workspaceId: 'ws-a',
      },
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({ kind: 'contributor-limit-exceeded' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/`,
    )
    const contributor = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', 'ws-a')
      .where('user_id', '=', 'u5')
      .executeTakeFirst()
    expect(contributor).toBeUndefined()
  })

  test('normalizes root entrypoint casing before storing R2 keys', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/INDEX.HTML', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    expect(storageMock.putArtifact).toHaveBeenCalledWith(
      {},
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/index.html`,
      expect.any(ArrayBuffer),
      { contentType: 'text/html; charset=utf-8' },
    )
    const version = await db
      .selectFrom('versions')
      .select('entrypoint_path')
      .where('id', '=', begun.session.versionId)
      .executeTakeFirstOrThrow()
    expect(version.entrypoint_path).toBe('/index.html')
  })

  test('normalizes Unicode paths to NFC before duplicate checks and R2 keys', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)
    const nfcPath = '/assets/café.html'
    const nfdPath = '/assets/cafe\u0301.html'

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile(nfdPath, 12, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const duplicate = await begun.session.addFile(
      fakeSiteFile(nfcPath, 12, 'text/html'),
    )

    expect(duplicate).toEqual({ kind: 'duplicate-path', path: nfcPath })
    expect(storageMock.putArtifact).toHaveBeenCalledWith(
      {},
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/assets/café.html`,
      expect.any(ArrayBuffer),
      { contentType: 'text/html; charset=utf-8' },
    )
    expect(
      storageMock.putArtifact.mock.calls.map((call) => call[1]),
    ).not.toContain(
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/assets/cafe\u0301.html`,
    )

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const versionFiles = await db
      .selectFrom('version_files')
      .select('path')
      .where('version_id', '=', begun.session.versionId)
      .where('path', 'like', '/assets/%')
      .execute()
    expect(versionFiles).toEqual([{ path: nfcPath }])
  })

  test('ignores OS metadata files in static site bundles', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/.DS_Store', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/assets/Thumbs.db', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(
        siteFile('/__MACOSX/next-export/index.html', 12, 'text/html'),
      ),
    ).resolves.toEqual({ kind: 'ok' })

    expect(begun.session.fileCount).toBe(1)
    expect(storageMock.putArtifact).toHaveBeenCalledTimes(1)
  })

  test('uses an HTML entrypoint title as the static site display title', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(
        siteTextFile(
          '/index.html',
          '<!doctype html><title>Agency Report</title><h1>Body</h1>',
          'text/html',
        ),
      ),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/style.css', 8, 'text/css')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select(['name', 'derived_title'])
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      name: 'Agency Report',
      derived_title: 'Agency Report',
    })
  })

  test('uses a Markdown entrypoint heading as the static site display title', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(
        siteTextFile('/index.md', '# Release Notes\n\nSee [details](./a.md).'),
      ),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select(['name', 'derived_title'])
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      name: 'Release Notes',
      derived_title: 'Release Notes',
    })
    const version = await db
      .selectFrom('versions')
      .select('fallback_to_index')
      .where('id', '=', begun.session.versionId)
      .executeTakeFirstOrThrow()
    expect(version.fallback_to_index).toBe(0)
  })

  test('accepts framework sidecar files in static site bundles', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/blog.data', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/about.rsc', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/about.meta', 12, '')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({
      kind: 'ok',
      id: begun.session.shareableId,
      versionId: begun.session.versionId,
      linkExpiresAt: null,
      visibility: 'private',
    })
    const dataFile = await db
      .selectFrom('version_files')
      .select(['path', 'mime_type'])
      .where('version_id', '=', begun.session.versionId)
      .where('path', '=', '/blog.data')
      .executeTakeFirstOrThrow()
    expect(dataFile).toEqual({
      path: '/blog.data',
      mime_type: 'application/octet-stream',
    })
    const sidecarFiles = await db
      .selectFrom('version_files')
      .select(['path', 'mime_type'])
      .where('version_id', '=', begun.session.versionId)
      .where('path', 'in', ['/about.rsc', '/about.meta'])
      .orderBy('path')
      .execute()
    expect(sidecarFiles).toEqual([
      {
        path: '/about.meta',
        mime_type: 'text/plain; charset=utf-8',
      },
      {
        path: '/about.rsc',
        mime_type: 'text/x-component; charset=utf-8',
      },
    ])
  })

  test.each([
    {
      name: 'react-spa',
      requiredPaths: ['/index.html'],
      requiredPathPrefixes: ['/assets/'],
    },
    {
      name: 'react-router-prerender',
      requiredPaths: ['/blog.data', '/blog/index.html', '/index.html'],
      requiredPathPrefixes: ['/assets/'],
    },
    {
      name: 'next-export',
      requiredPaths: ['/404.html', '/about.html', '/index.html'],
      requiredPathPrefixes: ['/_next/static/', '/about/'],
    },
  ])(
    'commits the $name sample fixture as a static site bundle',
    async (sample) => {
      const begun = await beginStaticSiteBundleUploadSession(db, OWNER)
      const fixture = await loadStaticSiteFixture(sample.name)

      expect(begun.kind).toBe('ok')
      if (begun.kind !== 'ok') throw new Error('expected ok')
      for (const file of await loadStaticSiteFixtureFiles(sample.name)) {
        await expect(begun.session.addFile(file)).resolves.toEqual({
          kind: 'ok',
        })
      }
      if (sample.name === 'next-export') {
        sqliteRef.beforeNextBatch = async (stmts) => {
          const versionFileInserts = stmts.filter((stmt) =>
            stmt.sql.includes('insert into "version_files"'),
          )
          expect(versionFileInserts.length).toBeGreaterThan(1)
          for (const stmt of versionFileInserts) {
            expect(stmt.params.length).toBeLessThanOrEqual(72)
          }
        }
      }

      const result = await begun.session.commit('private')

      expect(result).toEqual({
        kind: 'ok',
        id: begun.session.shareableId,
        versionId: begun.session.versionId,
        linkExpiresAt: null,
        visibility: 'private',
      })
      const version = await db
        .selectFrom('versions')
        .select(['entrypoint_path', 'fallback_to_index'])
        .where('id', '=', begun.session.versionId)
        .executeTakeFirstOrThrow()
      expect(version).toEqual({
        entrypoint_path: '/index.html',
        fallback_to_index: 1,
      })
      const paths = await db
        .selectFrom('version_files')
        .select('path')
        .where('version_id', '=', begun.session.versionId)
        .orderBy('path', 'asc')
        .execute()
      const storedPaths = paths.map((file) => file.path)
      expect(storedPaths).toHaveLength(fixture.length)
      expect(storedPaths).toEqual(expect.arrayContaining(sample.requiredPaths))
      for (const prefix of sample.requiredPathPrefixes) {
        expect(storedPaths.some((path) => path.startsWith(prefix))).toBe(true)
      }
    },
  )

  test('rejects control characters in bundle paths before reading or writing file content', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    const file = fakeSiteFile('/assets/app\n.js', 11, 'text/javascript')
    const result = await begun.session.addFile(file)

    expect(result).toMatchObject({
      kind: 'invalid-path',
      path: '/assets/app\n.js',
    })
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
    await begun.session.abort()
  })

  test('rejects over-quota sessions before reading or writing file content', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 104857600 - 10 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    const file = fakeSiteFile('/index.html', 11, 'text/html')
    const result = await begun.session.addFile(file)

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
    await begun.session.abort()
    const placeholder = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirst()
    expect(placeholder).toBeUndefined()
  })

  test('cleans up uploaded files when commit validation fails', async () => {
    const begun = await beginStaticSiteBundleUploadSession(db, OWNER)

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/about.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')

    expect(result).toEqual({ kind: 'missing-entrypoint' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/${begun.session.shareableId}/${begun.session.versionId}/`,
    )
    const shareable = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', begun.session.shareableId)
      .executeTakeFirst()
    expect(shareable).toBeUndefined()
  })

  test('external posting bills the project workspace for storage, contributor, R2 prefix, and ownership', async () => {
    await seedExternalProject(db)
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    // The R2 prefix is keyed by the project workspace, not the poster's.
    expect(begun.session.r2Prefix.startsWith(`${EXT_WS}/`)).toBe(true)
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const shareable = await db
      .selectFrom('shareables')
      .select(['workspace_id', 'owner_user_id', 'container_id'])
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow()
    expect(shareable.workspace_id).toBe(EXT_WS)
    expect(shareable.owner_user_id).toBe(OWNER.id)
    expect(shareable.container_id).toBe(EXT_PROJECT)

    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(16)
    const posterWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(posterWs.storage_used_bytes).toBe(0)

    const projectContributor = await db
      .selectFrom('workspace_members')
      .select(['first_contributed_at', 'pending_uploads'])
      .where('workspace_id', '=', EXT_WS)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(projectContributor.first_contributed_at).not.toBeNull()
    expect(projectContributor.pending_uploads).toBe(0)
    const posterContributor = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', OWNER.workspaceId)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirst()
    expect(posterContributor).toBeUndefined()
  })

  test('external static_site posting to plus workspace is rejected when over storage quota', async () => {
    await seedExternalProject(db, {
      plan: 'plus',
      storageQuotaBytes: 10,
      storageUsedBytes: 10,
    })
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')

    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'quota-exceeded' })

    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(10)
  })

  test('external static_site posting to contracted team workspace succeeds over storage quota and still accounts', async () => {
    await seedExternalProject(db, {
      plan: 'team',
      stripeSubscriptionStatus: 'active',
      storageQuotaBytes: 10,
      storageUsedBytes: 10,
    })
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commit('private')
    expect(result.kind).toBe('ok')
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(10 + 16)
  })

  test('external static_site posting blocks new contributors at the upload guardrail while existing contributors continue', async () => {
    await seedExternalProject(db)
    for (let i = 0; i < 3; i++) {
      await seedExternalContributorFiller(db, `ext-s-${i}`)
    }
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await begun.session.addFile(siteFile('/index.html', 16, 'text/html'))

    const result = await begun.session.commit('private')
    expect(result).toEqual({ kind: 'contributor-limit-exceeded' })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: EXT_WS,
        user_id: OWNER.id,
        role: 'member',
        status: 'active',
        first_contributed_at: '2026-05-22T00:00:00.000Z',
        last_contributed_at: '2026-05-22T00:00:00.000Z',
        pending_uploads: 0,
        removed_at: null,
        removed_by: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    const existing = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(existing.kind).toBe('ok')
  })

  test('cross-workspace static_site posting is rejected when the workspace policy is disabled', async () => {
    await seedExternalProject(db, {
      plan: 'team',
      externalPostingEnabled: false,
    })
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun).toEqual({ kind: 'invalid-container' })
  })

  test('cross-workspace static_site posting is rejected for a viewer-only relationship', async () => {
    await seedExternalProject(db, { role: 'viewer' })
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun).toEqual({ kind: 'invalid-container' })
  })

  test('external static_site batch failure releases the project workspace slot and quota', async () => {
    await seedExternalProject(db)
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await begun.session.addFile(siteFile('/index.html', 16, 'text/html'))
    sqliteRef.failNextBatch = true

    const result = await begun.session.commit('private')
    expect(result).toEqual({ kind: 'storage-failed' })
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(0)
    const projectContributor = await db
      .selectFrom('workspace_members')
      .select(['user_id', 'pending_uploads', 'first_contributed_at'])
      .where('workspace_id', '=', EXT_WS)
      .where('user_id', '=', OWNER.id)
      .executeTakeFirstOrThrow()
    expect(projectContributor).toEqual({
      user_id: OWNER.id,
      pending_uploads: 0,
      first_contributed_at: null,
    })
  })
})

describe('generateUniqueShareableId', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('generates an alphanumeric 10 character id', async () => {
    const result = await generateUniqueShareableId(db)

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.id).toMatch(/^[0-9a-z]{10}$/)
    }
  })

  test('retries when the generated id collides with an existing shareable', async () => {
    await seedShareableWithVersions(db, {
      shareableId: 'collide1234',
      versions: [],
    })
    nanoidMock.push(ID_ALPHABET, 'collide1234', 'nextid0001')

    const result = await generateUniqueShareableId(db)

    expect(result).toEqual({ kind: 'ok', id: 'nextid0001' })
  })

  test('returns id-exhausted when all 5 retry attempts collide', async () => {
    await seedShareableWithVersions(db, {
      shareableId: 'collide1234',
      versions: [],
    })
    nanoidMock.push(ID_ALPHABET, ...Array(5).fill('collide1234'))

    const result = await generateUniqueShareableId(db)

    expect(result).toEqual({ kind: 'id-exhausted' })
  })

  test('createNewShareableFromFile issues ids through the unique generator', async () => {
    nanoidMock.push(ID_ALPHABET, 'smokeid001')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('smoke.html', '<p>hello</p>'),
      'private',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.id).toBe('smokeid001')
    const row = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'smokeid001')
      .executeTakeFirstOrThrow()
    expect(row.id).toMatch(/^[0-9a-z]{10}$/)
  })

  test('uploadShareable returns id-exhausted when generator is exhausted', async () => {
    await seedShareableWithVersions(db, {
      shareableId: 'collide1234',
      versions: [],
    })
    nanoidMock.push(ID_ALPHABET, ...Array(5).fill('collide1234'))

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('exhaust.html', '<p>hi</p>'),
      'private',
    )

    expect(result).toEqual({ kind: 'id-exhausted' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })
})

describe('StaticSiteBundleVersionUploadSession', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db, { storageUsedBytes: 100 })
    await seedShareableWithVersions(db, {
      shareableId: 'bundle1',
      artifactKind: 'static_site',
      name: 'Old Site',
      derivedTitle: 'Old Site',
      versions: [
        { id: 'bv1', r2Key: 'ws-a/bundle1/bv1/index.html', sizeBytes: 100 },
      ],
    })
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('adds a new static site version and keeps existing versions addressable', async () => {
    await seedProjectContainer(db)
    await insertGrants(db, 'bundle1', ['viewer@example.com'])
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a', visibility: 'project' })
      .where('id', '=', 'bundle1')
      .execute()
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'bundle1',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(
        siteTextFile('/index.html', '<title>New Site</title>', 'text/html'),
      ),
    ).resolves.toEqual({ kind: 'ok' })
    await expect(
      begun.session.addFile(siteFile('/assets/app.js', 12, 'text/javascript')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commitVersion()

    expect(result).toEqual({
      kind: 'ok',
      id: 'bundle1',
      versionId: begun.session.versionId,
    })
    expect(artifactLiveMock.getByName).toHaveBeenCalledWith('bundle1')
    expect(artifactLiveMock.notifyVersionChanged).toHaveBeenCalledWith(
      begun.session.versionId,
    )
    const versionEvents = await db
      .selectFrom('events')
      .selectAll()
      .where('type', '=', 'version_published')
      .execute()
    expect(versionEvents).toHaveLength(1)
    expect(versionEvents[0]).toMatchObject({
      shareable_id: 'bundle1',
      subject_id: begun.session.versionId,
    })
    const shareable = await db
      .selectFrom('shareables')
      .select([
        'current_version_id',
        'name',
        'derived_title',
        'visibility',
        'container_id',
      ])
      .where('id', '=', 'bundle1')
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      current_version_id: begun.session.versionId,
      name: 'New Site',
      derived_title: 'New Site',
      visibility: 'project',
      container_id: 'project-a',
    })
    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', 'bundle1')
      .execute()
    expect(grants.map((grant) => grant.granted_email)).toEqual([
      'viewer@example.com',
    ])
    const contributors = await db
      .selectFrom('workspace_members')
      .select(['workspace_id', 'user_id'])
      .where('workspace_id', '=', OWNER.workspaceId)
      .execute()
    expect(contributors).toEqual([])
    const versions = await db
      .selectFrom('versions')
      .select(['id', 'shareable_id', 'artifact_kind'])
      .where('shareable_id', '=', 'bundle1')
      .orderBy('created_at', 'asc')
      .execute()
    expect(versions.map((version) => version.id)).toEqual([
      'bv1',
      begun.session.versionId,
    ])
    expect(versions.at(-1)).toMatchObject({
      shareable_id: 'bundle1',
      artifact_kind: 'static_site',
    })
    const versionFiles = await db
      .selectFrom('version_files')
      .select(['path', 'r2_key'])
      .where('version_id', '=', begun.session.versionId)
      .orderBy('path', 'asc')
      .execute()
    expect(versionFiles).toEqual([
      {
        path: '/assets/app.js',
        r2_key: `ws-a/bundle1/${begun.session.versionId}/assets/app.js`,
      },
      {
        path: '/index.html',
        r2_key: `ws-a/bundle1/${begun.session.versionId}/index.html`,
      },
    ])
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(135)
  })

  test('rejects non-static targets before staging files', async () => {
    await seedShareableWithVersions(db, {
      shareableId: 'doc1',
      versions: [
        { id: 'dv1', r2Key: 'artifacts/doc1/dv1/index.html', sizeBytes: 10 },
      ],
    })

    const result = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'doc1',
    )

    expect(result).toEqual({ kind: 'copy-forbidden' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('cleans up staged files and releases quota when version commit fails', async () => {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'bundle1',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    sqliteRef.failNextBatch = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await begun.session.commitVersion()
    errorSpy.mockRestore()

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/bundle1/${begun.session.versionId}/`,
    )
    const shareable = await db
      .selectFrom('shareables')
      .select('current_version_id')
      .where('id', '=', 'bundle1')
      .executeTakeFirstOrThrow()
    expect(shareable.current_version_id).toBe('bv1')
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(100)
  })

  test('cleans up when the target stops matching before version commit', async () => {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'bundle1',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'html_page' })
      .where('id', '=', 'bundle1')
      .execute()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await begun.session.commitVersion()
    errorSpy.mockRestore()

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/bundle1/${begun.session.versionId}/`,
    )
    const versions = await db
      .selectFrom('versions')
      .select('id')
      .where('shareable_id', '=', 'bundle1')
      .orderBy('created_at', 'asc')
      .execute()
    expect(versions.map((version) => version.id)).toEqual(['bv1'])
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(100)
  })

  test('cleans up staged files when the bundle is missing an entrypoint', async () => {
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'bundle1',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/assets/app.js', 16, 'text/javascript')),
    ).resolves.toEqual({ kind: 'ok' })

    const result = await begun.session.commitVersion()

    expect(result).toEqual({ kind: 'missing-entrypoint' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/bundle1/${begun.session.versionId}/`,
    )
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(100)
  })

  test('cleans up staged files without changing existing storage when over quota', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_quota_bytes: 120 })
      .where('id', '=', OWNER.workspaceId)
      .execute()
    const begun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      'bundle1',
    )

    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await expect(
      begun.session.addFile(siteFile('/index.html', 16, 'text/html')),
    ).resolves.toEqual({ kind: 'ok' })
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 110 })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const result = await begun.session.commitVersion()

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(storageMock.deleteArtifactsByPrefix).toHaveBeenCalledWith(
      {},
      `ws-a/bundle1/${begun.session.versionId}/`,
    )
    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(110)
  })
})

describe('createVersion', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    artifactLiveMock.getByName.mockClear()
    artifactLiveMock.notifyVersionChanged.mockClear()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
    await seedShareableWithVersions(db, {
      shareableId: 'share1',
      versions: [
        { id: 'v1', r2Key: 'artifacts/share1/v1/index.html', sizeBytes: 100 },
      ],
    })
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('returns quota-exceeded and short-circuits before file.arrayBuffer when over quota', async () => {
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 104857600 - 10 })
      .where('id', '=', OWNER.workspaceId)
      .execute()

    const file = htmlFile('big.html', '<p>'.repeat(100))
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer')

    const result = await createVersion({
      db,
      user: OWNER,
      shareableId: 'share1',
      file,
    })

    expect(result).toEqual({ kind: 'quota-exceeded' })
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('appendShareable concatenates exactly and preserves the artifact name', async () => {
    storageMock.getArtifact.mockResolvedValue({
      size: 9,
      body: new Blob(['<p>v1</p>']).stream(),
    })

    const result = await appendShareable(db, OWNER, 'share1', '\n<p>v2</p>')

    expect(result.kind).toBe('ok')
    const uploaded = storageMock.putArtifact.mock.calls[0]?.[2]
    expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
      '<p>v1</p>\n<p>v2</p>',
    )
    const row = await db
      .selectFrom('shareables')
      .select('name')
      .where('id', '=', 'share1')
      .executeTakeFirstOrThrow()
    expect(row.name).toBe('doc.html')
  })

  test('appendShareable preserves Markdown source containing a body-close string', async () => {
    await db
      .updateTable('shareables')
      .set({ artifact_kind: 'markdown_page' })
      .where('id', '=', 'share1')
      .execute()
    await db
      .updateTable('versions')
      .set({ artifact_kind: 'markdown_page' })
      .where('id', '=', 'v1')
      .execute()
    const source = '# Example\n\nLiteral `</body>` text'
    storageMock.getArtifact.mockResolvedValue({
      size: new TextEncoder().encode(source).byteLength,
      body: new Blob([source]).stream(),
    })

    const result = await appendShareable(db, OWNER, 'share1', '\n\n## Next')

    expect(result.kind).toBe('ok')
    const uploaded = storageMock.putArtifact.mock.calls[0]?.[2]
    expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
      `${source}\n\n## Next`,
    )
  })

  test.each([
    ['</body>', '</body>'],
    ['</BODY   >', '</BODY   >'],
    ['</body\t\n\f\r >', '</body\t\n\f\r >'],
  ])(
    'appendShareable inserts HTML before the last body close: %s',
    async (close, expectedClose) => {
      const source = `<html><body>one${close}tail${close}</html>`
      storageMock.getArtifact.mockResolvedValue({
        size: source.length,
        body: new Blob([source]).stream(),
      })

      const result = await appendShareable(
        db,
        OWNER,
        'share1',
        '<script>x</script>',
      )

      expect(result.kind).toBe('ok')
      const uploaded = storageMock.putArtifact.mock.calls[0]?.[2]
      expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
        `<html><body>one${close}tail<script>x</script>${expectedClose}</html>`,
      )
    },
  )

  test('appendShareable falls back to the source end for invalid or absent HTML body closes', async () => {
    for (const source of [
      '<body>x</body foo>',
      '<body>x</body\u00a0>',
      '<body>x',
    ]) {
      storageMock.putArtifact.mockClear()
      storageMock.getArtifact.mockResolvedValue({
        size: new TextEncoder().encode(source).byteLength,
        body: new Blob([new TextEncoder().encode(source)]).stream(),
      })

      const result = await appendShareable(
        db,
        OWNER,
        'share1',
        '<style>x</style>',
      )

      expect(result.kind).toBe('ok')
      const uploaded = storageMock.putArtifact.mock.calls[0]?.[2]
      expect(new TextDecoder().decode(uploaded as ArrayBuffer)).toBe(
        `${source}<style>x</style>`,
      )
    }
  })

  test('appendShareable treats a missing current source as retryable storage failure', async () => {
    storageMock.getArtifact.mockResolvedValue(null)

    const result = await appendShareable(db, OWNER, 'share1', 'later')

    expect(result).toEqual({ kind: 'storage-failed' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('appendShareable preserves existing non-UTF-8 bytes', async () => {
    storageMock.getArtifact.mockResolvedValue({
      size: 2,
      body: new Blob([Uint8Array.from([0xff, 0xfe])]).stream(),
    })

    const result = await appendShareable(db, OWNER, 'share1', 'A')

    expect(result.kind).toBe('ok')
    const uploaded = storageMock.putArtifact.mock.calls[0]?.[2]
    expect(Array.from(new Uint8Array(uploaded as ArrayBuffer))).toEqual([
      0xff, 0xfe, 0x41,
    ])

    const events = await db.selectFrom('events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'version_published',
      shareable_id: 'share1',
      actor_user_id: OWNER.id,
    })
  })

  test('appendShareable preserves a concurrent update and compensates the losing upload', async () => {
    storageMock.getArtifact.mockResolvedValue({
      size: 9,
      body: new Blob(['<p>v1</p>']).stream(),
    })
    const before = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    sqliteRef.beforeNextBatch = async () => {
      await db
        .insertInto('versions')
        .values({
          id: 'concurrent-v2',
          shareable_id: 'share1',
          artifact_kind: 'html_page',
          status: 'published',
          entrypoint_path: 'doc.html',
          r2_key: 'artifacts/share1/concurrent-v2/index.html',
          size_bytes: 12,
          sha256: 'concurrent',
          created_by_id: OWNER.id,
          created_at: '2026-07-26T00:00:00.000Z',
          published_at: '2026-07-26T00:00:00.000Z',
        })
        .execute()
      await db
        .updateTable('shareables')
        .set({ current_version_id: 'concurrent-v2' })
        .where('id', '=', 'share1')
        .execute()
    }

    const result = await appendShareable(db, OWNER, 'share1', 'loser')

    expect(result).toEqual({
      kind: 'version-conflict',
      currentVersionId: 'concurrent-v2',
    })
    const shareable = await db
      .selectFrom('shareables')
      .select(['current_version_id', 'name'])
      .where('id', '=', 'share1')
      .executeTakeFirstOrThrow()
    expect(shareable).toEqual({
      current_version_id: 'concurrent-v2',
      name: 'doc.html',
    })
    const versions = await db
      .selectFrom('versions')
      .select('id')
      .where('shareable_id', '=', 'share1')
      .execute()
    expect(versions.map(({ id }) => id).sort()).toEqual(['concurrent-v2', 'v1'])
    const after = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(after.storage_used_bytes).toBe(before.storage_used_bytes)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(1)
    expect(await db.selectFrom('events').selectAll().execute()).toEqual([])
  })

  test('rejects replacing a static_site shareable with a single file', async () => {
    const containerId = await seedInboxContainer(db)
    await db
      .insertInto('shareables')
      .values({
        id: 'bundle1',
        workspace_id: 'ws-a',
        owner_user_id: 'owner-1',
        slug: null,
        name: 'index.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'static_site',
        visibility: 'private',
        current_version_id: 'bv1',
        view_count: 0,
        container_id: containerId,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'bv1',
        shareable_id: 'bundle1',
        artifact_kind: 'static_site',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'ws-a/bundle1/bv1/index.html',
        size_bytes: 100,
        sha256: 'sha-bundle',
        created_by_id: 'owner-1',
        created_at: '2026-05-22T00:00:00.000Z',
        published_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    const file = htmlFile('replacement.html', '<p>replacement</p>')
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer')

    const result = await createVersion({
      db,
      user: OWNER,
      shareableId: 'bundle1',
      file,
    })

    expect(result).toEqual({ kind: 'copy-forbidden' })
    expect(arrayBufferSpy).not.toHaveBeenCalled()
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('keeps the version update successful when live notification fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    artifactLiveMock.notifyVersionChanged.mockRejectedValueOnce(
      new Error('live unavailable'),
    )

    try {
      const result = await createVersion({
        db,
        user: OWNER,
        shareableId: 'share1',
        file: htmlFile('replacement.html', '<p>replacement</p>'),
      })

      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') throw new Error('expected ok')
      expect(artifactLiveMock.getByName).toHaveBeenCalledWith('share1')
      expect(errorSpy).toHaveBeenCalledWith(
        'artifact_version_live_notify_failed',
        expect.objectContaining({
          shareable_id: 'share1',
          current_version_id: result.versionId,
          err: expect.any(Error),
        }),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('cross-workspace owner operations', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('createVersion bills the project workspace and consumes no contributor slot', async () => {
    await seedExternalProject(db)
    const initialBody = '<p>external</p>'
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', initialBody),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    const contributorsBefore = await db
      .selectFrom('workspace_members')
      .select(db.fn.count<number>('user_id').as('c'))
      .where('workspace_id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    const projectStorageBefore = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    const posterStorageBefore = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(projectStorageBefore.storage_used_bytes).toBe(initialBody.length)
    expect(posterStorageBefore.storage_used_bytes).toBe(0)

    const newBody = '<p>updated version</p>'
    const result = await createVersion({
      db,
      user: OWNER,
      shareableId: uploaded.id,
      file: htmlFile('v2.html', newBody),
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(artifactLiveMock.getByName).toHaveBeenCalledWith(uploaded.id)
    expect(artifactLiveMock.notifyVersionChanged).toHaveBeenCalledWith(
      result.versionId,
    )

    const projectStorageAfter = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    const posterStorageAfter = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(projectStorageAfter.storage_used_bytes).toBe(
      initialBody.length + newBody.length,
    )
    expect(posterStorageAfter.storage_used_bytes).toBe(0)

    const contributorsAfter = await db
      .selectFrom('workspace_members')
      .select(db.fn.count<number>('user_id').as('c'))
      .where('workspace_id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(contributorsAfter.c).toBe(contributorsBefore.c)
  })

  test('createVersion rejects cross-workspace version upload when destination plan is free', async () => {
    await seedExternalProject(db)
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>external</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    await db
      .updateTable('workspaces')
      .set({ plan: 'free' })
      .where('id', '=', EXT_WS)
      .execute()

    storageMock.putArtifact.mockClear()

    const result = await createVersion({
      db,
      user: OWNER,
      shareableId: uploaded.id,
      file: htmlFile('v2.html', '<p>blocked</p>'),
    })

    expect(result).toEqual({ kind: 'invalid-container' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('beginStaticSiteBundleVersionUploadSession rejects cross-workspace version when destination plan is free', async () => {
    await seedExternalProject(db)
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await begun.session.addFile(siteFile('/index.html', 16, 'text/html'))
    const created = await begun.session.commit('private')
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') throw new Error('expected ok')

    await db
      .updateTable('workspaces')
      .set({ plan: 'free' })
      .where('id', '=', EXT_WS)
      .execute()

    const versionBegun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      created.id,
      null,
    )

    expect(versionBegun).toEqual({ kind: 'invalid-container' })
  })

  test('beginStaticSiteBundleVersionUploadSession allows cross-workspace version when policy allows it', async () => {
    await seedExternalProject(db)
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      EXT_PROJECT,
      null,
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') throw new Error('expected ok')
    await begun.session.addFile(siteFile('/index.html', 16, 'text/html'))
    const created = await begun.session.commit('private')
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') throw new Error('expected ok')

    const versionBegun = await beginStaticSiteBundleVersionUploadSession(
      db,
      OWNER,
      created.id,
      null,
    )

    expect(versionBegun.kind).toBe('ok')
  })

  test('getOwnedShareableSummary and getOwnedArtifactRef return cross-workspace owned artifacts', async () => {
    await seedExternalProject(db)
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>external</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    const summary = await getOwnedShareableSummary(db, OWNER, uploaded.id)
    expect(summary).not.toBeNull()
    expect(summary!.id).toBe(uploaded.id)
    expect(summary!.projectId).toBe(EXT_PROJECT)

    const ref = await getOwnedArtifactRef(db, OWNER, uploaded.id)
    expect(ref).not.toBeNull()
    expect(ref!.artifactKind).toBe('html_page')
    expect(ref!.versionId).toBe(uploaded.versionId)
    expect(ref!.r2Key).not.toBeNull()
  })

  test('updateShareableMetadata updates cross-workspace owned artifacts', async () => {
    await seedExternalProject(db)
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>external</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    const result = await updateShareableMetadata(db, OWNER, uploaded.id, {
      visibility: 'workspace',
      titleOverride: 'Custom Title',
    })
    expect(result).toEqual({ kind: 'ok', linkExpiresAt: null })

    const row = await db
      .selectFrom('shareables')
      .select(['visibility', 'title_override'])
      .where('id', '=', uploaded.id)
      .executeTakeFirstOrThrow()
    expect(row.visibility).toBe('workspace')
    expect(row.title_override).toBe('Custom Title')
  })

  test('updateShareableMetadata clears expiry outside link and preserves omitted link expiry', async () => {
    await seedExternalProject(db)
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>external</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    const expiry = '2026-08-01T00:00:00.000Z'
    await db
      .updateTable('workspaces')
      .set({ link_expiry_default_days: 30 })
      .where('id', '=', EXT_WS)
      .execute()
    await db
      .updateTable('shareables')
      .set({ visibility: 'link', link_expires_at: expiry })
      .where('id', '=', uploaded.id)
      .execute()
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', EXT_WS)
      .execute()

    expect(
      await updateShareableMetadata(db, OWNER, uploaded.id, {
        titleOverride: 'Renamed',
      }),
    ).toEqual({ kind: 'ok', linkExpiresAt: expiry })
    let row = await db
      .selectFrom('shareables')
      .select(['visibility', 'link_expires_at'])
      .where('id', '=', uploaded.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ visibility: 'link', link_expires_at: expiry })

    expect(
      await updateShareableMetadata(db, OWNER, uploaded.id, {
        visibility: 'private',
      }),
    ).toEqual({ kind: 'ok', linkExpiresAt: null })
    row = await db
      .selectFrom('shareables')
      .select(['visibility', 'link_expires_at'])
      .where('id', '=', uploaded.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ visibility: 'private', link_expires_at: null })
  })

  test('non-owner cannot operate on cross-workspace artifacts owned by someone else', async () => {
    await seedExternalProject(db)
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext.html', '<p>external</p>'),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    await seedUser(db, 'other-user')
    const other = { id: 'other-user', workspaceId: 'ws-a' }

    const versionResult = await createVersion({
      db,
      user: other,
      shareableId: uploaded.id,
      file: htmlFile('hack.html', '<p>x</p>'),
    })
    expect(versionResult).toEqual({ kind: 'not-found' })
    expect(await getOwnedShareableSummary(db, other, uploaded.id)).toBeNull()
    expect(await getOwnedArtifactRef(db, other, uploaded.id)).toBeNull()
    expect(
      await updateShareableMetadata(db, other, uploaded.id, {
        visibility: 'workspace',
      }),
    ).toEqual({ kind: 'not-found' })
  })
})

describe('deleteShareable', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db, { storageUsedBytes: 3500 })
    await seedShareableWithVersions(db, {
      shareableId: 'share1',
      versions: [
        { id: 'v1', r2Key: 'artifacts/share1/v1/index.html', sizeBytes: 1500 },
        { id: 'v2', r2Key: 'artifacts/share1/v2/index.html', sizeBytes: 2000 },
      ],
    })
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('commits the D1 batch first, then deletes R2 objects, and decrements storage_used_bytes', async () => {
    let rowGoneAtR2Delete: boolean | null = null
    storageMock.deleteArtifact.mockImplementation(async () => {
      if (rowGoneAtR2Delete === null) {
        const row = await db
          .selectFrom('shareables')
          .select('id')
          .where('id', '=', 'share1')
          .executeTakeFirst()
        rowGoneAtR2Delete = row === undefined
      }
    })

    const result = await deleteShareable(db, OWNER, 'share1')

    expect(result).toEqual({ kind: 'ok' })
    expect(rowGoneAtR2Delete).toBe(true)
    expect(storageMock.deleteArtifact).toHaveBeenCalledTimes(2)

    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(0)
  })

  test('returns not-found for an unknown id and skips R2 / D1 work', async () => {
    const result = await deleteShareable(db, OWNER, 'missing')

    expect(result).toEqual({ kind: 'not-found' })
    expect(storageMock.deleteArtifact).not.toHaveBeenCalled()

    const workspace = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(workspace.storage_used_bytes).toBe(3500)
  })

  test('deletes both versions.r2_key and version_files.r2_key for a static_site bundle', async () => {
    // Seed a static_site shareable: entrypoint key in versions.r2_key plus two
    // asset keys living only in version_files. Without the fix, the asset
    // keys would never be passed to deleteArtifact.
    const containerId = await seedInboxContainer(db)
    await db
      .insertInto('shareables')
      .values({
        id: 'bundle1',
        workspace_id: 'ws-a',
        owner_user_id: 'owner-1',
        slug: null,
        name: 'index.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'static_site',
        visibility: 'private',
        current_version_id: 'bv1',
        view_count: 0,
        container_id: containerId,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'bv1',
        shareable_id: 'bundle1',
        artifact_kind: 'static_site',
        status: 'published',
        entrypoint_path: '/index.html',
        r2_key: 'ws-a/bundle1/bv1/index.html',
        size_bytes: 300,
        sha256: 'sha-bundle',
        created_by_id: 'owner-1',
        created_at: '2026-05-22T00:00:00.000Z',
        published_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('version_files')
      .values([
        {
          id: 'vf-index',
          version_id: 'bv1',
          path: '/index.html',
          r2_key: 'ws-a/bundle1/bv1/index.html',
          mime_type: 'text/html; charset=utf-8',
          size_bytes: 100,
          sha256: 'sha-i',
          scan_flags: null,
          created_at: '2026-05-22T00:00:00.000Z',
        },
        {
          id: 'vf-css',
          version_id: 'bv1',
          path: '/style.css',
          r2_key: 'ws-a/bundle1/bv1/style.css',
          mime_type: 'text/css; charset=utf-8',
          size_bytes: 100,
          sha256: 'sha-c',
          scan_flags: null,
          created_at: '2026-05-22T00:00:00.000Z',
        },
        {
          id: 'vf-js',
          version_id: 'bv1',
          path: '/app.js',
          r2_key: 'ws-a/bundle1/bv1/app.js',
          mime_type: 'text/javascript; charset=utf-8',
          size_bytes: 100,
          sha256: 'sha-j',
          scan_flags: null,
          created_at: '2026-05-22T00:00:00.000Z',
        },
      ])
      .execute()

    const result = await deleteShareable(db, OWNER, 'bundle1')

    expect(result).toEqual({ kind: 'ok' })
    const deletedKeys = storageMock.deleteArtifact.mock.calls.map(
      (call) => call[1],
    )
    expect(deletedKeys.sort()).toEqual([
      'ws-a/bundle1/bv1/app.js',
      'ws-a/bundle1/bv1/index.html',
      'ws-a/bundle1/bv1/style.css',
    ])
  })

  test('R2 delete failures are tolerated (best-effort, logged) and D1 still removes the row', async () => {
    storageMock.deleteArtifact.mockImplementation(async (key: string) => {
      if (key.includes('/v1/')) throw new Error('R2 down')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await deleteShareable(db, OWNER, 'share1')

    expect(result).toEqual({ kind: 'ok' })
    expect(errSpy).toHaveBeenCalled()

    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'share1')
      .executeTakeFirst()
    expect(remaining).toBeUndefined()

    errSpy.mockRestore()
  })

  test('owner deletes their own cross-workspace external posting and records the event', async () => {
    await seedExternalProject(db)
    const body = '<p>external delete</p>'
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('ext-delete.html', body),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') return

    const result = await deleteShareable(db, OWNER, uploaded.id)

    expect(result).toEqual({ kind: 'ok' })

    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(0)
    const posterWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', OWNER.workspaceId)
      .executeTakeFirstOrThrow()
    expect(posterWs.storage_used_bytes).toBe(3500)

    const events = await db.selectFrom('audit_events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      workspace_id: EXT_WS,
      actor_user_id: OWNER.id,
      action: 'artifact.delete',
      subject_type: 'shareable',
      subject_id: uploaded.id,
    })
    expect(JSON.parse(events[0]!.detail!)).toEqual({
      name: 'ext-delete.html',
      project_container_id: EXT_PROJECT,
      owner_user_id: OWNER.id,
    })
  })

  test('inbox shareable deletion does not record a delete event', async () => {
    const result = await deleteShareable(db, OWNER, 'share1')

    expect(result).toEqual({ kind: 'ok' })
    const events = await db.selectFrom('audit_events').select('id').execute()
    expect(events).toHaveLength(0)
  })

  test('cross-workspace manager deletes another poster project-visible shareable', async () => {
    await seedExternalProject(db, {
      posterEmail: OWNER.email,
      role: 'manager',
    })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'poster-share',
      ownerUserId: 'ext-admin-1',
      visibility: 'project',
      storageUsedBytes: 1200,
    })

    const result = await deleteShareable(db, OWNER, 'poster-share', {
      allowManagerDelete: true,
    })

    expect(result).toEqual({ kind: 'ok' })
    expect(storageMock.deleteArtifact).toHaveBeenCalledWith(
      expect.anything(),
      `${EXT_WS}/poster-share/v1/poster.html`,
    )
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'poster-share')
      .executeTakeFirst()
    expect(remaining).toBeUndefined()

    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(0)

    const events = await db.selectFrom('audit_events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor_user_id: OWNER.id,
      action: 'artifact.delete',
      subject_type: 'shareable',
      subject_id: 'poster-share',
      workspace_id: EXT_WS,
    })
    expect(JSON.parse(events[0]!.detail!)).toMatchObject({
      owner_user_id: 'ext-admin-1',
      project_container_id: EXT_PROJECT,
    })
  })

  test('manager cannot delete another poster private shareable', async () => {
    await seedExternalProject(db, {
      posterEmail: OWNER.email,
      role: 'manager',
    })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'private-poster',
      ownerUserId: 'ext-admin-1',
      visibility: 'private',
      storageUsedBytes: 1200,
    })

    const result = await deleteShareable(db, OWNER, 'private-poster', {
      allowManagerDelete: true,
    })

    expect(result).toEqual({ kind: 'not-found' })
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'private-poster')
      .executeTakeFirst()
    expect(remaining?.id).toBe('private-poster')
    const events = await db.selectFrom('audit_events').select('id').execute()
    expect(events).toHaveLength(0)
    const projectWs = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(projectWs.storage_used_bytes).toBe(1200)
  })

  test('manager deletion is rejected when external posting is disabled', async () => {
    await seedExternalProject(db, {
      posterEmail: OWNER.email,
      role: 'manager',
      plan: 'team',
      externalPostingEnabled: false,
    })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'flag-off-share',
      ownerUserId: 'ext-admin-1',
      visibility: 'project',
      storageUsedBytes: 1200,
    })

    const result = await deleteShareable(db, OWNER, 'flag-off-share', {
      allowManagerDelete: true,
    })

    expect(result).toEqual({ kind: 'not-found' })
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'flag-off-share')
      .executeTakeFirst()
    expect(remaining?.id).toBe('flag-off-share')
  })

  test('neither owner nor manager can delete a project shareable', async () => {
    await seedExternalProject(db, { role: 'viewer', posterEmail: OWNER.email })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'viewer-blocked',
      ownerUserId: 'ext-admin-1',
      visibility: 'project',
      storageUsedBytes: 1200,
    })

    const result = await deleteShareable(db, OWNER, 'viewer-blocked', {
      allowManagerDelete: true,
    })

    expect(result).toEqual({ kind: 'not-found' })
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'viewer-blocked')
      .executeTakeFirst()
    expect(remaining?.id).toBe('viewer-blocked')
  })

  test('concurrent delete does not duplicate the delete event', async () => {
    await seedExternalProject(db)
    const body = '<p>concurrent delete</p>'
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('concurrent-delete.html', body),
      'private',
      [],
      EXT_PROJECT,
      null,
    )
    expect(uploaded.kind).toBe('ok')
    if (uploaded.kind !== 'ok') return

    const storageBefore = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()

    sqliteRef.beforeNextBatch = async () => {
      await db.deleteFrom('shareables').where('id', '=', uploaded.id).execute()
    }

    const result = await deleteShareable(db, OWNER, uploaded.id)

    expect(result).toEqual({ kind: 'ok' })

    const events = await db.selectFrom('audit_events').select('id').execute()
    expect(events).toHaveLength(0)

    const storageAfter = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', EXT_WS)
      .executeTakeFirstOrThrow()
    expect(storageAfter.storage_used_bytes).toBe(
      storageBefore.storage_used_bytes,
    )
  })

  test('manager can delete a privately shared shareable', async () => {
    await seedExternalProject(db, {
      posterEmail: OWNER.email,
      role: 'manager',
    })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'granted-private',
      ownerUserId: 'ext-admin-1',
      visibility: 'private',
      storageUsedBytes: 1200,
    })
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'granted-private',
        granted_email: OWNER.email,
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: 'ext-admin-1',
      })
      .execute()

    const result = await deleteShareable(db, OWNER, 'granted-private', {
      allowManagerDelete: true,
    })

    expect(result).toEqual({ kind: 'ok' })
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'granted-private')
      .executeTakeFirst()
    expect(remaining).toBeUndefined()

    const events = await db.selectFrom('audit_events').selectAll().execute()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor_user_id: OWNER.id,
      action: 'artifact.delete',
      subject_type: 'shareable',
      subject_id: 'granted-private',
    })
    expect(JSON.parse(events[0]!.detail!)).toMatchObject({
      owner_user_id: 'ext-admin-1',
    })
  })

  test('manager cannot delete another poster shareable without allowManagerDelete opt-in', async () => {
    await seedExternalProject(db, {
      posterEmail: OWNER.email,
      role: 'manager',
    })
    await seedProjectShareableWithVersions(db, {
      shareableId: 'opt-in-required',
      ownerUserId: 'ext-admin-1',
      visibility: 'project',
      storageUsedBytes: 1200,
    })

    const result = await deleteShareable(db, OWNER, 'opt-in-required')

    expect(result).toEqual({ kind: 'not-found' })
    const remaining = await db
      .selectFrom('shareables')
      .select('id')
      .where('id', '=', 'opt-in-required')
      .executeTakeFirst()
    expect(remaining?.id).toBe('opt-in-required')
    expect(storageMock.deleteArtifact).not.toHaveBeenCalled()
    const events = await db.selectFrom('audit_events').select('id').execute()
    expect(events).toHaveLength(0)
  })
})

describe('stable keys (publish --key)', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seed(db)
    await seedProjectContainer(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  async function keyRows() {
    return await db
      .selectFrom('artifact_keys')
      .selectAll()
      .orderBy('created_at')
      .execute()
  }

  test('uploadShareable with a stable key inserts the key row alongside the shareable', async () => {
    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )

    expect(result.kind).toBe('ok')
    const rows = await keyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-a',
      owner_user_id: OWNER.id,
      container_id: 'project-a',
      stable_key: 'pr-482',
      shareable_id: result.kind === 'ok' ? result.id : '',
    })
  })

  test('紐付けありプロジェクトへの uploadShareable が Slack 通知 outbox に enqueue する', async () => {
    await seedSlackChannel(db, 'project-a')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('slack-notified.html', '<p>notified</p>'),
      'project',
      [],
      'project-a',
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const rows = await db
      .selectFrom('slack_notification_outbox')
      .selectAll()
      .where('shareable_id', '=', result.id)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      container_id: 'project-a',
      shareable_id: result.id,
    })
  })

  test('uploadShareable の options.slackNotify=false は Slack 通知 outbox に enqueue しない', async () => {
    await seedSlackChannel(db, 'project-a')

    const result = await uploadShareable(
      db,
      OWNER,
      htmlFile('slack-not-disabled.html', '<p>not notified</p>'),
      'project',
      [],
      'project-a',
      null,
      { slackNotify: false },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const rows = await db
      .selectFrom('slack_notification_outbox')
      .selectAll()
      .where('shareable_id', '=', result.id)
      .execute()
    expect(rows).toHaveLength(0)
  })

  test('resolveArtifactKey resolves create, then update, scoped to the destination', async () => {
    const first = await resolveArtifactKey(
      db,
      OWNER,
      'project-a',
      'pr-482',
      'single_file',
    )
    expect(first).toEqual({ kind: 'create', containerId: 'project-a' })

    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(uploaded.kind).toBe('ok')

    const second = await resolveArtifactKey(
      db,
      OWNER,
      'project-a',
      'pr-482',
      'single_file',
    )
    expect(second.kind).toBe('update')
    if (second.kind === 'update' && uploaded.kind === 'ok') {
      expect(second.shareableId).toBe(uploaded.id)
      expect(second.artifactKind).toBe('html_page')
    }

    // Same key in a different destination (the owner's inbox) is independent.
    const inbox = await resolveArtifactKey(
      db,
      OWNER,
      null,
      'pr-482',
      'single_file',
    )
    expect(inbox.kind).toBe('create')
  })

  test('resolveArtifactKey fails on kind mismatch and on a moved shareable', async () => {
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(uploaded.kind).toBe('ok')

    const mismatch = await resolveArtifactKey(
      db,
      OWNER,
      'project-a',
      'pr-482',
      'static_site',
    )
    expect(mismatch).toEqual({ kind: 'key-kind-mismatch' })

    const inboxId = await seedInboxContainer(db)
    await db
      .updateTable('shareables')
      .set({ container_id: inboxId })
      .where('id', '=', uploaded.kind === 'ok' ? uploaded.id : '')
      .execute()

    const moved = await resolveArtifactKey(
      db,
      OWNER,
      'project-a',
      'pr-482',
      'single_file',
    )
    expect(moved).toEqual({ kind: 'key-target-moved' })
  })

  test('uploadShareable returns key-conflict and rolls back when the key already exists', async () => {
    const first = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(first.kind).toBe('ok')

    const second = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v2</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(second).toEqual({ kind: 'key-conflict' })

    const shareables = await db.selectFrom('shareables').select('id').execute()
    expect(shareables).toHaveLength(1)
    expect(await keyRows()).toHaveLength(1)
  })

  test('createVersion with touchArtifactKeyId bumps the key row updated_at', async () => {
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(uploaded.kind).toBe('ok')
    const [keyRow] = await keyRows()
    await db
      .updateTable('artifact_keys')
      .set({ updated_at: '2000-01-01T00:00:00.000Z' })
      .where('id', '=', keyRow.id)
      .execute()

    const updated = await createVersion({
      db,
      user: OWNER,
      shareableId: uploaded.kind === 'ok' ? uploaded.id : '',
      file: htmlFile('report.html', '<p>v2</p>'),
      touchArtifactKeyId: keyRow.id,
    })
    expect(updated.kind).toBe('ok')

    const [touched] = await keyRows()
    expect(touched.updated_at > '2000-01-01T00:00:00.000Z').toBe(true)
  })

  test('static site create with a stable key inserts the key row on commit', async () => {
    const begun = await beginStaticSiteBundleUploadSession(
      db,
      OWNER,
      'project-a',
      'site-key',
    )
    expect(begun.kind).toBe('ok')
    if (begun.kind !== 'ok') return
    expect(
      (await begun.session.addFile(siteTextFile('index.html', '<p>hi</p>')))
        .kind,
    ).toBe('ok')

    const committed = await begun.session.commit('project')
    expect(committed.kind).toBe('ok')

    const rows = await keyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      container_id: 'project-a',
      stable_key: 'site-key',
    })
  })

  test('deleting the shareable cascades the key away so it can be reused', async () => {
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(uploaded.kind).toBe('ok')

    const removed = await deleteShareable(
      db,
      OWNER,
      uploaded.kind === 'ok' ? uploaded.id : '',
    )
    expect(removed.kind).toBe('ok')
    expect(await keyRows()).toHaveLength(0)
  })

  test('resolveArtifactKey returns key-target-moved when user workspace differs from shareable workspace', async () => {
    const uploaded = await uploadShareable(
      db,
      OWNER,
      htmlFile('report.html', '<p>v1</p>'),
      'project',
      [],
      'project-a',
      'pr-482',
    )
    expect(uploaded.kind).toBe('ok')

    await db
      .insertInto('workspaces')
      .values({
        id: 'ws-other',
        hd: null,
        name: 'Other workspace',
        created_at: '2026-05-22T00:00:00.000Z',
        plan: 'free',
        storage_quota_bytes: 104857600,
        storage_used_bytes: 0,
        storage_updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await db
      .updateTable('shareables')
      .set({ workspace_id: 'ws-other' })
      .where('id', '=', uploaded.kind === 'ok' ? uploaded.id : '')
      .execute()

    const resolution = await resolveArtifactKey(
      db,
      OWNER,
      'project-a',
      'pr-482',
      'single_file',
    )
    expect(resolution).toEqual({ kind: 'key-target-moved' })
  })

  test('normalizeArtifactKey trims and bounds the key', () => {
    expect(normalizeArtifactKey('  pr-482  ')).toBe('pr-482')
    expect(normalizeArtifactKey('   ')).toBeNull()
    expect(normalizeArtifactKey('k'.repeat(129))).toBeNull()
    expect(normalizeArtifactKey('k'.repeat(128))).toBe('k'.repeat(128))
  })
})

describe('member removal credential blocking', () => {
  const TEAM_WS = 'ws-team'
  const TEAM_PROJECT = 'team-project'
  const TEAM_ADMIN_ID = 'admin-1'
  const REMOVED_MEMBER_ID = 'member-2'

  const TEAM_ADMIN: SessionUser = {
    id: TEAM_ADMIN_ID,
    email: 'admin-1@example.com',
    emailVerified: true,
    name: 'Admin',
    image: null,
    workspaceId: TEAM_WS,
    hd: 'example.com',
    msTenantId: null,
    kind: 'human' as const,
    locale: null,
  }

  let db: Kysely<DB>

  beforeEach(async () => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    sqliteRef.current = fixture.sqlite
    sqliteRef.failNextBatch = false
    sqliteRef.beforeNextBatch = null
    nanoidMock.reset()
    nanoidMock.push(
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'shareable1',
      'version1',
      'version2',
      'shareable2',
      'version3',
      'version4',
    )
    storageMock.putArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifact.mockReset().mockResolvedValue(undefined)
    storageMock.deleteArtifactsByPrefix.mockReset().mockResolvedValue(undefined)
    await seedTeamWorkspaceForRemoval(db)
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  async function seedTeamWorkspaceForRemoval(fixtureDb: Kysely<DB>) {
    const now = '2026-05-22T00:00:00.000Z'
    await fixtureDb
      .insertInto('workspaces')
      .values({
        id: TEAM_WS,
        hd: 'example.com',
        name: 'Team workspace',
        created_at: now,
        plan: 'team',
        storage_quota_bytes: 53687091200,
        storage_used_bytes: 0,
        storage_updated_at: now,
      })
      .execute()

    for (const [userId, role] of [
      [TEAM_ADMIN_ID, 'admin'],
      [REMOVED_MEMBER_ID, 'member'],
    ] as const) {
      await fixtureDb
        .insertInto('users')
        .values({
          id: userId,
          email: `${userId}@example.com`,
          email_verified: 1,
          name: userId,
          image: null,
          created_at: now,
          updated_at: now,
          workspace_id: TEAM_WS,
          locale: null,
        })
        .execute()
      await fixtureDb
        .insertInto('workspace_members')
        .values({
          workspace_id: TEAM_WS,
          user_id: userId,
          role,
          status: 'active',
          first_contributed_at: role === 'member' ? now : null,
          last_contributed_at: role === 'member' ? now : null,
          pending_uploads: 0,
          created_at: now,
          updated_at: now,
        })
        .execute()
    }

    await fixtureDb
      .insertInto('artifact_containers')
      .values({
        id: TEAM_PROJECT,
        workspace_id: TEAM_WS,
        kind: 'project',
        owner_user_id: null,
        created_by_id: TEAM_ADMIN_ID,
        name: 'Team project',
        description: null,
        archived_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute()
  }

  function removedMemberUser(workspaceId: string): SessionUser {
    return {
      id: REMOVED_MEMBER_ID,
      email: 'member-2@example.com',
      emailVerified: true,
      name: 'Member 2',
      image: null,
      workspaceId,
      hd: 'example.com',
      msTenantId: null,
      kind: 'human' as const,
      locale: null,
    }
  }

  async function removeMember() {
    const result = await removeWorkspaceMember(
      db,
      { id: TEAM_ADMIN_ID, workspaceId: TEAM_WS },
      REMOVED_MEMBER_ID,
    )
    expect(result).toEqual({ kind: 'ok' })
    return (
      await db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', REMOVED_MEMBER_ID)
        .executeTakeFirstOrThrow()
    ).workspace_id
  }

  async function uploadMemberArtifact(stableKey: string | null = null) {
    const uploaded = await uploadShareable(
      db,
      removedMemberUser(TEAM_WS),
      htmlFile('member-report.html', '<p>member artifact</p>'),
      'workspace',
      [],
      TEAM_PROJECT,
      stableKey,
    )
    expect(uploaded.kind).toBe('ok')
    return uploaded
  }

  test('API token resolves to the personal workspace after removal', async () => {
    const created = await createApiToken(db, REMOVED_MEMBER_ID, 'CI deploy')
    const personalWorkspaceId = await removeMember()

    const resolved = await findUserByApiToken(db, created.token)
    expect(resolved?.workspace_id).toBe(personalWorkspaceId)
    expect(resolved?.workspace_id).not.toBe(TEAM_WS)
  })

  test('removed member cannot list or post to the old workspace project via API paths', async () => {
    const uploaded = await uploadMemberArtifact()
    if (uploaded.kind !== 'ok') throw new Error('expected ok')
    const personalWorkspaceId = await removeMember()
    const removedUser = removedMemberUser(personalWorkspaceId)

    await expect(
      listCliArtifacts(db, removedUser, {
        baseUrl: 'https://artifactshare.test',
        projectId: TEAM_PROJECT,
      }),
    ).resolves.toEqual({ kind: 'invalid-project' })

    await expect(
      resolveUploadContainer(
        db,
        removedUser,
        TEAM_PROJECT,
        '2026-05-22T00:00:00.000Z',
      ),
    ).resolves.toEqual({ kind: 'invalid-container' })
  })

  test('artifact key version update is rejected after member removal', async () => {
    const uploaded = await uploadMemberArtifact('pr-482')
    if (uploaded.kind !== 'ok') throw new Error('expected ok')
    const personalWorkspaceId = await removeMember()
    const removedUser = removedMemberUser(personalWorkspaceId)

    const resolution = await resolveArtifactKey(
      db,
      removedUser,
      TEAM_PROJECT,
      'pr-482',
      'single_file',
    )
    expect(resolution).toEqual({ kind: 'invalid-container' })

    storageMock.putArtifact.mockClear()
    const updated = await createVersion({
      db,
      user: removedUser,
      shareableId: uploaded.id,
      file: htmlFile('member-report.html', '<p>blocked update</p>'),
    })
    expect(updated).toEqual({ kind: 'invalid-container' })
    expect(storageMock.putArtifact).not.toHaveBeenCalled()
  })

  test('removing a slot-consuming member frees contributor capacity', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'free', storage_quota_bytes: 104857600 })
      .where('id', '=', TEAM_WS)
      .execute()

    const now = '2026-05-22T00:00:00.000Z'
    for (const id of ['slot-2', 'slot-3', 'slot-4']) {
      await db
        .insertInto('users')
        .values({
          id,
          email: `${id}@example.com`,
          email_verified: 1,
          name: id,
          image: null,
          created_at: now,
          updated_at: now,
          workspace_id: TEAM_WS,
          locale: null,
        })
        .execute()
      if (id !== 'slot-4') {
        await db
          .insertInto('workspace_members')
          .values({
            workspace_id: TEAM_WS,
            user_id: id,
            role: 'member',
            status: 'active',
            first_contributed_at: now,
            last_contributed_at: now,
            pending_uploads: 0,
            created_at: now,
            updated_at: now,
          })
          .execute()
      }
    }

    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: TEAM_WS,
        user_id: 'slot-4',
        role: 'member',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute()

    const blocked = await uploadShareable(
      db,
      {
        id: 'slot-4',
        email: 'slot-4@example.com',
        emailVerified: true,
        workspaceId: TEAM_WS,
        hd: 'example.com',
      },
      htmlFile('blocked.html', '<p>blocked</p>'),
      'private',
      [],
      null,
      null,
      { contributorGuardrailLimit: 3 },
    )
    expect(blocked).toEqual({ kind: 'contributor-limit-exceeded' })

    await removeMember()

    const allowed = await uploadShareable(
      db,
      {
        id: 'slot-4',
        email: 'slot-4@example.com',
        emailVerified: true,
        workspaceId: TEAM_WS,
        hd: 'example.com',
      },
      htmlFile('allowed.html', '<p>allowed</p>'),
      'private',
    )
    expect(allowed.kind).toBe('ok')
  })

  test('removed member artifacts remain in the old workspace for other members', async () => {
    const uploaded = await uploadMemberArtifact()
    if (uploaded.kind !== 'ok') throw new Error('expected ok')

    const now = '2026-05-22T00:00:00.000Z'
    await db
      .insertInto('comment_threads')
      .values({
        id: 'thread-1',
        shareable_id: uploaded.id,
        status: 'open',
        created_by_id: REMOVED_MEMBER_ID,
        resolved_by_id: null,
        resolved_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await db
      .insertInto('comment_messages')
      .values({
        id: 'message-1',
        thread_id: 'thread-1',
        body: 'keep me',
        agent: null,
        created_by_id: REMOVED_MEMBER_ID,
        created_at: now,
        updated_at: now,
      })
      .execute()

    await removeMember()

    const shareable = await db
      .selectFrom('shareables')
      .select(['id', 'workspace_id', 'owner_user_id'])
      .where('id', '=', uploaded.id)
      .executeTakeFirstOrThrow()
    expect(shareable).toMatchObject({
      id: uploaded.id,
      workspace_id: TEAM_WS,
      owner_user_id: REMOVED_MEMBER_ID,
    })

    const versions = await db
      .selectFrom('versions')
      .select('id')
      .where('shareable_id', '=', uploaded.id)
      .execute()
    expect(versions).toHaveLength(1)

    const comments = await db
      .selectFrom('comment_messages')
      .select('body')
      .where('thread_id', '=', 'thread-1')
      .execute()
    expect(comments).toEqual([{ body: 'keep me' }])

    const access = await loadCommentAccess(db, TEAM_ADMIN, uploaded.id)
    expect(access?.shareableId).toBe(uploaded.id)

    const adminArtifact = await uploadShareable(
      db,
      TEAM_ADMIN,
      htmlFile('admin-owned.html', '<p>admin</p>'),
      'workspace',
      [],
      TEAM_PROJECT,
    )
    expect(adminArtifact.kind).toBe('ok')
    if (adminArtifact.kind !== 'ok') throw new Error('expected ok')

    const updated = await createVersion({
      db,
      user: TEAM_ADMIN,
      shareableId: adminArtifact.id,
      file: htmlFile('admin-owned.html', '<p>admin v2</p>'),
    })
    expect(updated.kind).toBe('ok')
  })
})

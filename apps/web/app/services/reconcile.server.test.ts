import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { VersionStatus } from '~/lib/shareable-types'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const storageMock = vi.hoisted(() => ({
  putArtifact: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  headArtifact: vi.fn(),
  listArtifacts: vi.fn(),
  deleteArtifacts: vi.fn(),
  artifactR2Key: vi.fn(),
  artifactContentType: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {}, DB: {} },
}))

vi.mock('./storage.server', () => storageMock)

const {
  reconcileQuota,
  reconcileR2Orphans,
  runReconciliation,
  verifyR2References,
} = await import('./reconcile.server')

const NOW = new Date('2026-05-22T17:00:00.000Z')
const QUOTA_GRACE_BEFORE = '2026-05-22T15:30:00.000Z' // 1.5h ago (outside grace)
const QUOTA_GRACE_INSIDE = '2026-05-22T16:30:00.000Z' // 30 min ago (inside grace)

async function seedWorkspaceAndUser(
  db: Kysely<DB>,
  args: {
    userId?: string
    storageUsedBytes?: number
    storageUpdatedAt?: string
  } = {},
) {
  const userId = args.userId ?? 'owner-1'
  await db
    .insertInto('workspaces')
    .values({
      id: `ws-${userId}`,
      hd: 'example.com',
      name: 'Workspace',
      created_at: '2026-05-22T00:00:00.000Z',
      plan: 'free',
      storage_quota_bytes: 104857600,
      storage_used_bytes: args.storageUsedBytes ?? 0,
      storage_updated_at: args.storageUpdatedAt ?? QUOTA_GRACE_BEFORE,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute()
  await db
    .insertInto('users')
    .values({
      id: userId,
      email: `${userId}@example.com`,
      email_verified: 1,
      name: 'User',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: `ws-${userId}`,
      locale: null,
    })
    .execute()
}

async function seedShareableWithVersion(
  db: Kysely<DB>,
  args: {
    userId: string
    shareableId: string
    versionId: string
    r2Key: string
    sizeBytes: number
    status?: VersionStatus
  },
) {
  await db
    .insertInto('artifact_containers')
    .values({
      id: `inbox-${args.userId}`,
      workspace_id: `ws-${args.userId}`,
      kind: 'inbox',
      owner_user_id: args.userId,
      created_by_id: args.userId,
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: args.shareableId,
      workspace_id: `ws-${args.userId}`,
      owner_user_id: args.userId,
      slug: null,
      name: 'doc.html',
      derived_title: 'Doc',
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'private',
      current_version_id: args.versionId,
      view_count: 0,
      container_id: `inbox-${args.userId}`,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()

  await db
    .insertInto('versions')
    .values({
      id: args.versionId,
      shareable_id: args.shareableId,
      artifact_kind: 'html_page',
      status: args.status ?? 'published',
      entrypoint_path: '/doc.html',
      r2_key: args.r2Key,
      size_bytes: args.sizeBytes,
      sha256: 'sha-fake',
      created_by_id: args.userId,
      created_at: '2026-05-22T00:00:00.000Z',
      published_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
}

const fakeBucket = {} as R2Bucket

describe('reconcileQuota', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('quota_underreport: corrects user with recorded > SUM(size_bytes)', async () => {
    await seedWorkspaceAndUser(db, { storageUsedBytes: 1024 + 1024 })
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'artifacts/share1/v1/index.html',
      sizeBytes: 1024,
    })

    const result = await reconcileQuota(db, NOW)

    expect(result.diffs_found).toBe(1)
    expect(result.bytes_over_corrected).toBe(1024)
    expect(result.top_diffs[0]).toMatchObject({
      workspace_id: 'ws-owner-1',
      recorded: 2048,
      actual: 1024,
    })
    const updated = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', 'ws-owner-1')
      .executeTakeFirstOrThrow()
    expect(updated.storage_used_bytes).toBe(1024)
  })

  test('quota_no_drift: no UPDATE when recorded matches SUM', async () => {
    await seedWorkspaceAndUser(db, { storageUsedBytes: 1024 })
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'artifacts/share1/v1/index.html',
      sizeBytes: 1024,
    })

    const result = await reconcileQuota(db, NOW)
    expect(result.diffs_found).toBe(0)
    expect(result.bytes_over_corrected).toBe(0)
    expect(result.workspaces_checked).toBe(1)
  })

  test('quota_grace: skip user with updated_at within grace window', async () => {
    await seedWorkspaceAndUser(db, {
      storageUsedBytes: 999_999,
      storageUpdatedAt: QUOTA_GRACE_INSIDE,
    })
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'artifacts/share1/v1/index.html',
      sizeBytes: 1024,
    })

    const result = await reconcileQuota(db, NOW)
    expect(result.diffs_found).toBe(0)
    expect(result.workspaces_checked).toBe(0)
    const row = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', 'ws-owner-1')
      .executeTakeFirstOrThrow()
    expect(row.storage_used_bytes).toBe(999_999)
  })

  // NOTE: race_skipped (SELECT/UPDATE race) は production code 側の
  // `WHERE storage_updated_at < cutoff AND storage_used_bytes = row.recorded` で防御
  // しているが、unit test で再現するには「reconcile の SELECT と UPDATE の間に
  // 外部から書き換える」hook が必要で、Kysely の executor 経路を信頼できる形で
  // spy できる test seam が無い。test は省略し、production code の SQL 条件で
  // 担保する。

  test('quota_published_only: excludes uploading versions from actual', async () => {
    await seedWorkspaceAndUser(db, { storageUsedBytes: 3000 })
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'artifacts/share1/v1/index.html',
      sizeBytes: 1000,
      status: 'published',
    })
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share2',
      versionId: 'v2',
      r2Key: 'artifacts/share2/v2/index.html',
      sizeBytes: 2000,
      status: 'uploading',
    })

    const result = await reconcileQuota(db, NOW)
    expect(result.diffs_found).toBe(1)
    expect(result.bytes_over_corrected).toBe(2000)
    const row = await db
      .selectFrom('workspaces')
      .select('storage_used_bytes')
      .where('id', '=', 'ws-owner-1')
      .executeTakeFirstOrThrow()
    expect(row.storage_used_bytes).toBe(1000)
  })
})

describe('reconcileR2Orphans', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    storageMock.listArtifacts.mockReset().mockResolvedValue({
      objects: [],
      cursor: null,
    })
    storageMock.deleteArtifacts.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('r2_orphan_old: deletes keys past grace not referenced by versions', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'artifacts/share1/v1/index.html',
      sizeBytes: 1024,
    })
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [
        {
          key: 'artifacts/share1/v1/index.html',
          uploaded: twoDaysAgo,
          size: 1024,
        },
        {
          key: 'artifacts/orphan/v1/index.html',
          uploaded: twoDaysAgo,
          size: 99,
        },
      ],
      cursor: null,
    })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)

    expect(result.orphans_deleted).toBe(1)
    expect(result.orphans_skipped_grace).toBe(0)
    expect(result.r2_scanned).toBe(2)
    expect(result.d1_versions).toBe(1)
    expect(storageMock.deleteArtifacts).toHaveBeenCalledWith(fakeBucket, [
      'artifacts/orphan/v1/index.html',
    ])
  })

  test('r2_orphan_grace: skips keys uploaded within grace window', async () => {
    await seedWorkspaceAndUser(db)
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000)
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [
        {
          key: 'artifacts/draft/v1/index.html',
          uploaded: oneHourAgo,
          size: 50,
        },
      ],
      cursor: null,
    })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)
    expect(result.orphans_deleted).toBe(0)
    expect(result.orphans_skipped_grace).toBe(1)
    expect(storageMock.deleteArtifacts).not.toHaveBeenCalled()
  })

  test('r2_list_pagination: collects orphans across pages and deletes in one bulk', async () => {
    await seedWorkspaceAndUser(db)
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
    storageMock.listArtifacts
      .mockResolvedValueOnce({
        objects: [
          {
            key: 'artifacts/orphan/a/index.html',
            uploaded: twoDaysAgo,
            size: 1,
          },
        ],
        cursor: 'next',
      })
      .mockResolvedValueOnce({
        objects: [
          {
            key: 'artifacts/orphan/b/index.html',
            uploaded: twoDaysAgo,
            size: 1,
          },
        ],
        cursor: null,
      })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)
    expect(result.r2_scanned).toBe(2)
    expect(result.orphans_deleted).toBe(2)
    expect(storageMock.deleteArtifacts).toHaveBeenCalledTimes(1)
    expect(storageMock.deleteArtifacts).toHaveBeenCalledWith(fakeBucket, [
      'artifacts/orphan/a/index.html',
      'artifacts/orphan/b/index.html',
    ])
  })

  test.each(['failed', 'blocked'] as const)(
    'r2_terminal_%s: reclaims keys held by terminal-failure versions',
    async (status) => {
      await seedWorkspaceAndUser(db)
      await seedShareableWithVersion(db, {
        userId: 'owner-1',
        shareableId: 'share1',
        versionId: 'v1',
        r2Key: 'artifacts/share1/v1/index.html',
        sizeBytes: 1024,
        status,
      })
      const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
      storageMock.listArtifacts.mockResolvedValueOnce({
        objects: [
          {
            key: 'artifacts/share1/v1/index.html',
            uploaded: twoDaysAgo,
            size: 1024,
          },
        ],
        cursor: null,
      })

      const result = await reconcileR2Orphans(db, fakeBucket, NOW)
      expect(result.orphans_deleted).toBe(1)
      expect(result.d1_versions).toBe(0)
      expect(storageMock.deleteArtifacts).toHaveBeenCalledWith(fakeBucket, [
        'artifacts/share1/v1/index.html',
      ])
    },
  )

  test('r2_static_site_bundle: protects keys held only in version_files', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'ws-owner-1/share1/v1/index.html',
      sizeBytes: 1024,
    })
    // The asset key lives in version_files only (no row in versions). Without
    // the version_files join in reconcile, this key would be classified as
    // orphaned and deleted after R2_GRACE_MS.
    await db
      .insertInto('version_files')
      .values({
        id: 'vf1',
        version_id: 'v1',
        path: '/assets/app.js',
        r2_key: 'ws-owner-1/share1/v1/assets/app.js',
        mime_type: 'text/javascript; charset=utf-8',
        size_bytes: 200,
        sha256: 'sha-asset',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [
        {
          key: 'ws-owner-1/share1/v1/index.html',
          uploaded: twoDaysAgo,
          size: 1024,
        },
        {
          key: 'ws-owner-1/share1/v1/assets/app.js',
          uploaded: twoDaysAgo,
          size: 200,
        },
      ],
      cursor: null,
    })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)
    expect(result.orphans_deleted).toBe(0)
    expect(storageMock.deleteArtifacts).not.toHaveBeenCalled()
  })

  test.each(['uploading', 'scanning'] as const)(
    'r2_inflight_%s: protects keys referenced by in-flight versions',
    async (status) => {
      await seedWorkspaceAndUser(db)
      await seedShareableWithVersion(db, {
        userId: 'owner-1',
        shareableId: 'share1',
        versionId: 'v1',
        r2Key: 'artifacts/share1/v1/index.html',
        sizeBytes: 1024,
        status,
      })
      const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
      storageMock.listArtifacts.mockResolvedValueOnce({
        objects: [
          {
            key: 'artifacts/share1/v1/index.html',
            uploaded: twoDaysAgo,
            size: 1024,
          },
        ],
        cursor: null,
      })

      const result = await reconcileR2Orphans(db, fakeBucket, NOW)
      expect(result.orphans_deleted).toBe(0)
      expect(result.d1_versions).toBe(1)
      expect(storageMock.deleteArtifacts).not.toHaveBeenCalled()
    },
  )

  test('r2_non_artifact_prefix: never enumerates avatars or unknown namespaces', async () => {
    await seedWorkspaceAndUser(db)
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [
        {
          key: 'avatars/owner-1.jpg',
          uploaded: twoDaysAgo,
          size: 100,
        },
        {
          key: 'future-service/data.bin',
          uploaded: twoDaysAgo,
          size: 100,
        },
      ],
      cursor: null,
    })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)

    expect(result.r2_scanned).toBe(2)
    expect(storageMock.listArtifacts).toHaveBeenCalledOnce()
    expect(storageMock.listArtifacts).toHaveBeenCalledWith(
      fakeBucket,
      undefined,
    )
    expect(storageMock.deleteArtifacts).not.toHaveBeenCalled()
  })

  test('r2_deleted_workspace_bundle: reclaims a structurally valid static-site key', async () => {
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
    const key = 'Abcdefghijklmnopqrstu/site123abc/Abcdefghijklmnop/index.html'
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [{ key, uploaded: twoDaysAgo, size: 100 }],
      cursor: null,
    })

    const result = await reconcileR2Orphans(db, fakeBucket, NOW)

    expect(result.orphans_deleted).toBe(1)
    expect(storageMock.deleteArtifacts).toHaveBeenCalledWith(fakeBucket, [key])
  })
})

describe('verifyR2References', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    storageMock.listArtifacts.mockReset().mockResolvedValue({
      objects: [],
      cursor: null,
    })
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('r2_reference_ok: heads version and version_files keys', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'ws-owner-1/share1/v1/index.html',
      sizeBytes: 1024,
    })
    await db
      .insertInto('version_files')
      .values({
        id: 'vf1',
        version_id: 'v1',
        path: '/assets/app.js',
        r2_key: 'ws-owner-1/share1/v1/assets/app.js',
        mime_type: 'text/javascript; charset=utf-8',
        size_bytes: 200,
        sha256: 'sha-asset',
        scan_flags: null,
        created_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    storageMock.listArtifacts.mockResolvedValueOnce({
      objects: [
        {
          key: 'ws-owner-1/share1/v1/index.html',
          uploaded: NOW,
          size: 1024,
        },
        {
          key: 'ws-owner-1/share1/v1/assets/app.js',
          uploaded: NOW,
          size: 200,
        },
      ],
      cursor: null,
    })

    const result = await verifyR2References(db, fakeBucket)

    expect(result.d1_objects).toBe(2)
    expect(result.r2_scanned).toBe(2)
    expect(result.missing_objects).toBe(0)
    expect(storageMock.listArtifacts).toHaveBeenCalledWith(
      fakeBucket,
      undefined,
    )
  })

  test('r2_reference_missing: throws when a referenced key is absent', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'missing/index.html',
      sizeBytes: 1024,
    })

    await expect(verifyR2References(db, fakeBucket)).rejects.toThrow(
      'R2 reference check failed: 1 missing object(s)',
    )
  })

  test('r2_reference_delete_race: ignores references deleted before the final check', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'race/index.html',
      sizeBytes: 1024,
    })
    storageMock.listArtifacts.mockImplementationOnce(async () => {
      await db.deleteFrom('shareables').where('id', '=', 'share1').execute()
      return {
        objects: [],
        cursor: null,
      }
    })

    const result = await verifyR2References(db, fakeBucket)

    expect(result.d1_objects).toBe(1)
    expect(result.missing_objects).toBe(0)
    expect(result.missing_keys).toEqual([])
  })

  test('r2_reference_terminal: ignores terminal-failure versions', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'failed/index.html',
      sizeBytes: 1024,
      status: 'failed',
    })

    const result = await verifyR2References(db, fakeBucket)

    expect(result.d1_objects).toBe(0)
    expect(storageMock.listArtifacts).toHaveBeenCalledWith(
      fakeBucket,
      undefined,
    )
  })

  test.each(['uploading', 'scanning'] as const)(
    'r2_reference_%s: ignores pre-publish versions',
    async (status) => {
      await seedWorkspaceAndUser(db)
      await seedShareableWithVersion(db, {
        userId: 'owner-1',
        shareableId: 'share1',
        versionId: 'v1',
        r2Key: `${status}/index.html`,
        sizeBytes: 1024,
        status,
      })

      const result = await verifyR2References(db, fakeBucket)

      expect(result.d1_objects).toBe(0)
      expect(result.missing_objects).toBe(0)
    },
  )
})

describe('runReconciliation', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    db = fixture.db
    storageMock.listArtifacts.mockReset().mockResolvedValue({
      objects: [],
      cursor: null,
    })
    storageMock.deleteArtifacts.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('throws AggregateError when r2 job fails so dashboard records failure', async () => {
    await seedWorkspaceAndUser(db)
    storageMock.listArtifacts
      .mockReset()
      .mockRejectedValueOnce(new Error('induced r2 failure'))
      .mockResolvedValue({
        objects: [],
        cursor: null,
      })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runReconciliation(db, fakeBucket, NOW)).rejects.toThrow(
      AggregateError,
    )

    const events = logSpy.mock.calls.map(
      (call) => JSON.parse(call[0] as string).event,
    )
    // quota succeeds, daily usage succeeds, r2 fails, r2 references succeeds,
    // done emits failed_jobs > 0, then we throw.
    expect(events).toEqual([
      'reconcile_start',
      'reconcile_view_events_prune_done',
      'reconcile_quota_done',
      'reconcile_daily_usage_done',
      'reconcile_billing_overage_skipped',
      'reconcile_error',
      'reconcile_r2_references_done',
      'reconcile_security_audit_cleanup_done',
      'reconcile_done',
    ])
    const doneLog = JSON.parse(logSpy.mock.calls[8]?.[0] as string)
    expect(doneLog.failed_jobs).toBe(1)
    logSpy.mockRestore()
  })

  test('emits structured log lines in order', async () => {
    await seedWorkspaceAndUser(db)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runReconciliation(db, fakeBucket, NOW)

    const events = logSpy.mock.calls.map(
      (call) => JSON.parse(call[0] as string).event,
    )
    expect(events).toEqual([
      'reconcile_start',
      'reconcile_view_events_prune_done',
      'reconcile_quota_done',
      'reconcile_daily_usage_done',
      'reconcile_billing_overage_skipped',
      'reconcile_r2_done',
      'reconcile_r2_references_done',
      'reconcile_security_audit_cleanup_done',
      'reconcile_done',
    ])
    logSpy.mockRestore()
  })

  test('skips billing overage charge when stripe is not configured', async () => {
    await seedWorkspaceAndUser(db)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runReconciliation(db, fakeBucket, NOW)

    const events = logSpy.mock.calls.map(
      (call) => JSON.parse(call[0] as string).event,
    )
    expect(events).toContain('reconcile_billing_overage_skipped')
    logSpy.mockRestore()
  })

  test('throws AggregateError when referenced R2 object is missing', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'missing/index.html',
      sizeBytes: 1024,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(runReconciliation(db, fakeBucket, NOW)).rejects.toThrow(
      AggregateError,
    )

    const errorLog = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string))
      .find((event) => event.job === 'r2_references')
    expect(errorLog).toMatchObject({
      event: 'reconcile_error',
      job: 'r2_references',
      missing_objects: 1,
      missing_keys: ['missing/index.html'],
    })
    logSpy.mockRestore()
  })

  test('prunes only view events older than 90 days', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'x',
      sizeBytes: 1,
    })
    await db
      .updateTable('versions')
      .set({ status: 'failed' })
      .where('id', '=', 'v1')
      .execute()
    await db
      .insertInto('events')
      .values([
        {
          id: 'old-view',
          workspace_id: 'ws-owner-1',
          type: 'artifact_viewed',
          shareable_id: 'share1',
          actor_user_id: null,
          subject_id: null,
          created_at: '2026-02-20T00:00:00.000Z',
        },
        {
          id: 'new-view',
          workspace_id: 'ws-owner-1',
          type: 'artifact_viewed',
          shareable_id: 'share1',
          actor_user_id: null,
          subject_id: null,
          created_at: '2026-02-22T00:00:00.000Z',
        },
        {
          id: 'old-created',
          workspace_id: 'ws-owner-1',
          type: 'artifact_created',
          shareable_id: 'share1',
          actor_user_id: 'owner-1',
          subject_id: 'v1',
          created_at: '2026-02-20T00:00:00.000Z',
        },
      ])
      .execute()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runReconciliation(db, fakeBucket, NOW)
    logSpy.mockRestore()
    expect(
      (await db.selectFrom('events').select('id').execute()).map((r) => r.id),
    ).toEqual(expect.arrayContaining(['new-view', 'old-created']))
    expect(
      await db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', 'old-view')
        .execute(),
    ).toEqual([])
  })

  test('pruneViewEventsQuery honors its limit', async () => {
    await seedWorkspaceAndUser(db)
    await seedShareableWithVersion(db, {
      userId: 'owner-1',
      shareableId: 'share1',
      versionId: 'v1',
      r2Key: 'x',
      sizeBytes: 1,
    })
    await db
      .insertInto('events')
      .values([
        {
          id: 'old-a',
          workspace_id: 'ws-owner-1',
          type: 'artifact_viewed',
          shareable_id: 'share1',
          actor_user_id: null,
          subject_id: null,
          created_at: '2026-01-01',
        },
        {
          id: 'old-b',
          workspace_id: 'ws-owner-1',
          type: 'artifact_viewed',
          shareable_id: 'share1',
          actor_user_id: null,
          subject_id: null,
          created_at: '2026-01-02',
        },
      ])
      .execute()
    await (
      await import('./events.server')
    )
      .pruneViewEventsQuery(db, { cutoffIso: '2026-02-01', limit: 1 })
      .execute()
    expect(
      await db
        .selectFrom('events')
        .selectAll()
        .where('type', '=', 'artifact_viewed')
        .execute(),
    ).toHaveLength(1)
  })
})

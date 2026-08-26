import { type Kysely, sql } from 'kysely'
import type Stripe from 'stripe'
import type { DB } from '~/types/db'
import {
  createMonthlyOverageCharges,
  snapshotDailyStorageUsage,
} from './billing-usage.server'
import { deleteArtifacts, listArtifacts } from './storage.server'
import { pruneViewEventsQuery } from './events.server'
import {
  cleanupExpiredSecurityAuditRecords,
  SECURITY_AUDIT_CLEANUP_BATCH_SIZE,
} from './security-audit.server'

export type ReconciliationOptions = {
  stripe?: Stripe
  overageProductId?: string
}

const QUOTA_GRACE_MS = 60 * 60 * 1000
const R2_GRACE_MS = 24 * 60 * 60 * 1000
const TOP_DIFFS_LIMIT = 10

interface QuotaDiff {
  workspace_id: string
  recorded: number
  actual: number
}

export interface QuotaReconcileResult {
  duration_ms: number
  workspaces_checked: number
  diffs_found: number
  // Split positive (recorded > actual: we shrunk the recorded value down) and
  // negative (recorded < actual: we lifted the recorded value up) corrections
  // into two scalars so a daily log can be summed without sign cancellation.
  bytes_over_corrected: number
  bytes_under_corrected: number
  // Number of diffs we detected at SELECT time but skipped at UPDATE time
  // because the row changed in the gap (reserveQuota / releaseQuota /
  // deleteShareable raced us). Non-zero is benign — next cron picks them up.
  race_skipped: number
  top_diffs: QuotaDiff[]
}

export interface R2ReconcileResult {
  duration_ms: number
  r2_scanned: number
  d1_versions: number
  orphans_deleted: number
  orphans_skipped_grace: number
}

export interface R2ReferenceCheckResult {
  duration_ms: number
  r2_scanned: number
  d1_objects: number
  missing_objects: number
  missing_keys: string[]
}

export async function reconcileQuota(
  db: Kysely<DB>,
  now: Date,
): Promise<QuotaReconcileResult> {
  const start = Date.now()
  const graceCutoffIso = new Date(now.getTime() - QUOTA_GRACE_MS).toISOString()

  const result = await sql<{
    id: string
    recorded: number
    actual: number
  }>`
    SELECT
      w.id,
      w.storage_used_bytes AS recorded,
      COALESCE(a.actual, 0) AS actual
    FROM workspaces w
    LEFT JOIN (
      SELECT s.workspace_id, SUM(v.size_bytes) AS actual
      FROM versions v
      INNER JOIN shareables s ON s.id = v.shareable_id
      WHERE v.status = 'published'
      GROUP BY s.workspace_id
    ) a ON a.workspace_id = w.id
    WHERE w.storage_updated_at < ${graceCutoffIso}
  `.execute(db)

  const rows = result.rows
  const diffs: QuotaDiff[] = []
  let bytesOverCorrected = 0
  let bytesUnderCorrected = 0
  let raceSkipped = 0

  for (const row of rows) {
    if (row.recorded !== row.actual) {
      diffs.push({
        workspace_id: row.id,
        recorded: row.recorded,
        actual: row.actual,
      })
      // Optimistic concurrency: only apply the correction if the row is
      // exactly as we read it. reserveQuota / releaseQuota / deleteShareable
      // running between SELECT and UPDATE would bump storage_updated_at (now within
      // grace) or storage_used_bytes; either way our pre-image WHERE bails
      // and we skip the row. Next cron handles the now-fresh state.
      const updateResult = await db
        .updateTable('workspaces')
        .set({ storage_used_bytes: row.actual })
        .where('id', '=', row.id)
        .where('storage_updated_at', '<', graceCutoffIso)
        .where('storage_used_bytes', '=', row.recorded)
        .executeTakeFirst()
      const updatedRows = Number(updateResult.numUpdatedRows ?? 0n)
      if (updatedRows === 0) {
        raceSkipped++
        continue
      }
      const delta = row.recorded - row.actual
      if (delta > 0) bytesOverCorrected += delta
      else bytesUnderCorrected += -delta
    }
  }

  // Sort by |delta| desc so "top" actually means "largest drift" — operators
  // looking at the log want to see the worst offenders first.
  diffs.sort(
    (a, b) => Math.abs(b.recorded - b.actual) - Math.abs(a.recorded - a.actual),
  )

  return {
    duration_ms: Date.now() - start,
    workspaces_checked: rows.length,
    diffs_found: diffs.length,
    bytes_over_corrected: bytesOverCorrected,
    bytes_under_corrected: bytesUnderCorrected,
    race_skipped: raceSkipped,
    top_diffs: diffs.slice(0, TOP_DIFFS_LIMIT),
  }
}

export async function reconcileR2Orphans(
  db: Kysely<DB>,
  bucket: R2Bucket,
  now: Date,
): Promise<R2ReconcileResult> {
  const start = Date.now()
  const graceCutoff = new Date(now.getTime() - R2_GRACE_MS)

  // Build the "in use" set from non-terminal-failure versions only. Terminal
  // statuses ('failed' / 'blocked') won't transition further, so their r2_key
  // is fair game for reclamation if R2 still holds the object. uploading /
  // scanning / published all count as "in use" — uploading and scanning are
  // mid-flight and their r2_key must be protected (see spec §4.3).
  //
  // Include version_files keys too: static_site bundles store the entrypoint
  // key in versions.r2_key but all asset keys (CSS / JS / images) live only in
  // version_files. Without this join the cron would classify every asset as
  // an orphan and delete the published site's assets after R2_GRACE_MS.
  const [versionRows, versionFileRows, workspaceRows] = await Promise.all([
    db
      .selectFrom('versions')
      .select('r2_key')
      .where('status', 'not in', ['failed', 'blocked'])
      .execute(),
    db
      .selectFrom('version_files')
      .innerJoin('versions', 'versions.id', 'version_files.version_id')
      .select('version_files.r2_key')
      .where('versions.status', 'not in', ['failed', 'blocked'])
      .execute(),
    db.selectFrom('workspaces').select('id').execute(),
  ])
  const usedKeys = new Set<string>([
    ...versionRows.map((r) => r.r2_key),
    ...versionFileRows.map((r) => r.r2_key),
  ])

  const orphans: string[] = []
  let scanned = 0
  let skippedGrace = 0
  // Scan the bucket once to keep R2 subrequests bounded, but only classify
  // namespaces owned by artifact storage. Unknown top-level prefixes are
  // non-artifact data by default and must never become eligible for deletion
  // merely because no versions row references them. Single-file artifacts use
  // artifacts/, while static-site bundles are rooted at their workspace id.
  const workspaceIds = new Set(workspaceRows.map((row) => row.id))
  let cursor: string | null = null
  do {
    const page = await listArtifacts(bucket, cursor ?? undefined)
    scanned += page.objects.length
    for (const obj of page.objects) {
      const firstSlash = obj.key.indexOf('/')
      const artifactOwned =
        obj.key.startsWith('artifacts/') ||
        (firstSlash > 0 && workspaceIds.has(obj.key.slice(0, firstSlash)))
      if (!artifactOwned || usedKeys.has(obj.key)) continue
      if (obj.uploaded > graceCutoff) {
        skippedGrace++
        continue
      }
      orphans.push(obj.key)
    }
    cursor = page.cursor
  } while (cursor)

  if (orphans.length > 0) {
    await deleteArtifacts(bucket, orphans)
  }

  return {
    duration_ms: Date.now() - start,
    r2_scanned: scanned,
    d1_versions: versionRows.length,
    orphans_deleted: orphans.length,
    orphans_skipped_grace: skippedGrace,
  }
}

export async function verifyR2References(
  db: Kysely<DB>,
  bucket: R2Bucket,
): Promise<R2ReferenceCheckResult> {
  const start = Date.now()
  const [versionRows, versionFileRows] = await Promise.all([
    db
      .selectFrom('versions')
      .select('r2_key')
      .where('status', '=', 'published')
      .execute(),
    db
      .selectFrom('version_files')
      .innerJoin('versions', 'versions.id', 'version_files.version_id')
      .select('version_files.r2_key')
      .where('versions.status', '=', 'published')
      .execute(),
  ])
  const keys = [
    ...new Set([
      ...versionRows.map((row) => row.r2_key),
      ...versionFileRows.map((row) => row.r2_key),
    ]),
  ]
  const existingKeys = new Set<string>()
  let cursor: string | null = null
  let scanned = 0
  do {
    const page = await listArtifacts(bucket, cursor ?? undefined)
    scanned += page.objects.length
    for (const obj of page.objects) {
      existingKeys.add(obj.key)
    }
    cursor = page.cursor
  } while (cursor)

  const missingCandidates: string[] = []
  for (const key of keys) {
    if (!existingKeys.has(key)) missingCandidates.push(key)
  }
  const missingKeys = await findPersistingR2ReferenceKeys(db, missingCandidates)

  const result = {
    duration_ms: Date.now() - start,
    r2_scanned: scanned,
    d1_objects: keys.length,
    missing_objects: missingKeys.length,
    missing_keys: missingKeys.slice(0, TOP_DIFFS_LIMIT),
  }
  if (missingKeys.length > 0) {
    throw new R2ReferenceMissingError(result)
  }
  return result
}

async function findPersistingR2ReferenceKeys(
  db: Kysely<DB>,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return []

  const persisted = new Set<string>()
  for (let index = 0; index < keys.length; index += 100) {
    const chunk = keys.slice(index, index + 100)
    const [versionRows, versionFileRows] = await Promise.all([
      db
        .selectFrom('versions')
        .select('r2_key')
        .where('r2_key', 'in', chunk)
        .where('status', '=', 'published')
        .execute(),
      db
        .selectFrom('version_files')
        .innerJoin('versions', 'versions.id', 'version_files.version_id')
        .select('version_files.r2_key')
        .where('version_files.r2_key', 'in', chunk)
        .where('versions.status', '=', 'published')
        .execute(),
    ])
    for (const row of versionRows) persisted.add(row.r2_key)
    for (const row of versionFileRows) persisted.add(row.r2_key)
  }
  return keys.filter((key) => persisted.has(key))
}

export async function runReconciliation(
  db: Kysely<DB>,
  bucket: R2Bucket,
  now: Date,
  options?: ReconciliationOptions,
): Promise<void> {
  const totalStart = Date.now()
  console.log(
    JSON.stringify({ event: 'reconcile_start', at: now.toISOString() }),
  )

  // Capture each job's failure independently — we want the R2 sweep to run
  // even if quota failed, and vice versa, so log per-job. Then re-throw at the
  // end so ctx.waitUntil sees a rejection and Cloudflare records the cron run
  // as failed (otherwise dashboard shows "success" while reconcile_error logs
  // are buried in Workers Logs).
  const errors: unknown[] = []

  try {
    const cutoffIso = new Date(
      now.getTime() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString()
    const pruneResult = await pruneViewEventsQuery(db, {
      cutoffIso,
      limit: 1000,
    }).executeTakeFirst()
    console.log(
      JSON.stringify({
        event: 'reconcile_view_events_prune_done',
        deleted: Number(pruneResult?.numDeletedRows ?? 0),
      }),
    )
  } catch (err) {
    console.log(JSON.stringify(formatError('view_events_prune', err)))
    errors.push(err)
  }

  try {
    const quota = await reconcileQuota(db, now)
    console.log(JSON.stringify({ event: 'reconcile_quota_done', ...quota }))
  } catch (err) {
    console.log(JSON.stringify(formatError('quota', err)))
    errors.push(err)
  }

  try {
    const dailyUsage = await snapshotDailyStorageUsage(db, now)
    console.log(
      JSON.stringify({ event: 'reconcile_daily_usage_done', ...dailyUsage }),
    )
    if (dailyUsage.workspaces_failed > 0) {
      errors.push(
        new Error(
          `daily_usage: ${dailyUsage.workspaces_failed} workspace snapshot(s) failed`,
        ),
      )
    }
  } catch (err) {
    console.log(JSON.stringify(formatError('daily_usage', err)))
    errors.push(err)
  }

  if (!options?.stripe || !options.overageProductId) {
    console.log(
      JSON.stringify({
        event: 'reconcile_billing_overage_skipped',
        reason: 'stripe_unconfigured',
      }),
    )
  } else {
    try {
      const billingOverage = await createMonthlyOverageCharges(
        db,
        options.stripe,
        options.overageProductId,
        now,
      )
      console.log(
        JSON.stringify({
          event: 'reconcile_billing_overage_done',
          ...billingOverage,
        }),
      )
      if (billingOverage.workspaces_failed > 0) {
        errors.push(
          new Error(
            `billing_overage: ${billingOverage.workspaces_failed} workspace charge(s) failed`,
          ),
        )
      }
    } catch (err) {
      console.log(JSON.stringify(formatError('billing_overage', err)))
      errors.push(err)
    }
  }

  try {
    const r2 = await reconcileR2Orphans(db, bucket, now)
    console.log(JSON.stringify({ event: 'reconcile_r2_done', ...r2 }))
  } catch (err) {
    console.log(JSON.stringify(formatError('r2', err)))
    errors.push(err)
  }

  try {
    const r2References = await verifyR2References(db, bucket)
    console.log(
      JSON.stringify({
        event: 'reconcile_r2_references_done',
        ...r2References,
      }),
    )
  } catch (err) {
    console.log(JSON.stringify(formatError('r2_references', err)))
    errors.push(err)
  }

  try {
    let deleted = 0
    for (;;) {
      const batch = await cleanupExpiredSecurityAuditRecords(db, now)
      deleted += batch
      if (batch < SECURITY_AUDIT_CLEANUP_BATCH_SIZE) break
    }
    console.log(
      JSON.stringify({
        event: 'reconcile_security_audit_cleanup_done',
        deleted,
      }),
    )
  } catch (err) {
    console.log(JSON.stringify(formatError('security_audit_cleanup', err)))
    errors.push(err)
  }

  console.log(
    JSON.stringify({
      event: 'reconcile_done',
      total_duration_ms: Date.now() - totalStart,
      failed_jobs: errors.length,
    }),
  )

  if (errors.length > 0) {
    throw new AggregateError(errors, 'reconciliation failed')
  }
}

export class R2ReferenceMissingError extends Error {
  constructor(readonly result: R2ReferenceCheckResult) {
    super(
      `R2 reference check failed: ${result.missing_objects} missing object(s)`,
    )
  }
}

function formatError(
  job:
    | 'quota'
    | 'security_audit_cleanup'
    | 'daily_usage'
    | 'billing_overage'
    | 'r2'
    | 'r2_references'
    | 'view_events_prune',
  err: unknown,
) {
  const e = err instanceof Error ? err : new Error(String(err))
  const event = {
    event: 'reconcile_error',
    job,
    err: e.message,
    stack: e.stack?.split('\n').slice(0, 3).join('\n'),
  }
  if (e instanceof R2ReferenceMissingError) {
    return {
      ...event,
      d1_objects: e.result.d1_objects,
      missing_objects: e.result.missing_objects,
      missing_keys: e.result.missing_keys,
    }
  }
  return event
}

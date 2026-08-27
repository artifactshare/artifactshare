import { nanoid } from 'nanoid'
import { sql, type Compilable, type Kysely, type Selectable } from 'kysely'
import { runD1BatchWithResults } from '~/lib/d1-batch.server'
import type { DB } from '~/types/db'
import { listWorkspaceMigrationCandidates } from './workspace-domain-claims.server'

export const WORKSPACE_MIGRATION_WAIT_LOG_MARKER =
  'artifactshare_workspace_migration_wait'

export interface WorkspaceMigrationWaitNotification {
  revision: number
}

export interface WorkspaceMigrationWaitReconcileResult {
  active: number
  newlyDetected: number
  resolved: number
  skipped: boolean
  notifications: WorkspaceMigrationWaitNotification[]
}

const RECONCILIATION_LEASE_MS = 15 * 60 * 1000
const RELEASED_LEASE = '1970-01-01T00:00:00.000Z'

export async function reconcileWorkspaceMigrationWaits(
  db: Kysely<DB>,
  now: Date,
): Promise<WorkspaceMigrationWaitReconcileResult> {
  const detectedAt = now.toISOString()
  const leaseUntil = new Date(
    now.getTime() + RECONCILIATION_LEASE_MS,
  ).toISOString()
  const lease = await db
    .updateTable('workspace_migration_wait_alert_state')
    .set({ lease_until: leaseUntil })
    .where('id', '=', 1)
    .where('lease_until', '<', detectedAt)
    .returning('revision')
    .executeTakeFirst()
  if (!lease) {
    return {
      active: 0,
      newlyDetected: 0,
      resolved: 0,
      skipped: true,
      notifications: [],
    }
  }

  try {
    return await reconcileWorkspaceMigrationWaitsWithLease(
      db,
      detectedAt,
      Number(lease.revision),
    )
  } finally {
    await db
      .updateTable('workspace_migration_wait_alert_state')
      .set({ lease_until: RELEASED_LEASE })
      .where('id', '=', 1)
      .where('lease_until', '=', leaseUntil)
      .execute()
  }
}

async function reconcileWorkspaceMigrationWaitsWithLease(
  db: Kysely<DB>,
  detectedAt: string,
  alertRevision: number,
): Promise<WorkspaceMigrationWaitReconcileResult> {
  const candidates = await listWorkspaceMigrationCandidates(db)
  const existing = (
    await sql<Selectable<DB['workspace_migration_waits']>>`
      SELECT waits.*
      FROM workspace_migration_waits AS waits
      WHERE waits.resolved_at IS NULL
      UNION ALL
      SELECT waits.*
      FROM workspace_domain_claims AS claims
      INNER JOIN users
        ON lower(substr(users.email, instr(users.email, '@') + 1)) = claims.domain
      INNER JOIN workspace_migration_waits AS waits
        ON waits.user_id = users.id
        AND waits.target_workspace_id = claims.workspace_id
      WHERE waits.resolved_at IS NOT NULL
        AND users.workspace_id <> claims.workspace_id
        AND users.kind = 'human'
    `.execute(db)
  ).rows
  const existingByKey = new Map(
    existing.map((wait) => [
      waitKey(wait.user_id, wait.target_workspace_id),
      wait,
    ]),
  )
  const activeKeys = new Set<string>()
  const queries: Compilable<unknown>[] = []
  const upsertValues: Array<{
    id: string
    user_id: string
    source_workspace_id: string
    target_workspace_id: string
    reason_codes: string
    generation: number
    first_detected_at: string
    last_detected_at: string
    resolved_at: null
  }> = []
  let newlyDetected = 0

  for (const candidate of candidates) {
    const key = waitKey(candidate.userId, candidate.claimWorkspaceId)
    activeKeys.add(key)
    const previous = existingByKey.get(key)
    const reasonCodes = JSON.stringify([...candidate.reasonCodes].sort())
    if (!previous) {
      const id = nanoid(16)
      upsertValues.push({
        id,
        user_id: candidate.userId,
        source_workspace_id: candidate.personalWorkspaceId,
        target_workspace_id: candidate.claimWorkspaceId,
        reason_codes: reasonCodes,
        generation: 1,
        first_detected_at: detectedAt,
        last_detected_at: detectedAt,
        resolved_at: null,
      })
      newlyDetected++
      continue
    }

    const reactivated = previous.resolved_at !== null
    const generation = reactivated
      ? Number(previous.generation) + 1
      : Number(previous.generation)
    upsertValues.push({
      id: previous.id,
      user_id: candidate.userId,
      source_workspace_id: candidate.personalWorkspaceId,
      target_workspace_id: candidate.claimWorkspaceId,
      reason_codes: reasonCodes,
      generation,
      first_detected_at: previous.first_detected_at,
      last_detected_at: detectedAt,
      resolved_at: null,
    })
    if (reactivated) {
      newlyDetected++
    }
  }

  if (upsertValues.length > 0) {
    for (let index = 0; index < upsertValues.length; index += 500) {
      const valuesJson = JSON.stringify(upsertValues.slice(index, index + 500))
      queries.push(
        db
          .insertInto('workspace_migration_waits')
          .columns([
            'id',
            'user_id',
            'source_workspace_id',
            'target_workspace_id',
            'reason_codes',
            'generation',
            'first_detected_at',
            'last_detected_at',
            'resolved_at',
          ])
          .expression(
            () => sql`
            SELECT
              json_extract(value, '$.id'),
              json_extract(value, '$.user_id'),
              json_extract(value, '$.source_workspace_id'),
              json_extract(value, '$.target_workspace_id'),
              json_extract(value, '$.reason_codes'),
              json_extract(value, '$.generation'),
              json_extract(value, '$.first_detected_at'),
              json_extract(value, '$.last_detected_at'),
              NULL
            FROM json_each(${valuesJson})
            WHERE true
          `,
          )
          .onConflict((conflict) =>
            conflict.columns(['user_id', 'target_workspace_id']).doUpdateSet({
              source_workspace_id: (eb) =>
                eb.ref('excluded.source_workspace_id'),
              reason_codes: (eb) => eb.ref('excluded.reason_codes'),
              generation: (eb) => eb.ref('excluded.generation'),
              last_detected_at: sql<string>`max(
                workspace_migration_waits.last_detected_at,
                excluded.last_detected_at
              )`,
              resolved_at: null,
            }),
          ),
      )
    }
  }

  const resolvedIds: string[] = []
  for (const previous of existing) {
    if (
      previous.resolved_at === null &&
      !activeKeys.has(waitKey(previous.user_id, previous.target_workspace_id))
    ) {
      resolvedIds.push(previous.id)
    }
  }
  for (let index = 0; index < resolvedIds.length; index += 5000) {
    const idsJson = JSON.stringify(resolvedIds.slice(index, index + 5000))
    queries.push(
      db
        .updateTable('workspace_migration_waits')
        .set({ resolved_at: detectedAt })
        .where('resolved_at', 'is', null)
        .where(
          'id',
          'in',
          sql<string>`(SELECT value FROM json_each(${idsJson}))`,
        ),
    )
  }
  const resolved = resolvedIds.length
  if (newlyDetected > 0) {
    queries.push(
      db
        .updateTable('workspace_migration_wait_alert_state')
        .set({
          revision: sql<number>`revision + 1`,
          updated_at: detectedAt,
        })
        .where('id', '=', 1)
        .returning('revision'),
    )
  }

  const results =
    queries.length > 0 ? await runD1BatchWithResults(db, ...queries) : []
  const notificationRevision =
    newlyDetected > 0 ? revisionFromBatchResult(results.at(-1)) : alertRevision
  return {
    active: candidates.length,
    newlyDetected,
    resolved,
    skipped: false,
    notifications:
      candidates.length > 0 && notificationRevision > 0
        ? [{ revision: notificationRevision }]
        : [],
  }
}

function revisionFromBatchResult(result: unknown): number {
  const row = Array.isArray(result)
    ? result[0]
    : result && typeof result === 'object' && 'results' in result
      ? (result as { results?: unknown[] }).results?.[0]
      : null
  const revision = Number(
    row && typeof row === 'object' && 'revision' in row
      ? (row as { revision: unknown }).revision
      : Number.NaN,
  )
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error('workspace migration wait alert revision was not returned')
  }
  return revision
}

function waitKey(userId: string, targetWorkspaceId: string): string {
  return `${userId}\u0000${targetWorkspaceId}`
}

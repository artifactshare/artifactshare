import { nanoid } from 'nanoid'
import type { Compilable, Kysely } from 'kysely'
import { runD1Batch } from '~/lib/d1-batch.server'
import type { DB } from '~/types/db'
import { listWorkspaceMigrationCandidates } from './workspace-domain-claims.server'

export const WORKSPACE_MIGRATION_WAIT_LOG_MARKER =
  'artifactshare_workspace_migration_wait'

export interface WorkspaceMigrationWaitNotification {
  waitId: string
  generation: number
}

export interface WorkspaceMigrationWaitReconcileResult {
  active: number
  newlyDetected: number
  resolved: number
  notifications: WorkspaceMigrationWaitNotification[]
}

export async function reconcileWorkspaceMigrationWaits(
  db: Kysely<DB>,
  now: Date,
): Promise<WorkspaceMigrationWaitReconcileResult> {
  const detectedAt = now.toISOString()
  const candidates = await listWorkspaceMigrationCandidates(db)
  const existing = await db
    .selectFrom('workspace_migration_waits')
    .selectAll()
    .execute()
  const existingByKey = new Map(
    existing.map((wait) => [
      waitKey(wait.user_id, wait.target_workspace_id),
      wait,
    ]),
  )
  const activeKeys = new Set<string>()
  const notifications: WorkspaceMigrationWaitNotification[] = []
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
      notifications.push({ waitId: id, generation: 1 })
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
    notifications.push({ waitId: previous.id, generation })
  }

  if (upsertValues.length > 0) {
    // Ten columns per row plus the conflict update stay below D1's 100 bound
    // parameter limit when each statement contains at most eight rows.
    for (let index = 0; index < upsertValues.length; index += 8) {
      queries.push(
        db
          .insertInto('workspace_migration_waits')
          .values(upsertValues.slice(index, index + 8))
          .onConflict((conflict) =>
            conflict.columns(['user_id', 'target_workspace_id']).doUpdateSet({
              source_workspace_id: (eb) =>
                eb.ref('excluded.source_workspace_id'),
              reason_codes: (eb) => eb.ref('excluded.reason_codes'),
              generation: (eb) => eb.ref('excluded.generation'),
              last_detected_at: (eb) => eb.ref('excluded.last_detected_at'),
              resolved_at: null,
            }),
          ),
      )
    }
  }

  const resolvedIds = existing
    .filter(
      (previous) =>
        previous.resolved_at === null &&
        !activeKeys.has(
          waitKey(previous.user_id, previous.target_workspace_id),
        ),
    )
    .map((previous) => previous.id)
  for (let index = 0; index < resolvedIds.length; index += 90) {
    queries.push(
      db
        .updateTable('workspace_migration_waits')
        .set({ resolved_at: detectedAt })
        .where('id', 'in', resolvedIds.slice(index, index + 90))
        .where('resolved_at', 'is', null),
    )
  }
  const resolved = resolvedIds.length

  if (queries.length > 0) await runD1Batch(db, ...queries)
  return {
    active: candidates.length,
    newlyDetected,
    resolved,
    notifications,
  }
}

function waitKey(userId: string, targetWorkspaceId: string): string {
  return `${userId}\u0000${targetWorkspaceId}`
}

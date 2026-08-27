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
  let newlyDetected = 0

  for (const candidate of candidates) {
    const key = waitKey(candidate.userId, candidate.claimWorkspaceId)
    activeKeys.add(key)
    const previous = existingByKey.get(key)
    const reasonCodes = JSON.stringify([...candidate.reasonCodes].sort())
    if (!previous) {
      const id = nanoid(16)
      queries.push(
        db.insertInto('workspace_migration_waits').values({
          id,
          user_id: candidate.userId,
          source_workspace_id: candidate.personalWorkspaceId,
          target_workspace_id: candidate.claimWorkspaceId,
          reason_codes: reasonCodes,
          generation: 1,
          first_detected_at: detectedAt,
          last_detected_at: detectedAt,
          resolved_at: null,
        }),
      )
      notifications.push({ waitId: id, generation: 1 })
      newlyDetected++
      continue
    }

    const reactivated = previous.resolved_at !== null
    const generation = reactivated
      ? Number(previous.generation) + 1
      : Number(previous.generation)
    queries.push(
      db
        .updateTable('workspace_migration_waits')
        .set({
          source_workspace_id: candidate.personalWorkspaceId,
          reason_codes: reasonCodes,
          generation,
          last_detected_at: detectedAt,
          resolved_at: null,
        })
        .where('id', '=', previous.id),
    )
    if (reactivated) {
      notifications.push({ waitId: previous.id, generation })
      newlyDetected++
    }
  }

  let resolved = 0
  for (const previous of existing) {
    if (
      previous.resolved_at === null &&
      !activeKeys.has(waitKey(previous.user_id, previous.target_workspace_id))
    ) {
      queries.push(
        db
          .updateTable('workspace_migration_waits')
          .set({ resolved_at: detectedAt })
          .where('id', '=', previous.id)
          .where('resolved_at', 'is', null),
      )
      resolved++
    }
  }

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

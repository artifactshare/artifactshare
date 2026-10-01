import {
  VERSION_CONFLICT_RECOVERY_GUIDANCE,
  type VersionConflictDetails,
} from '@artifactshare/contract'
import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'

export type CreatedVia = 'web' | 'cli' | 'mcp' | 'api'
export type VersionSafetyFailure =
  | { kind: 'validation-failed' }
  | { kind: 'expected-version-required' }
  | {
      kind: 'version-conflict'
      currentVersionId: string | null
      readTarget: string
    }

export const recoveryGuidance = VERSION_CONFLICT_RECOVERY_GUIDANCE
export function conflictDetails(result: {
  currentVersionId: string | null
  readTarget: string
}): VersionConflictDetails {
  return {
    current_version_id: result.currentVersionId,
    read_target: result.readTarget,
    recovery_guidance: recoveryGuidance,
  }
}

/** Caller must authorize the target before reading or returning version details. */
export async function checkVersionSafety(
  db: Kysely<DB>,
  id: string,
  expected?: string | null,
  force = false,
): Promise<VersionSafetyFailure | null> {
  const base = expected?.trim() || null
  if (force && base) return { kind: 'validation-failed' }
  const current = await db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select(['shareables.current_version_id', 'versions.created_via'])
    .where('shareables.id', '=', id)
    .executeTakeFirst()
  if (
    current &&
    !force &&
    (base ? base !== current.current_version_id : current.created_via === 'web')
  ) {
    return {
      kind: 'version-conflict',
      currentVersionId: current.current_version_id,
      readTarget: id,
    }
  }
  return null
}

/** Evaluated in the write transaction, against the current pointer, not history order. */
export function versionSafetySql(expected?: string | null, force = false) {
  if (expected) return sql<boolean>`shareables.current_version_id = ${expected}`
  if (force) return sql<boolean>`1 = 1`
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM versions AS current_version WHERE current_version.id = shareables.current_version_id AND current_version.created_via = 'web')`
}

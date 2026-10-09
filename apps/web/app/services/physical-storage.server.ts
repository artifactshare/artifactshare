import { sql, type Kysely, type SelectQueryBuilder } from 'kysely'
import type { DB } from '~/types/db'

// Keep this incremental: reservations for uploads in flight have no rows yet.
// The deletion set is evaluated once inside the same batch as the deletion.
export function releasedObjectBytes(
  removed: SelectQueryBuilder<DB, 'versions', { id: string }>,
) {
  return sql<number>`(WITH removed AS ${removed}, objects AS (
    SELECT f.r2_key, f.size_bytes FROM version_files f WHERE f.version_id IN (SELECT id FROM removed)
    UNION
    SELECT v.r2_key, v.size_bytes FROM versions v WHERE v.id IN (SELECT id FROM removed)
      AND NOT EXISTS (SELECT 1 FROM version_files f WHERE f.r2_key = v.r2_key)
  ) SELECT COALESCE(SUM(size_bytes), 0) FROM (SELECT r2_key, MAX(size_bytes) AS size_bytes FROM objects GROUP BY r2_key) o
    WHERE NOT EXISTS (SELECT 1 FROM version_files f WHERE f.r2_key = o.r2_key AND f.version_id NOT IN (SELECT id FROM removed))
      AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.r2_key = o.r2_key AND v.id NOT IN (SELECT id FROM removed)))`
}

export async function objectIsReferenced(db: Kysely<DB>, key: string) {
  const result = await db
    .selectNoFrom(
      sql<number>`(
    EXISTS (SELECT 1 FROM version_files WHERE r2_key = ${key}) OR
    EXISTS (SELECT 1 FROM versions WHERE r2_key = ${key})
  )`.as('referenced'),
    )
    .executeTakeFirstOrThrow()
  return Boolean(result.referenced)
}

// Callers scope versions explicitly, including their own publication policy.
export function physicalVersionBytes(
  versions: SelectQueryBuilder<DB, 'versions', { id: string }>,
) {
  return sql<number>`(WITH selected AS ${versions}
    SELECT COALESCE(SUM(size_bytes), 0) FROM (
      SELECT DISTINCT f.r2_key, f.size_bytes FROM version_files f
      JOIN versions v ON v.id = f.version_id
      WHERE v.id IN (SELECT id FROM selected) AND v.artifact_kind = 'static_site'
      UNION ALL
      SELECT v.r2_key, v.size_bytes FROM versions v
      WHERE v.id IN (SELECT id FROM selected) AND v.artifact_kind != 'static_site'
    ))`
}

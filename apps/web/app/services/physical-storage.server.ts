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

// Each key is bound once per reference table, leaving at most 100 bindings.
export const OBJECT_REFERENCE_CHUNK = 50

export async function unreferencedObjectKeys(db: Kysely<DB>, keys: string[]) {
  if (keys.length === 0) return []
  const rows = await db
    .selectFrom('version_files')
    .select('r2_key')
    .where('r2_key', 'in', keys)
    .union(
      db.selectFrom('versions').select('r2_key').where('r2_key', 'in', keys),
    )
    .execute()
  const referenced = new Set(rows.map((row) => row.r2_key))
  return keys.filter((key) => !referenced.has(key))
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

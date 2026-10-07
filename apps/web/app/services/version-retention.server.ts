import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import { runD1BatchWithResults } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'
import { deleteArtifact } from './storage.server'

// Re-evaluated inside the atomic batch: concurrent publishes/settings changes
// cannot make a current version eligible or release the same quota twice.
function candidates(shareableId: string) {
  return sql<string>`(SELECT v.id FROM versions v
    JOIN shareables s ON s.id = v.shareable_id
    WHERE s.id = ${shareableId} AND s.retain_versions IS NOT NULL
      AND v.status = 'published' AND v.published_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM shareables current WHERE current.current_version_id = v.id)
      AND v.id NOT IN (
        SELECT kept.id FROM versions kept
        WHERE kept.shareable_id = ${shareableId} AND kept.status = 'published' AND kept.published_at IS NOT NULL
        ORDER BY (kept.id = (SELECT current_version_id FROM shareables WHERE id = ${shareableId})) DESC, kept.number DESC
        LIMIT (SELECT retain_versions FROM shareables WHERE id = ${shareableId})
      ))`
}

export async function pruneVersions(
  db: Kysely<DB>,
  shareableId: string,
): Promise<number> {
  const keys = new Set<string>()
  let deletedCount = 0
  // Finish the database work before best-effort R2 cleanup so object deletion
  // failures cannot leave later batches of history visible or billed.
  while (true) {
    const selected = await db
      .selectFrom('versions')
      .select(['id', 'r2_key'])
      .where('id', 'in', candidates(shareableId))
      // Leave room for the predicate bindings under D1's 100-parameter limit.
      .limit(80)
      .execute()
    if (selected.length === 0) break
    const ids = selected.map((row) => row.id)
    const files = await db
      .selectFrom('version_files')
      .select(['version_id', 'r2_key'])
      .where('version_id', 'in', ids)
      .execute()
    // Bound deletion to rows whose object keys were collected before cascades.
    const eligible = db
      .selectFrom('versions')
      .select('id')
      .where('id', 'in', ids)
      .where('id', 'in', candidates(shareableId))
    const [, result] = await runD1BatchWithResults(
      db,
      db
        .updateTable('workspaces')
        .set({
          storage_used_bytes: sql<number>`MAX(storage_used_bytes - COALESCE((SELECT SUM(size_bytes) FROM versions WHERE id IN (${eligible})), 0), 0)`,
          storage_updated_at: nowIso(),
        })
        .where(
          'id',
          '=',
          db
            .selectFrom('shareables')
            .select('workspace_id')
            .where('id', '=', shareableId),
        ),
      db.deleteFrom('versions').where('id', 'in', eligible).returning('id'),
    )
    const rows = (
      Array.isArray(result)
        ? result
        : (result as { results: { id: string }[] }).results
    ) as { id: string }[]
    const deleted = new Set(rows.map((row) => row.id))
    deletedCount += deleted.size
    for (const row of selected) if (deleted.has(row.id)) keys.add(row.r2_key)
    for (const file of files)
      if (deleted.has(file.version_id)) keys.add(file.r2_key)
  }
  const pendingKeys = [...keys]
  // Cap in-flight deletes even when retention is first enabled on a long history.
  for (let offset = 0; offset < pendingKeys.length; offset += 8) {
    await Promise.all(
      pendingKeys.slice(offset, offset + 8).map(async (key) => {
        try {
          await deleteArtifact(env.BUCKET, key)
        } catch (err) {
          console.error('r2_orphan_after_version_retention', {
            shareable_id: shareableId,
            r2_key: key,
            err,
          })
        }
      }),
    )
  }
  return deletedCount
}

// Publication is already durable. A cleanup failure must not invite callers to
// retry the publish or prevent the version-changed notification. Settings edits
// still use pruneVersions directly so they cannot report a false deletion count.
export async function pruneVersionsAfterPublish(
  db: Kysely<DB>,
  shareableId: string,
): Promise<void> {
  try {
    await pruneVersions(db, shareableId)
  } catch (err) {
    console.error('version_retention_after_publish_failed', {
      shareable_id: shareableId,
      err,
    })
  }
}

import {
  publisherArtifactSql,
  type PublisherAuthority,
} from './publisher-scope.server'
import {
  OBJECT_REFERENCE_CHUNK,
  unreferencedObjectKeys,
  releasedObjectBytes,
} from './physical-storage.server'
import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import { runD1BatchWithResults } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'
import { deleteArtifacts } from './storage.server'

// Re-evaluated inside the atomic batch: concurrent publishes/settings changes
// cannot make a current version eligible or release the same quota twice.
export function candidates(shareableId: string, proposed?: number | null) {
  const limit =
    proposed === undefined
      ? sql`(SELECT retain_versions FROM shareables WHERE id = ${shareableId})`
      : sql`${proposed}`
  return sql<string>`(SELECT v.id FROM versions v
    JOIN shareables s ON s.id = v.shareable_id
    WHERE s.id = ${shareableId} AND ${limit} IS NOT NULL
      AND v.status = 'published' AND v.published_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM shareables current WHERE current.current_version_id = v.id)
      AND v.id NOT IN (
        SELECT kept.id FROM versions kept
        WHERE kept.shareable_id = ${shareableId} AND kept.status = 'published' AND kept.published_at IS NOT NULL
        ORDER BY (kept.id = (SELECT current_version_id FROM shareables WHERE id = ${shareableId})) DESC, kept.number DESC
        LIMIT COALESCE(${limit}, -1)
      ))`
}

export async function pruneVersions(
  db: Kysely<DB>,
  shareableId: string,
  confirmedSnapshot?: string,
  publisher?: { userId: string; authority: PublisherAuthority },
): Promise<number> {
  const publisherGuard = publisher
    ? sql<boolean>`EXISTS (SELECT 1 FROM shareables WHERE shareables.id = ${shareableId} AND ${publisherArtifactSql(publisher.userId, publisher.authority)})`
    : sql<boolean>`1`
  const approved =
    confirmedSnapshot === undefined
      ? sql<boolean>`1`
      : sql<boolean>`id IN (SELECT value FROM json_each(json_extract(${confirmedSnapshot}, '$.eligible')))`
  const keys = new Set<string>()
  let deletedCount = 0
  // Finish the database work before best-effort R2 cleanup so object deletion
  // failures cannot leave later batches of history visible or billed.
  while (true) {
    const selected = await db
      .selectFrom('versions')
      .select(['id', 'r2_key'])
      .where('id', 'in', candidates(shareableId))
      .where(approved)
      .where(publisherGuard)
      // Leave room for the predicate bindings under D1's 100-parameter limit.
      .limit(publisher ? 50 : 80)
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
      .where(approved)
      .where(publisherGuard)
    const [, , result] = await runD1BatchWithResults(
      db,
      db
        .updateTable('workspaces')
        .set({
          storage_used_bytes: sql<number>`MAX(storage_used_bytes - ${releasedObjectBytes(eligible)}, 0)`,
          storage_updated_at: nowIso(),
        })
        .where(publisherGuard)
        .where(
          'id',
          '=',
          db
            .selectFrom('shareables')
            .select('workspace_id')
            .where('id', '=', shareableId),
        ),
      db
        .insertInto('version_retention_tombstones')
        .columns(['version_id', 'shareable_id', 'version_number', 'removed_at'])
        .expression(
          db
            .selectFrom('versions')
            .select([
              'id',
              'shareable_id',
              sql<number>`number`.as('version_number'),
              sql<string>`${nowIso()}`.as('removed_at'),
            ])
            .where('id', 'in', eligible),
        ),
      db.deleteFrom('versions').where('id', 'in', eligible).returning('id'),
    )
    const rows = (
      Array.isArray(result)
        ? result
        : (result as { results: { id: string }[] }).results
    ) as { id: string }[]
    const deleted = new Set(rows.map((row) => row.id))
    // A current-pointer change can invalidate every selected row while making
    // another version eligible. Reselect with the live policy, confirmation and
    // authority guards; only an empty selection means pruning is finished.
    if (deleted.size === 0) continue
    deletedCount += deleted.size
    for (const row of selected) if (deleted.has(row.id)) keys.add(row.r2_key)
    for (const file of files)
      if (deleted.has(file.version_id)) keys.add(file.r2_key)
  }
  const pendingKeys = [...keys]
  const chunks: string[][] = []
  for (
    let offset = 0;
    offset < pendingKeys.length;
    offset += OBJECT_REFERENCE_CHUNK
  ) {
    chunks.push(pendingKeys.slice(offset, offset + OBJECT_REFERENCE_CHUNK))
  }
  // Each worker finishes reference checking and deletion before its next chunk.
  const cleanupWorkers = Array.from({ length: 8 }, () => Promise.resolve())
  chunks.forEach((chunk, index) => {
    const worker = index % cleanupWorkers.length
    cleanupWorkers[worker] = cleanupWorkers[worker].then(async () => {
      try {
        const unreferenced = await unreferencedObjectKeys(db, chunk)
        await deleteArtifacts(env.BUCKET, unreferenced)
      } catch (err) {
        for (const key of chunk) {
          console.error('r2_orphan_after_version_retention', {
            shareable_id: shareableId,
            r2_key: key,
            err,
          })
        }
      }
    })
  })
  await Promise.all(cleanupWorkers)
  return deletedCount
}

// Publication is already durable. A cleanup failure must not invite callers to
// retry the publish or prevent the version-changed notification. Settings edits
// still use pruneVersions directly so they cannot report a false deletion count.
export async function pruneVersionsAfterPublish(
  db: Kysely<DB>,
  shareableId: string,
  publisher?: { userId: string; authority: PublisherAuthority },
): Promise<void> {
  try {
    await pruneVersions(db, shareableId, undefined, publisher)
  } catch (err) {
    console.error('version_retention_after_publish_failed', {
      shareable_id: shareableId,
      err,
    })
  }
}

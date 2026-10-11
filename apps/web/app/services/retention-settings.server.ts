import {
  publisherArtifactSql,
  type PublisherAuthority,
} from './publisher-scope.server'
import { sql, type Kysely } from 'kysely'
import { batchRows, runD1BatchWithResults } from '~/lib/d1-batch.server'
import { workspaceAccessRevokedSql } from '~/modules/access'
import type { DB } from '~/types/db'
import { candidates, pruneVersions } from './version-retention.server'

function ownerQuery(db: Kysely<DB>, id: string, ownerId: string) {
  return db
    .selectFrom('shareables')
    .where('id', '=', id)
    .where('owner_user_id', '=', ownerId)
    .where(
      sql<boolean>`NOT ${workspaceAccessRevokedSql(sql.ref('shareables.workspace_id'), ownerId)}`,
    )
}

// A single SQL snapshot is also compared by the guarded UPDATE. It includes
// unpublished rows and, for managed artifacts, other files' current references.
function snapshot(id: string, proposed: number | null) {
  return sql<string>`json_object('file', id, 'owner', owner_user_id,
    'workspace', workspace_id, 'stored', retain_versions,
    'createdPublisher', created_by_publisher_client_id,
    'assignedPublisher', assigned_publisher_client_id,
    'current', current_version_id, 'sequence', version_sequence, 'proposed', ${proposed},
    'versions', (SELECT json_group_array(json_array(id, number, status, published_at, created_by_publisher_client_id))
      FROM (SELECT id, number, status, published_at, created_by_publisher_client_id FROM versions
        WHERE shareable_id = ${id} ORDER BY id)),
    'references', CASE WHEN created_by_publisher_client_id IS NOT NULL
      OR assigned_publisher_client_id IS NOT NULL THEN (SELECT json_group_array(current_version_id)
      FROM (SELECT current_version_id FROM shareables
        WHERE current_version_id IN (SELECT id FROM versions WHERE shareable_id = ${id}) ORDER BY current_version_id)) ELSE NULL END,
    'eligible', (SELECT json_group_array(id) FROM (SELECT id FROM versions
      WHERE id IN ${candidates(id, proposed)} ORDER BY id)))`
}

export async function previewRetention(
  db: Kysely<DB>,
  id: string,
  ownerId: string,
  proposed: number | null,
) {
  const row = await ownerQuery(db, id, ownerId)
    .select([
      'retain_versions',
      snapshot(id, proposed).as('snapshot'),
      sql<number>`(SELECT COUNT(*) FROM versions WHERE id IN ${candidates(id, proposed)})`.as(
        'count',
      ),
    ])
    .executeTakeFirst()
  return row
    ? {
        stored: row.retain_versions,
        proposed,
        count: Number(row.count),
        snapshot: row.snapshot,
      }
    : null
}

// Used by both the unrestricted API edit and the session-only browser flow.
// The ownership/access and optional preview guard are evaluated by the write,
// inside D1's batch, rather than relying on an earlier authorization lookup.
export async function saveRetention(
  db: Kysely<DB>,
  id: string,
  ownerId: string,
  proposed: number | null,
  expectedSnapshot?: string,
  publisherAuthority?: PublisherAuthority,
) {
  let query = db
    .updateTable('shareables')
    .set({ retain_versions: proposed })
    .where('id', '=', id)
    .where('owner_user_id', '=', ownerId)
    .where(
      sql<boolean>`NOT ${workspaceAccessRevokedSql(sql.ref('shareables.workspace_id'), ownerId)}`,
    )
  if (publisherAuthority)
    query = query.where(publisherArtifactSql(ownerId, publisherAuthority))
  if (expectedSnapshot !== undefined)
    query = query.where(snapshot(id, proposed), '=', expectedSnapshot)
  const [result] = await runD1BatchWithResults(db, query.returning('id'))
  if (batchRows<{ id: string }>(result).length === 0) return null
  return {
    retain_versions: proposed,
    deleted_versions: await pruneVersions(
      db,
      id,
      expectedSnapshot,
      publisherAuthority
        ? { userId: ownerId, authority: publisherAuthority }
        : undefined,
    ),
  }
}

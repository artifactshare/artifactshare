import { sql, type Kysely } from 'kysely'
import type { ArtifactVersionSummary } from '@artifactshare/contract'
import type { DB } from '~/types/db'

// Call only with authorized IDs. A list page has at most 50 IDs.
// Match static-site history visibility while retaining zero-history rows.
export async function loadArtifactVersionSummaries(
  db: Kysely<DB>,
  ids: string[],
  viewerUserId: string,
) {
  if (ids.length === 0) return new Map<string, ArtifactVersionSummary>()
  const rows = await db
    .selectFrom('shareables as s')
    .leftJoin('versions as v', (join) =>
      join
        .onRef('v.shareable_id', '=', 's.id')
        .on(
          sql<boolean>`(s.artifact_kind != 'static_site' OR s.owner_user_id = ${viewerUserId} OR (v.status = 'published' AND v.published_at IS NOT NULL))`,
        ),
    )
    .select([
      's.id',
      's.retain_versions',
      sql<number>`count(v.id)`.as('version_count'),
      sql<number>`coalesce(sum(v.size_bytes), 0)`.as('total_size_bytes'),
    ])
    .where('s.id', 'in', ids)
    .groupBy(['s.id', 's.retain_versions'])
    .execute()
  return new Map(rows.map(({ id, ...summary }) => [id, summary]))
}

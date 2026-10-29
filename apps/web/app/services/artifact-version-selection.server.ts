import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'

/** Call only after authorizing access to the artifact. Explicit reads have no age limit. */
export async function selectArtifactVersion(
  db: Kysely<DB>,
  artifactId: string,
  versionId: string,
) {
  const version = await db
    .selectFrom('versions')
    .select([
      'id',
      'artifact_kind',
      'entrypoint_path',
      'r2_key',
      'fallback_to_index',
    ])
    .where('shareable_id', '=', artifactId)
    .where('id', '=', versionId.trim())
    .where('status', '=', 'published')
    .where('published_at', 'is not', null)
    .executeTakeFirst()
  if (version) return { kind: 'ok' as const, version }
  return {
    kind: (await isRemovedArtifactVersion(db, artifactId, versionId.trim()))
      ? ('version-removed' as const)
      : ('not-found' as const),
  }
}

export async function isRemovedArtifactVersion(
  db: Kysely<DB>,
  artifactId: string,
  versionId: string,
) {
  return Boolean(
    await db
      .selectFrom('version_retention_tombstones')
      .select('version_id')
      .where('shareable_id', '=', artifactId)
      .where('version_id', '=', versionId)
      .executeTakeFirst(),
  )
}

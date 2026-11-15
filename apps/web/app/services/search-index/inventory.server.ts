import type { Db } from '../db.server'
import type { DB } from '../../types/db'
import type { SelectQueryBuilder, Selectable } from 'kysely'
import { createHash } from 'node:crypto'

export type Source = Pick<
  Selectable<DB['shareables']>,
  | 'id'
  | 'workspace_id'
  | 'current_version_id'
  | 'title_override'
  | 'derived_title'
  | 'name'
  | 'description'
  | 'container_id'
  | 'owner_user_id'
  | 'updated_at'
> &
  Pick<
    Selectable<DB['versions']>,
    'artifact_kind' | 'entrypoint_path' | 'r2_key' | 'sha256'
  >
export function inventory(
  db: Db,
  workspaceId: string,
): SelectQueryBuilder<
  DB & { s: DB['shareables']; v: DB['versions'] },
  's' | 'v',
  Source
> {
  return db
    .selectFrom('shareables as s')
    .innerJoin('versions as v', 'v.id', 's.current_version_id')
    .select([
      's.id',
      's.workspace_id',
      's.current_version_id',
      's.title_override',
      's.derived_title',
      's.name',
      's.description',
      's.container_id',
      's.owner_user_id',
      's.updated_at',
      'v.artifact_kind',
      'v.entrypoint_path',
      'v.r2_key',
      'v.sha256',
    ])
    .where('s.workspace_id', '=', workspaceId)
    .where('v.status', '=', 'published')
}
export function displayTitle(row: Source): string {
  return row.title_override || row.derived_title || row.name
}
export function fingerprint(row: Source): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}
export function contentFingerprint(row: Source): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.current_version_id,
        row.description,
        row.artifact_kind,
        row.entrypoint_path,
        row.r2_key,
        row.sha256,
      ]),
    )
    .digest('hex')
}

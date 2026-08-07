import { sql, type Kysely, type RawBuilder } from 'kysely'
import type { DB } from '~/types/db'

type ProjectPinsDb = Kysely<DB>

// visibleTo: 読み手の可視性フィルタ (member は visibleShareableToViewer、共有された
// 関係者は visibleSharedProjectShareableToViewer)。ピンでも読めないタイトルを漏らさない。
export async function listProjectPins(
  db: ProjectPinsDb,
  containerId: string,
  visibleTo: RawBuilder<boolean>,
) {
  const rows = await db
    .selectFrom('project_pins')
    .innerJoin('shareables', 'shareables.id', 'project_pins.shareable_id')
    .leftJoin('versions as latest', (join) =>
      join.on(
        'latest.id',
        '=',
        // published_at の同時刻タイでも 1 行に定まるよう id で決定的に選ぶ
        sql`(select v2.id from versions v2 where v2.shareable_id = shareables.id and v2.status = 'published' order by v2.published_at desc, v2.id desc limit 1)`,
      ),
    )
    .leftJoin(
      'users as latestAuthors',
      'latestAuthors.id',
      'latest.created_by_id',
    )
    .select([
      'shareables.id as shareableId',
      'shareables.name',
      'shareables.derived_title as derivedTitle',
      'shareables.title_override as titleOverride',
      'shareables.artifact_kind as artifactKind',
      sql<number>`(select count(*) from versions v3 where v3.shareable_id = shareables.id and v3.status = 'published')`.as(
        'latestVersionNumber',
      ),
      'latest.published_at as latestPublishedAt',
      'latestAuthors.name as latestAuthorName',
      'latestAuthors.email as latestAuthorEmail',
      'latestAuthors.image as latestAuthorImage',
      'project_pins.created_at as createdAt',
    ])
    .where('project_pins.container_id', '=', containerId)
    .where(visibleTo)
    .orderBy('project_pins.created_at', 'asc')
    .orderBy('shareables.id', 'asc')
    .execute()
  return rows
}

export type PinShareableResult = 'added' | 'already-existed' | 'not-added'

export async function pinShareable(
  db: ProjectPinsDb,
  input: { containerId: string; shareableId: string; userId: string },
): Promise<PinShareableResult> {
  const inserted = await db
    .insertInto('project_pins')
    .columns([
      'container_id',
      'shareable_id',
      'pinned_by_user_id',
      'created_at',
    ])
    .expression(
      db
        .selectFrom('shareables')
        .select([
          sql`${input.containerId}`.as('container_id'),
          sql`${input.shareableId}`.as('shareable_id'),
          sql`${input.userId}`.as('pinned_by_user_id'),
          sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('created_at'),
        ])
        .where('shareables.id', '=', input.shareableId)
        .where('shareables.container_id', '=', input.containerId)
        .where(
          sql<boolean>`(select count(*) from project_pins where container_id = ${input.containerId}) < 20`,
        ),
    )
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst()
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) > 0) return 'added'
  const existing = await db
    .selectFrom('project_pins')
    .select('shareable_id')
    .where('container_id', '=', input.containerId)
    .where('shareable_id', '=', input.shareableId)
    .executeTakeFirst()
  return existing ? 'already-existed' : 'not-added'
}

export async function unpinShareable(
  db: ProjectPinsDb,
  input: { containerId: string; shareableId: string },
) {
  await db
    .deleteFrom('project_pins')
    .where('container_id', '=', input.containerId)
    .where('shareable_id', '=', input.shareableId)
    .execute()
}

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import { localDayKeyFromTimezone } from '~/lib/datetime'
import { timezoneDayUtcRange } from '~/lib/timezone-boundary.server'
import {
  canonicalViewerTimezone,
  DEFAULT_VIEWER_TIMEZONE,
} from '~/lib/viewer-timezone.server'
import type { DB } from '~/types/db'
import {
  visibleShareableToViewer,
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
} from './projects.server'

export { timezoneDayUtcRange } from '~/lib/timezone-boundary.server'

export function resolveFeedTimezone(
  cursor: FeedCursor | undefined,
  timeZone: string,
): string {
  const cursorTimeZone = canonicalViewerTimezone(cursor?.timeZone)
  if (cursorTimeZone) return cursorTimeZone
  return canonicalViewerTimezone(timeZone) ?? DEFAULT_VIEWER_TIMEZONE
}

type EventDb = Kysely<DB>
// D1 は 1 statement あたり 100 bindings。view 再集計は mine が 5/key、
// その他が 9/key を使うため、固定条件を含めても上限内に収まる値にする。
const RECOUNT_KEY_CHUNK_SIZE = 10
const COMMENT_RECOUNT_KEY_CHUNK_SIZE = 20
const ADD_RECOUNT_KEY_CHUNK_SIZE = 20
const VIEW_DIGEST_KEY_CHUNK_SIZE = 18

export type FeedUser = {
  id: string
  workspaceId: string
  email: string
  emailVerified: boolean
}
export type FeedCursor = {
  createdAt: string
  id: string
  timeZone: string
}
export type FeedEventRow = {
  id: string
  type: DB['events']['type']
  shareableId: string
  shareableTitle: string
  actorId: string | null
  actorName: string | null
  versionNumber: number | null
  versionStart: number | null
  versionEnd: number | null
  versionAuthorCount: number | null
  commentBody: string | null
  viewUniqueCount: number | null
  anonymousViewCount: number | null
  viewedFileCount: number | null
  viewTopItems: { shareableId: string; title: string; count: number }[] | null
  commentCount: number | null
  createdAt: string
  dayKey: string
  addCount?: number | null
  containerId?: string | null
  containerName?: string | null
  containerKind?: DB['artifact_containers']['kind'] | null
  isViewerInbox: boolean
}
export type FeedEventsResult = {
  rows: FeedEventRow[]
  nextCursor: FeedCursor | null
  hasMore: boolean
}

export async function listFeedEvents(
  db: EventDb,
  {
    user,
    slice,
    cursor,
    timeZone,
    targetRows,
    maxRawEvents,
    containerId,
  }: {
    user: FeedUser
    timeZone: string
    cursor?: FeedCursor
    targetRows: number
    maxRawEvents: number
  } & (
    | { slice: 'all' | 'mine'; containerId?: undefined }
    | { slice: 'project'; containerId: string }
  ),
): Promise<FeedEventsResult> {
  const effectiveTimeZone = resolveFeedTimezone(cursor, timeZone)
  const rows: FeedEventRow[] = []
  let current = cursor
  let consumed = 0
  let hasMore = false
  while (rows.length < targetRows && consumed < maxRawEvents) {
    const limit = Math.min(100, maxRawEvents - consumed)
    let query = db
      .selectFrom('events')
      .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
      .leftJoin(
        'artifact_containers as projectContainers',
        'projectContainers.id',
        'shareables.container_id',
      )
      .leftJoin('users as actors', 'actors.id', 'events.actor_user_id')
      .leftJoin('comment_messages', 'comment_messages.id', 'events.subject_id')
      .leftJoin(
        'versions as subject_versions',
        'subject_versions.id',
        'events.subject_id',
      )
      .select([
        'events.id as id',
        'events.type as type',
        'events.shareable_id as shareableId',
        sql<string>`coalesce(shareables.title_override, shareables.derived_title, shareables.name)`.as(
          'shareableTitle',
        ),
        'events.actor_user_id as actorId',
        'actors.name as actorName',
        sql<
          number | null
        >`(select count(*) from versions v2 where v2.shareable_id = events.shareable_id and v2.status = 'published' and v2.published_at <= events.created_at)`.as(
          'versionNumber',
        ),
        'comment_messages.body as commentBody',
        'events.created_at as createdAt',
        'shareables.container_id as containerId',
        'projectContainers.name as containerName',
        'projectContainers.kind as containerKind',
        'projectContainers.owner_user_id as containerOwnerId',
      ])
      .where((eb) =>
        slice === 'project'
          ? eb('shareables.container_id', '=', containerId)
          : slice === 'mine'
            ? eb.or([
                eb('shareables.workspace_id', '=', user.workspaceId),
                eb.exists(
                  sql`(select 1 from project_members pm where pm.container_id = shareables.container_id and pm.user_id = ${user.id})`,
                ),
              ])
            : eb('shareables.workspace_id', '=', user.workspaceId),
      )
      .where(
        slice === 'project'
          ? sql<boolean>`(
            (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = projectContainers.workspace_id AND wm.user_id = ${user.id} AND wm.status = 'active')
              AND ${visibleShareableToViewerSql(user)})
            OR (NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = projectContainers.workspace_id AND wm.user_id = ${user.id} AND wm.status = 'active')
              AND ${visibleSharedProjectShareableToViewerSql(user)})
          )`
          : slice === 'mine'
            ? sql<boolean>`((shareables.workspace_id = ${user.workspaceId} AND ${visibleShareableToViewerSql(user)}) OR (shareables.workspace_id <> ${user.workspaceId} AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.container_id=shareables.container_id AND pm.user_id=${user.id}) AND ${visibleSharedProjectShareableToViewerSql(user)}))`
            : visibleShareableToViewerSql(user),
      )
      // 削除済みの comment / version は join が外れたら表示しない (events.md)
      .where((eb) =>
        eb.or([
          eb('events.type', '<>', 'comment_posted'),
          eb('comment_messages.id', 'is not', null),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('events.type', '<>', 'version_published'),
          eb('subject_versions.id', 'is not', null),
        ]),
      )
      .where((eb) =>
        slice === 'all' || slice === 'project'
          ? sql`1 = 1`
          : eb.or([
              eb.and([
                eb('events.type', '=', 'artifact_created'),
                eb('events.actor_user_id', '<>', user.id),
                eb.exists(
                  sql`(select 1 from project_members pm where pm.container_id = shareables.container_id and pm.user_id = ${user.id})`,
                ),
              ]),
              eb.and([
                eb('shareables.owner_user_id', '=', user.id),
                eb.or([
                  eb('events.actor_user_id', 'is', null),
                  eb('events.actor_user_id', '<>', user.id),
                ]),
              ]),
              eb.and([
                eb.exists(
                  sql`(select 1 from shareable_viewer_recency svr where svr.shareable_id = events.shareable_id and svr.viewer_user_id = ${user.id})`,
                ),
                eb('events.type', 'in', [
                  'version_published',
                  'comment_posted',
                ]),
                eb('events.actor_user_id', '<>', user.id),
              ]),
            ]),
      )
      .orderBy('events.created_at', 'desc')
      .orderBy('events.id', 'desc')
      .limit(limit)
    if (current)
      query = query.where((eb) =>
        eb.or([
          eb('events.created_at', '<', current!.createdAt),
          eb.and([
            eb('events.created_at', '=', current!.createdAt),
            eb('events.id', '<', current!.id),
          ]),
        ]),
      )
    const batch = await query.execute()
    consumed += batch.length
    if (!batch.length) break
    const viewKeyMap = new Map<string, (typeof batch)[number]>()
    for (const row of batch) {
      if (row.type !== 'artifact_viewed') continue
      const dayKey = localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)
      const key = slice === 'mine' ? dayKey : `${row.shareableId}:${dayKey}`
      viewKeyMap.set(key, row)
    }
    const viewKeys = Array.from(viewKeyMap.values())
    const counts = new Map<
      string,
      {
        unique: number
        anonymous: number
        files?: number
        top?: { shareableId: string; title: string; count: number }[]
      }
    >()
    const digestActors = new Map<string, Set<string>>()
    if (slice === 'mine' && viewKeys.length) {
      for (
        let offset = 0;
        offset < viewKeys.length;
        offset += VIEW_DIGEST_KEY_CHUNK_SIZE
      ) {
        const keyChunk = viewKeys.slice(
          offset,
          offset + VIEW_DIGEST_KEY_CHUNK_SIZE,
        )
        const countRows = await db
          .selectFrom('events')
          .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
          .select([
            'events.shareable_id as shareableId',
            'shareables.owner_user_id as ownerId',
            sql<string>`coalesce(shareables.title_override, shareables.derived_title, shareables.name)`.as(
              'title',
            ),
            sql<string>`case ${sql.join(
              keyChunk.map((row) => {
                const day = localDayKeyFromTimezone(
                  row.createdAt,
                  effectiveTimeZone,
                )
                const { start, end } = timezoneDayUtcRange(
                  day,
                  effectiveTimeZone,
                )
                return sql`when events.created_at >= ${start} and events.created_at < ${end} then ${day}`
              }),
              sql` `,
            )} end`.as('day'),
            'events.actor_user_id as actorId',
          ])
          .where('events.type', '=', 'artifact_viewed')
          .where('shareables.workspace_id', '=', user.workspaceId)
          .where('shareables.owner_user_id', '=', user.id)
          .where((eb) =>
            eb.or([
              eb('events.actor_user_id', 'is', null),
              eb('events.actor_user_id', '<>', user.id),
            ]),
          )
          .where(
            sql<boolean>`(${sql.join(
              keyChunk.map((row) => {
                const day = localDayKeyFromTimezone(
                  row.createdAt,
                  effectiveTimeZone,
                )
                const { start, end } = timezoneDayUtcRange(
                  day,
                  effectiveTimeZone,
                )
                return sql`events.created_at >= ${start} and events.created_at < ${end}`
              }),
              sql` or `,
            )})`,
          )
          .execute()
        const grouped = new Map<
          string,
          {
            title: string
            actors: Set<string>
            anonymous: number
            shareableId: string
            count: number
          }
        >()
        for (const count of countRows) {
          const key = `${count.shareableId}:${count.day}`
          const item = grouped.get(key) ?? {
            title: count.title,
            actors: new Set<string>(),
            anonymous: 0,
            shareableId: count.shareableId,
            count: 0,
          }
          item.count += 1
          if (count.actorId && count.actorId !== count.ownerId)
            item.actors.add(count.actorId)
          else item.anonymous += 1
          grouped.set(key, item)
        }
        for (const [groupedKey, item] of grouped) {
          const day = groupedKey.slice(groupedKey.indexOf(':') + 1)
          const key = day
          const previous = counts.get(key)
          const actors = digestActors.get(key) ?? new Set<string>()
          for (const actor of item.actors) actors.add(actor)
          digestActors.set(key, actors)
          const items = [
            ...(previous?.top ?? []),
            {
              shareableId: item.shareableId,
              title: item.title,
              count: item.count,
            },
          ]
          counts.set(key, {
            unique: actors.size,
            anonymous: (previous?.anonymous ?? 0) + item.anonymous,
            files: (previous?.files ?? 0) + 1,
            top: items
              .sort(
                (a, b) =>
                  b.count - a.count ||
                  a.shareableId.localeCompare(b.shareableId),
              )
              .slice(0, 3),
          })
        }
      }
    } else if (viewKeys.length) {
      for (
        let offset = 0;
        offset < viewKeys.length;
        offset += RECOUNT_KEY_CHUNK_SIZE
      ) {
        const keyChunk = viewKeys.slice(offset, offset + RECOUNT_KEY_CHUNK_SIZE)
        const countRows = await db
          .selectFrom('events')
          .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
          .select([
            'events.shareable_id as shareableId',
            sql<string>`case ${sql.join(
              keyChunk.map((row) => {
                const day = localDayKeyFromTimezone(
                  row.createdAt,
                  effectiveTimeZone,
                )
                const { start, end } = timezoneDayUtcRange(
                  day,
                  effectiveTimeZone,
                )
                return sql`when events.created_at >= ${start} and events.created_at < ${end} then ${day}`
              }),
              sql` `,
            )} end`.as('day'),
            sql<number>`count(distinct case when events.actor_user_id is not null and events.actor_user_id <> shareables.owner_user_id then events.actor_user_id end)`.as(
              'unique',
            ),
            sql<number>`sum(case when events.actor_user_id is null then 1 else 0 end)`.as(
              'anonymous',
            ),
          ])
          .where('events.type', '=', 'artifact_viewed')
          .where(
            sql<boolean>`(${sql.join(
              keyChunk.map((row) => {
                const day = localDayKeyFromTimezone(
                  row.createdAt,
                  effectiveTimeZone,
                )
                const { start, end } = timezoneDayUtcRange(
                  day,
                  effectiveTimeZone,
                )
                return sql`events.shareable_id = ${row.shareableId} and events.created_at >= ${start} and events.created_at < ${end}`
              }),
              sql` or `,
            )})`,
          )
          .groupBy([
            sql`events.shareable_id`,
            sql<string>`case ${sql.join(
              keyChunk.map((row) => {
                const day = localDayKeyFromTimezone(
                  row.createdAt,
                  effectiveTimeZone,
                )
                const { start, end } = timezoneDayUtcRange(
                  day,
                  effectiveTimeZone,
                )
                return sql`when events.created_at >= ${start} and events.created_at < ${end} then ${day}`
              }),
              sql` `,
            )} end`,
          ])
          .execute()
        for (const count of countRows)
          counts.set(`${count.shareableId}:${count.day}`, {
            unique: Number(count.unique),
            anonymous: Number(count.anonymous),
          })
      }
    }
    const versionKeyMap = new Map<string, (typeof batch)[number]>()
    if (slice === 'mine') {
      for (const row of batch) {
        if (row.type !== 'version_published') continue
        versionKeyMap.set(
          `${row.shareableId}:${localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)}`,
          row,
        )
      }
    }
    const versionAggregates = new Map<
      string,
      { start: number; end: number; authors: Set<string> } | null
    >()
    if (versionKeyMap.size) {
      const candidates = []
      const versionKeys = Array.from(versionKeyMap.values())
      // Each key contributes three bindings; leave headroom under D1's 100-binding limit.
      for (
        let offset = 0;
        offset < versionKeys.length;
        offset += RECOUNT_KEY_CHUNK_SIZE
      ) {
        const keyChunk = versionKeys.slice(
          offset,
          offset + RECOUNT_KEY_CHUNK_SIZE,
        )
        const chunk = await db
          .selectFrom('events')
          .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
          .innerJoin('versions', 'versions.id', 'events.subject_id')
          .select([
            'events.shareable_id as shareableId',
            'events.actor_user_id as actorId',
            'events.created_at as createdAt',
            sql<number>`(select count(*) from versions v2 where v2.shareable_id = events.shareable_id and v2.status = 'published' and v2.published_at <= events.created_at)`.as(
              'versionNumber',
            ),
          ])
          .where('events.type', '=', 'version_published')
          .where('shareables.workspace_id', '=', user.workspaceId)
          .where((eb) => visibleShareableToViewer(eb, user))
          .where('shareables.owner_user_id', '<>', user.id)
          .where((eb) =>
            eb.exists(
              sql`(select 1 from shareable_viewer_recency svr where svr.shareable_id = events.shareable_id and svr.viewer_user_id = ${user.id})`,
            ),
          )
          .where('events.actor_user_id', '<>', user.id)
          .where(
            (eb) =>
              sql<boolean>`(${sql.join(
                keyChunk.map((row) => {
                  const day = localDayKeyFromTimezone(
                    row.createdAt,
                    effectiveTimeZone,
                  )
                  const { start, end } = timezoneDayUtcRange(
                    day,
                    effectiveTimeZone,
                  )
                  return sql`events.shareable_id = ${row.shareableId} and events.created_at >= ${start} and events.created_at < ${end}`
                }),
                sql` or `,
              )})`,
          )
          .execute()
        candidates.push(...chunk)
      }
      for (const row of candidates) {
        const key = `${row.shareableId}:${localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)}`
        const version = Number(row.versionNumber)
        const aggregate = versionAggregates.get(key)
        if (!aggregate)
          versionAggregates.set(key, {
            start: version,
            end: version,
            authors: new Set(row.actorId ? [row.actorId] : []),
          })
        else {
          aggregate.start = Math.min(aggregate.start, version)
          aggregate.end = Math.max(aggregate.end, version)
          if (row.actorId) aggregate.authors.add(row.actorId)
        }
      }
      const candidateCounts = new Map<string, number>()
      for (const row of candidates) {
        const key = `${row.shareableId}:${localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)}`
        candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1)
      }
      for (const [key, aggregate] of versionAggregates) {
        const count = candidateCounts.get(key) ?? 0
        if (
          aggregate &&
          (count < 2 || aggregate.end - aggregate.start + 1 !== count)
        )
          versionAggregates.set(key, null)
      }
    }
    const commentKeyMap = new Map<string, (typeof batch)[number]>()
    for (const row of batch)
      if (row.type === 'comment_posted' && row.actorId)
        commentKeyMap.set(
          `${row.actorId}:${row.shareableId}:${localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)}`,
          row,
        )
    const commentAggregates = new Map<string, { count: number; body: string }>()
    const commentKeys = Array.from(commentKeyMap.values())
    for (
      let offset = 0;
      offset < commentKeys.length;
      offset += COMMENT_RECOUNT_KEY_CHUNK_SIZE
    ) {
      const keyChunk = commentKeys.slice(
        offset,
        offset + COMMENT_RECOUNT_KEY_CHUNK_SIZE,
      )
      const candidates = await db
        .selectFrom('events')
        .innerJoin(
          'comment_messages',
          'comment_messages.id',
          'events.subject_id',
        )
        .select([
          'events.actor_user_id as actorId',
          'events.shareable_id as shareableId',
          'events.created_at as createdAt',
          'events.id as id',
          'comment_messages.body as body',
        ])
        .where('events.type', '=', 'comment_posted')
        .where(
          sql<boolean>`(${sql.join(
            keyChunk.map((row) => {
              const day = localDayKeyFromTimezone(
                row.createdAt,
                effectiveTimeZone,
              )
              const { start, end } = timezoneDayUtcRange(day, effectiveTimeZone)
              return sql`events.actor_user_id = ${row.actorId} and events.shareable_id = ${row.shareableId} and events.created_at >= ${start} and events.created_at < ${end}`
            }),
            sql` or `,
          )})`,
        )
        .orderBy('events.created_at', 'desc')
        .orderBy('events.id', 'desc')
        .execute()
      for (const candidate of candidates) {
        const key = `${candidate.actorId}:${candidate.shareableId}:${localDayKeyFromTimezone(candidate.createdAt, effectiveTimeZone)}`
        const aggregate = commentAggregates.get(key)
        if (aggregate) aggregate.count += 1
        else commentAggregates.set(key, { count: 1, body: candidate.body })
      }
    }
    const addKeyMap = new Map<string, (typeof batch)[number]>()
    if (slice === 'mine') {
      for (const row of batch) {
        if (row.type !== 'artifact_created' || !row.actorId || !row.containerId)
          continue
        addKeyMap.set(
          `${row.actorId}:${row.containerId}:${localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)}`,
          row,
        )
      }
    }
    const addAggregates = new Map<string, number>()
    const addKeys = Array.from(addKeyMap.values())
    for (
      let offset = 0;
      offset < addKeys.length;
      offset += ADD_RECOUNT_KEY_CHUNK_SIZE
    ) {
      const keyChunk = addKeys.slice(
        offset,
        offset + ADD_RECOUNT_KEY_CHUNK_SIZE,
      )
      const candidates = await db
        .selectFrom('events')
        .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
        .leftJoin(
          'artifact_containers as projectContainers',
          'projectContainers.id',
          'shareables.container_id',
        )
        .select([
          'events.actor_user_id as actorId',
          'shareables.container_id as containerId',
          'events.created_at as createdAt',
        ])
        .where('events.type', '=', 'artifact_created')
        .where('events.actor_user_id', 'is not', null)
        .where('events.actor_user_id', '<>', user.id)
        .where((eb) =>
          eb.or([
            eb('shareables.workspace_id', '=', user.workspaceId),
            eb.exists(
              sql`(select 1 from project_members pm where pm.container_id=shareables.container_id and pm.user_id=${user.id})`,
            ),
          ]),
        )
        .where(
          sql<boolean>`((shareables.workspace_id = ${user.workspaceId} AND ${visibleShareableToViewerSql(user)}) OR (shareables.workspace_id <> ${user.workspaceId} AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.container_id=shareables.container_id AND pm.user_id=${user.id}) AND ${visibleSharedProjectShareableToViewerSql(user)}))`,
        )
        .where(
          sql<boolean>`(${sql.join(
            keyChunk.map((row) => {
              const day = localDayKeyFromTimezone(
                row.createdAt,
                effectiveTimeZone,
              )
              const { start, end } = timezoneDayUtcRange(day, effectiveTimeZone)
              return sql`events.actor_user_id=${row.actorId} and shareables.container_id=${row.containerId} and events.created_at >= ${start} and events.created_at < ${end}`
            }),
            sql` or `,
          )})`,
        )
        .execute()
      for (const candidate of candidates) {
        const key = `${candidate.actorId}:${candidate.containerId}:${localDayKeyFromTimezone(candidate.createdAt, effectiveTimeZone)}`
        addAggregates.set(key, (addAggregates.get(key) ?? 0) + 1)
      }
    }
    let stoppedMidBatch = false
    for (const [index, row] of batch.entries()) {
      // 集約に畳まれて出力しない行も「消費済み」としてカーソルを進める。
      // push 時だけ進めると、読み飛ばした同日 view を跨がずにカーソルが
      // 確定し、同じ集約が次ページへ再出現する。
      current = {
        createdAt: row.createdAt,
        id: row.id,
        timeZone: effectiveTimeZone,
      }
      const dayKey = localDayKeyFromTimezone(row.createdAt, effectiveTimeZone)
      const key =
        row.type === 'artifact_viewed'
          ? slice === 'mine'
            ? dayKey
            : `${row.shareableId}:${dayKey}`
          : null
      const versionKey =
        row.type === 'version_published' ? `${row.shareableId}:${dayKey}` : null
      const versionAggregate = versionKey
        ? versionAggregates.get(versionKey)
        : null
      const commentKey =
        row.type === 'comment_posted' && row.actorId
          ? `${row.actorId}:${row.shareableId}:${dayKey}`
          : null
      const commentAggregate = commentKey
        ? commentAggregates.get(commentKey)
        : null
      const addKey =
        row.type === 'artifact_created' && row.actorId && row.containerId
          ? `${row.actorId}:${row.containerId}:${dayKey}`
          : null
      const addCount = addKey ? (addAggregates.get(addKey) ?? 0) : 0
      if (
        (key &&
          rows.some(
            (r) =>
              r.type === row.type &&
              (slice === 'all' || slice === 'project'
                ? r.shareableId === row.shareableId
                : true) &&
              r.dayKey === dayKey,
          )) ||
        (versionAggregate &&
          rows.some(
            (r) =>
              r.type === row.type &&
              r.shareableId === row.shareableId &&
              r.dayKey === dayKey,
          )) ||
        (commentAggregate &&
          commentAggregate.count >= 2 &&
          rows.some(
            (r) =>
              r.type === row.type &&
              r.actorId === row.actorId &&
              r.shareableId === row.shareableId &&
              r.dayKey === dayKey,
          )) ||
        (addCount >= 2 &&
          rows.some(
            (r) =>
              r.addCount != null &&
              r.actorId === row.actorId &&
              r.containerId === row.containerId &&
              r.dayKey === dayKey,
          ))
      )
        continue
      const { containerOwnerId, ...rowWithoutOwner } = row
      rows.push({
        ...rowWithoutOwner,
        dayKey,
        isViewerInbox:
          row.containerKind === 'inbox' && containerOwnerId === user.id,
        viewUniqueCount: key ? (counts.get(key)?.unique ?? 0) : null,
        anonymousViewCount: key ? (counts.get(key)?.anonymous ?? 0) : null,
        viewedFileCount:
          key && slice === 'mine' ? (counts.get(key)?.files ?? 0) : null,
        viewTopItems:
          key && slice === 'mine' ? (counts.get(key)?.top ?? []) : null,
        commentCount:
          commentAggregate && commentAggregate.count >= 2
            ? commentAggregate.count
            : null,
        commentBody:
          commentAggregate && commentAggregate.count >= 2
            ? commentAggregate.body
            : row.commentBody,
        versionStart: versionAggregate?.start ?? null,
        versionEnd: versionAggregate?.end ?? null,
        versionAuthorCount: versionAggregate?.authors.size ?? null,
        addCount: addCount >= 2 ? addCount : null,
      })
      if (rows.length >= targetRows) {
        // batch の途中で目標行数に達した場合、残りの行はカーソル以降に
        // 未消費で残っている。batch が SQL limit 未満でも続きがある。
        stoppedMidBatch = index < batch.length - 1
        break
      }
    }
    hasMore = batch.length === limit || stoppedMidBatch
    if (batch.length < limit) break
  }
  return {
    rows,
    nextCursor: current ?? null,
    hasMore: hasMore || consumed >= maxRawEvents,
  }
}

export async function listProjectViewRanking(
  db: EventDb,
  {
    containerId,
    now,
    user,
  }: { containerId: string; now: string; user: FeedUser },
) {
  return await db
    .selectFrom('events')
    .innerJoin('shareables', 'shareables.id', 'events.shareable_id')
    .leftJoin(
      'artifact_containers as projectContainers',
      'projectContainers.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id as shareableId',
      'shareables.name',
      'shareables.derived_title as derivedTitle',
      'shareables.title_override as titleOverride',
      'shareables.artifact_kind as artifactKind',
      sql<number>`count(*)`.as('viewCount'),
    ])
    .where('events.type', '=', 'artifact_viewed')
    .where('shareables.container_id', '=', containerId)
    .where(
      'events.created_at',
      '>=',
      // 格納形式 (ISO 8601 T 区切り + Z) と同じ書式で比較する。datetime() の
      // 空白区切りだと 10 文字目 'T' > ' ' で窓が最大 1 日広がる
      sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-30 days')`,
    )
    .where(sql<boolean>`(
      (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = projectContainers.workspace_id AND wm.user_id = ${user.id} AND wm.status = 'active')
        AND ${visibleShareableToViewerSql(user)})
      OR (NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = projectContainers.workspace_id AND wm.user_id = ${user.id} AND wm.status = 'active')
        AND ${visibleSharedProjectShareableToViewerSql(user)})
    )`)
    .groupBy([
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.artifact_kind',
    ])
    .orderBy('viewCount', 'desc')
    .orderBy('shareables.id', 'asc')
    .limit(5)
    .execute()
}

export function artifactCreatedEventQuery(
  db: EventDb,
  { versionId }: { versionId: string },
) {
  return db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'created_at',
    ])
    .expression(
      db
        .selectFrom('versions')
        .innerJoin('shareables', 'shareables.id', 'versions.shareable_id')
        .select([
          sql`${nanoid()}`.as('id'),
          sql`shareables.workspace_id`.as('workspace_id'),
          sql`'artifact_created'`.as('type'),
          sql`versions.shareable_id`.as('shareable_id'),
          sql`versions.created_by_id`.as('actor_user_id'),
          sql`versions.id`.as('subject_id'),
          sql`versions.published_at`.as('created_at'),
        ])
        .where('versions.id', '=', versionId)
        .where('versions.status', '=', 'published')
        .where('versions.published_at', 'is not', null),
    )
    .onConflict((oc) => oc.doNothing())
}
export function versionPublishedEventQuery(
  db: EventDb,
  { versionId }: { versionId: string },
) {
  return db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'created_at',
    ])
    .expression(
      db
        .selectFrom('versions')
        .innerJoin('shareables', 'shareables.id', 'versions.shareable_id')
        .select([
          sql`${nanoid()}`.as('id'),
          sql`shareables.workspace_id`.as('workspace_id'),
          sql`'version_published'`.as('type'),
          sql`versions.shareable_id`.as('shareable_id'),
          sql`versions.created_by_id`.as('actor_user_id'),
          sql`versions.id`.as('subject_id'),
          sql`versions.published_at`.as('created_at'),
        ])
        .where('versions.id', '=', versionId)
        .where('versions.status', '=', 'published')
        .where('versions.published_at', 'is not', null),
    )
    .onConflict((oc) => oc.doNothing())
}
export function commentPostedEventQuery(
  db: EventDb,
  args: {
    messageId: string
    shareableId: string
    actorUserId: string
    createdAt: string
  },
) {
  return db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'created_at',
    ])
    .expression(
      db
        .selectFrom('shareables')
        .select([
          sql`${nanoid()}`.as('id'),
          sql`workspace_id`.as('workspace_id'),
          sql`'comment_posted'`.as('type'),
          sql`id`.as('shareable_id'),
          sql`${args.actorUserId}`.as('actor_user_id'),
          sql`${args.messageId}`.as('subject_id'),
          sql`${args.createdAt}`.as('created_at'),
        ])
        .where('id', '=', args.shareableId),
    )
    .onConflict((oc) => oc.doNothing())
}
export function artifactViewedEventQuery(
  db: EventDb,
  args: { shareableId: string; actorUserId: string | null; viewedAt: string },
) {
  return db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'created_at',
    ])
    .expression(
      db
        .selectFrom('shareables')
        .select([
          sql`${nanoid()}`.as('id'),
          sql`workspace_id`.as('workspace_id'),
          sql`'artifact_viewed'`.as('type'),
          sql`id`.as('shareable_id'),
          sql`${args.actorUserId}`.as('actor_user_id'),
          sql`NULL`.as('subject_id'),
          sql`${args.viewedAt}`.as('created_at'),
        ])
        .where('id', '=', args.shareableId),
    )
}
export function pruneViewEventsQuery(
  db: EventDb,
  { cutoffIso, limit }: { cutoffIso: string; limit: number },
) {
  return db
    .deleteFrom('events')
    .where(
      'id',
      'in',
      db
        .selectFrom('events')
        .select('id')
        .where('type', '=', 'artifact_viewed')
        .where('created_at', '<', cutoffIso)
        .limit(limit),
    )
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Db } from './db.server'
import { discoverCandidates } from './search-discovery.server'

export async function readSearchLogs(db: Db, actorId: string) {
  const logs = await db
    .selectFrom('search_logs')
    .selectAll()
    .where('actor_id', '=', actorId)
    .orderBy('created_at', 'desc')
    .orderBy('id')
    .limit(50)
    .execute()
  if (!logs.length) return []
  const opens = await db
    .selectFrom(
      db
        .selectFrom('search_opens')
        .select(['id', 'search_id', 'shareable_id', 'rank', 'opened_at'])
        .select(
          sql<number>`row_number() OVER (PARTITION BY search_id ORDER BY opened_at DESC, id)`.as(
            'position',
          ),
        )
        .where(
          sql<boolean>`search_id IN (SELECT value FROM json_each(${JSON.stringify(logs.map((row) => row.id))}))`,
        )
        .as('o'),
    )
    .innerJoin('shareables as s', 's.id', 'o.shareable_id')
    .select([
      'o.search_id',
      'o.shareable_id',
      'o.rank',
      'o.opened_at',
      's.workspace_id',
    ])
    .where('o.position', '<=', 500)
    .orderBy('o.opened_at', 'desc')
    .orderBy('o.id')
    .limit(1000)
    .execute()
  const allowed = new Set<string>()
  for (const workspaceId of new Set(opens.map((row) => row.workspace_id))) {
    const ids = [
      ...new Set(
        opens
          .filter((opened) => opened.workspace_id === workspaceId)
          .map((opened) => opened.shareable_id),
      ),
    ]
    for (let offset = 0; offset < ids.length; offset += 100) {
      for (const row of await discoverCandidates(db, {
        viewerUserId: actorId,
        workspaceId,
        candidateIds: ids.slice(offset, offset + 100),
        includeArchived: true,
      }))
        allowed.add(row.id)
    }
  }
  return logs.map(({ token_key: _key, ...log }) => ({
    ...log,
    opens: opens
      .filter(
        (row) => row.search_id === log.id && allowed.has(row.shareable_id),
      )
      .map((row) => ({
        shareableId: row.shareable_id,
        rank: row.rank,
        openedAt: row.opened_at,
      })),
  }))
}
export async function recordSearchOpen(
  db: Db,
  actorId: string,
  searchId: string,
  receipt: string,
  now = new Date().toISOString(),
) {
  const token = await readSearchToken(db, actorId, receipt, 'open', now)
  if (
    !token ||
    token.log.id !== searchId ||
    typeof token.payload.file !== 'string' ||
    !Number.isSafeInteger(token.payload.rank) ||
    token.payload.rank <= 0
  )
    return false
  const row = await db
    .selectFrom('shareables')
    .select(['id as shareable_id', 'workspace_id'])
    .where('id', '=', token.payload.file)
    .executeTakeFirst()
  if (!row) return false
  const accepted = await discoverCandidates(db, {
    viewerUserId: actorId,
    workspaceId: row.workspace_id,
    candidateIds: [row.shareable_id],
    includeArchived: true,
    now,
  })
  if (!accepted.length) return false
  await db
    .insertInto('search_opens')
    .values({
      id: crypto.randomUUID(),
      search_id: searchId,
      shareable_id: row.shareable_id,
      rank: token.payload.rank,
      opened_at: now,
    })
    .execute()
  return true
}
export async function pruneSearchLogs(db: Db, cutoff: string) {
  const result = await db
    .deleteFrom('search_logs')
    .where(
      'id',
      'in',
      db
        .selectFrom('search_logs')
        .select('id')
        .where('created_at', '<', cutoff)
        .orderBy('created_at')
        .limit(500),
    )
    .returning('id')
    .execute()
  return result.length
}

/** A per-search key lives only on the actor-bound log. */
export const newSearchTokenKey = () => randomBytes(32).toString('base64url')
type SearchTokenPayload = {
  kind: 'cursor' | 'open'
  rank: number
  file?: string
}
export function sealSearchToken(
  id: string,
  key: string,
  payload: SearchTokenPayload,
) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64url'),
    iv,
  )
  cipher.setAAD(Buffer.from(id))
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  return `${id}.${Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url')}`
}
export async function readSearchToken(
  db: Db,
  actor: string,
  token: string,
  kind: SearchTokenPayload['kind'],
  now: string,
) {
  const [id, encoded, extra] = token.split('.')
  if (!id || !encoded || extra !== undefined) return null
  const log = await db
    .selectFrom('search_logs')
    .selectAll()
    .where('id', '=', id)
    .where('actor_id', '=', actor)
    .executeTakeFirst()
  if (
    !log ||
    new Date(now).getTime() - new Date(log.created_at).getTime() >= 30 * 60000
  )
    return null
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(log.token_key, 'base64url'),
      bytes.subarray(0, 12),
    )
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(bytes.subarray(12, 28))
    const payload: SearchTokenPayload = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString(),
    )
    if (
      payload.kind !== kind ||
      !Number.isSafeInteger(payload.rank) ||
      payload.rank <= 0
    )
      return null
    return { log, payload }
  } catch {
    return null
  }
}

import { sql, type Kysely, type Selectable } from 'kysely'
import {
  ANCHOR_TEXT_FORMAT,
  type AnchorDocument,
} from '@artifactshare/viewer-kit/anchor-text'
import type { DB } from '~/types/db'
import {
  MAX_ANCHOR_TEXT_UNITS,
  buildAnchorTransition,
  mapAnchorRange,
  type AnchorPosition,
  type AnchorTransition,
} from './comment-anchor-map.server'

export const MAX_ANCHOR_HOPS = 32
export const MAX_ANCHOR_VERSIONS = 256
export const MAX_TRANSITION_CACHE_BYTES = 4_000_000
export const MAX_ANCHOR_DOCUMENT_CACHE_BYTES = 16_000_000
const completedMaps = new Map<
  string,
  { map: AnchorTransition; bytes: number }
>()
let completedMapBytes = 0
function rememberMap(key: string, map: AnchorTransition, bytes: number) {
  if (bytes > MAX_TRANSITION_CACHE_BYTES) return
  while (
    completedMapBytes + bytes > MAX_TRANSITION_CACHE_BYTES &&
    completedMaps.size
  ) {
    const oldest = completedMaps.keys().next().value!
    completedMapBytes -= completedMaps.get(oldest)!.bytes
    completedMaps.delete(oldest)
  }
  if (!completedMaps.has(key)) {
    completedMaps.set(key, { map, bytes })
    completedMapBytes += bytes
  }
}
export async function pruneAnchorDocumentSnapshots(db: Kysely<DB>) {
  const rows = await db
    .selectFrom('comment_anchor_documents')
    .select([
      'version_id',
      'target_path',
      'format',
      sql<number>`length(document) * 2`.as('bytes'),
    ])
    .orderBy('created_at', 'asc')
    .execute()
  let bytes = rows.reduce((total, row) => total + Number(row.bytes), 0)
  for (const row of rows) {
    if (bytes <= MAX_ANCHOR_DOCUMENT_CACHE_BYTES) break
    await db
      .deleteFrom('comment_anchor_documents')
      .where('version_id', '=', row.version_id)
      .where('target_path', '=', row.target_path)
      .where('format', '=', row.format)
      .execute()
    bytes -= Number(row.bytes)
  }
}
export type StoredAnchor = {
  id: string
  version_id: string | null
  target_path: string
  text_start: number
  text_end: number
  quoted_text: string
}
type Version = Selectable<DB['versions']>
export type ResolvedPosition = AnchorPosition | null

/** Missing positions mean unfinished work. Only proven results are written. */
export function createAnchorResolver(
  db: Kysely<DB>,
  shareableId: string,
  currentVersionId: string | null,
  load: (version: Version) => Promise<AnchorDocument | null>,
  limits: {
    hops?: number
    versions?: number
    frontier?: number
    format?: string
  } = {},
) {
  const format = limits.format ?? ANCHOR_TEXT_FORMAT
  const versions = new Map<string, Version | null>()
  const documents = new Map<string, AnchorDocument | null>()
  const storedDocuments = new Set<string>()
  const priorDocuments = new Map<string, AnchorDocument | null>()
  const maps = new Map<string, AnchorTransition | null>()
  async function version(id: string) {
    if (versions.has(id)) return versions.get(id)
    if (versions.size >= (limits.versions ?? MAX_ANCHOR_VERSIONS))
      return undefined
    const row = await db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', id)
      .where('shareable_id', '=', shareableId)
      .executeTakeFirst()
    versions.set(id, row ?? null)
    return row ?? null
  }
  async function document(row: Version) {
    if (!documents.has(row.id)) {
      try {
        const source = await load(row)
        documents.set(
          row.id,
          source && source.text.length <= MAX_ANCHOR_TEXT_UNITS ? source : null,
        )
      } catch {
        documents.set(row.id, null)
      }
    }
    const value = documents.get(row.id) ?? null
    if (value && !storedDocuments.has(row.id)) {
      storedDocuments.add(row.id)
      const encoded = JSON.stringify(value)
      const retained = await db
        .selectFrom('comment_anchor_documents')
        .select([
          'version_id',
          'target_path',
          'format',
          sql<number>`length(document) * 2`.as('bytes'),
        ])
        .orderBy('created_at', 'asc')
        .execute()
      let bytes = retained.reduce(
        (total, item) => total + Number(item.bytes),
        encoded.length * 2,
      )
      for (const item of retained) {
        if (bytes <= MAX_ANCHOR_DOCUMENT_CACHE_BYTES) break
        await db
          .deleteFrom('comment_anchor_documents')
          .where('version_id', '=', item.version_id)
          .where('target_path', '=', item.target_path)
          .where('format', '=', item.format)
          .execute()
        bytes -= Number(item.bytes)
      }
      if (encoded.length * 2 <= MAX_ANCHOR_DOCUMENT_CACHE_BYTES)
        await db
          .insertInto('comment_anchor_documents')
          .values({
            version_id: row.id,
            target_path: row.entrypoint_path,
            format,
            document: encoded,
            created_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(['version_id', 'target_path', 'format']).doNothing(),
          )
          .execute()
    }
    return value
  }
  async function cached(anchor: StoredAnchor, id: string) {
    const row = await db
      .selectFrom('comment_anchor_positions')
      .selectAll()
      .where('anchor_id', '=', anchor.id)
      .where('version_id', '=', id)
      .where('target_path', '=', anchor.target_path)
      .where('format', '=', format)
      .executeTakeFirst()
    if (!row) return undefined
    return row.reason !== null
      ? { reason: row.reason }
      : { textStart: row.text_start!, textEnd: row.text_end! }
  }
  async function save(
    anchor: StoredAnchor,
    id: string,
    position: AnchorPosition,
  ) {
    await db
      .insertInto('comment_anchor_positions')
      .values({
        anchor_id: anchor.id,
        version_id: id,
        target_path: anchor.target_path,
        format,
        text_start: 'reason' in position ? null : position.textStart,
        text_end: 'reason' in position ? null : position.textEnd,
        reason: 'reason' in position ? position.reason : null,
      })
      .onConflict((oc) =>
        oc
          .columns(['anchor_id', 'version_id', 'target_path', 'format'])
          .doNothing(),
      )
      .execute()
  }
  async function transition(
    left: Version,
    right: Version,
    prior?: { format: string; document: AnchorDocument },
  ) {
    const pair = `${left.id}:${right.id}:${prior?.format ?? format}:${format}`
    if (maps.has(pair)) return maps.get(pair) ?? null
    const a = prior?.document ?? (await document(left)),
      b = await document(right)
    if (!a || !b) return null
    const bytes = new TextEncoder().encode(
      JSON.stringify([
        format,
        prior?.format ?? format,
        left.id,
        right.id,
        left.entrypoint_path,
        right.entrypoint_path,
        a,
        b,
      ]),
    )
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const key = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
    const stored = await db
      .selectFrom('comment_anchor_transitions')
      .select('edit_map')
      .where('cache_key', '=', key)
      .executeTakeFirst()
    const map =
      completedMaps.get(key)?.map ??
      (stored
        ? (JSON.parse(stored.edit_map) as AnchorTransition)
        : buildAnchorTransition(a, b, limits.frontier))
    if (map) rememberMap(key, map, JSON.stringify(map).length * 2)
    maps.set(pair, map)
    if (map && !stored) {
      const encoded = JSON.stringify(map)
      if (encoded.length * 2 <= MAX_TRANSITION_CACHE_BYTES) {
        // Bound retained maps by age and count; eviction never changes results.
        await db
          .deleteFrom('comment_anchor_transitions')
          .where(
            'created_at',
            '<',
            new Date(Date.now() - 7 * 86400000).toISOString(),
          )
          .execute()
        const retained = await db
          .selectFrom('comment_anchor_transitions')
          .select(['cache_key', sql<number>`length(edit_map) * 2`.as('bytes')])
          .orderBy('created_at', 'asc')
          .execute()
        let total = retained.reduce(
          (sum, row) => sum + Number(row.bytes),
          encoded.length * 2,
        )
        for (const row of retained) {
          if (total <= MAX_TRANSITION_CACHE_BYTES) break
          await db
            .deleteFrom('comment_anchor_transitions')
            .where('cache_key', '=', row.cache_key)
            .execute()
          total -= Number(row.bytes)
        }
        await db
          .insertInto('comment_anchor_transitions')
          .values({
            cache_key: key,
            shareable_id: shareableId,
            edit_map: encoded,
            created_at: new Date().toISOString(),
          })
          .onConflict((oc) => oc.column('cache_key').doNothing())
          .execute()
      }
    }
    return map
  }
  return async (anchor: StoredAnchor): Promise<ResolvedPosition> => {
    if (!currentVersionId) return { reason: 'missing-lineage' }
    const path: Version[] = []
    const seen = new Set<string>()
    let id: string | null = currentVersionId
    let position: AnchorPosition | undefined
    let base: Version | undefined
    while (id) {
      if (seen.has(id)) return null
      seen.add(id)
      const row = await version(id)
      if (row === undefined) return null
      if (row === null) break
      const saved = await cached(anchor, id)
      if (saved) {
        position = saved
        base = row
        break
      }
      const prior = await db
        .selectFrom('comment_anchor_positions')
        .selectAll()
        .where('anchor_id', '=', anchor.id)
        .where('version_id', '=', id)
        .where('target_path', '=', anchor.target_path)
        .orderBy('format', 'asc')
        .executeTakeFirst()
      if (prior) {
        if (prior.reason) position = { reason: prior.reason }
        else {
          const sourceKey = `${id}:${anchor.target_path}:${prior.format}`
          if (!priorDocuments.has(sourceKey)) {
            const old = await db
              .selectFrom('comment_anchor_documents')
              .select('document')
              .where('version_id', '=', id)
              .where('target_path', '=', anchor.target_path)
              .where('format', '=', prior.format)
              .executeTakeFirst()
            priorDocuments.set(
              sourceKey,
              old ? (JSON.parse(old.document) as AnchorDocument) : null,
            )
          }
          const oldDocument = priorDocuments.get(sourceKey)
          if (!oldDocument) return null
          const map = await transition(row, row, {
            format: prior.format,
            document: oldDocument,
          })
          if (!map) return null
          position = mapAnchorRange(map, prior.text_start!, prior.text_end!)
        }
        await save(anchor, id, position)
        base = row
        break
      }
      if (id === anchor.version_id) {
        const source = await document(row)
        if (!source) return null
        position =
          anchor.text_start >= 0 &&
          anchor.text_end > anchor.text_start &&
          anchor.text_end <= source.text.length &&
          source.text.slice(anchor.text_start, anchor.text_end) ===
            anchor.quoted_text
            ? { textStart: anchor.text_start, textEnd: anchor.text_end }
            : { reason: 'invalid-origin' }
        await save(anchor, id, position)
        base = row
        break
      }
      path.push(row)
      if (row.anchor_lineage_recorded !== 1) break
      id = row.previous_current_version_id
    }
    if (!position || !base) {
      const missing = { reason: 'missing-lineage' }
      if (await version(currentVersionId))
        await save(anchor, currentVersionId, missing)
      return missing
    }
    let hops = 0
    for (const target of path.reverse()) {
      if (++hops > (limits.hops ?? MAX_ANCHOR_HOPS)) return null
      if (!('reason' in position)) {
        if (
          target.entrypoint_path !== anchor.target_path ||
          base.entrypoint_path !== anchor.target_path
        )
          position = { reason: 'target-path-changed' }
        else {
          const map = await transition(base, target)
          if (!map) return null
          position = mapAnchorRange(map, position.textStart, position.textEnd)
        }
      }
      await save(anchor, target.id, position)
      base = target
    }
    return position
  }
}

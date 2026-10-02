import { sql, type Kysely, type Selectable } from 'kysely'
import {
  ANCHOR_TEXT_FORMAT,
  type AnchorDocument,
} from '@artifactshare/viewer-kit/anchor-text'
import type { DB } from '~/types/db'
import {
  MAX_ANCHOR_TEXT_UNITS,
  MAX_ANCHOR_FRONTIER_STEPS,
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
// Exhaustion is not absence. Avoid repeatedly spending the same budget on a
// hot pair; more generous callers can retry immediately, others after backoff.
const exhaustedMaps = new Map<
  string,
  { budget: number; retryAt: number; attempts: number }
>()
const MAX_EXHAUSTED_PAIRS = 128
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
      sql<number>`length(CAST(document AS BLOB))`.as('bytes'),
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
// Keep every cache row well below D1's 2 MB UTF-8 row limit. The manifest
// is written last; incomplete/evicted snapshots remain retryable cache misses.
const SNAPSHOT_CHUNK_UNITS = 200_000
export async function storeAnchorDocumentSnapshot(
  db: Kysely<DB>,
  versionId: string,
  targetPath: string,
  format: string,
  document: AnchorDocument,
) {
  try {
    const encoded = JSON.stringify(document)
    if (
      new TextEncoder().encode(encoded).byteLength >
      MAX_ANCHOR_DOCUMENT_CACHE_BYTES
    )
      return
    const parts: string[] = []
    for (let start = 0; start < encoded.length;) {
      let end = Math.min(encoded.length, start + SNAPSHOT_CHUNK_UNITS)
      const last = encoded.charCodeAt(end - 1)
      if (end < encoded.length && last >= 0xd800 && last <= 0xdbff) end--
      parts.push(encoded.slice(start, end))
      start = end
    }
    const chunks = parts.length
    for (let i = 0; i < chunks; i++) {
      await db
        .insertInto('comment_anchor_documents')
        .values({
          version_id: versionId,
          target_path: targetPath,
          format: `${format}:chunk:${i}`,
          document: parts[i]!,
          created_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['version_id', 'target_path', 'format']).doNothing(),
        )
        .execute()
    }
    await db
      .insertInto('comment_anchor_documents')
      .values({
        version_id: versionId,
        target_path: targetPath,
        format,
        document: JSON.stringify({ chunks }),
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(['version_id', 'target_path', 'format']).doNothing(),
      )
      .execute()
    await pruneAnchorDocumentSnapshots(db)
  } catch {
    // Snapshot retention is optional; it must never fail a comment operation.
  }
}
async function readAnchorDocumentSnapshot(
  db: Kysely<DB>,
  versionId: string,
  targetPath: string,
  format: string,
): Promise<AnchorDocument | null> {
  try {
    const rows = await db
      .selectFrom('comment_anchor_documents')
      .select(['format', 'document'])
      .where('version_id', '=', versionId)
      .where('target_path', '=', targetPath)
      .execute()
    const byFormat = new Map(rows.map((row) => [row.format, row.document]))
    const encoded = byFormat.get(format)
    if (!encoded) return null
    const manifest = JSON.parse(encoded)
    if (!('chunks' in manifest)) return manifest as AnchorDocument
    if (
      !Number.isInteger(manifest.chunks) ||
      manifest.chunks < 1 ||
      manifest.chunks > 100
    )
      return null
    const parts: string[] = []
    for (let i = 0; i < manifest.chunks; i++) {
      const chunk = byFormat.get(`${format}:chunk:${i}`)
      if (chunk === undefined) return null
      parts.push(chunk)
    }
    return JSON.parse(parts.join('')) as AnchorDocument
  } catch {
    return null
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
      await storeAnchorDocumentSnapshot(
        db,
        row.id,
        row.entrypoint_path,
        format,
        value,
      )
    }
    return value
  }
  type PositionRow = Selectable<DB['comment_anchor_positions']>
  let loadedPositions: Map<string, PositionRow[]> | undefined
  const pendingPositions = new Map<string, PositionRow[]>()
  const positionKey = (anchor: StoredAnchor, id: string) =>
    JSON.stringify([anchor.id, id, anchor.target_path])
  function priorPosition(anchor: StoredAnchor, id: string) {
    if (loadedPositions)
      return loadedPositions
        .get(positionKey(anchor, id))
        ?.toSorted((a, b) => a.format.localeCompare(b.format))[0]
    return db
      .selectFrom('comment_anchor_positions')
      .selectAll()
      .where('anchor_id', '=', anchor.id)
      .where('version_id', '=', id)
      .where('target_path', '=', anchor.target_path)
      .orderBy('format', 'asc')
      .executeTakeFirst()
  }
  async function cached(anchor: StoredAnchor, id: string) {
    const row = loadedPositions
      ? loadedPositions
          .get(positionKey(anchor, id))
          ?.find((entry) => entry.format === format)
      : await db
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
    const row: PositionRow = {
      anchor_id: anchor.id,
      version_id: id,
      target_path: anchor.target_path,
      format,
      text_start: 'reason' in position ? null : position.textStart,
      text_end: 'reason' in position ? null : position.textEnd,
      reason: 'reason' in position ? position.reason : null,
    }
    if (loadedPositions) {
      const key = positionKey(anchor, id)
      const rows = loadedPositions.get(key) ?? []
      rows.push(row)
      loadedPositions.set(key, rows)
      const pending = pendingPositions.get(id) ?? []
      pending.push(row)
      pendingPositions.set(id, pending)
    } else {
      await db
        .insertInto('comment_anchor_positions')
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(['anchor_id', 'version_id', 'target_path', 'format'])
            .doNothing(),
        )
        .execute()
    }
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
        'block-boundaries-v2',
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
    const budget = limits.frontier ?? MAX_ANCHOR_FRONTIER_STEPS
    const failure = exhaustedMaps.get(key)
    const map =
      completedMaps.get(key)?.map ??
      (stored
        ? (JSON.parse(stored.edit_map) as AnchorTransition)
        : failure && failure.budget >= budget && failure.retryAt > Date.now()
          ? null
          : buildAnchorTransition(a, b, budget))
    if (map) {
      exhaustedMaps.delete(key)
      rememberMap(key, map, JSON.stringify(map).length * 2)
    } else if (
      !failure ||
      failure.retryAt <= Date.now() ||
      failure.budget < budget
    ) {
      const attempts = (failure?.attempts ?? 0) + 1
      if (exhaustedMaps.size >= MAX_EXHAUSTED_PAIRS)
        exhaustedMaps.delete(exhaustedMaps.keys().next().value!)
      exhaustedMaps.set(key, {
        budget,
        attempts,
        retryAt:
          Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)),
      })
    }
    maps.set(pair, map)
    if (map && !stored) {
      try {
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
            .select([
              'cache_key',
              sql<number>`length(edit_map) * 2`.as('bytes'),
            ])
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
      } catch {
        // A cache write failure does not invalidate a completed transition.
      }
    }
    return map
  }
  async function* resolveSteps(
    anchor: StoredAnchor,
  ): AsyncGenerator<void, ResolvedPosition> {
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
      const prior = await priorPosition(anchor, id)
      if (prior) {
        if (prior.reason) position = { reason: prior.reason }
        else {
          const sourceKey = `${id}:${anchor.target_path}:${prior.format}`
          if (!priorDocuments.has(sourceKey)) {
            priorDocuments.set(
              sourceKey,
              await readAnchorDocumentSnapshot(
                db,
                id,
                row.entrypoint_path,
                prior.format,
              ),
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
        yield
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
        yield
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
        const map = await transition(base, target)
        if (!map) return null
        position = mapAnchorRange(map, position.textStart, position.textEnd)
      }
      await save(anchor, target.id, position)
      yield
      base = target
    }
    return position
  }
  async function resolve(anchor: StoredAnchor): Promise<ResolvedPosition> {
    const steps = resolveSteps(anchor)
    let step = await steps.next()
    while (!step.done) step = await steps.next()
    return step.value
  }
  async function flushPositions() {
    // One JSON parameter per version keeps a full window below D1's parameter
    // limit. Flush each completed hop before beginning the next transition.
    for (const rows of pendingPositions.values()) {
      await sql`INSERT OR IGNORE INTO comment_anchor_positions
        (anchor_id, version_id, target_path, format, text_start, text_end, reason)
        SELECT json_extract(value, '$.anchor_id'), json_extract(value, '$.version_id'),
          json_extract(value, '$.target_path'), json_extract(value, '$.format'),
          json_extract(value, '$.text_start'), json_extract(value, '$.text_end'),
          json_extract(value, '$.reason') FROM json_each(${JSON.stringify(rows)})`.execute(
        db,
      )
    }
    pendingPositions.clear()
  }
  return Object.assign(resolve, {
    async resolveMany(anchors: StoredAnchor[]): Promise<ResolvedPosition[]> {
      if (!anchors.length) return []
      loadedPositions = new Map()
      const lineage: string[] = []
      const seen = new Set<string>()
      let current = currentVersionId
      while (current && !seen.has(current)) {
        seen.add(current)
        const row = await version(current)
        if (!row) break
        lineage.push(current)
        if (row.anchor_lineage_recorded !== 1) break
        current = row.previous_current_version_id
      }
      // Read all formats and progress in bounded-parameter batches, once for
      // the window. No anchor/hop loop performs a position SELECT or INSERT.
      for (let i = 0; lineage.length && i < anchors.length; i += 90) {
        const rows = await db
          .selectFrom('comment_anchor_positions')
          .selectAll()
          .where(
            'version_id',
            'in',
            sql<string>`(SELECT value FROM json_each(${JSON.stringify(lineage)}))`,
          )
          .where(
            'anchor_id',
            'in',
            anchors.slice(i, i + 90).map((a) => a.id),
          )
          .execute()
        for (const row of rows) {
          const key = JSON.stringify([
            row.anchor_id,
            row.version_id,
            row.target_path,
          ])
          const entries = loadedPositions.get(key) ?? []
          entries.push(row)
          loadedPositions.set(key, entries)
        }
      }
      try {
        const results: ResolvedPosition[] = Array(anchors.length).fill(null)
        let active = anchors.map((anchor, index) => ({
          index,
          steps: resolveSteps(anchor),
        }))
        while (active.length) {
          const next: typeof active = []
          for (const item of active) {
            // Readers share transition construction and persistence state.
            // Advancing them serially prevents duplicate in-flight diff work.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const step = await item.steps.next()
            if (step.done) results[item.index] = step.value
            else next.push(item)
          }
          await flushPositions()
          active = next
        }
        return results
      } finally {
        await flushPositions()
        loadedPositions = undefined
      }
    },
  })
}

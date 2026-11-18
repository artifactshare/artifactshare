import * as workers from 'cloudflare:workers'
import { sql } from 'kysely'
import { withDb, type Db } from '../db.server'

/** The Durable Object regions a workspace search index can be created in. */
export type SearchIndexLocation =
  | 'wnam'
  | 'enam'
  | 'sam'
  | 'weur'
  | 'eeur'
  | 'apac'
  | 'apac-ne'
  | 'apac-se'
  | 'oc'
  | 'afr'
  | 'me'

const NORTHEAST_ASIA = new Set(['JP', 'KR', 'KP', 'TW', 'HK', 'MO', 'CN', 'MN'])
const SOUTHEAST_ASIA = new Set([
  'SG',
  'MY',
  'ID',
  'TH',
  'VN',
  'PH',
  'KH',
  'LA',
  'MM',
  'BN',
  'TL',
])
const MIDDLE_EAST = new Set([
  'AE',
  'SA',
  'QA',
  'KW',
  'BH',
  'OM',
  'YE',
  'IL',
  'PS',
  'JO',
  'LB',
  'SY',
  'IQ',
  'IR',
])
const EASTERN_EUROPE = new Set([
  'PL',
  'CZ',
  'SK',
  'HU',
  'RO',
  'BG',
  'UA',
  'BY',
  'MD',
  'LT',
  'LV',
  'EE',
  'RU',
  'RS',
  'HR',
  'SI',
  'BA',
  'ME',
  'MK',
  'AL',
  'XK',
  'GR',
  'TR',
  'CY',
  'GE',
  'AM',
  'AZ',
])

/**
 * The search index location for a request's country and continent, as
 * Cloudflare reports them. Undefined when the request carries neither or
 * the region has no mapping, so nothing is recorded from it.
 */
export function searchIndexLocation(cf: {
  country?: unknown
  continent?: unknown
  longitude?: unknown
}): SearchIndexLocation | undefined {
  const country = typeof cf.country === 'string' ? cf.country : ''
  const continent = typeof cf.continent === 'string' ? cf.continent : ''
  if (NORTHEAST_ASIA.has(country)) return 'apac-ne'
  if (SOUTHEAST_ASIA.has(country)) return 'apac-se'
  if (MIDDLE_EAST.has(country)) return 'me'
  if (EASTERN_EUROPE.has(country)) return 'eeur'
  switch (continent) {
    case 'AS':
      return 'apac'
    case 'OC':
      return 'oc'
    case 'EU':
      return 'weur'
    case 'AF':
      return 'afr'
    case 'SA':
      return 'sam'
    case 'NA': {
      // West of the Rockies is closer to the west coast region.
      const longitude = Number(cf.longitude)
      return Number.isFinite(longitude) && longitude < -100 ? 'wnam' : 'enam'
    }
    default:
      return undefined
  }
}

/**
 * Record the location once for a workspace when the user is one of its
 * active members and none is recorded yet. One statement returns the stored
 * location: null means the workspace still has none (the user is not an
 * active member), whether or not another request recorded it first.
 */
export async function recordSearchIndexLocation(
  db: Db,
  input: { workspaceId: string; userId: string; location: SearchIndexLocation },
): Promise<string | null> {
  const result = await sql<{ location_hint: string | null }>`
    INSERT INTO search_index_workspaces(workspace_id, dispatched_at, location_hint)
    SELECT ${input.workspaceId}, '', CASE WHEN EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_id = ${input.workspaceId}
        AND user_id = ${input.userId}
        AND status = 'active'
    ) THEN ${input.location} END
    WHERE true
    ON CONFLICT(workspace_id) DO UPDATE SET location_hint =
      coalesce(search_index_workspaces.location_hint, excluded.location_hint)
    RETURNING location_hint
  `.execute(db)
  return result.rows[0]?.location_hint ?? null
}

/** Insertion-ordered set that drops its oldest entry beyond a limit. */
class BoundedSet {
  readonly #values = new Map<string, number>()
  constructor(readonly limit: number) {}
  has(key: string, now: number) {
    const expires = this.#values.get(key)
    if (expires === undefined) return false
    if (expires > now) return true
    this.#values.delete(key)
    return false
  }
  add(key: string, expires: number) {
    this.#values.delete(key)
    this.#values.set(key, expires)
    if (this.#values.size > this.limit)
      this.#values.delete(this.#values.keys().next().value!)
  }
}

// A recorded location never changes, so a workspace with one is skipped for
// the rest of this isolate. A user who could not record (not an active
// member) is skipped for that workspace for a while, so repeated requests
// do not keep writing; any other member can still record meanwhile.
const recorded = new BoundedSet(10_000)
const declined = new BoundedSet(10_000)
const inFlight = new Set<string>()
const DECLINED_MS = 10 * 60_000

function logRecordFailure(error: unknown) {
  console.error(
    JSON.stringify({
      event: 'search_index_location_record_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}

/**
 * After a signed-in request, record the workspace's search index location
 * from where the request came from, without delaying or failing the
 * response.
 */
export function rememberSearchIndexLocation(
  request: Request,
  user: { id: string; workspaceId: string; kind: 'human' | 'bot' },
  options: {
    background?: ((promise: Promise<unknown>) => void) | undefined
    open?: <T>(run: (db: Db) => Promise<T>) => Promise<T>
    now?: number
  } = {},
) {
  const background =
    'background' in options ? options.background : workers.waitUntil
  const open = options.open ?? withDb
  const now = options.now ?? Date.now()
  const workspaceId = user.workspaceId
  const attempt = `${workspaceId}\u0000${user.id}`
  if (
    typeof background !== 'function' ||
    user.kind !== 'human' ||
    recorded.has(workspaceId, now) ||
    declined.has(attempt, now) ||
    inFlight.has(workspaceId)
  )
    return
  const location = searchIndexLocation({
    country: request.cf?.country,
    continent: request.cf?.continent,
    longitude: request.cf?.longitude,
  })
  if (!location) return
  inFlight.add(workspaceId)
  // The write releases inFlight itself, even if waitUntil refuses it.
  const work = open((db) =>
    recordSearchIndexLocation(db, {
      workspaceId,
      userId: user.id,
      location,
    }),
  )
    .then((stored) => {
      if (stored) recorded.add(workspaceId, Number.POSITIVE_INFINITY)
      else declined.add(attempt, now + DECLINED_MS)
    })
    .catch(logRecordFailure)
    .finally(() => inFlight.delete(workspaceId))
  try {
    background(work)
  } catch (error) {
    logRecordFailure(error)
  }
}

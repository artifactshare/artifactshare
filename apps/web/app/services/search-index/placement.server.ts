import * as workers from 'cloudflare:workers'
import { sql } from 'kysely'
import { withDb, type Db } from '../db.server'

import type { SearchIndexLocation } from './names'

export type { SearchIndexLocation }

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
 * active members and none is recorded yet. Returns the stored location,
 * or null when the workspace still has none (the user is not an active
 * member). Nothing is written unless a location is recorded.
 */
export async function recordSearchIndexLocation(
  db: Db,
  input: { workspaceId: string; userId: string; location: SearchIndexLocation },
): Promise<string | null> {
  const written = await sql<{ location_hint: string }>`
    INSERT INTO search_index_workspaces(workspace_id, dispatched_at, location_hint)
    SELECT ${input.workspaceId}, '', ${input.location}
    WHERE EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_id = ${input.workspaceId}
        AND user_id = ${input.userId}
        AND status = 'active'
    )
    ON CONFLICT(workspace_id) DO UPDATE SET location_hint = excluded.location_hint
    WHERE search_index_workspaces.location_hint IS NULL
    RETURNING location_hint
  `.execute(db)
  if (written.rows[0]) return written.rows[0].location_hint
  // Nothing written: either a location was already recorded or the user is
  // not an active member.
  const stored = await db
    .selectFrom('search_index_workspaces')
    .select('location_hint')
    .where('workspace_id', '=', input.workspaceId)
    .executeTakeFirst()
  return stored?.location_hint ?? null
}

const CACHE_LIMIT = 10_000
const DECLINED_MS = 10 * 60_000
const IN_FLIGHT_MS = 60_000

// Workspaces known to have a location, which never changes. Oldest first.
const recorded = new Set<string>()
// Workspace and user pairs that could not record (not an active member),
// with when they may try again; any other member can still record.
const declinedUntil = new Map<string, number>()
// Workspaces with a write in progress and when it started. A write that
// never settles stops blocking after a minute.
const inFlightSince = new Map<string, number>()

function addRecorded(workspaceId: string) {
  recorded.delete(workspaceId)
  recorded.add(workspaceId)
  if (recorded.size > CACHE_LIMIT)
    recorded.delete(recorded.values().next().value!)
}

function addDeclined(attempt: string, until: number) {
  declinedUntil.delete(attempt)
  declinedUntil.set(attempt, until)
  if (declinedUntil.size > CACHE_LIMIT)
    declinedUntil.delete(declinedUntil.keys().next().value!)
}

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
    background?: (promise: Promise<unknown>) => void
    open?: <T>(run: (db: Db) => Promise<T>) => Promise<T>
    now?: number
  } = {},
) {
  const background = options.background ?? workers.waitUntil
  const open = options.open ?? withDb
  const now = options.now ?? Date.now()
  const workspaceId = user.workspaceId
  const attempt = `${workspaceId}\u0000${user.id}`
  if (
    typeof background !== 'function' ||
    user.kind !== 'human' ||
    recorded.has(workspaceId) ||
    (declinedUntil.get(attempt) ?? 0) > now ||
    now - (inFlightSince.get(workspaceId) ?? -Infinity) < IN_FLIGHT_MS
  )
    return
  const location = searchIndexLocation({
    country: request.cf?.country,
    continent: request.cf?.continent,
    longitude: request.cf?.longitude,
  })
  if (!location) return
  inFlightSince.set(workspaceId, now)
  const work = open((db) =>
    recordSearchIndexLocation(db, {
      workspaceId,
      userId: user.id,
      location,
    }),
  )
    .then((stored) => {
      if (stored) addRecorded(workspaceId)
      else addDeclined(attempt, now + DECLINED_MS)
    })
    .catch(logRecordFailure)
    .finally(() => inFlightSince.delete(workspaceId))
  try {
    background(work)
  } catch (error) {
    logRecordFailure(error)
  }
}

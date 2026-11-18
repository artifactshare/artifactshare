import * as workers from 'cloudflare:workers'
import { sql } from 'kysely'
import { createDb, type Db } from '../db.server'

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
 * Record the location once for a workspace, only when the user is one of
 * its active members and no location is recorded yet.
 */
export async function recordSearchIndexLocation(
  db: Db,
  input: { workspaceId: string; userId: string; location: SearchIndexLocation },
) {
  await sql`
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
  `.execute(db)
}

// Workspaces this isolate already tried to record; a recorded hint never
// changes, so later requests skip the write.
const attempted = new Set<string>()
const ATTEMPT_LIMIT = 10_000

/**
 * After a signed-in request, record the workspace's search index location
 * from where the request came from, without delaying the response.
 */
export function rememberSearchIndexLocation(
  request: Request,
  user: { id: string; workspaceId: string; kind: 'human' | 'bot' },
  background:
    | ((promise: Promise<unknown>) => void)
    | undefined = workers.waitUntil,
) {
  if (
    typeof background !== 'function' ||
    user.kind !== 'human' ||
    attempted.has(user.workspaceId)
  )
    return
  const location = searchIndexLocation({
    country: request.cf?.country,
    continent: request.cf?.continent,
    longitude: request.cf?.longitude,
  })
  if (!location) return
  if (attempted.size >= ATTEMPT_LIMIT) attempted.clear()
  attempted.add(user.workspaceId)
  const db = createDb()
  background(
    recordSearchIndexLocation(db, {
      workspaceId: user.workspaceId,
      userId: user.id,
      location,
    })
      .catch(() => {
        attempted.delete(user.workspaceId)
        console.error('search_index_location_record_failed')
      })
      .finally(() => db.destroy()),
  )
}

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
 * Record the location once for a workspace, only when the user is one of
 * its active members and no location is recorded yet. Returns whether the
 * workspace has a recorded location afterwards.
 */
export async function recordSearchIndexLocation(
  db: Db,
  input: { workspaceId: string; userId: string; location: SearchIndexLocation },
): Promise<boolean> {
  const existing = await db
    .selectFrom('search_index_workspaces')
    .select('location_hint')
    .where('workspace_id', '=', input.workspaceId)
    .executeTakeFirst()
  if (existing?.location_hint) return true
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
  return written.rows.length > 0
}

// A recorded location never changes, so a workspace known to have one is
// skipped for the rest of this isolate. A workspace whose request did not
// record (not an active member) stays eligible for the next request.
const recorded = new Set<string>()
const inFlight = new Set<string>()
const RECORDED_LIMIT = 10_000

/**
 * After a signed-in request, record the workspace's search index location
 * from where the request came from, without delaying or failing the
 * response.
 */
export function rememberSearchIndexLocation(
  request: Request,
  user: { id: string; workspaceId: string; kind: 'human' | 'bot' },
  background:
    | ((promise: Promise<unknown>) => void)
    | undefined = workers.waitUntil,
) {
  const workspaceId = user.workspaceId
  if (
    typeof background !== 'function' ||
    user.kind !== 'human' ||
    recorded.has(workspaceId) ||
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
  try {
    background(
      withDb((db) =>
        recordSearchIndexLocation(db, {
          workspaceId,
          userId: user.id,
          location,
        }),
      )
        .then((done) => {
          if (!done) return
          if (recorded.size >= RECORDED_LIMIT) recorded.clear()
          recorded.add(workspaceId)
        })
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: 'search_index_location_record_failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        })
        .finally(() => inFlight.delete(workspaceId)),
    )
  } catch (error) {
    inFlight.delete(workspaceId)
    console.error(
      JSON.stringify({
        event: 'search_index_location_record_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

import { sql, type Selectable } from 'kysely'
import type { SecurityDeceptionSignalsTable } from '~/types/db'
import { createDb, type Db } from './db.server'
import {
  resolveDeceptionIdentity,
  type DeceptionPrincipal,
} from './security-deception-auth.server'
import { postSlackWebhook } from './slack.server'

export const DECEPTION_PATH = '/api/internal/credential-inventory'
type Signal = Selectable<SecurityDeceptionSignalsTable>
const iso = (ms: number) => new Date(ms).toISOString()
export function deceptionResponse(status = 404) {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
export function qualifiedDeceptionRequest(request: Request, origin: string) {
  return (
    new URL(request.url).pathname === DECEPTION_PATH &&
    request.method === 'POST' &&
    request.headers.get('X-ArtifactShare-Inventory') === 'inspect' &&
    !/prefetch|prerender/i.test(
      `${request.headers.get('purpose') ?? ''} ${request.headers.get('sec-purpose') ?? ''}`,
    ) &&
    (!request.headers.has('origin') ||
      request.headers.get('origin') === origin) &&
    request.headers.get('sec-fetch-site')?.toLowerCase() !== 'cross-site'
  )
}
export async function handleDeceptionRequest(request: Request, origin: string) {
  if (!qualifiedDeceptionRequest(request, origin)) return deceptionResponse()
  const correlation = crypto.randomUUID()
  let db: Db | undefined
  try {
    db = createDb()
    const result = await resolveDeceptionIdentity(db, request)
    if (result.kind === 'unavailable') throw new Error('identity unavailable')
    if (result.kind === 'trusted')
      await admitDeceptionSignal(db, result.principal, new Date(), correlation)
    return deceptionResponse()
  } catch {
    console.error('security_deception_unavailable', {
      correlation_id: correlation,
    })
    return deceptionResponse(503)
  } finally {
    await db?.destroy().catch(() => {})
  }
}

export async function admitDeceptionSignal(
  db: Db,
  principal: DeceptionPrincipal,
  now = new Date(),
  id = crypto.randomUUID(),
) {
  const at = now.toISOString(),
    day = at.slice(0, 10),
    hour = at.slice(0, 13)
  const p = principal
  const inserted = await sql<{
    id: string
  }>`INSERT INTO security_deception_signals
    (id, decoy_id, reason, actor_kind, actor_id, workspace_id, auth_route, client_kind, client_id, authority_kind, agent_profile_id, publisher_client_id, first_detected_at, day_bucket, hour_bucket, next_attempt_at)
    SELECT ${id}, 'credential_inventory_v1', 'authenticated_decoy_probe', ${p.actor_kind}, ${p.actor_id}, ${p.workspace_id}, ${p.auth_route}, ${p.client_kind}, ${p.client_id}, ${p.authority_kind}, ${p.agent_profile_id}, ${p.publisher_client_id}, ${at}, ${day}, ${hour}, ${at}
    WHERE (SELECT count(*) FROM security_deception_signals WHERE day_bucket = ${day}) < 1000
    ON CONFLICT DO NOTHING RETURNING id`.execute(db)
  if (inserted.rows.length) {
    // Mark saturation at admission, even if no later suppressed hit arrives.
    await markSaturated(db, day)
    console.log('security_deception_admitted', { correlation_id: id })
    return 'admitted' as const
  }
  const duplicate = await db
    .selectFrom('security_deception_signals')
    .select('id')
    .where('actor_id', '=', p.actor_id)
    .where('workspace_id', '=', p.workspace_id)
    .where('auth_route', '=', p.auth_route)
    .where('decoy_id', '=', 'credential_inventory_v1')
    .where('hour_bucket', '=', hour)
    .executeTakeFirst()
  if (duplicate) return 'duplicate' as const
  await markSaturated(db, day)
  return 'saturated' as const
}
async function markSaturated(db: Db, day: string) {
  await sql`UPDATE security_deception_delivery_control SET saturated_day = ${day}
    WHERE id = 1 AND (saturated_day IS NULL OR saturated_day < ${day})
    AND (SELECT count(*) FROM security_deception_signals WHERE day_bucket = ${day}) >= 1000`.execute(
    db,
  )
}

/** Atomic actual-time reservation, only when due eligible work exists. */
export async function reserveDeceptionDelivery(
  db: Db,
  now: number,
  token: string,
) {
  const result = await sql<{
    id: number
  }>`UPDATE security_deception_delivery_control
    SET next_send_at = ${iso(now + 300000)}, lease_token = ${token}, lease_expires_at = ${iso(now + 60000)}
    WHERE id = 1 AND next_send_at <= ${iso(now)} AND (lease_expires_at IS NULL OR lease_expires_at <= ${iso(now)})
    AND EXISTS (SELECT 1 FROM security_deception_signals WHERE status IN ('pending', 'retry')
      AND next_attempt_at <= ${iso(now)} AND first_detected_at > ${iso(now - 86400000)} AND attempt_count < 12
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${iso(now)})) RETURNING id`.execute(
    db,
  )
  return result.rows.length > 0
}
export async function claimDeceptionSignals(
  db: Db,
  now: number,
  token: string,
) {
  return (
    await sql<Signal>`UPDATE security_deception_signals SET lease_token = ${token}, lease_expires_at = ${iso(now + 60000)}
    WHERE id IN (SELECT id FROM security_deception_signals WHERE status IN ('pending', 'retry')
      AND next_attempt_at <= ${iso(now)} AND first_detected_at > ${iso(now - 86400000)} AND attempt_count < 12
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${iso(now)})
      ORDER BY next_attempt_at, first_detected_at, id LIMIT 10)
    AND EXISTS (SELECT 1 FROM security_deception_delivery_control WHERE id = 1 AND lease_token = ${token} AND lease_expires_at > ${iso(now)})
    RETURNING *`.execute(db)
  ).rows
}
function displayed(value: string | null, limit = 128) {
  if (value === null) return '-'
  // Plain identifiers only: disable Slack links, mentions and line injection.
  const clean = value.replace(/[\p{Cc}\p{Cf}\s<>@&`:/]/gu, '_')
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}
export function deceptionDigest(rows: Signal[]) {
  const heading =
    'Suspicious authenticated API exploration — investigation required; this is not proof of AI use, malice or compromise.\ncredential_inventory_v1 authenticated_decoy_probe\n'
  // All ten correlations remain visible even with oversized verified IDs.
  const budget = Math.floor((4000 - heading.length) / Math.max(rows.length, 1))
  return (
    heading +
    rows
      .map((row) => {
        const fixed = `${row.first_detected_at} correlation=${row.id} ${row.actor_kind}/${row.auth_route}`
        const fields = [
          row.actor_id,
          row.workspace_id,
          row.client_id,
          row.agent_profile_id,
          row.publisher_client_id,
        ]
        const limit = Math.min(
          128,
          Math.floor((budget - fixed.length - 90) / fields.length),
        )
        return `${fixed} actor=${displayed(fields[0]!, limit)} workspace=${displayed(fields[1]!, limit)} client=${row.client_kind ?? '-'}/${displayed(fields[2]!, limit)} agent=${displayed(fields[3]!, limit)} publisher=${displayed(fields[4]!, limit)}\n`
      })
      .join('')
  )
}

export async function drainDeceptionSignals(
  db: Db,
  webhook: string | undefined,
  clock: () => number = Date.now,
) {
  let newlyFailed = 0
  let newlyExpired = 0
  let currentFailure = false
  try {
    const now = clock()
    const expired = await sql<{
      id: string
      status: string
    }>`UPDATE security_deception_signals
      SET status = CASE WHEN attempt_count >= 12 THEN 'failed' ELSE 'expired' END,
        failure_code = COALESCE(failure_code, CASE WHEN attempt_count >= 12 THEN 'attempt_limit' ELSE 'age_limit' END),
        http_status = CASE WHEN failure_code IS NOT NULL THEN http_status ELSE NULL END,
        lease_token = NULL, lease_expires_at = NULL
      WHERE id IN (SELECT id FROM security_deception_signals WHERE status IN ('pending', 'retry')
        AND (first_detected_at <= ${iso(now - 86400000)} OR attempt_count >= 12)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${iso(now)}) ORDER BY first_detected_at, id LIMIT 1000)
      RETURNING id, status`.execute(db)
    newlyFailed += expired.rows.filter((row) => row.status === 'failed').length
    newlyExpired += expired.rows.filter(
      (row) => row.status === 'expired',
    ).length
    const token = crypto.randomUUID()
    if (await reserveDeceptionDelivery(db, clock(), token)) {
      const rows = await claimDeceptionSignals(db, clock(), token)
      if (rows.length) {
        if (!webhook) {
          await db
            .updateTable('security_deception_signals')
            .set({
              status: 'retry',
              failure_code: 'configuration_missing',
              http_status: null,
              next_attempt_at: iso(clock() + 300000),
              lease_token: null,
              lease_expires_at: null,
            })
            .where('lease_token', '=', token)
            .where('lease_expires_at', '>', iso(clock()))
            .execute()
        } else {
          // Persist attempts and fence the single dispatch immediately beforehand.
          const start = clock()
          const attempted = (
            await sql<Signal>`UPDATE security_deception_signals SET attempt_count = attempt_count + 1, last_attempt_at = ${iso(start)}
            WHERE lease_token = ${token} AND lease_expires_at > ${iso(start)} AND first_detected_at > ${iso(start - 86400000)}
            AND EXISTS (SELECT 1 FROM security_deception_delivery_control WHERE id = 1 AND lease_token = ${token} AND lease_expires_at > ${iso(start)}) RETURNING *`.execute(
              db,
            )
          ).rows
          const fence = await db
            .selectFrom('security_deception_delivery_control')
            .select('lease_expires_at')
            .where('id', '=', 1)
            .where('lease_token', '=', token)
            .where('lease_expires_at', '>', iso(clock()))
            .executeTakeFirst()
          const dispatchAt = clock()
          const dispatchRows = attempted.filter(
            (row) => Date.parse(row.first_detected_at) > dispatchAt - 86400000,
          )
          const canDispatch = Boolean(
            dispatchRows.length &&
            fence?.lease_expires_at &&
            fence.lease_expires_at > iso(dispatchAt),
          )
          try {
            if (canDispatch) {
              const result = await postSlackWebhook(
                webhook,
                deceptionDigest(dispatchRows),
                { timeoutMs: 5000, redirect: 'error' },
              )
              if (!result.ok) currentFailure = true
              const at = clock()
              const acknowledgements = await Promise.allSettled(
                dispatchRows.map(async (row) => {
                  const permanent =
                    !result.ok &&
                    result.status >= 400 &&
                    result.status < 500 &&
                    result.status !== 429
                  const terminal = permanent || row.attempt_count >= 12
                  const aged =
                    at - Date.parse(row.first_detected_at) >= 86400000
                  const status = result.ok
                    ? 'delivered'
                    : terminal
                      ? 'failed'
                      : aged
                        ? 'expired'
                        : 'retry'
                  const updated = await db
                    .updateTable('security_deception_signals')
                    .set({
                      status,
                      delivered_at: result.ok ? iso(at) : null,
                      failure_code: result.ok
                        ? null
                        : permanent
                          ? 'http_rejected'
                          : result.status === 0
                            ? 'network'
                            : 'http_retry',
                      http_status:
                        result.ok || result.status === 0 ? null : result.status,
                      next_attempt_at: iso(
                        at +
                          Math.min(60, 5 * 2 ** (row.attempt_count - 1)) *
                            60000,
                      ),
                      lease_token: null,
                      lease_expires_at: null,
                    })
                    .where('id', '=', row.id)
                    .where('lease_token', '=', token)
                    .where('lease_expires_at', '>', iso(at))
                    .executeTakeFirst()
                  if (Number(updated.numUpdatedRows) !== 1)
                    currentFailure = true
                  if (Number(updated.numUpdatedRows) === 1) {
                    if (status === 'failed') newlyFailed++
                    if (status === 'expired') newlyExpired++
                  }
                }),
              )
              for (const acknowledgement of acknowledgements) {
                if (acknowledgement.status === 'rejected') currentFailure = true
              }
            }
          } finally {
            const sentIds = new Set(
              canDispatch ? dispatchRows.map((row) => row.id) : [],
            )
            const restoreAt = clock()
            const restorations = await Promise.allSettled(
              rows
                .filter((claimed) => !sentIds.has(claimed.id))
                .map(async (row) => {
                  // Only an observed no-send can undo a persisted attempt. A crash or
                  // unknown transport result leaves conservative accounting intact.
                  currentFailure = true
                  const incremented = attempted.some(
                    (attempt) => attempt.id === row.id,
                  )
                  const aged =
                    restoreAt - Date.parse(row.first_detected_at) >= 86400000
                  const restored = await db
                    .updateTable('security_deception_signals')
                    .set({
                      status: aged ? 'expired' : 'retry',
                      failure_code: aged
                        ? (row.failure_code ?? 'age_limit')
                        : 'dispatch_expired',
                      http_status:
                        aged && row.failure_code !== null
                          ? row.http_status
                          : null,
                      ...(incremented
                        ? {
                            attempt_count: sql`attempt_count - 1`,
                            last_attempt_at: row.last_attempt_at,
                          }
                        : {}),
                      next_attempt_at: iso(restoreAt + 300000),
                      lease_token: null,
                      lease_expires_at: null,
                    })
                    .where('id', '=', row.id)
                    .where('lease_token', '=', token)
                    .executeTakeFirst()
                  if (aged && Number(restored.numUpdatedRows) === 1)
                    newlyExpired++
                }),
            )
            for (const restoration of restorations) {
              if (restoration.status === 'rejected') currentFailure = true
            }
          }
        }
      }
    }
  } catch {
    currentFailure = true
  }
  try {
    const summary = (
      await sql<{
        active: number
        oldest: string | null
      }>`SELECT count(*) AS active, min(first_detected_at) AS oldest
      FROM security_deception_signals WHERE status IN ('pending', 'retry')`.execute(
        db,
      )
    ).rows[0]!
    const control = await db
      .selectFrom('security_deception_delivery_control')
      .select('saturated_day')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow()
    const oldestAge = summary.oldest
      ? Math.max(0, clock() - Date.parse(summary.oldest))
      : 0
    const missing = summary.active > 0 && !webhook
    console.log('security_deception_delivery', {
      active: summary.active,
      oldest_age_ms: oldestAge,
      configuration_missing: missing,
      newly_failed: newlyFailed,
      newly_expired: newlyExpired,
      saturated_day: control.saturated_day,
      current_failure: currentFailure,
    })
    if (
      currentFailure ||
      newlyFailed ||
      newlyExpired ||
      oldestAge > 600000 ||
      missing
    )
      throw new Error('security deception delivery unhealthy')
  } catch {
    throw new Error('security deception delivery unhealthy')
  }
}

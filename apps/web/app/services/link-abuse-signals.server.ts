import { nanoid } from 'nanoid'
import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'
import type { LinkAbuseTrigger } from './link-abuse-judgment/types'

export const AD_CLICK_PARAMS = [
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
  'ttclid',
  'twclid',
] as const

export type AdClickParam = (typeof AD_CLICK_PARAMS)[number]
export type LinkAbuseGateKind = 'automatic' | 'manual'

export type StartLinkAbuseJudgmentResult =
  | { kind: 'started' }
  | { kind: 'cooldown'; retryAfterSeconds: number }
  | { kind: 'failed' }

export interface AnonymousViewSignal {
  referrerHost: string | null
  adClickParam: AdClickParam | null
}

type LinkAbuseTriggerEnv = Pick<
  Cloudflare.Env,
  | 'LINK_ABUSE_JUDGMENT_WORKFLOW'
  | 'LINK_ABUSE_SPIKE_WINDOW_MINUTES'
  | 'LINK_ABUSE_SPIKE_THRESHOLD'
  | 'LINK_ABUSE_JUDGMENT_COOLDOWN_MINUTES'
  | 'LINK_ABUSE_MANUAL_COOLDOWN_MINUTES'
>

export function anonymousViewSignal(request: Request): AnonymousViewSignal {
  const viewerUrl = new URL(request.url)
  const referrerUrl = parseHttpUrl(request.headers.get('referer'))
  const adClickParam =
    AD_CLICK_PARAMS.find((name) => viewerUrl.searchParams.has(name)) ?? null
  return {
    referrerHost: referrerUrl
      ? referrerUrl.hostname.toLowerCase().replace(/\.$/u, '') || null
      : null,
    adClickParam,
  }
}

export async function recordAnonymousViewSignalAndMaybeJudge(
  db: Kysely<DB>,
  env: LinkAbuseTriggerEnv,
  args: {
    shareableId: string
    workspaceId: string
    request: Request
    counted: boolean
    now?: Date
  },
): Promise<void> {
  if (!args.counted) return
  try {
    const signal = anonymousViewSignal(args.request)
    const now = args.now ?? new Date()
    await db
      .insertInto('anonymous_view_signals')
      .values({
        id: nanoid(),
        shareable_id: args.shareableId,
        workspace_id: args.workspaceId,
        viewed_at: now.toISOString(),
        referrer_host: signal.referrerHost,
        ad_click_param: signal.adClickParam,
      })
      .execute()

    if (signal.adClickParam) {
      await startLinkAbuseJudgment(db, env, {
        shareableId: args.shareableId,
        trigger: 'ad_click',
        detail: signal.adClickParam,
        now,
      })
    }

    const windowMinutes = positiveInteger(
      env.LINK_ABUSE_SPIKE_WINDOW_MINUTES,
      60,
    )
    const threshold = positiveInteger(env.LINK_ABUSE_SPIKE_THRESHOLD, 200)
    const windowStart = new Date(
      now.getTime() - windowMinutes * 60_000,
    ).toISOString()
    const countResult = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM (
      SELECT 1
      FROM anonymous_view_signals
      WHERE shareable_id = ${args.shareableId}
        AND viewed_at >= ${windowStart}
        AND NOT EXISTS (
          SELECT 1
          FROM link_abuse_judgment_gates
          WHERE shareable_id = ${args.shareableId}
            AND kind = 'automatic'
            AND expires_at > ${now.toISOString()}
        )
      LIMIT ${threshold})
    `.execute(db)
    const count = Number(countResult.rows[0]?.count ?? 0)
    if (count >= threshold) {
      await startLinkAbuseJudgment(db, env, {
        shareableId: args.shareableId,
        trigger: 'view_spike',
        detail: `${count}_views_in_${windowMinutes}_minutes`,
        now,
      })
    }
  } catch (error) {
    logLinkAbuseSignalFailure(args.shareableId, error)
  }
}

export async function startLinkAbuseJudgment(
  db: Kysely<DB>,
  env: Pick<
    LinkAbuseTriggerEnv,
    | 'LINK_ABUSE_JUDGMENT_WORKFLOW'
    | 'LINK_ABUSE_JUDGMENT_COOLDOWN_MINUTES'
    | 'LINK_ABUSE_MANUAL_COOLDOWN_MINUTES'
  >,
  args: {
    shareableId: string
    trigger: LinkAbuseTrigger
    detail: string
    now?: Date
  },
): Promise<StartLinkAbuseJudgmentResult> {
  let acquiredExpiresAt: string | null = null
  const gateKind: LinkAbuseGateKind =
    args.trigger === 'manual' ? 'manual' : 'automatic'
  try {
    const now = args.now ?? new Date()
    const cooldownMinutes =
      args.trigger === 'manual'
        ? positiveInteger(env.LINK_ABUSE_MANUAL_COOLDOWN_MINUTES, 5)
        : positiveInteger(env.LINK_ABUSE_JUDGMENT_COOLDOWN_MINUTES, 360)
    const expiresAt = new Date(
      now.getTime() + cooldownMinutes * 60_000,
    ).toISOString()
    const gate = await db
      .insertInto('link_abuse_judgment_gates')
      .values({
        shareable_id: args.shareableId,
        kind: gateKind,
        expires_at: expiresAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['shareable_id', 'kind'])
          .doUpdateSet({ expires_at: expiresAt })
          .where('expires_at', '<', now.toISOString()),
      )
      .returning('shareable_id')
      .executeTakeFirst()
    if (!gate) {
      const activeGate = await db
        .selectFrom('link_abuse_judgment_gates')
        .select('expires_at')
        .where('shareable_id', '=', args.shareableId)
        .where('kind', '=', gateKind)
        .executeTakeFirst()
      const parsedExpiresAt = Date.parse(activeGate?.expires_at ?? expiresAt)
      const retryAfterSeconds = Number.isFinite(parsedExpiresAt)
        ? Math.max(1, Math.ceil((parsedExpiresAt - now.getTime()) / 1_000))
        : 60
      return { kind: 'cooldown', retryAfterSeconds }
    }
    acquiredExpiresAt = expiresAt

    await env.LINK_ABUSE_JUDGMENT_WORKFLOW.create({
      id: crypto.randomUUID(),
      params: {
        shareableId: args.shareableId,
        kind: gateKind,
        trigger: args.trigger,
        detail: args.detail,
        expiresAt,
      },
    })
    return { kind: 'started' }
  } catch (error) {
    logLinkAbuseSignalFailure(args.shareableId, error)
    if (acquiredExpiresAt) {
      try {
        await db
          .deleteFrom('link_abuse_judgment_gates')
          .where('shareable_id', '=', args.shareableId)
          .where('kind', '=', gateKind)
          .where('expires_at', '=', acquiredExpiresAt)
          .execute()
      } catch (cleanupError) {
        logLinkAbuseSignalFailure(args.shareableId, cleanupError)
      }
    }
    return { kind: 'failed' }
  }
}

export async function cleanupExpiredAnonymousViewSignals(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const result = await db
    .deleteFrom('anonymous_view_signals')
    .where('viewed_at', '<', cutoff)
    .executeTakeFirst()
  await db
    .deleteFrom('link_abuse_judgment_gates')
    .where('expires_at', '<', now.toISOString())
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

function parseHttpUrl(value: string | null): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch (_error) {
    return null
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function logLinkAbuseSignalFailure(
  shareableId: string,
  error?: unknown,
): void {
  console.error('link_abuse_signal_failed', {
    shareableId,
    error: error instanceof Error ? error.name : 'Error',
  })
}

import { env } from 'cloudflare:workers'
import { sql } from 'kysely'
import { nanoid } from 'nanoid'
import { encodeBase64Url } from '~/lib/base64url'
import { readCookie, serializeCookie } from '~/lib/cookies.server'
import { nowIso } from '~/lib/datetime'
import { constantTimeEqual, hmacSha256Base64Url } from '~/lib/hmac'
import type { Db } from '~/services/db.server'
import { artifactViewedEventQuery } from './events.server'

const DEDUP_WINDOW_SECONDS = 5 * 60
export const ANON_VIEWER_COOKIE = '__as_viewer'
const ANON_VIEWER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const ENCODER = new TextEncoder()

interface RecordViewOpts {
  hmacSecret: string
  now?: string
  versionSeenThroughAt?: string | null
  commentSeenThroughAt?: string | null
  deferAfterRecency?: boolean
}

type ViewLiveBinding = {
  getByName(name: string): {
    notifyViewCountChanged(viewCount: number): Promise<void> | void
  }
}

type ViewIdentifier =
  | { kind: 'user'; id: string }
  | { kind: 'anon'; id: string; fallbackId: string | null }

export async function recordView(
  db: Db,
  dedupKv: KVNamespace,
  shareableId: string,
  identifier: ViewIdentifier,
  opts: RecordViewOpts,
): Promise<{ counted: boolean; deferred?: Promise<void> }> {
  const viewedAt = opts.now ?? nowIso()
  const dedupKeys = viewDedupKeys(shareableId, identifier)
  const existing = await Promise.all(dedupKeys.map((key) => dedupKv.get(key)))
  const counted = existing.every((value) => value === null)

  if (counted) {
    await sql`
      UPDATE shareables
      SET view_count = view_count + 1, last_accessed_at = ${viewedAt}
      WHERE id = ${shareableId}
    `.execute(db)
  }

  if (identifier.kind === 'user') {
    await sql`
      INSERT INTO shareable_viewer_recency (
        shareable_id,
        viewer_user_id,
        first_viewed_at,
        last_viewed_at,
        version_seen_through_at,
        comment_seen_through_at,
        effective_view_count,
        viewed_title,
        viewed_owner_name
      )
      SELECT
        ${shareableId},
        ${identifier.id},
        ${viewedAt},
        ${viewedAt},
        ${opts.versionSeenThroughAt ?? null},
        ${opts.commentSeenThroughAt ?? null},
        ${counted ? 1 : 0},
        coalesce(s.title_override, s.derived_title, s.name),
        u.name
      FROM shareables s
      JOIN users u ON u.id = s.owner_user_id
      WHERE s.id = ${shareableId}
      ON CONFLICT(shareable_id, viewer_user_id) DO UPDATE SET
        last_viewed_at = excluded.last_viewed_at,
        version_seen_through_at = CASE
          WHEN excluded.version_seen_through_at IS NULL THEN shareable_viewer_recency.version_seen_through_at
          WHEN shareable_viewer_recency.version_seen_through_at IS NULL THEN excluded.version_seen_through_at
          WHEN excluded.version_seen_through_at > shareable_viewer_recency.version_seen_through_at THEN excluded.version_seen_through_at
          ELSE shareable_viewer_recency.version_seen_through_at END,
        comment_seen_through_at = CASE
          WHEN excluded.comment_seen_through_at IS NULL THEN shareable_viewer_recency.comment_seen_through_at
          WHEN shareable_viewer_recency.comment_seen_through_at IS NULL THEN excluded.comment_seen_through_at
          WHEN excluded.comment_seen_through_at > shareable_viewer_recency.comment_seen_through_at THEN excluded.comment_seen_through_at
          ELSE shareable_viewer_recency.comment_seen_through_at END,
        effective_view_count = shareable_viewer_recency.effective_view_count + ${counted ? 1 : 0},
        viewed_title = excluded.viewed_title,
        viewed_owner_name = excluded.viewed_owner_name
    `.execute(db)
  }

  if (counted) {
    await Promise.all(
      dedupKeys.map((key) =>
        dedupKv.put(key, '1', { expirationTtl: DEDUP_WINDOW_SECONDS }),
      ),
    )
  }

  const recordEvent = async () => {
    if (!counted) return
    try {
      await artifactViewedEventQuery(db, {
        shareableId,
        actorUserId: identifier.kind === 'user' ? identifier.id : null,
        viewedAt,
      }).execute()
    } catch (err) {
      console.error('view_event_write_failed', {
        shareable_id: shareableId,
        err,
      })
    }
  }

  if (opts.deferAfterRecency) {
    return { counted, deferred: recordEvent() }
  }
  await recordEvent()

  return { counted }
}

export async function notifyViewCountChanged(
  shareableId: string,
  viewCount: number,
  live: ViewLiveBinding | undefined = (
    env as { ARTIFACT_LIVE?: ViewLiveBinding }
  ).ARTIFACT_LIVE,
): Promise<void> {
  if (!live) return
  try {
    await live.getByName(shareableId).notifyViewCountChanged(viewCount)
  } catch {
    // Realtime delivery is advisory; D1 remains the source of truth.
  }
}

export async function recordViewAndNotifyViewCount(
  db: Db,
  dedupKv: KVNamespace,
  shareableId: string,
  identifier: ViewIdentifier,
  opts: RecordViewOpts,
  live: ViewLiveBinding | undefined = (
    env as { ARTIFACT_LIVE?: ViewLiveBinding }
  ).ARTIFACT_LIVE,
): Promise<{ counted: boolean; deferred?: Promise<void> }> {
  const result = await recordView(db, dedupKv, shareableId, identifier, opts)
  if (result.deferred) {
    if (!result.counted) return result
    result.deferred = result.deferred.then(async () => {
      const shareable = await db
        .selectFrom('shareables')
        .select('view_count')
        .where('id', '=', shareableId)
        .executeTakeFirst()
      if (shareable)
        await notifyViewCountChanged(
          shareableId,
          Number(shareable.view_count ?? 0),
          live,
        )
    })
    return result
  }
  if (!result.counted) return result

  const shareable = await db
    .selectFrom('shareables')
    .select('view_count')
    .where('id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable) return result

  await notifyViewCountChanged(
    shareableId,
    Number(shareable.view_count ?? 0),
    live,
  )
  return result
}

function viewDedupKeys(
  shareableId: string,
  identifier: ViewIdentifier,
): string[] {
  const viewerKey =
    identifier.kind === 'user'
      ? `user:${identifier.id}`
      : `anon:${identifier.id}`
  const keys = [`view:${shareableId}:${viewerKey}`]
  if (identifier.kind === 'anon' && identifier.fallbackId) {
    keys.push(`view:${shareableId}:anon-fallback:${identifier.fallbackId}`)
  }
  return keys
}

export async function anonymousViewIdentifier(
  request: Request,
  hmacSecret: string,
): Promise<{
  identifier: Extract<ViewIdentifier, { kind: 'anon' }>
  cookieHeader: string | null
}> {
  const fallbackId = await anonymousFallbackId(request, hmacSecret)
  const cookie = readCookie(request, ANON_VIEWER_COOKIE)
  const verifiedId = cookie
    ? await verifyAnonymousViewerCookie(cookie, hmacSecret)
    : null
  if (verifiedId) {
    return {
      identifier: { kind: 'anon', id: verifiedId, fallbackId },
      cookieHeader: null,
    }
  }

  const id = nanoid()
  return {
    identifier: { kind: 'anon', id, fallbackId },
    cookieHeader: await anonymousViewerCookieHeader(
      id,
      hmacSecret,
      request.url,
    ),
  }
}

async function anonymousFallbackId(
  request: Request,
  hmacSecret: string,
): Promise<string | null> {
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  return ip ? await hashIp(ip, nowIso(), hmacSecret) : null
}

async function anonymousViewerCookieHeader(
  id: string,
  hmacSecret: string,
  requestUrl: string,
): Promise<string> {
  const secure = new URL(requestUrl).protocol === 'https:'
  return serializeCookie(
    ANON_VIEWER_COOKIE,
    await signAnonymousViewerId(id, hmacSecret),
    {
      maxAgeSeconds: ANON_VIEWER_COOKIE_MAX_AGE_SECONDS,
      httpOnly: true,
      secure,
    },
  )
}

async function signAnonymousViewerId(
  id: string,
  hmacSecret: string,
): Promise<string> {
  const sig = await hmacSha256Base64Url(hmacSecret, id)
  return `${id}.${sig}`
}

async function verifyAnonymousViewerCookie(
  value: string,
  hmacSecret: string,
): Promise<string | null> {
  const dot = value.indexOf('.')
  if (dot < 0) return null
  const id = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!id || !sig) return null
  const expected = await hmacSha256Base64Url(hmacSecret, id)
  return constantTimeEqual(sig, expected) ? id : null
}

function hashIp(
  ip: string,
  viewedAt: string,
  hmacSecret: string,
): Promise<string> {
  return hashWithDailySalt(ip, viewedAt, hmacSecret)
}

async function hashWithDailySalt(
  value: string,
  viewedAt: string,
  hmacSecret: string,
): Promise<string> {
  const date = viewedAt.slice(0, 10)
  const salt = await dailySalt(date, hmacSecret)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    ENCODER.encode(salt + value),
  )
  return encodeBase64Url(digest)
}

function dailySalt(date: string, hmacSecret: string): Promise<string> {
  return hmacSha256Base64Url(hmacSecret, date)
}

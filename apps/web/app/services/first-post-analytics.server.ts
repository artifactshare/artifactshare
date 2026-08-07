import { env } from 'cloudflare:workers'
import { hmacSha256Base64Url } from '~/lib/hmac'
import { nowIso } from '~/lib/datetime'
import {
  isMeasurementProtocolConfigured,
  sendFirstArtifactPosted,
} from '~/lib/analytics/measurement-protocol.server'
import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'
export async function recordFirstArtifactPost(
  db: Kysely<DB>,
  user: { id: string },
  opts: {
    channel: 'web' | 'cli' | 'mcp'
    // Whether this send is permitted to reach Google. Browser posts (channel
    // 'web') pass the visitor's analytics-consent decision here; CLI/MCP have
    // no browser consent signal and are measured as first-party account
    // actions, so they pass true. When false we still claim the row (internal
    // dedup, never sent to Google) so a later post is not mislabeled as first,
    // but we do not send the event.
    sendToGa: boolean
    waitUntil?: (p: Promise<unknown>) => void
  },
): Promise<void> {
  try {
    if (!isMeasurementProtocolConfigured(env) || !env.BETTER_AUTH_SECRET) return
    const claimed = await db
      .insertInto('first_post_analytics')
      .values({
        user_id: user.id,
        channel: opts.channel,
        first_posted_at: nowIso(),
      })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .returning('user_id')
      .executeTakeFirst()
    if (!claimed) return
    if (!opts.sendToGa) return
    const userId = await hmacSha256Base64Url(
      env.BETTER_AUTH_SECRET,
      `ga4:${user.id}`,
    )
    const clientId = await hmacSha256Base64Url(
      env.BETTER_AUTH_SECRET,
      `ga4:cid:${user.id}`,
    )
    const send = sendFirstArtifactPosted({
      env,
      userId,
      clientId,
      channel: opts.channel,
    })
    // Log only a marker on send failure: the MP request URL carries the api
    // secret in its query string, so the fetch error itself must not be logged.
    const onSendError = () => console.error('first_artifact_posted_send_failed')
    if (opts.waitUntil) opts.waitUntil(send.catch(onSendError))
    else await send.catch(onSendError)
  } catch (error) {
    // Non-invasive: analytics must not affect publishing. Log for operability
    // (claim/hmac/config errors here carry no secret).
    console.error(
      'first_artifact_posted_record_failed',
      error instanceof Error ? error.message : error,
    )
  }
}

/*
 * Signed-URL tokens for the sandbox subdomain.
 *
 * The apex worker signs after verifying access; the sandbox worker verifies
 * the signature before checking the one-time nonce and current version in D1.
 *
 * Token = base64url(payload) "." base64url(hmac-sha256(secret, payload))
 */

import { decodeBase64Url, encodeBase64Url } from './base64url'
import type { ArtifactType } from './artifact-type'
import type { MarkdownRenderer } from './markdown-renderer.server'
import { constantTimeEqual, hmacSha256 } from './hmac'

const TTL_SECONDS = 60
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

export interface SandboxPayload {
  uid: string | null
  wid: string
  aid: string
  vid: string
  fid: string
  mt: string | null
  /** Carried in the token so the cache lookup can skip the DB on hit. */
  t: ArtifactType
  /** Server-selected renderer. Signed so clients cannot override rollout. */
  mr?: MarkdownRenderer
  jti: string
  /**
   * Embed token: minted for previewing an artifact inside an MCP host
   * (ChatGPT / Claude). Unlike a viewer token it is reusable within its TTL
   * (the host may re-render the widget) and widens the content's
   * `frame-ancestors` to the host's sandbox origin. Absent / false on the
   * normal viewer path.
   */
  emb?: boolean
  /** Unix seconds. */
  exp: number
}

export async function signSandboxToken(
  payload: Omit<SandboxPayload, 'exp'>,
  secret: string,
  ttlSeconds: number = TTL_SECONDS,
): Promise<string> {
  const full: SandboxPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  }
  const body = encodeBase64Url(ENCODER.encode(JSON.stringify(full)))
  const sig = encodeBase64Url(await hmacSha256(secret, body))
  return `${body}.${sig}`
}

export type SandboxTokenFailure =
  | 'bad_format'
  | 'bad_signature'
  | 'bad_payload'
  | 'expired'

export type SandboxTokenResult =
  | { ok: true; payload: SandboxPayload }
  | { ok: false; failure: SandboxTokenFailure; expiredBySeconds?: number }

export async function verifySandboxTokenDetailed(
  token: string,
  secret: string,
): Promise<SandboxTokenResult> {
  const dot = token.indexOf('.')
  if (dot < 0) return { ok: false, failure: 'bad_format' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expected = encodeBase64Url(await hmacSha256(secret, body))
  if (!constantTimeEqual(sig, expected)) {
    return { ok: false, failure: 'bad_signature' }
  }

  let payload: SandboxPayload
  try {
    payload = JSON.parse(DECODER.decode(decodeBase64Url(body)))
  } catch {
    return { ok: false, failure: 'bad_payload' }
  }

  if (!isSandboxPayload(payload)) return { ok: false, failure: 'bad_payload' }
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) {
    return {
      ok: false,
      failure: 'expired',
      expiredBySeconds: now - payload.exp,
    }
  }
  return { ok: true, payload }
}

export async function verifySandboxToken(
  token: string,
  secret: string,
): Promise<SandboxPayload | null> {
  const result = await verifySandboxTokenDetailed(token, secret)
  return result.ok ? result.payload : null
}

function isSandboxPayload(value: unknown): value is SandboxPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<Record<keyof SandboxPayload, unknown>>
  return (
    (typeof payload.uid === 'string' || payload.uid === null) &&
    typeof payload.wid === 'string' &&
    typeof payload.aid === 'string' &&
    typeof payload.vid === 'string' &&
    typeof payload.fid === 'string' &&
    (typeof payload.mt === 'string' || payload.mt === null) &&
    (payload.t === 'html' ||
      payload.t === 'md' ||
      payload.t === 'static_site') &&
    (payload.mr === undefined ||
      payload.mr === 'marked' ||
      payload.mr === 'tanstack') &&
    typeof payload.jti === 'string' &&
    (payload.emb === undefined || typeof payload.emb === 'boolean') &&
    typeof payload.exp === 'number'
  )
}

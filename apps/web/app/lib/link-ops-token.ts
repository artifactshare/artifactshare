import { decodeBase64Url, encodeBase64Url } from './base64url'
import { constantTimeEqual, hmacSha256Base64Url } from './hmac'

// A signed, expiring token that lets an operator act on one link share from
// the Slack judgment notification without an account. The token names the
// shareable only; the action (pause, resume, no action) is chosen on the
// page it opens, so a leaked link cannot be replayed into a different move.
export const LINK_OPS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

export type LinkOpsTokenPayload = {
  purpose: 'link-ops'
  shareableId: string
  judgmentId: string | null
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function signLinkOpsToken(
  input: { shareableId: string; judgmentId?: string | null; now?: number },
  secret: string,
): Promise<string> {
  const payload: LinkOpsTokenPayload = {
    purpose: 'link-ops',
    shareableId: input.shareableId,
    judgmentId: input.judgmentId ?? null,
    exp:
      Math.floor((input.now ?? Date.now()) / 1000) + LINK_OPS_TOKEN_TTL_SECONDS,
  }
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = await hmacSha256Base64Url(secret, encoded)
  return `${encoded}.${signature}`
}

export async function verifyLinkOpsToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<LinkOpsTokenPayload | null> {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const expected = await hmacSha256Base64Url(secret, encoded)
  if (!constantTimeEqual(signature, expected)) return null
  let payload: Partial<LinkOpsTokenPayload>
  try {
    payload = JSON.parse(decoder.decode(decodeBase64Url(encoded)))
  } catch {
    return null
  }
  if (
    payload.purpose !== 'link-ops' ||
    typeof payload.shareableId !== 'string' ||
    typeof payload.exp !== 'number' ||
    (payload.judgmentId !== null && typeof payload.judgmentId !== 'string')
  )
    return null
  if (payload.exp <= Math.floor(now / 1000)) return null
  return {
    purpose: 'link-ops',
    shareableId: payload.shareableId,
    judgmentId: payload.judgmentId ?? null,
    exp: payload.exp,
  }
}

export function linkOpsUrl(origin: string, shareableId: string, token: string) {
  const url = new URL(`/ops/link/${shareableId}`, origin)
  url.searchParams.set('token', token)
  return url.toString()
}

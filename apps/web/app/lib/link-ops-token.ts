import { decodeBase64Url, encodeBase64Url } from './base64url'
import { constantTimeEqual, hmacSha256Base64Url } from './hmac'

// A signed, expiring token that lets an operator act on one link share from
// the Slack judgment notification without an account. The token names the
// shareable only; the action (pause, resume, no action) is chosen on the
// page it opens, so a leaked link cannot be replayed into a different move.
// Two days: long enough to act on a notification after a weekend, short
// enough that a copied link does not stay a credential for long.
export const LINK_OPS_TOKEN_TTL_SECONDS = 2 * 24 * 60 * 60

export type LinkOpsTokenPayload = {
  purpose: 'link-ops'
  shareableId: string
  credentialId: string
  source: { kind: 'judgment' | 'appeal'; id: string }
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function signLinkOpsToken(
  input: {
    shareableId: string
    credentialId: string
    source: LinkOpsTokenPayload['source']
    now?: number
  },
  secret: string,
): Promise<string> {
  const payload: LinkOpsTokenPayload = {
    purpose: 'link-ops',
    shareableId: input.shareableId,
    credentialId: input.credentialId,
    source: input.source,
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
    typeof payload.credentialId !== 'string' ||
    payload.credentialId.length < 16 ||
    payload.credentialId.length > 128 ||
    !payload.source ||
    (payload.source.kind !== 'judgment' && payload.source.kind !== 'appeal') ||
    typeof payload.source.id !== 'string' ||
    payload.source.id.length < 1 ||
    payload.source.id.length > 128 ||
    typeof payload.exp !== 'number' ||
    !Number.isSafeInteger(payload.exp)
  )
    return null
  if (payload.exp <= Math.floor(now / 1000)) return null
  return {
    purpose: 'link-ops',
    shareableId: payload.shareableId,
    credentialId: payload.credentialId,
    source: payload.source,
    exp: payload.exp,
  }
}

export function linkOpsUrl(origin: string, shareableId: string, token: string) {
  const url = new URL(`/ops/link/${shareableId}`, origin)
  url.searchParams.set('token', token)
  return url.toString()
}

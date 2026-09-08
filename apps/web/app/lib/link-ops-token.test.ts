import { describe, expect, test } from 'vitest'
import { encodeBase64Url } from './base64url'
import { hmacSha256Base64Url } from './hmac'
import {
  LINK_OPS_TOKEN_TTL_SECONDS,
  linkOpsUrl,
  signLinkOpsToken,
  verifyLinkOpsToken,
} from './link-ops-token'

describe('link ops token', () => {
  const secret = 'ops-secret'
  const now = Date.parse('2026-09-07T00:00:00.000Z')

  const credentialId = 'credential-1234567890'
  const source = { kind: 'judgment' as const, id: 'judg-1' }

  test('round-trips the credential and source within its lifetime', async () => {
    const token = await signLinkOpsToken(
      { shareableId: 'abc123def4', credentialId, source, now },
      secret,
    )
    expect(await verifyLinkOpsToken(token, secret, now + 1000)).toEqual({
      purpose: 'link-ops',
      shareableId: 'abc123def4',
      credentialId,
      source,
      exp: Math.floor(now / 1000) + LINK_OPS_TOKEN_TTL_SECONDS,
    })
    expect(linkOpsUrl('https://artifactshare.com', 'abc123def4', token)).toBe(
      `https://artifactshare.com/ops/link/abc123def4?token=${encodeURIComponent(token)}`,
    )
  })

  test('rejects a wrong secret, a tampered body, and an expired token', async () => {
    const token = await signLinkOpsToken(
      { shareableId: 'abc123def4', credentialId, source, now },
      secret,
    )
    expect(await verifyLinkOpsToken(token, 'other', now)).toBeNull()
    const [, signature] = token.split('.')
    expect(
      await verifyLinkOpsToken(`eyJ4IjoxfQ.${signature}`, secret, now),
    ).toBeNull()
    expect(
      await verifyLinkOpsToken(
        token,
        secret,
        now + (LINK_OPS_TOKEN_TTL_SECONDS + 1) * 1000,
      ),
    ).toBeNull()
    expect(await verifyLinkOpsToken('garbage', secret, now)).toBeNull()
  })

  test('rejects the previous judgment-only payload format', async () => {
    const body = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          purpose: 'link-ops',
          shareableId: 'abc123def4',
          judgmentId: 'judg-1',
          exp: Math.floor(now / 1000) + LINK_OPS_TOKEN_TTL_SECONDS,
        }),
      ),
    )
    const signature = await hmacSha256Base64Url(secret, body)

    expect(
      await verifyLinkOpsToken(`${body}.${signature}`, secret, now),
    ).toBeNull()
  })
})

import { describe, expect, test, vi } from 'vitest'
import { encodeBase64Url } from './base64url'
import { signSandboxToken, verifySandboxToken } from './sandbox-token'

const SECRET = 'test-secret-with-enough-entropy-for-hmac'
const ENCODER = new TextEncoder()

const VALID_PAYLOAD = {
  uid: 'u1',
  wid: 'ws1',
  aid: 'a',
  vid: 'v1',
  fid: 'f',
  mt: null,
  t: 'html' as const,
  jti: 'j1',
}

describe('sandbox-token', () => {
  test('round-trips a valid payload', async () => {
    const token = await signSandboxToken(
      {
        uid: 'u1',
        wid: 'ws1',
        aid: 'a1',
        vid: 'v1',
        fid: 'f1',
        mt: '2026-01-01T00:00:00Z',
        t: 'md',
        jti: 'j1',
      },
      SECRET,
    )
    const payload = await verifySandboxToken(token, SECRET)
    expect(payload).not.toBeNull()
    expect(payload?.uid).toBe('u1')
    expect(payload?.wid).toBe('ws1')
    expect(payload?.aid).toBe('a1')
    expect(payload?.vid).toBe('v1')
    expect(payload?.fid).toBe('f1')
    expect(payload?.mt).toBe('2026-01-01T00:00:00Z')
    expect(payload?.t).toBe('md')
    expect(payload?.jti).toBe('j1')
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('rejects a tampered signature', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const tampered = `${token}xx`
    expect(await verifySandboxToken(tampered, SECRET)).toBeNull()
  })

  test('rejects a tampered payload', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const [body, sig] = token.split('.')
    const tampered = `${body}X.${sig}`
    expect(await verifySandboxToken(tampered, SECRET)).toBeNull()
  })

  test('rejects a token signed with a different secret', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    expect(await verifySandboxToken(token, 'other-secret')).toBeNull()
  })

  test('rejects malformed token (no dot)', async () => {
    expect(await verifySandboxToken('not-a-token', SECRET)).toBeNull()
  })

  test('null modifiedTime survives the round-trip', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const payload = await verifySandboxToken(token, SECRET)
    expect(payload?.mt).toBeNull()
  })

  test('null uid survives the round-trip for anonymous viewers', async () => {
    const token = await signSandboxToken(
      { ...VALID_PAYLOAD, uid: null },
      SECRET,
    )
    const payload = await verifySandboxToken(token, SECRET)
    expect(payload?.uid).toBeNull()
  })

  test('supports static_site payloads with workspace scope', async () => {
    const token = await signSandboxToken(
      {
        uid: null,
        wid: 'ws-bundle',
        aid: 'abc123def4',
        vid: 'v-bundle',
        fid: 'ws-bundle/abc123def4/v-bundle/index.html',
        mt: null,
        t: 'static_site',
        jti: 'j-bundle',
      },
      SECRET,
    )

    const payload = await verifySandboxToken(token, SECRET)

    expect(payload).toMatchObject({
      uid: null,
      wid: 'ws-bundle',
      aid: 'abc123def4',
      vid: 'v-bundle',
      fid: 'ws-bundle/abc123def4/v-bundle/index.html',
      mt: null,
      t: 'static_site',
      jti: 'j-bundle',
    })
  })

  test('rejects old-format payloads missing uid, vid, or jti', async () => {
    const token = await signedToken({
      aid: 'a',
      fid: 'f',
      mt: null,
      t: 'html',
      exp: Math.floor(Date.now() / 1000) + 60,
    })

    expect(await verifySandboxToken(token, SECRET)).toBeNull()
  })

  test('uses a 60 second TTL boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)

    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    expect(await verifySandboxToken(token, SECRET)).not.toBeNull()

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    expect(await verifySandboxToken(token, SECRET)).toBeNull()

    vi.useRealTimers()
  })
})

async function signedToken(payload: unknown): Promise<string> {
  const body = encodeBase64Url(ENCODER.encode(JSON.stringify(payload)))
  const key = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = encodeBase64Url(
    await crypto.subtle.sign('HMAC', key, ENCODER.encode(body)),
  )
  return `${body}.${sig}`
}

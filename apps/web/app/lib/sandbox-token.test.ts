import { describe, expect, test, vi } from 'vitest'
import { encodeBase64Url } from './base64url'
import {
  signSandboxToken as signDeliveryToken,
  signSandboxUrl,
  verifySandboxTokenDetailed,
} from './sandbox-token'

const signSandboxToken = (
  payload: Parameters<typeof signDeliveryToken>[0],
  secret: string,
  ttl?: number,
) => signDeliveryToken(payload, secret, { APP_ENV: 'production' }, ttl)

const SECRET = 'test-secret-with-enough-entropy-for-hmac'
const ENCODER = new TextEncoder()

const VALID_PAYLOAD = {
  uid: 'u1',
  wid: 'ws1',
  aid: 'abc123def4',
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
        aid: 'abc123def4',
        vid: 'v1',
        fid: 'f1',
        mt: '2026-01-01T00:00:00Z',
        t: 'md',
        jti: 'j1',
      },
      SECRET,
    )
    const payload = await verifySandboxTokenDetailed(token, SECRET)
    expect(payload.ok).toBe(true)
    if (!payload.ok) throw new Error('Expected valid token')
    expect(payload.payload.uid).toBe('u1')
    expect(payload.payload.wid).toBe('ws1')
    expect(payload.payload.aid).toBe('abc123def4')
    expect(payload.payload.vid).toBe('v1')
    expect(payload.payload.fid).toBe('f1')
    expect(payload.payload.mt).toBe('2026-01-01T00:00:00Z')
    expect(payload.payload.t).toBe('md')
    expect(payload.payload.jti).toBe('j1')
    expect(payload.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test('rejects a tampered signature', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const tampered = `${token}xx`
    expect(await verifySandboxTokenDetailed(tampered, SECRET)).toMatchObject({
      ok: false,
    })
  })

  test('rejects a tampered payload', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const [body, sig] = token.split('.')
    const tampered = `${body}X.${sig}`
    expect(await verifySandboxTokenDetailed(tampered, SECRET)).toMatchObject({
      ok: false,
    })
  })

  test('rejects a token signed with a different secret', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    expect(
      await verifySandboxTokenDetailed(token, 'other-secret'),
    ).toMatchObject({ ok: false })
  })

  test('rejects malformed token (no dot)', async () => {
    expect(
      await verifySandboxTokenDetailed('not-a-token', SECRET),
    ).toMatchObject({ ok: false })
  })

  test('null modifiedTime survives the round-trip', async () => {
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)
    const payload = await verifySandboxTokenDetailed(token, SECRET)
    expect(payload.ok).toBe(true)
    if (!payload.ok) throw new Error('Expected valid token')
    expect(payload.payload.mt).toBeNull()
  })

  test('null uid survives the round-trip for anonymous viewers', async () => {
    const token = await signSandboxToken(
      { ...VALID_PAYLOAD, uid: null },
      SECRET,
    )
    const payload = await verifySandboxTokenDetailed(token, SECRET)
    expect(payload.ok).toBe(true)
    if (!payload.ok) throw new Error('Expected valid token')
    expect(payload.payload.uid).toBeNull()
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

    const payload = await verifySandboxTokenDetailed(token, SECRET)

    expect(payload).toMatchObject({
      ok: true,
      payload: {
        uid: null,
        wid: 'ws-bundle',
        aid: 'abc123def4',
        vid: 'v-bundle',
        fid: 'ws-bundle/abc123def4/v-bundle/index.html',
        mt: null,
        t: 'static_site',
        jti: 'j-bundle',
      },
    })
  })

  test('rejects old-format payloads missing uid, vid, or jti', async () => {
    const token = await signedToken({
      aid: 'abc123def4',
      fid: 'f',
      mt: null,
      t: 'html',
      exp: Math.floor(Date.now() / 1000) + 60,
    })

    expect(await verifySandboxTokenDetailed(token, SECRET)).toMatchObject({
      ok: false,
    })
  })

  test('uses a 60 second TTL boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await signSandboxToken(VALID_PAYLOAD, SECRET)

    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    expect(await verifySandboxTokenDetailed(token, SECRET)).toMatchObject({
      ok: true,
    })

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    expect(await verifySandboxTokenDetailed(token, SECRET)).toMatchObject({
      ok: false,
    })

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

test.each(['production', 'development'])(
  'signed URLs use their signed audience and kind in %s',
  async (APP_ENV) => {
    for (const uid of ['u1', null]) {
      const url = new URL(
        await signSandboxUrl(
          { ...VALID_PAYLOAD, uid },
          SECRET,
          { APP_ENV, ARTIFACT_DELIVERY_STAGE: 'usercontent' },
          '/docs/hello world.html',
        ),
      )
      const payload = await verifySandboxTokenDetailed(
        url.searchParams.get('__as_token')!,
        SECRET,
      )
      expect(payload).toMatchObject({
        ok: true,
        payload: {
          uid,
          aud: url.hostname,
          kind: uid === null ? 'link' : 'authenticated',
          aid: VALID_PAYLOAD.aid,
          vid: VALID_PAYLOAD.vid,
        },
      })
      expect(url.hostname.startsWith(uid === null ? 'l-' : 'a-')).toBe(true)
      expect(url.pathname).toBe('/docs/hello%20world.html')
    }
  },
)

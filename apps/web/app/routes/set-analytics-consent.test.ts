import { describe, expect, test } from 'vitest'
import { action } from './set-analytics-consent'

describe('/set-analytics-consent action', () => {
  test('sets a granted consent cookie', async () => {
    const response = await call('granted', 'https://artifactshare.com')
    const cookie = header(response, 'Set-Cookie')

    expect(response.init?.status ?? 200).toBe(200)
    expect(cookie).toContain('__as_analytics_consent=granted')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Max-Age=31536000')
    expect(cookie).not.toContain('Domain=')
  })

  test('sets a denied consent cookie', async () => {
    const response = await call('denied', 'https://artifactshare.com')
    expect(header(response, 'Set-Cookie')).toContain(
      '__as_analytics_consent=denied',
    )
  })

  test('rejects invalid consent', async () => {
    const response = await call('xxx', 'https://artifactshare.com')
    expect(response.init?.status).toBe(400)
    expect(header(response, 'Set-Cookie')).toBeNull()
  })

  test.each([
    ['missing Origin', null, undefined],
    ['mismatched Origin', 'https://evil.example', undefined],
    ['cross-site fetch', 'https://artifactshare.com', 'cross-site'],
    ['same-site fetch', 'https://artifactshare.com', 'same-site'],
  ])('rejects %s', async (_name, origin, site) => {
    const response = await call('granted', origin, site)
    expect(response.init?.status).toBe(403)
  })

  test('allows same-origin fetch', async () => {
    const response = await call(
      'granted',
      'https://artifactshare.com',
      'same-origin',
    )
    expect(response.init?.status ?? 200).toBe(200)
    expect(header(response, 'Set-Cookie')).toContain(
      '__as_analytics_consent=granted',
    )
  })

  test('allows a missing Sec-Fetch-Site header', async () => {
    const response = await call('granted', 'https://artifactshare.com')
    expect(response.init?.status ?? 200).toBe(200)
  })

  test('trusts a same-origin Sec-Fetch-Site even when Origin does not match the URL', async () => {
    // Dev servers and proxies can present request.url without the port (e.g.
    // https://localhost vs Origin https://localhost:5173). Fetch Metadata is the
    // reliable signal, so an exact Origin match must not be required when
    // Sec-Fetch-Site is same-origin.
    const response = await call(
      'granted',
      'https://mismatch.example',
      'same-origin',
    )
    expect(response.init?.status ?? 200).toBe(200)
    expect(header(response, 'Set-Cookie')).toContain(
      '__as_analytics_consent=granted',
    )
  })
})

function call(consent: string, origin: string | null, site?: string) {
  const headers = new Headers()
  if (origin !== null) headers.set('Origin', origin)
  if (site) headers.set('Sec-Fetch-Site', site)
  return action({
    request: new Request('https://artifactshare.com/set-analytics-consent', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ consent }),
    }),
  } as RouteActionArgs)
}

function header(
  response: Awaited<ReturnType<typeof action>>,
  name: string,
): string | null {
  return new Headers(response.init?.headers).get(name)
}

type RouteActionArgs = Parameters<typeof action>[0]

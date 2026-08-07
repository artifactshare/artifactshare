import { describe, expect, test } from 'vitest'
import { appThemeCookieHeader, getAppTheme } from './app-theme.server'

describe('getAppTheme', () => {
  test('reads a supported app theme from cookie', () => {
    const request = new Request('https://example.com/a/demo', {
      headers: { cookie: '__as_theme=dark' },
    })

    expect(getAppTheme(request)).toBe('dark')
  })

  test('reads system from cookie', () => {
    const request = new Request('https://example.com/a/demo', {
      headers: { cookie: '__as_theme=system' },
    })

    expect(getAppTheme(request)).toBe('system')
  })

  test('falls back unsupported values to system', () => {
    const request = new Request('https://example.com/a/demo', {
      headers: { cookie: '__as_theme=sepia' },
    })

    expect(getAppTheme(request)).toBe('system')
  })
})

describe('appThemeCookieHeader', () => {
  test('builds a host-only 1-year cookie', () => {
    const header = appThemeCookieHeader('dark')

    expect(header).toContain('__as_theme=dark')
    expect(header).toContain('Path=/')
    expect(header).toContain('Max-Age=31536000')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure')
    expect(header).not.toContain('Domain=')
  })
})

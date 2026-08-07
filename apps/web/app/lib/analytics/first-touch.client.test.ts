// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { captureFirstTouch, clearFirstTouch } from './first-touch.client'

describe('first-touch client', () => {
  beforeEach(() => {
    document.cookie =
      '__as_first_touch=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: '', protocol: 'http:' },
    })
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: '',
    })
  })

  it('does not capture before consent', () => {
    captureFirstTouch({ shouldLoadAnalytics: false, artifactId: 'a' })
    expect(
      document.cookie
        .split('; ')
        .some(
          (v) => v.startsWith('__as_first_touch=') && v !== '__as_first_touch=',
        ),
    ).toBe(false)
  })

  it('does not overwrite an existing cookie', () => {
    document.cookie = '__as_first_touch=existing; Path=/'
    captureFirstTouch({ shouldLoadAnalytics: true, artifactId: 'a' })
    expect(document.cookie).toContain('__as_first_touch=existing')
  })

  it('captures UTM and artifact information', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: '?utm_source=a' },
    })
    captureFirstTouch({ shouldLoadAnalytics: true, artifactId: 'a' })
    const cookie = document.cookie
      .split('; ')
      .find((v) => v.startsWith('__as_first_touch='))
    const raw = cookie?.slice('__as_first_touch='.length)
    expect(raw).toBeDefined()
    expect(JSON.parse(decodeURIComponent(raw!))).toMatchObject({
      artifactId: 'a',
      utm: { utm_source: 'a' },
    })
  })

  it('does not write without a capture signal', () => {
    captureFirstTouch({ shouldLoadAnalytics: true })
    expect(
      document.cookie
        .split('; ')
        .some(
          (v) => v.startsWith('__as_first_touch=') && v !== '__as_first_touch=',
        ),
    ).toBe(false)
  })

  it('clears the cookie', () => {
    document.cookie = '__as_first_touch=value; Path=/'
    clearFirstTouch()
    expect(document.cookie).not.toContain('__as_first_touch=value')
  })
})

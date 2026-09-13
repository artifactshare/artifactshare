import { describe, expect, test } from 'vitest'

import { resolvePublicRouteLocale } from './public-route-locale'

describe('public route locale parameter', () => {
  test('maps the stable unprefixed and Japanese URL shapes', () => {
    expect(resolvePublicRouteLocale(undefined)).toBe('en')
    expect(resolvePublicRouteLocale('ja')).toBe('ja')
  })

  test.each(['en', 'fr', 'guides'])(
    'rejects unsupported prefix %s',
    (locale) => {
      expect(() => resolvePublicRouteLocale(locale)).toThrow(
        expect.objectContaining({ status: 404 }),
      )
    },
  )
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildShareableUrl } from './share-url'

describe('buildShareableUrl', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('uses the production link viewer for link visibility', () => {
    vi.stubGlobal('window', {
      location: {
        hostname: 'artifactshare.com',
        origin: 'https://artifactshare.com',
      },
    })
    expect(buildShareableUrl('abc123def4', 'link')).toBe(
      'https://abc123def4.artifactshare.link/',
    )
  })

  test('keeps other visibilities on the app origin', () => {
    vi.stubGlobal('window', {
      location: {
        hostname: 'artifactshare.com',
        origin: 'https://artifactshare.com',
      },
    })
    expect(buildShareableUrl('abc123def4', 'private')).toBe(
      'https://artifactshare.com/a/abc123def4',
    )
  })

  test('uses a per-ID localhost viewer during development', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'localhost', origin: 'https://localhost:5173' },
    })
    expect(buildShareableUrl('abc123def4', 'link')).toBe(
      'https://abc123def4.localhost:5173/',
    )
  })
})

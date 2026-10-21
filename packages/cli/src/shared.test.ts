import { describe, expect, test } from 'vitest'
import { resolveArtifactId } from './shared.js'

describe('execution URL resolution', () => {
  test.each(['a', 'l'])(
    'resolves new %s version hosts without fetching content',
    (kind) => {
      expect(
        resolveArtifactId(
          `https://${kind}-abc123def4--v-7631.artifactshareusercontent.com/path?t=ignored#part`,
        ),
      ).toBe('abc123def4')
      expect(
        resolveArtifactId(
          `https://${kind}-abc123def4--v-7631.usercontent.localhost:5174/path`,
        ),
      ).toBe('abc123def4')
    },
  )

  test.each([
    'https://artifactshare.com/a/abc123def4',
    'https://abc123def4.artifactshare.link/',
    'https://abc123def4--v-7631.artifactshare.link/index.html',
    'https://abc123def4--v-7631.sandbox.artifactshare.com/index.html',
  ])('preserves ID resolution for %s', (url) => {
    expect(resolveArtifactId(url)).toBe('abc123def4')
  })

  test.each([
    'a-abc123def4--v-7',
    'a-abc123def4--v-ff',
    'x-abc123def4--v-7631',
    `a-abc123def4--v-${'78'.repeat(24)}`,
  ])('rejects malformed new identity %s', (label) => {
    expect(
      resolveArtifactId(`https://${label}.artifactshareusercontent.com/`),
    ).toBeNull()
  })
})

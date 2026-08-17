import { describe, expect, test } from 'vitest'
import {
  artifactSandboxUrl,
  MCP_EMBED_FRAME_ANCESTORS,
  requestHostname,
  sandboxVersionIdentityFromHostname,
  sandboxVersionLabel,
} from './hosts'

describe('artifactSandboxUrl', () => {
  test('uses the sandbox dev server root for index.html entrypoints', () => {
    const url = artifactSandboxUrl(
      { APP_ENV: 'development' },
      'abc123def4',
      'version_1-test',
      'token',
      '/index.html',
    )

    expect(url).toBe(
      'https://abc123def4--v-76657273696f6e5f312d74657374.sandbox.localhost:5174/?t=token',
    )
  })

  test('uses the sandbox dev server without an app path prefix', () => {
    const url = artifactSandboxUrl(
      { APP_ENV: 'development' },
      'abc123def4',
      'version_1-test',
      'token',
      '/CLAUDE.md',
    )

    expect(url).toBe(
      'https://abc123def4--v-76657273696f6e5f312d74657374.sandbox.localhost:5174/CLAUDE.md?t=token',
    )
  })

  test('encodes entrypoint path segments without encoding slashes', () => {
    const url = artifactSandboxUrl(
      { APP_ENV: 'production' },
      'abc123def4',
      'version_1-test',
      'token',
      '/docs/50% off.html',
    )

    expect(url).toBe(
      'https://abc123def4--v-76657273696f6e5f312d74657374.sandbox.artifactshare.com/docs/50%25%20off.html?t=token',
    )
  })
})

describe('sandbox version identity', () => {
  test('round trips DNS-unsafe version ids through a version-scoped hostname', () => {
    const label = sandboxVersionLabel('abc123def4', 'version_1-test')
    expect(
      sandboxVersionIdentityFromHostname(`${label}.sandbox.artifactshare.com`, {
        APP_ENV: 'production',
      }),
    ).toEqual({ shareableId: 'abc123def4', versionId: 'version_1-test' })
  })

  test('rejects malformed and oversized identities', () => {
    expect(
      sandboxVersionIdentityFromHostname(
        'abc123def4--v-0g.sandbox.artifactshare.com',
        { APP_ENV: 'production' },
      ),
    ).toBeNull()
    expect(() => sandboxVersionLabel('abc123def4', 'x'.repeat(26))).toThrow()
  })
})

describe('requestHostname', () => {
  test('uses the URL hostname in production', () => {
    const request = new Request('https://localhost:5173/', {
      headers: { host: 'abc123def4.sandbox.localhost:5174' },
    })

    expect(requestHostname(request, { APP_ENV: 'production' })).toBe(
      'localhost',
    )
  })

  test('uses localhost host header in development', () => {
    const request = new Request('https://localhost:5173/index.html', {
      headers: { host: 'abc123def4.sandbox.localhost:5174' },
    })

    expect(requestHostname(request, { APP_ENV: 'development' })).toBe(
      'abc123def4.sandbox.localhost',
    )
  })

  test('uses Miniflare original hostname before normalized host header in development', () => {
    const request = new Request('https://localhost:5174/', {
      headers: {
        host: 'localhost:5174',
        'mf-original-hostname': 'abc123def4.sandbox.localhost:5174',
      },
    })

    expect(requestHostname(request, { APP_ENV: 'development' })).toBe(
      'abc123def4.sandbox.localhost',
    )
  })

  test('prefers sandbox URL hostname over normalized localhost host header in development', () => {
    const request = new Request('https://abc123def4.sandbox.localhost:5174/', {
      headers: { host: 'localhost:5173' },
    })

    expect(requestHostname(request, { APP_ENV: 'development' })).toBe(
      'abc123def4.sandbox.localhost',
    )
  })

  test('ignores non-sandbox localhost host header in development', () => {
    const request = new Request('https://localhost:5173/', {
      headers: { host: 'example.localhost:5173' },
    })

    expect(requestHostname(request, { APP_ENV: 'development' })).toBe(
      'localhost',
    )
  })

  test('ignores non-localhost host header in development', () => {
    const request = new Request('https://localhost:5173/', {
      headers: { host: 'example.com' },
    })

    expect(requestHostname(request, { APP_ENV: 'development' })).toBe(
      'localhost',
    )
  })
})

describe('MCP_EMBED_FRAME_ANCESTORS', () => {
  test('allows Claude widget origins for MCP preview embeds', () => {
    expect(MCP_EMBED_FRAME_ANCESTORS).toContain(
      'https://*.claudemcpcontent.com',
    )
  })
})

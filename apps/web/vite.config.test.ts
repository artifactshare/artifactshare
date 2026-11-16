import { describe, expect, test, vi } from 'vitest'
import {
  devServerTopology,
  originalHostnamePlugin,
  sourceRevision,
} from './vite.config'

describe('capture source revision', () => {
  test('accepts only the unchanged clean startup commit', () => {
    const head = 'a'.repeat(40)
    const clean = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${head}\n` : '',
    )
    expect(sourceRevision(head, clean)).toEqual({ head, clean: true })
  })

  test('rejects a dirty or changed server worktree', () => {
    const startupHead = 'a'.repeat(40)
    const dirty = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${startupHead}\n` : ' M app.tsx\n',
    )
    expect(sourceRevision(startupHead, dirty)).toEqual({
      head: startupHead,
      clean: false,
    })

    const changedHead = 'b'.repeat(40)
    const changed = vi.fn((_file: string, args: readonly string[]) =>
      args[0] === 'rev-parse' ? `${changedHead}\n` : '',
    )
    expect(sourceRevision(startupHead, changed)).toEqual({
      head: startupHead,
      clean: false,
    })
  })
})

describe('dev server topology', () => {
  test('keeps pnpm dev on 5173 with the Worker variables untouched', () => {
    expect(devServerTopology({})).toEqual({
      port: 5173,
      host: undefined,
      inspectorPort: undefined,
      vars: {},
    })
  })

  test('moves the app, its auth URL and sandbox links to selected ports', () => {
    expect(
      devServerTopology({
        ARTIFACTSHARE_DEV_APP_PORT: '41101',
        ARTIFACTSHARE_DEV_SANDBOX_PORT: '41102',
        ARTIFACTSHARE_DEV_INSPECTOR_PORT: '41104',
        ARTIFACTSHARE_DEV_HOST: '::1',
      }),
    ).toEqual({
      port: 41101,
      host: '::1',
      inspectorPort: 41104,
      vars: {
        DEV_APP_PORT: '41101',
        BETTER_AUTH_URL: 'https://localhost:41101',
        DEV_SANDBOX_PORT: '41102',
      },
    })
  })

  test('rejects a port that is not a TCP port', () => {
    expect(() =>
      devServerTopology({ ARTIFACTSHARE_DEV_APP_PORT: '5173; rm' }),
    ).toThrow(/ARTIFACTSHARE_DEV_APP_PORT must be a TCP port/)
  })
})

describe('original hostname plugin', () => {
  type Handler = (
    request: {
      headers: Record<string, string | undefined>
      rawHeaders: string[]
    },
    response: unknown,
    next: () => void,
  ) => void

  function install(): Handler {
    let handler: Handler | undefined
    const plugin = originalHostnamePlugin() as unknown as {
      configureServer: (server: {
        middlewares: { use: (fn: Handler) => void }
      }) => void
    }
    plugin.configureServer({
      middlewares: {
        use: (fn) => {
          handler = fn
        },
      },
    })
    if (!handler) throw new Error('middleware was not installed')
    return handler
  }

  test('carries a per-ID .localhost host into the Worker hostname header', () => {
    const handler = install()
    const next = vi.fn()
    const request = {
      headers: { ':authority': 'abc123def4.localhost:5173' } as Record<
        string,
        string | undefined
      >,
      rawHeaders: [':authority', 'abc123def4.localhost:5173'],
    }
    handler(request, undefined, next)
    expect(request.headers['mf-original-hostname']).toBe('abc123def4.localhost')
    expect(request.rawHeaders.slice(-2)).toEqual([
      'mf-original-hostname',
      'abc123def4.localhost',
    ])
    expect(next).toHaveBeenCalledOnce()
  })

  test('leaves plain localhost and an existing header alone', () => {
    const handler = install()
    const plain = {
      headers: { host: 'localhost:5173' } as Record<string, string | undefined>,
      rawHeaders: ['host', 'localhost:5173'],
    }
    handler(plain, undefined, () => {})
    expect(plain.headers['mf-original-hostname']).toBeUndefined()
    expect(plain.rawHeaders).toEqual(['host', 'localhost:5173'])

    const preset = {
      headers: {
        host: 'abc123def4.localhost:5173',
        'mf-original-hostname': 'preset.localhost',
      } as Record<string, string | undefined>,
      rawHeaders: [],
    }
    handler(preset, undefined, () => {})
    expect(preset.headers['mf-original-hostname']).toBe('preset.localhost')
  })
})

test('unit tests reject an unmocked Workers runtime import', async () => {
  await expect(vi.importActual('cloudflare:workers')).rejects.toThrow(
    'cloudflare:workers requires an explicit mock in unit tests',
  )
})

import { describe, expect, test, vi } from 'vitest'
import { originalHostnamePlugin, sourceRevision } from './vite.config'

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

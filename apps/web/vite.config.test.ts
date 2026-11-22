import * as path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  devServerFiles,
  devServerTopology,
  originalHostnameMiddleware,
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
    expect(() =>
      devServerTopology({ ARTIFACTSHARE_DEV_SANDBOX_PORT: '443' }),
    ).toThrow(/ARTIFACTSHARE_DEV_SANDBOX_PORT must be a TCP port from 1024/)
  })
})

describe('dev server files', () => {
  const root = path.resolve(import.meta.dirname, '../..')

  test('pnpm dev reads the checkout certificate and variables', () => {
    expect(devServerFiles({})).toEqual({
      certPath: path.join(root, '.dev-certs/cert.pem'),
      keyPath: path.join(root, '.dev-certs/key.pem'),
      varsPath: path.join(root, '.dev.vars'),
      gitRoot: root,
    })
  })

  test('a local capture points every shared file at its runtime directory', () => {
    expect(
      devServerFiles({
        ARTIFACTSHARE_DEV_CERT_DIR: '/run/certs',
        ARTIFACTSHARE_DEV_VARS_PATH: '/run/dev.vars',
        ARTIFACTSHARE_DEV_GIT_ROOT: '/checkout',
      }),
    ).toEqual({
      certPath: '/run/certs/cert.pem',
      keyPath: '/run/certs/key.pem',
      varsPath: '/run/dev.vars',
      gitRoot: '/checkout',
    })
  })

  test('the revision check asks the configured Git root', () => {
    const head = 'c'.repeat(40)
    const exec = vi.fn(
      (
        _file: string,
        args: readonly string[],
        _options: { cwd: string; encoding: 'utf8' },
      ) => (args[0] === 'rev-parse' ? `${head}\n` : ''),
    )
    expect(sourceRevision(head, exec, '/checkout')).toEqual({
      head,
      clean: true,
    })
    expect(exec.mock.calls.map(([, , options]) => options.cwd)).toEqual([
      '/checkout',
      '/checkout',
    ])
  })
})

describe('original hostname middleware', () => {
  const handler = originalHostnameMiddleware

  test('carries a per-ID .localhost host into the Worker hostname header', () => {
    const next = vi.fn()
    const request: Parameters<typeof handler>[0] = {
      headers: { ':authority': 'abc123def4.localhost:5173' },
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
    const plain: Parameters<typeof handler>[0] = {
      headers: { host: 'localhost:5173' },
      rawHeaders: ['host', 'localhost:5173'],
    }
    handler(plain, undefined, () => {})
    expect(plain.headers['mf-original-hostname']).toBeUndefined()
    expect(plain.rawHeaders).toEqual(['host', 'localhost:5173'])

    const preset = {
      headers: {
        host: 'abc123def4.localhost:5173',
        'mf-original-hostname': 'preset.localhost',
      },
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

test('the dev server scans the client entry, root and routes for dependencies', async () => {
  // Without this scan the first browser load re-optimizes dependencies and the
  // pages that were loading get 504 for them and never hydrate.
  const { default: config } = await import('./vite.config')
  const resolved =
    typeof config === 'function'
      ? config({ command: 'build', mode: 'test', isPreview: false })
      : config
  const entries = (await resolved).optimizeDeps?.entries
  expect(entries).toEqual(
    expect.arrayContaining([
      'app/entry.client.tsx',
      'app/root.tsx',
      'app/routes/**/*.tsx',
      '!app/**/*.test.tsx',
    ]),
  )
})

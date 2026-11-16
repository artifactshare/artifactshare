import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { reactRouter } from '@react-router/dev/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { APP_DEV_PORT } from './app/lib/hosts.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CERT_PATH = path.join(REPO_ROOT, '.dev-certs/cert.pem')
const KEY_PATH = path.join(REPO_ROOT, '.dev-certs/key.pem')
const DEV_VARS_PATH = path.join(REPO_ROOT, '.dev.vars')

type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf8' },
) => string

function loadDevCerts(): { cert: Buffer; key: Buffer } {
  const missing = [CERT_PATH, KEY_PATH].filter((file) => !fs.existsSync(file))
  if (missing.length)
    throw new Error(
      `Dev HTTPS certificate missing: ${missing.join(', ')}. Run pnpm dev:setup.`,
    )
  return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }
}

function loadDevVars(): Record<string, string> {
  if (!fs.existsSync(DEV_VARS_PATH))
    throw new Error('Local variables missing. Run pnpm dev:setup.')
  return Object.fromEntries(
    fs
      .readFileSync(DEV_VARS_PATH, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=')
        return separator === -1
          ? [line, '']
          : [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
}

export function sourceHead(exec: GitExec = execFileSync): string {
  const head = exec('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the Vite source SHA.')
  return head
}

export function sourceRevision(
  startupHead: string,
  exec: GitExec = execFileSync,
) {
  const currentHead = sourceHead(exec)
  const status = exec('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  return { head: startupHead, clean: currentHead === startupHead && !status }
}

export function sourceRevisionPlugin(startupHead: string): Plugin {
  return {
    name: 'artifactshare-source-revision',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname
        if (pathname !== '/__screen_capture_revision') return next()
        const revision = sourceRevision(startupHead)
        response.statusCode = revision.clean ? 200 : 409
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(revision))
      })
    },
  }
}

// The Cloudflare Vite plugin normalizes the request host to `localhost` before
// the Worker sees it, which would hide per-ID viewer hosts such as
// `<id>.localhost`. Carry the original host in the header the Worker already
// reads for local sandbox hosts (`requestHostname` in `app/lib/hosts.ts`); the
// header is ignored in production.
export function originalHostnamePlugin(): Plugin {
  return {
    name: 'artifactshare-original-hostname',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const authority = request.headers[':authority']
        const host =
          request.headers.host ??
          (typeof authority === 'string' ? authority : undefined)
        if (host && !request.headers['mf-original-hostname']) {
          const hostname = host.replace(/:\d+$/u, '').toLowerCase()
          if (hostname.endsWith('.localhost')) {
            request.headers['mf-original-hostname'] = hostname
            request.rawHeaders.push('mf-original-hostname', hostname)
          }
        }
        next()
      })
    },
  }
}

function optionalPort(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = env[name]
  if (value === undefined || value === '') return undefined
  const port = Number(value)
  if (!/^\d+$/u.test(value) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port from 1 to 65535: ${value}`)
  return port
}

/**
 * Dev-server overrides for a private local stack. `pnpm dev` sets none of
 * these and keeps port 5173 with the Worker's own variables; the local
 * capture commands (`scripts/local-capture.mjs`) set them so the app, its
 * per-ID viewers and the sandbox links all follow the ports they chose.
 * The values are applied after `.dev.vars`, so they win over its URL.
 */
export function devServerTopology(
  env: Record<string, string | undefined> = process.env,
) {
  const appPort = optionalPort(env, 'ARTIFACTSHARE_DEV_APP_PORT')
  const sandboxPort = optionalPort(env, 'ARTIFACTSHARE_DEV_SANDBOX_PORT')
  const inspectorPort = optionalPort(env, 'ARTIFACTSHARE_DEV_INSPECTOR_PORT')
  return {
    port: appPort ?? APP_DEV_PORT,
    host: env.ARTIFACTSHARE_DEV_HOST || undefined,
    inspectorPort,
    vars: {
      ...(appPort === undefined
        ? {}
        : {
            DEV_APP_PORT: String(appPort),
            BETTER_AUTH_URL: `https://localhost:${appPort}`,
          }),
      ...(sandboxPort === undefined
        ? {}
        : { DEV_SANDBOX_PORT: String(sandboxPort) }),
    },
  }
}

export default defineConfig(({ command, isPreview }) => {
  const isDevServer = command === 'serve' && isPreview === false
  const startupHead = isDevServer ? sourceHead() : undefined
  const topology = isDevServer ? devServerTopology() : undefined

  return {
    build: { sourcemap: process.env.VITE_SOURCEMAP === '1' },
    plugins: [
      ...(startupHead
        ? [sourceRevisionPlugin(startupHead), originalHostnamePlugin()]
        : []),
      cloudflare({
        configPath: process.env.WRANGLER_CONFIG_PATH ?? 'wrangler.jsonc',
        config: topology
          ? (config) => ({
              vars: { ...config.vars, ...loadDevVars(), ...topology.vars },
            })
          : undefined,
        persistState: process.env.ARTIFACTSHARE_DEV_PERSIST_PATH
          ? { path: process.env.ARTIFACTSHARE_DEV_PERSIST_PATH }
          : true,
        ...(topology?.inspectorPort === undefined
          ? {}
          : { inspectorPort: topology.inspectorPort }),
        remoteBindings: false,
        viteEnvironment: { name: 'ssr' },
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: {
      alias: {
        '@artifactshare/contract': path.resolve(
          REPO_ROOT,
          'packages/contract/src/index.ts',
        ),
      },
      tsconfigPaths: true,
    },
    server: topology
      ? {
          port: topology.port,
          ...(topology.host ? { host: topology.host } : {}),
          strictPort: true,
          https: loadDevCerts(),
        }
      : undefined,
  }
})

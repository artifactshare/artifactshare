import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { reactRouter } from '@react-router/dev/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { APP_DEV_PORT, parseDevPort } from './app/lib/hosts.js'
import { resolveAlias } from './resolve-alias.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf8' },
) => string

/**
 * Files the dev server reads. `pnpm dev` sets none of these and uses the
 * checkout's own certificate and `.dev.vars`. The local capture commands,
 * which run this config from an export of HEAD, name the certificate and
 * variables they chose.
 */
export function devServerFiles(
  env: Record<string, string | undefined> = process.env,
) {
  const certs =
    env.ARTIFACTSHARE_DEV_CERT_DIR || path.join(REPO_ROOT, '.dev-certs')
  return {
    certPath: path.join(certs, 'cert.pem'),
    keyPath: path.join(certs, 'key.pem'),
    varsPath:
      env.ARTIFACTSHARE_DEV_VARS_PATH || path.join(REPO_ROOT, '.dev.vars'),
    // The local capture commands run this config from an export of HEAD,
    // which has no Git metadata: the revision check asks the checkout.
    gitRoot: env.ARTIFACTSHARE_DEV_GIT_ROOT || REPO_ROOT,
  }
}

type DevServerFiles = ReturnType<typeof devServerFiles>

function loadDevCerts(files: DevServerFiles): { cert: Buffer; key: Buffer } {
  const missing = [files.certPath, files.keyPath].filter(
    (file) => !fs.existsSync(file),
  )
  if (missing.length)
    throw new Error(
      `Dev HTTPS certificate missing: ${missing.join(', ')}. Run pnpm dev:setup.`,
    )
  return {
    cert: fs.readFileSync(files.certPath),
    key: fs.readFileSync(files.keyPath),
  }
}

function loadDevVars(files: DevServerFiles): Record<string, string> {
  if (!fs.existsSync(files.varsPath))
    throw new Error('Local variables missing. Run pnpm dev:setup.')
  return Object.fromEntries(
    fs
      .readFileSync(files.varsPath, 'utf8')
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

export function sourceHead(
  exec: GitExec = execFileSync,
  gitRoot = REPO_ROOT,
): string {
  const head = exec('git', ['rev-parse', 'HEAD'], {
    cwd: gitRoot,
    encoding: 'utf8',
  }).trim()
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the Vite source SHA.')
  return head
}

export function sourceRevision(
  startupHead: string,
  exec: GitExec = execFileSync,
  gitRoot = REPO_ROOT,
) {
  const currentHead = sourceHead(exec, gitRoot)
  const status = exec('git', ['status', '--porcelain'], {
    cwd: gitRoot,
    encoding: 'utf8',
  }).trim()
  return { head: startupHead, clean: currentHead === startupHead && !status }
}

export function sourceRevisionPlugin(
  startupHead: string,
  gitRoot = REPO_ROOT,
): Plugin {
  return {
    name: 'artifactshare-source-revision',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost')
          .pathname
        if (pathname !== '/__screen_capture_revision') return next()
        const revision = sourceRevision(startupHead, execFileSync, gitRoot)
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
export function originalHostnameMiddleware(
  request: Pick<IncomingMessage, 'headers' | 'rawHeaders'>,
  _response: unknown,
  next: () => void,
) {
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
}

export function originalHostnamePlugin(): Plugin {
  return {
    name: 'artifactshare-original-hostname',
    configureServer(server) {
      server.middlewares.use(originalHostnameMiddleware)
    },
  }
}

/**
 * Dev-server overrides for a private local stack. `pnpm dev` sets none of
 * these and keeps port 5173 with the Worker's own variables. Setting
 * `ARTIFACTSHARE_DEV_APP_PORT` and `ARTIFACTSHARE_DEV_SANDBOX_PORT` moves the
 * app, its per-ID viewers and the sandbox links to those ports together.
 * The values are applied after `.dev.vars`, so they win over its URL.
 */
export function devServerTopology(
  env: Record<string, string | undefined> = process.env,
) {
  const appPort = parseDevPort(
    'ARTIFACTSHARE_DEV_APP_PORT',
    env.ARTIFACTSHARE_DEV_APP_PORT,
  )
  const sandboxPort = parseDevPort(
    'ARTIFACTSHARE_DEV_SANDBOX_PORT',
    env.ARTIFACTSHARE_DEV_SANDBOX_PORT,
  )
  const inspectorPort = parseDevPort(
    'ARTIFACTSHARE_DEV_INSPECTOR_PORT',
    env.ARTIFACTSHARE_DEV_INSPECTOR_PORT,
  )
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
  const files = devServerFiles()
  const startupHead = isDevServer
    ? sourceHead(execFileSync, files.gitRoot)
    : undefined
  const topology = isDevServer ? devServerTopology() : undefined

  return {
    build: { sourcemap: process.env.VITE_SOURCEMAP === '1' },
    // React Router scans the client entry and route modules for dependencies
    // only under its unstable optimizeDeps flag. Without a scan, the dev server
    // discovers them on the first page load, re-optimizes, and answers the
    // in-flight dependency requests with 504: those pages never hydrate.
    optimizeDeps: {
      entries: [
        'app/entry.client.tsx',
        'app/root.tsx',
        'app/routes/**/*.tsx',
        '!app/**/*.test.tsx',
      ],
    },
    plugins: [
      ...(startupHead
        ? [
            sourceRevisionPlugin(startupHead, files.gitRoot),
            originalHostnamePlugin(),
          ]
        : []),
      cloudflare({
        configPath: process.env.WRANGLER_CONFIG_PATH ?? 'wrangler.jsonc',
        config: topology
          ? (config) => ({
              vars: {
                ...config.vars,
                ...loadDevVars(files),
                ...topology.vars,
              },
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
    resolve: { alias: resolveAlias },
    server: topology
      ? {
          port: topology.port,
          ...(topology.host ? { host: topology.host } : {}),
          strictPort: true,
          https: loadDevCerts(files),
        }
      : undefined,
  }
})

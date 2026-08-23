import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { reactRouter } from '@react-router/dev/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { APP_DEV_PORT } from './app/lib/hosts.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CERT_PATH = path.join(REPO_ROOT, '.dev-certs/cert.pem')
const KEY_PATH = path.join(REPO_ROOT, '.dev-certs/key.pem')
const DEV_VARS_PATH = path.join(REPO_ROOT, '.dev.vars')

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

function sourceHead(): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Could not resolve the Vite source SHA.')
  return head
}

export default defineConfig(({ command, isPreview }) => {
  const isDevServer = command === 'serve' && isPreview === false

  return {
    build: { sourcemap: process.env.VITE_SOURCEMAP === '1' },
    plugins: [
      cloudflare({
        configPath: process.env.WRANGLER_CONFIG_PATH ?? 'wrangler.jsonc',
        config: isDevServer
          ? (config) => ({
              vars: {
                ...config.vars,
                ...loadDevVars(),
                ARTIFACTSHARE_SOURCE_HEAD: sourceHead(),
              },
            })
          : undefined,
        persistState: process.env.ARTIFACTSHARE_DEV_PERSIST_PATH
          ? { path: process.env.ARTIFACTSHARE_DEV_PERSIST_PATH }
          : true,
        remoteBindings: false,
        viteEnvironment: { name: 'ssr' },
      }),
      tailwindcss(),
      reactRouter(),
    ],
    resolve: { tsconfigPaths: true },
    server: isDevServer
      ? { port: APP_DEV_PORT, strictPort: true, https: loadDevCerts() }
      : undefined,
  }
})

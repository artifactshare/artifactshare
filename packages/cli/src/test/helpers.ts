import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
export {
  collectBody,
  collectBodyBuffer,
  formField,
  withServer,
} from './server.js'
import { stat } from 'node:fs/promises'
import assert from 'node:assert/strict'

const bin = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
const defaultConfigHome = join(
  tmpdir(),
  'artifactshare-cli-test-config-missing',
)
const defaultHome = join(tmpdir(), 'artifactshare-cli-test-home-missing')
/** Project config is discovered by walking up from the working directory, so
 * running from inside this checkout lets a developer's own
 * `.artifactshare/config.local.json` answer tests that assume no credential.
 * Every run starts outside the repository unless a test picks its own place. */
export const testCwd = join(tmpdir(), 'artifactshare-cli-test-cwd')
mkdirSync(testCwd, { recursive: true })

export function recordCliSubprocessLaunch(): void {
  const path = process.env.ARTIFACTSHARE_TEST_SUBPROCESS_COUNT_FILE
  if (path) appendFileSync(path, '1\n')
}

export type CliResult = {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

type JsonPayload = {
  schema_version: number
  ok: boolean
  command?: string
  data?: any
  error?: any
}

/** Every CLI subprocess loads the same `dist/index.js`, so letting Node keep
 * its compiled bytecode saves roughly 70 ms of startup per launch across the
 * hundreds of launches this suite makes. The cache is keyed by source content,
 * so a rebuilt CLI is never served a stale entry. */
const compileCache = join(tmpdir(), 'artifactshare-cli-test-compile-cache')

/** The CLI routes requests through a proxy named in the environment, so a
 * developer's own proxy settings would reroute the loopback stubs. Tests that
 * exercise the proxy set these themselves. */
export function withoutProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
  ])
    delete copy[name]
  return copy
}

function subprocessEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = withoutProxyEnv(process.env)
  delete env.CLAUDE_CONFIG_DIR
  return {
    ...env,
    HOME: defaultHome,
    ARTIFACTSHARE_CONFIG_HOME: defaultConfigHome,
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    NODE_COMPILE_CACHE: compileCache,
    CI: '',
    ...overrides,
  }
}

export function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { cwd?: string; input?: string } = {},
): SpawnSyncReturns<string> {
  recordCliSubprocessLaunch()
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: subprocessEnv(env),
    cwd: options.cwd ?? testCwd,
    input: options.input,
    timeout: 10_000,
  })
}

export function runAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { cwd?: string; input?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    recordCliSubprocessLaunch()
    const child = spawn(process.execPath, [bin, ...args], {
      env: subprocessEnv(env),
      cwd: options.cwd ?? testCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('CLI process timed out'))
    }, 5000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export function sha256Base64Url(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('base64url')
}

// root bypasses file permissions via CAP_DAC_OVERRIDE, so chmod-based
// write-failure tests cannot fail and must be skipped
export const rootBypassesFilePermissions = process.getuid?.() === 0

export async function pathExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null))
}

export function expectFailure(
  result: CliResult | SpawnSyncReturns<string>,
  {
    command,
    code,
    exitCode = 1,
  }: { command?: string; code?: string; exitCode?: number } = {},
): JsonPayload {
  assert.equal(result.status, exitCode)
  assert.equal(result.stdout, '')
  const payload = JSON.parse(result.stderr) as JsonPayload
  assert.equal(payload.schema_version, 2)
  assert.equal(payload.ok, false)
  assert.ok('error' in payload, 'failure payload has error')
  assert.ok(!('data' in payload), 'failure payload omits data')
  if (command !== undefined) assert.equal(payload.command, command)
  if (code !== undefined) assert.equal(payload.error.code, code)
  return payload
}

export function expectSuccess(
  result: CliResult | SpawnSyncReturns<string>,
  command?: string,
): JsonPayload {
  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout) as JsonPayload
  assert.equal(payload.schema_version, 2)
  assert.equal(payload.ok, true)
  assert.ok('data' in payload, 'success payload has data')
  assert.ok(!('error' in payload), 'success payload omits error')
  if (command !== undefined) assert.equal(payload.command, command)
  return payload
}

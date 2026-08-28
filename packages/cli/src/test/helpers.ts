import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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

export async function collectBody(request: IncomingMessage): Promise<string> {
  return (await collectBodyBuffer(request)).toString('utf8')
}

export async function collectBodyBuffer(
  request: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
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

export function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { cwd?: string; input?: string } = {},
): SpawnSyncReturns<string> {
  recordCliSubprocessLaunch()
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: defaultHome,
      ARTIFACTSHARE_CONFIG_HOME: defaultConfigHome,
      ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
      CI: '',
      ...env,
    },
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
      env: {
        ...process.env,
        HOME: defaultHome,
        ARTIFACTSHARE_CONFIG_HOME: defaultConfigHome,
        ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
        CI: '',
        ...env,
      },
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

export async function withServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

export async function withHttpsServer<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const certificateDirectory = await mkdtemp(
    join(tmpdir(), 'artifactshare-cli-test-certificate-'),
  )
  let server: ReturnType<typeof createHttpsServer> | undefined
  try {
    const keyPath = join(certificateDirectory, 'key.pem')
    const certificatePath = join(certificateDirectory, 'certificate.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        keyPath,
        '-out',
        certificatePath,
      ],
      { stdio: 'ignore' },
    )
    const httpsServer = createHttpsServer(
      {
        key: await readFile(keyPath),
        cert: await readFile(certificatePath),
      },
      handler,
    )
    server = httpsServer
    await new Promise<void>((resolve, reject) => {
      httpsServer.once('error', reject)
      httpsServer.listen(0, '127.0.0.1', resolve)
    })
    const address = httpsServer.address()
    assert.ok(address && typeof address === 'object')
    return await callback(`https://127.0.0.1:${address.port}`)
  } finally {
    if (server?.listening) {
      const listeningServer = server
      await new Promise<void>((resolve, reject) => {
        listeningServer.close((error) => (error ? reject(error) : resolve()))
      })
    }
    await rm(certificateDirectory, { recursive: true, force: true })
  }
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

// Runs `screens:capture` or `walkthroughs:capture` against a private local
// stack: prepares missing inputs, starts the app, sandbox and og-image dev
// services for the current HEAD on their own ports, registry and persistence,
// runs the capture, and stops everything it started on every exit path.
//
//   node scripts/local-capture.mjs screens -- --screen about
//   node scripts/local-capture.mjs walkthroughs -- --task share-file-link
//
// `prepare` is the internal setup step, run as an owned child process so an
// interrupt can stop it like any other process this command started.
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { request } from 'node:https'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEV_SERVICES,
  prepareDevEnvironment,
  serviceIdentityMatches,
} from './dev-setup.mjs'
import { assertSafeCaptureOutput } from './screen-capture-output.mjs'
import {
  cleanCaptureHead,
  parseArgs as parseScreenArgs,
} from './screen-capture.mjs'
import { parseWalkthroughArgs } from './task-walkthrough-capture.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SELF = resolve(import.meta.dirname, 'local-capture.mjs')

/** The ports `pnpm dev` uses; never chosen automatically. */
export const DEFAULT_DEV_PORTS = [5173, 5174, 5175]
export const PORT_SETTINGS = {
  app: 'LOCAL_CAPTURE_APP_PORT',
  sandbox: 'LOCAL_CAPTURE_SANDBOX_PORT',
  ogImage: 'LOCAL_CAPTURE_OG_IMAGE_PORT',
}
// Runtime inspector ports: not configurable, but chosen like the public ones
// so they cannot land on a developer's listener either.
const AUXILIARY_PORTS = ['appInspector', 'sandboxInspector', 'ogImageInspector']
const LOOPBACK_HOSTS = ['127.0.0.1', '::1']
const DEFAULT_READY_TIMEOUT_MS = 300_000
const REQUEST_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 5_000
const KILL_WAIT_MS = 5_000
const LOG_TAIL_BYTES = 8 * 1024

export const LOCAL_CAPTURE_MODES = {
  screens: {
    command: 'pnpm screens:capture:local',
    launcher: 'scripts/run-screen-capture.mjs',
    parse: parseScreenArgs,
    needsCli: false,
  },
  walkthroughs: {
    command: 'pnpm walkthroughs:capture:local',
    launcher: 'scripts/run-task-walkthroughs.mjs',
    parse: parseWalkthroughArgs,
    needsCli: true,
  },
}

/** Validates the forwarded selection with the capture's own parser. */
export function parseLocalCaptureArgs(mode, argv) {
  const spec = LOCAL_CAPTURE_MODES[mode]
  if (!spec)
    throw new Error(
      `Usage: node scripts/local-capture.mjs <${Object.keys(LOCAL_CAPTURE_MODES).join('|')}> -- <capture options>`,
    )
  // Only the separator pnpm passes first is dropped; later arguments are
  // forwarded to the capture command unchanged.
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  spec.parse(forwarded)
  return forwarded
}

export function parsePortSetting(name, value) {
  if (value === undefined || value === '') return undefined
  const port = Number(value)
  if (!/^\d+$/u.test(value) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port from 1 to 65535, got ${value}`)
  return port
}

function listen(port, host) {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen({ port, host, exclusive: true }, () => done(server))
  })
}

function closeServer(server) {
  return new Promise((done) => server.close(() => done()))
}

/**
 * Whether `port` can be bound on both loopback families. A port in use (or
 * reserved for privileged users) is unavailable; any other failure means the
 * machine lacks a loopback family the stack needs and is reported as such.
 */
export async function portIsFree(port, hosts = LOOPBACK_HOSTS) {
  for (const host of hosts) {
    let server
    try {
      server = await listen(port, host)
    } catch (error) {
      if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') return false
      throw new Error(
        `Cannot bind loopback ${host}:${port} (${error?.code ?? error}); local capture needs IPv4 and IPv6 loopback`,
        { cause: error },
      )
    }
    await closeServer(server)
  }
  return true
}

/** A kernel-chosen free port on IPv6 loopback; `portIsFree` checks IPv4. */
export async function ephemeralPort() {
  const server = await listen(0, '::1')
  const { port } = server.address()
  await closeServer(server)
  return port
}

/**
 * Chooses distinct ports for the three services and their inspectors.
 * Explicit settings must be valid, distinct and free; nothing is chosen
 * automatically from the `pnpm dev` ports or from a port already in use.
 */
export async function selectPorts({
  env = process.env,
  isFree = portIsFree,
  nextPort = ephemeralPort,
  excluded = DEFAULT_DEV_PORTS,
  attempts = 50,
} = {}) {
  const ports = {}
  for (const [name, setting] of Object.entries(PORT_SETTINGS)) {
    const port = parsePortSetting(setting, env[setting])
    if (port === undefined) continue
    const duplicate = Object.entries(ports).find(([, value]) => value === port)
    if (duplicate)
      throw new Error(
        `${setting} and ${PORT_SETTINGS[duplicate[0]]} both select port ${port}; each service needs its own port`,
      )
    if (!(await isFree(port)))
      throw new Error(
        `${setting}=${port} is already in use on 127.0.0.1 or [::1]; choose a free port or unset it`,
      )
    ports[name] = port
  }
  for (const name of [...Object.keys(PORT_SETTINGS), ...AUXILIARY_PORTS]) {
    if (ports[name] !== undefined) continue
    for (let attempt = 0; ports[name] === undefined; attempt++) {
      if (attempt >= attempts)
        throw new Error(`Could not find a free loopback port for ${name}`)
      const port = await nextPort()
      if (
        excluded.includes(port) ||
        Object.values(ports).includes(port) ||
        !(await isFree(port))
      )
        continue
      ports[name] = port
    }
  }
  return ports
}

export function localTopology(ports) {
  return {
    appOrigin: `https://localhost:${ports.app}`,
    sandboxOrigin: `https://localhost:${ports.sandbox}`,
    ogImageOrigin: `https://localhost:${ports.ogImage}`,
  }
}

/**
 * One private directory outside every registered worktree, holding the dev
 * registry, D1/R2 persistence and Wrangler logs of this invocation only.
 */
export function createRuntimeRoot({
  tmp = tmpdir(),
  assertOutside = (paths) => assertSafeCaptureOutput(paths),
} = {}) {
  const root = mkdtempSync(
    join(realpathSync(tmp), 'artifactshare-local-capture-'),
  )
  try {
    assertOutside([root])
    const runtime = {
      root,
      registry: join(root, 'registry'),
      persist: join(root, 'persist'),
      logs: join(root, 'logs'),
    }
    for (const dir of [runtime.registry, runtime.persist, runtime.logs])
      mkdirSync(dir)
    return runtime
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

// Inherited values that would point a child at another stack's URL,
// registry, persistence or logs. They are dropped and replaced below.
const INHERITED_TOPOLOGY =
  /^(?:SCREEN_CAPTURE_BASE_URL|SCREEN_CAPTURE_SANDBOX_URL|CLOUDFLARE_DEV_REGISTRY_PATH|WRANGLER_REGISTRY_PATH|WRANGLER_LOG_PATH|WRANGLER_CONFIG_PATH|ARTIFACTSHARE_DEV_[A-Z0-9_]+|LOCAL_CAPTURE_[A-Z0-9_]+)$/u

/** The environment every child of this invocation starts from. */
export function ownedEnvironment(base, runtime) {
  const env = Object.fromEntries(
    Object.entries(base).filter(([name]) => !INHERITED_TOPOLOGY.test(name)),
  )
  return {
    ...env,
    // Miniflare (Vite plugin and Wrangler) and Wrangler's own lookup each
    // read a different variable; both name this invocation's registry.
    CLOUDFLARE_DEV_REGISTRY_PATH: runtime.registry,
    WRANGLER_REGISTRY_PATH: runtime.registry,
    WRANGLER_LOG_PATH: runtime.logs,
    ARTIFACTSHARE_DEV_PERSIST_PATH: runtime.persist,
  }
}

/** Every process this invocation starts, with its arguments and environment. */
export function localCaptureCommands({
  mode,
  argv,
  ports,
  runtime,
  env,
  root = ROOT,
  cliBuilt = existsSync(join(root, 'packages/cli/dist/index.js')),
}) {
  const spec = LOCAL_CAPTURE_MODES[mode]
  const app = join(root, 'apps/web')
  const certs = join(root, '.dev-certs')
  const topology = localTopology(ports)
  const tls = [
    '--local-protocol',
    'https',
    '--https-key-path',
    join(certs, 'key.pem'),
    '--https-cert-path',
    join(certs, 'cert.pem'),
  ]
  const wrangler = (config, port, inspectorPort, extra = []) => [
    'exec',
    'wrangler',
    'dev',
    '-c',
    config,
    '--env-file',
    join(root, '.dev.vars'),
    '--port',
    String(port),
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    runtime.persist,
    ...tls,
    ...extra,
  ]
  return {
    setup: [
      {
        name: 'prepare',
        command: process.execPath,
        args: [SELF, 'prepare'],
        cwd: root,
        env: {
          ...env,
          LOCAL_CAPTURE_PREPARE: JSON.stringify({ persistTo: runtime.persist }),
        },
      },
      {
        name: 'contract build',
        command: 'pnpm',
        args: ['--filter', '@artifactshare/contract', 'build'],
        cwd: root,
        env,
      },
      ...(spec.needsCli && !cliBuilt
        ? [
            {
              name: 'cli build',
              command: 'pnpm',
              args: ['--filter', '@artifactshare/cli', 'build'],
              cwd: root,
              env,
            },
          ]
        : []),
    ],
    services: [
      {
        name: 'og-image',
        command: 'pnpm',
        args: wrangler(
          'wrangler.og-image.jsonc',
          ports.ogImage,
          ports.ogImageInspector,
        ),
        cwd: app,
        env,
      },
      {
        name: 'sandbox',
        command: 'pnpm',
        args: wrangler(
          'wrangler.sandbox.jsonc',
          ports.sandbox,
          ports.sandboxInspector,
          [
            '--var',
            `DEV_APP_PORT:${ports.app}`,
            '--var',
            `DEV_SANDBOX_PORT:${ports.sandbox}`,
            '--var',
            `BETTER_AUTH_URL:${topology.appOrigin}`,
          ],
        ),
        cwd: app,
        env,
      },
      {
        name: 'app',
        command: 'pnpm',
        args: ['exec', 'react-router', 'dev'],
        cwd: app,
        env: {
          ...env,
          ARTIFACTSHARE_INCLUDE_DEV_ROUTES: '1',
          ARTIFACTSHARE_DEV_APP_PORT: String(ports.app),
          ARTIFACTSHARE_DEV_SANDBOX_PORT: String(ports.sandbox),
          ARTIFACTSHARE_DEV_INSPECTOR_PORT: String(ports.appInspector),
          // Vite binds one address; IPv4 reaches it through the relay.
          ARTIFACTSHARE_DEV_HOST: '::1',
        },
      },
    ],
    capture: {
      name: 'capture',
      command: process.execPath,
      args: [join(root, spec.launcher), ...argv],
      cwd: root,
      env: {
        ...env,
        SCREEN_CAPTURE_BASE_URL: topology.appOrigin,
        SCREEN_CAPTURE_SANDBOX_URL: topology.sandboxOrigin,
      },
      stdio: 'inherit',
    },
  }
}

/** `ps` rows for every process, used to find descendants of owned children. */
export function processTable(run = execFileSync) {
  return run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 4)
    .map(([pid, ppid, pgid, stat]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: stat.startsWith('Z'),
    }))
}

const OWNER_TAG = 'LOCAL_CAPTURE_OWNER'
const VANISHED = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])

/**
 * Processes whose environment contains `entry` (`NAME=value`). An owned child
 * passes its environment to every descendant, so this still finds a
 * descendant after its parent exited and it was reparented to another group.
 */
export function processesWithEnvironment(
  entry,
  { platform = process.platform, run = execFileSync } = {},
) {
  if (platform === 'linux') {
    const pids = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/u.test(name)) continue
      try {
        if (
          readFileSync(`/proc/${name}/environ`, 'utf8')
            .split('\0')
            .includes(entry)
        )
          pids.push(Number(name))
      } catch (error) {
        // The process exited or belongs to another user since the listing.
        if (!VANISHED.has(error?.code)) throw error
      }
    }
    return pids
  }
  return run('ps', ['-E', '-A', '-ww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.slice(1).includes(entry))
    .map((fields) => Number(fields[0]))
}

function appendTail(buffer, chunk) {
  const combined = Buffer.concat([buffer, Buffer.from(chunk)])
  return combined.byteLength <= LOG_TAIL_BYTES
    ? combined
    : combined.subarray(combined.byteLength - LOG_TAIL_BYTES)
}

/**
 * Starts children in their own process groups and stops them together with
 * every descendant, including ones that left the group or ignore SIGTERM.
 */
export class OwnedProcesses {
  constructor({
    spawnProcess = spawn,
    table = processTable,
    tagged = processesWithEnvironment,
    kill = (pid, signal) => process.kill(pid, signal),
    graceMs = STOP_GRACE_MS,
    killWaitMs = KILL_WAIT_MS,
  } = {}) {
    this.spawnProcess = spawnProcess
    this.table = table
    this.tagged = tagged
    // Every child, and so every descendant, inherits this ownership tag.
    this.ownerId = randomUUID()
    this.tag = `${OWNER_TAG}=${this.ownerId}`
    this.kill = kill
    this.graceMs = graceMs
    this.killWaitMs = killWaitMs
    this.children = []
    this.known = new Set()
  }

  start({ name, command, args, cwd, env, stdio = 'pipe' }) {
    const child = this.spawnProcess(command, args, {
      cwd,
      env: { ...env, [OWNER_TAG]: this.ownerId },
      detached: true,
      stdio:
        stdio === 'inherit'
          ? ['ignore', 'inherit', 'inherit']
          : ['ignore', 'pipe', 'pipe'],
    })
    const entry = { name, child, tail: Buffer.alloc(0) }
    const keep = (chunk) => {
      entry.tail = appendTail(entry.tail, chunk)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    entry.exited = new Promise((done) => {
      child.once('error', (error) => done({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => done({ code, signal }))
    })
    if (child.pid) this.known.add(child.pid)
    this.children.push(entry)
    return entry
  }

  /** Runs one command to completion; a nonzero exit is an error. */
  async run(command) {
    const entry = this.start({ stdio: 'inherit', ...command })
    const { code, signal, error } = await entry.exited
    if (error)
      throw new Error(`${command.name} could not start: ${error.message}`)
    if (code !== 0)
      throw new Error(
        `${command.name} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`,
      )
  }

  #refresh() {
    for (const pid of this.tagged(this.tag))
      if (pid !== process.pid) this.known.add(pid)
    const rows = this.table()
    const groups = new Set(
      this.children.map(({ child }) => child.pid).filter(Boolean),
    )
    let added = true
    while (added) {
      added = false
      for (const row of rows) {
        if (this.known.has(row.pid) || row.pid === process.pid) continue
        if (groups.has(row.pgid) || this.known.has(row.ppid)) {
          this.known.add(row.pid)
          added = true
        }
      }
    }
    const live = new Set(
      rows.filter((row) => !row.zombie).map((row) => row.pid),
    )
    return [...this.known].filter((pid) => live.has(pid))
  }

  #signal(pids, signal) {
    for (const target of [
      ...this.children
        .map(({ child }) => child.pid)
        .filter(Boolean)
        .map((pid) => -pid),
      ...pids,
    ]) {
      try {
        this.kill(target, signal)
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error
      }
    }
  }

  async #waitGone(ms) {
    const deadline = Date.now() + ms
    let alive = this.#refresh()
    while (alive.length && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100))
      alive = this.#refresh()
    }
    return alive
  }

  /** SIGTERM, a grace period, then SIGKILL; throws if anything survives. */
  async stopAll() {
    let alive = this.#refresh()
    if (alive.length) {
      this.#signal(alive, 'SIGTERM')
      alive = await this.#waitGone(this.graceMs)
    }
    if (alive.length) {
      this.#signal(alive, 'SIGKILL')
      alive = await this.#waitGone(this.killWaitMs)
    }
    if (alive.length)
      throw new Error(`Owned processes survived SIGKILL: ${alive.join(', ')}`)
    // Gone from the process table; also wait until Node has reaped each
    // direct child so no zombie outlives this call.
    await Promise.all(this.children.map((entry) => entry.exited))
  }

  tails() {
    return this.children
      .filter((entry) => entry.tail.byteLength)
      .map(
        (entry) =>
          `--- ${entry.name} (last output) ---\n${entry.tail.toString('utf8')}`,
      )
      .join('\n')
  }
}

/**
 * Accepts IPv4 loopback connections on `port` and forwards the bytes to the
 * IPv6 loopback server on the same port. TLS stays end to end; this lets a
 * single-address Vite server answer on both families without a wildcard bind.
 */
export async function startLoopbackRelay(
  port,
  { listenHost = '127.0.0.1', targetHost = '::1' } = {},
) {
  const sockets = new Set()
  const server = createServer((socket) => {
    const upstream = connect({ port, host: targetHost })
    for (const item of [socket, upstream]) {
      sockets.add(item)
      item.once('close', () => sockets.delete(item))
    }
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise((done, fail) => {
    server.once('error', (error) =>
      fail(
        new Error(
          `${listenHost}:${port} was taken after it was selected (${error?.code ?? error}); rerun to choose other ports`,
          { cause: error },
        ),
      ),
    )
    server.listen({ port, host: listenHost, exclusive: true }, () => done())
  })
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
    },
  }
}

/** One HTTPS request to a loopback address, presented as `localhost:port`. */
export function loopbackRequest(
  address,
  port,
  path,
  { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS, signal } = {},
) {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: address,
        port,
        path,
        method: 'GET',
        servername: 'localhost',
        rejectUnauthorized: false,
        headers: { host: `localhost:${port}`, ...headers },
        timeout: timeoutMs,
        signal,
      },
      (response) => {
        response.setEncoding('latin1')
        let body = ''
        response.on('data', (chunk) => {
          if (body.length < 64 * 1024) body += chunk
        })
        response.on('end', () =>
          done({
            status: response.statusCode,
            contentType: response.headers['content-type'],
            body,
          }),
        )
        response.on('error', fail)
      },
    )
    req.on('timeout', () =>
      req.destroy(new Error(`no response within ${timeoutMs}ms`)),
    )
    req.on('error', fail)
    req.end()
  })
}

/**
 * Readiness of the owned stack: each service answers as itself on both
 * loopback families, the app reaches og-image through its service binding
 * (resolved through this invocation's registry), and the app serves HEAD.
 */
export function readinessChecks(ports, head, send = loopbackRequest) {
  const servicePort = {
    app: ports.app,
    sandbox: ports.sandbox,
    'og-image': ports.ogImage,
  }
  const identity = DEV_SERVICES.flatMap((service) =>
    LOOPBACK_HOSTS.map((address) => ({
      name: `${service.name} on ${address}`,
      check: async (signal) => {
        const actual = await send(
          address,
          servicePort[service.name],
          service.path,
          { headers: service.headers, signal },
        )
        if (!serviceIdentityMatches(service.expected, actual))
          throw new Error(
            `answered HTTP ${actual.status} ${actual.contentType ?? ''} instead of the ${service.name} service`,
          )
      },
    })),
  )
  return [
    ...identity,
    {
      name: 'og-image service binding',
      check: async (signal) => {
        const actual = await send('::1', ports.app, '/og-image', { signal })
        if (actual.status !== 200 || !actual.contentType?.startsWith('image/'))
          throw new Error(
            `/og-image answered HTTP ${actual.status} ${actual.contentType ?? ''}`,
          )
      },
    },
    {
      name: 'app revision',
      check: async (signal) => {
        const actual = await send(
          '::1',
          ports.app,
          '/__screen_capture_revision',
          { signal },
        )
        const body = JSON.parse(actual.body)
        if (body?.head !== head || body?.clean !== true)
          throw new Error(
            `app serves ${body?.head ?? 'unknown'} (clean: ${body?.clean}), expected clean ${head}`,
          )
      },
    },
  ]
}

/**
 * Polls every check until all pass, within one absolute deadline. Each check
 * receives a signal that aborts its in-flight request at the deadline (or on
 * cancellation); a check still running then counts as not ready, and a pass
 * that completes after the deadline is not success.
 */
export async function waitUntilReady({
  checks,
  timeoutMs,
  intervalMs = 1_000,
  signal,
}) {
  const attempt = new AbortController()
  let timedOut = false
  let stop
  const stopped = new Promise((done) => {
    stop = done
  })
  stopped.then(() => attempt.abort())
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  // True when `work` finished before the wait stopped.
  const beforeStop = (work) =>
    Promise.race([work.then(() => true), stopped.then(() => false)])
  const pending = new Map(checks.map((item) => [item.name, 'not checked yet']))
  try {
    for (;;) {
      for (const item of checks) {
        if (!pending.has(item.name) || attempt.signal.aborted) continue
        try {
          const run = Promise.resolve().then(() => item.check(attempt.signal))
          if (await beforeStop(run)) pending.delete(item.name)
          else pending.set(item.name, 'no answer before the deadline')
        } catch (error) {
          pending.set(
            item.name,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      if (signal?.aborted) throw new Error('Readiness wait cancelled')
      if (timedOut)
        throw new Error(
          `Local services were not ready within ${Math.round(timeoutMs / 1000)}s:\n${[...pending].map(([name, reason]) => `  ${name}: ${reason}`).join('\n')}`,
        )
      if (!pending.size) return
      let pause
      await beforeStop(
        new Promise((done) => {
          pause = setTimeout(done, intervalMs)
        }),
      )
      clearTimeout(pause)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    stop()
  }
}

export function readyTimeout(env = process.env) {
  const value = env.LOCAL_CAPTURE_READY_TIMEOUT_MS
  if (value === undefined || value === '') return DEFAULT_READY_TIMEOUT_MS
  if (!/^\d+$/u.test(value) || Number(value) < 1)
    throw new Error(
      `LOCAL_CAPTURE_READY_TIMEOUT_MS must be a positive number of milliseconds, got ${value}`,
    )
  return Number(value)
}

class Interrupted extends Error {
  constructor(signal) {
    super(`Interrupted by ${signal}; stopping local services`)
    this.signal = signal
  }
}

/**
 * The whole lifecycle. Returns the exit status; it never resolves before
 * every owned process is gone and the runtime directory is removed.
 */
export async function runLocalCapture({
  mode,
  argv,
  env = process.env,
  signals = process,
  log = (line) => process.stderr.write(`${line}\n`),
  deps = {},
}) {
  const {
    head = () => cleanCaptureHead(),
    select = () => selectPorts({ env }),
    runtimeRoot = () => createRuntimeRoot(),
    commands = localCaptureCommands,
    owner = new OwnedProcesses(),
    relay = startLoopbackRelay,
    checks = readinessChecks,
    readyTimeoutMs,
  } = deps
  const stopped = new AbortController()
  let interrupted = null
  let wake = () => {}
  const aborted = new Promise((_, fail) => {
    wake = (signal) => fail(new Interrupted(signal))
  })
  aborted.catch(() => {})
  // Installed before any owned work. A repeated signal only reports that
  // teardown is still running; it never skips it.
  const onSignal = (signal) => {
    if (interrupted) {
      log(`${signal} received again; still stopping local services`)
      return
    }
    interrupted = signal
    log(`${signal} received; stopping local services`)
    wake(signal)
  }
  const onInt = () => onSignal('SIGINT')
  const onTerm = () => onSignal('SIGTERM')
  signals.on('SIGINT', onInt)
  signals.on('SIGTERM', onTerm)
  const step = (promise) => Promise.race([promise, aborted])

  let status = 1
  let runtime
  let relayHandle
  try {
    const forwarded = parseLocalCaptureArgs(mode, argv)
    const timeoutMs = readyTimeoutMs ?? readyTimeout(env)
    const revision = head()
    runtime = runtimeRoot()
    const ports = await step(select())
    const childEnv = ownedEnvironment(env, runtime)
    const topology = localTopology(ports)
    const plan = commands({
      mode,
      argv: forwarded,
      ports,
      runtime,
      env: childEnv,
    })
    log(
      `local capture: app ${topology.appOrigin}, sandbox ${topology.sandboxOrigin}, og-image ${topology.ogImageOrigin}; runtime ${runtime.root}`,
    )
    for (const command of plan.setup) {
      log(`local capture: ${command.name}`)
      await step(owner.run(command))
    }
    relayHandle = await step(relay(ports.app))
    const services = plan.services.map((command) => owner.start(command))
    const serviceExit = Promise.race(
      services.map(async (entry) => {
        const { code, signal, error } = await entry.exited
        throw new Error(
          `${entry.name} dev server ${error ? `could not start: ${error.message}` : `exited (${signal ? `signal ${signal}` : `code ${code}`})`}`,
        )
      }),
    )
    serviceExit.catch(() => {})
    log('local capture: waiting for the app, sandbox and og-image services')
    await step(
      Promise.race([
        waitUntilReady({
          checks: checks(ports, revision),
          timeoutMs,
          signal: stopped.signal,
        }),
        serviceExit,
      ]),
    )
    log('local capture: services ready; starting the capture')
    const capture = owner.start(plan.capture)
    const result = await step(
      Promise.race([
        capture.exited,
        serviceExit.then(
          () => {},
          (error) => {
            throw new Error(`${error.message} during capture`)
          },
        ),
      ]),
    )
    if (result.error)
      throw new Error(`capture could not start: ${result.error.message}`)
    status = result.code === 0 ? 0 : 1
    if (status !== 0)
      log(
        `local capture: capture failed (${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`})`,
      )
  } catch (error) {
    status = 1
    if (!(error instanceof Interrupted)) {
      log(error instanceof Error ? error.message : String(error))
      const tails = owner.tails()
      if (tails) log(tails)
    }
  } finally {
    stopped.abort()
    try {
      await owner.stopAll()
    } catch (error) {
      status = 1
      log(
        `local capture cleanup failed: ${error instanceof Error ? error.message : error}`,
      )
    }
    try {
      await relayHandle?.close()
    } catch (error) {
      status = 1
      log(
        `local capture cleanup failed: ${error instanceof Error ? error.message : error}`,
      )
    }
    if (runtime)
      try {
        rmSync(runtime.root, { recursive: true, force: true })
      } catch (error) {
        status = 1
        log(
          `local capture could not remove ${runtime.root}: ${error instanceof Error ? error.message : error}`,
        )
      }
    signals.off('SIGINT', onInt)
    signals.off('SIGTERM', onTerm)
  }
  if (interrupted) return interrupted === 'SIGINT' ? 130 : 143
  return status
}

/** The `prepare` step: dev-setup inputs, private D1 schema, fixtures. */
export function runPrepareStep(env = process.env) {
  const { persistTo } = JSON.parse(env.LOCAL_CAPTURE_PREPARE ?? '{}')
  if (!persistTo) throw new Error('LOCAL_CAPTURE_PREPARE needs persistTo')
  return prepareDevEnvironment({
    persistTo,
    env,
    fixtures: true,
    requireFixtures: true,
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, ...argv] = process.argv.slice(2)
  if (mode === 'prepare') {
    const result = runPrepareStep()
    if (result.ok) result.actions.forEach((action) => console.log(action))
    else {
      console.error(result.reason)
      if (result.recoveryCommand)
        console.error(`Run: ${result.recoveryCommand}`)
      process.exitCode = 1
    }
  } else {
    process.exitCode = await runLocalCapture({ mode, argv })
  }
}

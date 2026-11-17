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
  constants,
  copyFileSync,
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
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { parseDevPort } from '../apps/web/app/lib/hosts.ts'
import {
  certificateSupportsDevelopmentHosts,
  DEV_SERVICES,
  prepareDevEnvironment,
  serviceIdentityMatches,
} from './dev-setup.mjs'
import { assertSafeCaptureOutput } from './screen-capture-output.mjs'

// The capture modules are loaded only by the lifecycle in the checkout, not
// by the `prepare` setup step that loads this module in the
// export, which do not need them.
const screenCapture = () => import('./screen-capture.mjs')
const walkthroughCapture = () => import('./task-walkthrough-capture.mjs')

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
    parse: async (argv) => (await screenCapture()).parseArgs(argv),
    needsCli: false,
  },
  walkthroughs: {
    command: 'pnpm walkthroughs:capture:local',
    launcher: 'scripts/run-task-walkthroughs.mjs',
    parse: async (argv) =>
      (await walkthroughCapture()).parseWalkthroughArgs(argv),
    needsCli: true,
  },
}

/** Validates the forwarded selection with the capture's own parser. */
export async function parseLocalCaptureArgs(mode, argv) {
  const spec = LOCAL_CAPTURE_MODES[mode]
  if (!spec)
    throw new Error(
      `Usage: node scripts/local-capture.mjs <${Object.keys(LOCAL_CAPTURE_MODES).join('|')}> -- <capture options>`,
    )
  // Only the separator pnpm passes first is dropped; later arguments are
  // forwarded to the capture command unchanged.
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  await spec.parse(forwarded)
  return forwarded
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
    const port = parseDevPort(setting, env[setting])
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
 * registry, D1/R2 persistence, logs, caches and any generated input
 * (certificate, `.dev.vars`, CLI build) of this invocation only.
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
      certs: join(root, 'certs'),
      vars: join(root, 'dev.vars'),
      // The export of HEAD the setup steps and services run from.
      source: join(root, 'source'),
    }
    for (const dir of [runtime.registry, runtime.persist, runtime.logs])
      mkdirSync(dir)
    return runtime
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Where the owned stack reads its certificate and variables. A usable checkout
 * certificate a developer's `pnpm dev` also reads is used read-only; a missing
 * or obsolete one is generated in the runtime directory instead. The
 * checkout's `.dev.vars` is copied into the runtime directory, and every step
 * reads and completes only that copy, so no step is ever handed a checkout
 * path it could create or rewrite (even if the file disappears meanwhile).
 */
export function localInputs({
  root = ROOT,
  runtime,
  certificateValid = certificateSupportsDevelopmentHosts,
}) {
  const certs = join(root, '.dev-certs')
  const usableCerts =
    existsSync(join(certs, 'key.pem')) &&
    existsSync(join(certs, 'cert.pem')) &&
    certificateValid(readFileSync(join(certs, 'cert.pem')))
  const vars = join(root, '.dev.vars')
  let copiedFrom = null
  try {
    copyFileSync(vars, runtime.vars, constants.COPYFILE_EXCL)
    copiedFrom = vars
  } catch (error) {
    // No checkout variables: prepare creates them in the runtime directory.
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    certs: usableCerts
      ? { dir: certs, generate: false }
      : { dir: runtime.certs, generate: true },
    vars: { path: runtime.vars, copiedFrom },
  }
}

// Inherited values that would point a child at another stack's URL,
// registry, persistence, logs, caches or CLI build. They are dropped and
// replaced below.
const INHERITED_TOPOLOGY =
  /^(?:SCREEN_CAPTURE_BASE_URL|SCREEN_CAPTURE_SANDBOX_URL|WALKTHROUGH_CLI_ENTRY|CLOUDFLARE_DEV_REGISTRY_PATH|WRANGLER_REGISTRY_PATH|WRANGLER_LOG_PATH|WRANGLER_CONFIG_PATH|WRANGLER_CACHE_DIR|MINIFLARE_CACHE_DIR|CLOUDFLARE_CF_FETCH_[A-Z0-9_]+|ARTIFACTSHARE_DEV_[A-Z0-9_]+|LOCAL_CAPTURE_[A-Z0-9_]+)$/u

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

/**
 * The package store the checkout was installed from (recorded by pnpm in
 * `node_modules/.modules.yaml`). The export installs from it offline.
 */
export function checkoutStoreDir(root = ROOT) {
  const state = join(root, 'node_modules/.modules.yaml')
  const storeDir = existsSync(state)
    ? parseYaml(readFileSync(state, 'utf8'))?.storeDir
    : undefined
  if (!storeDir)
    throw new Error(
      `${state} names no package store; run pnpm install in the checkout first`,
    )
  return storeDir
}

/**
 * The environment of the export's dependency install. Inherited Git variables
 * are dropped and Git may not search above the export, so a lifecycle script
 * that asks Git (hook installers) finds no repository: the export has no Git
 * metadata of its own, and a temporary directory inside some other repository
 * must not lead it there.
 */
export function installEnvironment(env, source) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    GIT_CEILING_DIRECTORIES: dirname(source),
  }
}

/** Every process this invocation starts, with its arguments and environment. */
export function localCaptureCommands({
  mode,
  argv,
  ports,
  runtime,
  env,
  inputs,
  revision,
  storeDir,
  root = ROOT,
}) {
  const spec = LOCAL_CAPTURE_MODES[mode]
  // Setup steps and services run from the export of HEAD with its own
  // dependency install, never the checkout; only the capture itself (which
  // writes nothing beside its sources) runs from the checkout.
  const source = runtime.source
  const sourceScript = join(source, 'scripts/local-capture.mjs')
  const app = join(source, 'apps/web')
  const node = (entry, args) => [join(app, 'node_modules', entry), ...args]
  const certs = inputs.certs.dir
  const topology = localTopology(ports)
  const tls = [
    '--local-protocol',
    'https',
    '--https-key-path',
    join(certs, 'key.pem'),
    '--https-cert-path',
    join(certs, 'cert.pem'),
  ]
  const wrangler = (config, port, inspectorPort, extra = []) =>
    node('wrangler/bin/wrangler.js', [
      'dev',
      '-c',
      config,
      '--env-file',
      inputs.vars.path,
      '--port',
      String(port),
      '--inspector-port',
      String(inspectorPort),
      '--persist-to',
      runtime.persist,
      ...tls,
      ...extra,
    ])
  return {
    // The services read @artifactshare/contract from its sources (Vite alias
    // and tsconfig paths), so no `packages/contract/dist` is built.
    setup: [
      {
        name: 'source export',
        command: process.execPath,
        args: [SELF, 'export-source', source, revision],
        cwd: root,
        env,
      },
      // Every dependency link then resolves inside the export, and pnpm's
      // own dependency check is satisfied there. Offline, from the store the
      // checkout was installed from: nothing is downloaded, and nothing is
      // written in the checkout.
      {
        name: 'dependency install',
        command: 'pnpm',
        args: [
          'install',
          '--frozen-lockfile',
          '--offline',
          '--store-dir',
          storeDir,
        ],
        cwd: source,
        env: installEnvironment(env, source),
      },
      {
        name: 'prepare',
        command: process.execPath,
        args: [sourceScript, 'prepare'],
        cwd: source,
        env: {
          ...env,
          LOCAL_CAPTURE_PREPARE: JSON.stringify({
            persistTo: runtime.persist,
            certs: inputs.certs.generate ? inputs.certs.dir : null,
            vars: inputs.vars.path,
          }),
        },
      },
      // Built for the current HEAD on every walkthrough run, in the export:
      // the checkout's `packages/cli/dist` may be from an earlier HEAD.
      ...(spec.needsCli
        ? [
            {
              name: 'cli build',
              command: 'pnpm',
              args: ['--filter', '@artifactshare/cli', 'build'],
              cwd: source,
              env,
            },
          ]
        : []),
    ],
    services: [
      {
        name: 'og-image',
        command: process.execPath,
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
        command: process.execPath,
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
        command: process.execPath,
        args: node('@react-router/dev/bin.cjs', ['dev']),
        cwd: app,
        env: {
          ...env,
          ARTIFACTSHARE_INCLUDE_DEV_ROUTES: '1',
          // Revision checks ask the checkout; the export has no Git metadata.
          ARTIFACTSHARE_DEV_GIT_ROOT: root,
          ARTIFACTSHARE_DEV_APP_PORT: String(ports.app),
          ARTIFACTSHARE_DEV_SANDBOX_PORT: String(ports.sandbox),
          ARTIFACTSHARE_DEV_INSPECTOR_PORT: String(ports.appInspector),
          // Vite binds one address; IPv4 reaches it through the relay.
          ARTIFACTSHARE_DEV_HOST: '::1',
          ARTIFACTSHARE_DEV_CERT_DIR: certs,
          ARTIFACTSHARE_DEV_VARS_PATH: inputs.vars.path,
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
        ...(spec.needsCli
          ? {
              WALKTHROUGH_CLI_ENTRY: join(source, 'packages/cli/dist/index.js'),
            }
          : {}),
      },
      stdio: 'inherit',
    },
  }
}

/**
 * `ps` rows for every process, or only for `pids`; used to find descendants
 * of owned children and to check that a tracked PID still exists.
 */
export function processTable(run = execFileSync, pids) {
  if (pids && !pids.length) return []
  let output
  try {
    output = run(
      'ps',
      [
        ...(pids ? ['-p', pids.join(',')] : ['-A']),
        '-o',
        'pid=,ppid=,pgid=,stat=',
      ],
      { encoding: 'utf8' },
    )
  } catch (error) {
    // `ps -p` exits 1 when none of the PIDs exists any more.
    if (pids && error?.status === 1) return []
    throw error
  }
  return output
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
 *
 * A PID is signalled only while it can be proven to be owned: a direct child
 * Node has not reaped yet (its number cannot be reused), a process whose
 * environment carries this invocation's tag, or a live descendant of such a
 * process. Exited PIDs and empty groups are dropped on every refresh, and
 * ownership is read again right before each individual signal, because any
 * earlier signal can end an owned process whose number is then reused.
 */
export class OwnedProcesses {
  constructor({
    spawnProcess = spawn,
    table = (pids) => processTable(execFileSync, pids),
    tagged = processesWithEnvironment,
    kill = (pid, signal) => process.kill(pid, signal),
    graceMs = STOP_GRACE_MS,
    killWaitMs = KILL_WAIT_MS,
    pollMs = 100,
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
    this.pollMs = pollMs
    this.children = []
    this.known = new Set()
    this.unproven = new Set()
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
    const entry = { name, child, tail: Buffer.alloc(0), reaped: false }
    const keep = (chunk) => {
      entry.tail = appendTail(entry.tail, chunk)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    entry.exited = new Promise((done) => {
      child.once('error', (error) => {
        entry.reaped = true
        done({ code: null, signal: null, error })
      })
      // Node has reaped the child: from now on its number may be reused, so
      // it is no longer tracked as owned.
      child.once('exit', (code, signal) => {
        entry.reaped = true
        this.known.delete(child.pid)
        done({ code, signal })
      })
    })
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

  /** Direct children Node has not reaped: their PIDs cannot have been reused. */
  #unreaped() {
    return this.children
      .filter((entry) => !entry.reaped && entry.child.pid)
      .map((entry) => entry.child.pid)
  }

  /**
   * Full refresh (environment scan and whole process table), run at the start
   * and end of each grace period. Rebuilds the owned set from proof alone, so
   * an exited PID or a group whose leader was reaped drops out.
   */
  #scan() {
    const live = new Map(
      this.table()
        .filter((row) => !row.zombie && row.pid !== process.pid)
        .map((row) => [row.pid, row]),
    )
    const groups = new Set(this.#unreaped())
    const owned = new Set(
      [...groups, ...this.tagged(this.tag)].filter((pid) => live.has(pid)),
    )
    let added = true
    while (added) {
      added = false
      for (const row of live.values()) {
        if (owned.has(row.pid)) continue
        if (owned.has(row.ppid) || groups.has(row.pgid)) {
          owned.add(row.pid)
          added = true
        }
      }
    }
    // A tracked process that is still running but can no longer be proved
    // ours is kept for the report, never signalled.
    for (const pid of this.known)
      if (!owned.has(pid) && live.has(pid)) this.unproven.add(pid)
    for (const pid of this.unproven)
      if (!live.has(pid)) this.unproven.delete(pid)
    this.known = owned
    return [...owned]
  }

  /**
   * Between full scans: only checks that the tracked PIDs (and the unproven
   * ones awaiting their report) still exist.
   */
  #poll() {
    const live = new Set(
      this.table([...this.known, ...this.unproven])
        .filter((row) => !row.zombie)
        .map((row) => row.pid),
    )
    for (const set of [this.known, this.unproven])
      for (const pid of set) if (!live.has(pid)) set.delete(pid)
    return [...this.known]
  }

  /**
   * Fresh proof of ownership for one PID, read right before it is signalled:
   * one read of the process table and one of the ownership tags, then the
   * ancestors are walked in memory. A PID is owned while it is an unreaped
   * child, carries the tag, or has a live ancestor that does.
   */
  #ownedNow(pid) {
    const unreaped = new Set(this.#unreaped())
    const live = new Map(
      this.table()
        .filter((row) => !row.zombie)
        .map((row) => [row.pid, row]),
    )
    const own = live.get(pid)
    if (!own) return { owned: false, alive: false }
    const tagged = new Set(this.tagged(this.tag))
    const unproven = { owned: false, alive: true }
    const seen = new Set()
    for (let row = own; row && !seen.has(row.pid); row = live.get(row.ppid)) {
      seen.add(row.pid)
      if (unreaped.has(row.pid)) return { owned: true, row: own }
      if (row.pid === process.pid) return unproven
      if (tagged.has(row.pid)) return { owned: true, row: own }
      if (row.ppid <= 1) return unproven
    }
    return unproven
  }

  #send(target, signal) {
    try {
      this.kill(target, signal)
    } catch (error) {
      if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error
    }
  }

  #signal(signal) {
    // A group is signalled only while its leader is unreaped: then the group
    // ID is still this invocation's. Members that left it (or whose leader
    // was reaped) are signalled one by one, each after a fresh ownership
    // read: any earlier signal can end an owned process whose number is then
    // reused.
    const groups = this.#unreaped()
    for (const pgid of groups) this.#send(-pgid, signal)
    // One read of the tracked PIDs finds the members of the owned groups,
    // which the group signal above already reached and which therefore need
    // no individual signal or proof; only the rest are proved one by one.
    const tracked = new Map(
      this.table([...this.known])
        .filter((row) => !row.zombie)
        .map((row) => [row.pid, row]),
    )
    // Deleting the current entry while iterating a Set is safe.
    for (const pid of this.known) {
      if (groups.includes(pid)) continue
      const current = tracked.get(pid)
      if (!current) {
        this.known.delete(pid)
        continue
      }
      if (groups.includes(current.pgid)) continue
      const { owned, alive, row } = this.#ownedNow(pid)
      if (!owned) {
        this.known.delete(pid)
        if (alive) this.unproven.add(pid)
        continue
      }
      // Already reached through its owned group above.
      if (groups.includes(row.pgid)) continue
      this.#send(pid, signal)
    }
  }

  async #waitGone(ms) {
    const deadline = Date.now() + ms
    let alive = this.#poll()
    while ((alive.length || this.unproven.size) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, this.pollMs))
      alive = this.#poll()
    }
    return this.#scan()
  }

  /**
   * SIGTERM, a grace period, then SIGKILL. Throws if an owned process
   * survives, or if a process this run tracked is still running but could no
   * longer be proved its own (its PID may have been reused): such a process
   * is reported, never signalled.
   */
  async stopAll() {
    let alive = this.#scan()
    if (alive.length) {
      this.#signal('SIGTERM')
      alive = await this.#waitGone(this.graceMs)
    }
    if (alive.length) {
      this.#signal('SIGKILL')
      alive = await this.#waitGone(this.killWaitMs)
    }
    this.#poll()
    const problems = []
    if (alive.length)
      problems.push(`owned processes survived SIGKILL: ${alive.join(', ')}`)
    if (this.unproven.size)
      problems.push(
        `processes this run tracked are still running but could no longer be proved its own, so they were not signalled: ${[...this.unproven].join(', ')}`,
      )
    if (problems.length) throw new Error(problems.join('; '))
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
 * IPv6 loopback server on the same port. TLS stays end to end.
 *
 * A workaround: Vite's dev server listens on exactly one address
 * (`server.host` is a single value). Clients reach the app as `localhost`,
 * which resolves to either loopback family depending on the client (Workers
 * runtime, Node, the browser for plain `localhost`), so the app must answer on
 * both, and holding both keeps any other listener from answering a client
 * that tries 127.0.0.1 first. Vite is bound to ::1 (where the captures map
 * `*.localhost`) and this relay covers 127.0.0.1.
 * The relay does not use a wildcard bind (`::` with dual-stack, or 0.0.0.0)
 * because that would expose the private stack on every interface and would
 * accept a port whose loopback address another process already holds; an
 * exclusive loopback bind fails instead, so a lost race is reported rather
 * than answered by someone else's server.
 * Remove it when Vite can listen on several addresses, or when the app is
 * served by a server that binds both loopback families itself.
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

/**
 * One HTTPS request to a loopback address, presented as `localhost:port`.
 * The certificate is not verified: a mkcert certificate chains to a local
 * root that Node does not read, and whether that root is installed depends
 * on the machine. Each check identifies the service by its response instead.
 */
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
        const actual = await send('::1', ports.app, '/og-image', {
          signal,
        })
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
 * Polls every check until all pass, running the pending checks of each round
 * in parallel. The deadline is the contract: when `timeoutMs` elapses (or the
 * wait is cancelled) the checks still running are aborted through their
 * signal, and anything that settles after that, success included, does not
 * count; the wait fails naming every check not yet passed.
 */
export async function waitUntilReady({
  checks,
  timeoutMs,
  intervalMs = 1_000,
  signal,
}) {
  const attempt = new AbortController()
  let timedOut = false
  let wake = () => {}
  const stopped = new Promise((done) =>
    attempt.signal.addEventListener(
      'abort',
      () => {
        done()
        wake()
      },
      { once: true },
    ),
  )
  const deadline = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, timeoutMs)
  const cancel = () => attempt.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const pending = new Map(checks.map((item) => [item.name, 'not checked yet']))
  const notReady = () =>
    new Error(
      `Local services were not ready within ${Math.round(timeoutMs / 1000)}s:\n${[...pending].map(([name, reason]) => `  ${name}: ${reason}`).join('\n')}`,
    )
  try {
    for (;;) {
      const round = checks
        .filter((item) => pending.has(item.name))
        .map((item) => {
          const state = { done: false }
          // An outcome that arrives once the attempt is over is ignored.
          state.run = Promise.resolve()
            .then(() => item.check(attempt.signal))
            .then(
              () => {
                if (attempt.signal.aborted) return
                state.done = true
                pending.delete(item.name)
              },
              (error) => {
                if (attempt.signal.aborted) return
                state.done = true
                pending.set(
                  item.name,
                  error instanceof Error ? error.message : String(error),
                )
              },
            )
          return { item, state }
        })
      await Promise.race([
        Promise.all(round.map(({ state }) => state.run)),
        stopped,
      ])
      if (signal?.aborted) throw new Error('Readiness wait cancelled')
      if (timedOut) {
        for (const { item, state } of round)
          if (!state.done)
            pending.set(item.name, 'no answer before the deadline')
        throw notReady()
      }
      if (!pending.size) return
      await new Promise((done) => {
        const pause = setTimeout(done, intervalMs)
        wake = () => {
          clearTimeout(pause)
          done()
        }
      })
      wake = () => {}
      if (signal?.aborted) throw new Error('Readiness wait cancelled')
      // No new round starts after the deadline.
      if (timedOut) throw notReady()
    }
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', cancel)
    attempt.abort()
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

class Crashed extends Error {
  constructor(kind, cause) {
    super(
      `${kind} in local capture: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
    )
  }
}

const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

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
    head = async () => (await screenCapture()).cleanCaptureHead(),
    select = () => selectPorts({ env }),
    runtimeRoot = () => createRuntimeRoot(),
    inputs = (runtime) => localInputs({ runtime }),
    storeDir = () => checkoutStoreDir(),
    commands = localCaptureCommands,
    owner = new OwnedProcesses(),
    relay = startLoopbackRelay,
    checks = readinessChecks,
    readyTimeoutMs,
  } = deps
  const stopped = new AbortController()
  let interrupted = null
  let crashed = false
  let wake = () => {}
  const aborted = new Promise((_, fail) => {
    wake = fail
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
    wake(new Interrupted(signal))
  }
  // An exception nothing caught (in this lifecycle or a library it drives)
  // takes the same teardown path as a signal instead of exiting with owned
  // services still running; the process then exits by itself, nonzero.
  const onCrash = (kind) => (error) => {
    crashed = true
    const failure = new Crashed(kind, error)
    log(failure.message)
    wake(failure)
  }
  const handlers = {
    SIGINT: () => onSignal('SIGINT'),
    SIGTERM: () => onSignal('SIGTERM'),
    SIGHUP: () => onSignal('SIGHUP'),
    uncaughtException: onCrash('Uncaught exception'),
    unhandledRejection: onCrash('Unhandled rejection'),
  }
  for (const [event, handler] of Object.entries(handlers))
    signals.on(event, handler)
  const step = (promise) => Promise.race([promise, aborted])

  let status = 1
  let runtime
  let relayHandle
  try {
    const forwarded = await parseLocalCaptureArgs(mode, argv)
    const timeoutMs = readyTimeoutMs ?? readyTimeout(env)
    const revision = await head()
    runtime = runtimeRoot()
    const ports = await step(select())
    const childEnv = ownedEnvironment(env, runtime)
    const topology = localTopology(ports)
    const files = inputs(runtime)
    const plan = commands({
      mode,
      argv: forwarded,
      ports,
      runtime,
      env: childEnv,
      inputs: files,
      revision,
      storeDir: storeDir(),
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
    if (!(error instanceof Interrupted) && !(error instanceof Crashed)) {
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
    for (const [event, handler] of Object.entries(handlers))
      signals.off(event, handler)
  }
  if (interrupted) return SIGNAL_STATUS[interrupted]
  if (crashed) return 1
  return status
}

/**
 * The `prepare` step, run from the export of HEAD (`root`) after its
 * dependency install: certificate (only into the runtime directory), the
 * runtime copy of the variables, private D1 schema, and the static-site
 * fixtures, always built in the export from HEAD (the export never has any),
 * so neither the checkout's fixtures nor its builder outputs are read or
 * written. A failed build fails the step.
 */
export function runPrepareStep(
  env = process.env,
  { prepare = prepareDevEnvironment } = {},
) {
  const { persistTo, certs, vars } = JSON.parse(
    env.LOCAL_CAPTURE_PREPARE ?? '{}',
  )
  if (!persistTo || certs === undefined || !vars)
    throw new Error('LOCAL_CAPTURE_PREPARE needs persistTo, certs and vars')
  // This step runs the export's copy of the script, so Wrangler, the D1
  // state and the fixture build all resolve in the export.
  return prepare({
    persistTo,
    env,
    requireFixtures: true,
    paths: { certs, vars },
  })
}

/**
 * Exports `revision` of the checkout into `dest`; the next setup step gives it
 * its own dependency install. The owned services run from this copy, so
 * everything they generate beside their sources (React Router's
 * `.react-router/types`, Wrangler's `.wrangler/tmp`, fixture and builder
 * outputs) lands in the runtime directory instead of the checkout a
 * developer's `pnpm dev` reads.
 */
export function exportSource({
  root = ROOT,
  dest,
  revision,
  run = execFileSync,
}) {
  mkdirSync(dest, { recursive: true })
  const archive = `${dest}.tar`
  try {
    run('git', ['archive', '--format=tar', '-o', archive, revision], {
      cwd: root,
    })
    run('tar', ['-xf', archive, '-C', dest])
  } finally {
    rmSync(archive, { force: true })
  }
  return dest
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
  } else if (mode === 'export-source') {
    const [dest, revision] = argv
    if (!dest || !revision)
      throw new Error('export-source needs a destination and a revision')
    exportSource({ dest, revision })
  } else {
    process.exitCode = await runLocalCapture({ mode, argv })
  }
}

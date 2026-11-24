#!/usr/bin/env node
// Private local Artifact Share stack for verification runs.
//
//   node .claude/skills/verify-artifactshare/scripts/stack.mjs up [--run <id>]
//   node .claude/skills/verify-artifactshare/scripts/stack.mjs doctor [--run <id>]
//   node .claude/skills/verify-artifactshare/scripts/stack.mjs down [--run <id>]
//
// `up` starts the app (Vite) and the sandbox Worker on free ports with an empty
// D1/R2 state directory, waits until a dev persona can sign in, and writes
// `.verify-artifactshare/runs/<id>/run.json`. It never touches the developer's
// `pnpm dev` on 5173/5174 or the checkout's `.wrangler/state`. `down` kills only
// the process groups recorded in run.json and removes the state directory;
// the run's `evidence/` directory stays.
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')
const RUNS = join(ROOT, '.verify-artifactshare/runs')
const WEB = join(ROOT, 'apps/web')
const PERSONAS = ['free-owner', 'plus-owner', 'team-owner', 'team-member']

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--run') options.run = rest[++i]
    else throw new Error(`Unknown option: ${rest[i]}`)
  }
  return { command, options }
}

// The newest run (by startedAt) that `down` has not stopped yet.
function latestRun() {
  if (!existsSync(RUNS)) return undefined
  return readdirSync(RUNS)
    .filter((name) => existsSync(join(RUNS, name, 'run.json')))
    .map((name) => JSON.parse(readFileSync(join(RUNS, name, 'run.json'), 'utf8')))
    .filter((run) => !run.stoppedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1)?.id
}

function readRun(id) {
  const run = id ?? latestRun()
  if (!run) throw new Error('No running verification stack. Run `up` first.')
  const file = join(RUNS, run, 'run.json')
  if (!existsSync(file)) throw new Error(`No run.json for run ${run}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function freePort() {
  return new Promise((done, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

async function appFetch(url, options) {
  const { appFetch: fetchApp } = await import(
    join(ROOT, 'scripts/lib/dev-sign-in.mjs')
  )
  return fetchApp(url, '', options)
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

// `signIn` adds a session row, so only `up` asks for it; `doctor` stays read-only.
async function probe(run, { signIn = false } = {}) {
  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })
  for (const [name, pid] of Object.entries(run.pids))
    record(`${name} process group ${pid}`, groupAlive(pid))
  try {
    const response = await appFetch(`${run.appOrigin}/dev/sign-in`)
    const body = await response.text()
    record(
      `app ${run.appOrigin}/dev/sign-in`,
      response.status === 200 && body.includes('Local dev sign-in'),
      `HTTP ${response.status}`,
    )
  } catch (error) {
    record(`app ${run.appOrigin}/dev/sign-in`, false, error.message)
  }
  try {
    const response = await appFetch(`${run.sandboxOrigin}/`, {
      headers: {
        'mf-original-hostname':
          'a-probe00000--v-70726f6265.usercontent.localhost',
      },
    })
    const body = await response.text()
    record(
      `sandbox ${run.sandboxOrigin}`,
      response.status === 401 && body.includes('Invalid token'),
      `HTTP ${response.status}`,
    )
  } catch (error) {
    record(`sandbox ${run.sandboxOrigin}`, false, error.message)
  }
  try {
    // Which commit the dev server started from, and whether the source moved
    // since (Vite still serves the edited files; this is information only).
    const response = await appFetch(
      `${run.appOrigin}/__screen_capture_revision`,
    )
    const revision = await response.json()
    checks.push({
      name: 'source revision',
      ok: true,
      info: true,
      detail: `${revision.head.slice(0, 12)} ${revision.clean ? 'clean' : 'changed since start'}`,
    })
  } catch {}
  if (signIn) await probeSignIn(run, record)
  return checks
}

async function probeSignIn(run, record) {
  try {
    const { cookiesFromHeaders, cookieHeader } = await import(
      join(ROOT, 'scripts/lib/dev-sign-in.mjs')
    )
    const response = await appFetch(`${run.appOrigin}/api/auth/dev/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona: 'free-owner' }),
    })
    const cookies = cookiesFromHeaders(response.headers)
    const session = await appFetch(`${run.appOrigin}/api/auth/get-session`, {
      headers: { Cookie: cookieHeader(cookies) },
    })
    const body = await session.json().catch(() => null)
    record(
      'dev persona session',
      session.ok && Boolean(body?.user),
      body?.user?.email ?? `HTTP ${session.status}`,
    )
  } catch (error) {
    record('dev persona session', false, error.message)
  }
}

function printChecks(run, checks) {
  console.log(`run ${run.id}  app ${run.appOrigin}  sandbox ${run.sandboxOrigin}`)
  console.log(`state ${run.stateDir}`)
  console.log(`evidence ${run.evidenceDir}`)
  for (const check of checks)
    console.log(
      `${check.info ? 'info' : check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? `  (${check.detail})` : ''}`,
    )
}

async function up(options) {
  const id = options.run ?? new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(RUNS, id)
  if (existsSync(join(runDir, 'run.json')))
    throw new Error(`Run ${id} already exists. Use another --run id.`)
  const stateDir = join(runDir, 'state')
  const evidenceDir = join(runDir, 'evidence')
  const logDir = join(runDir, 'logs')
  for (const dir of [stateDir, evidenceDir, logDir])
    mkdirSync(dir, { recursive: true })

  // Certificates and the checkout .dev.vars, then the schema into our own
  // state directory (app and sandbox share it, as they share one D1 in dev).
  const { prepareDevEnvironment } = await import(
    join(ROOT, 'scripts/dev-setup.mjs')
  )
  const prepared = prepareDevEnvironment({
    reset: false,
    fixtures: false,
    persistTo: stateDir,
  })
  if (!prepared.ok)
    throw new Error(
      `Dev setup failed: ${prepared.reason}. Recovery: ${prepared.recoveryCommand}`,
    )

  const appPort = await freePort()
  const sandboxPort = await freePort()
  const appOrigin = `https://localhost:${appPort}`
  const sandboxOrigin = `https://localhost:${sandboxPort}`

  // The sandbox reads its URLs from vars; give it a copy of .dev.vars that
  // points at this run's ports instead of 5173/5174.
  const varsPath = join(runDir, 'dev.vars')
  const baseVars = readFileSync(join(ROOT, '.dev.vars'), 'utf8')
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^(BETTER_AUTH_URL|DEV_APP_PORT|DEV_SANDBOX_PORT)=/u.test(line),
    )
  writeFileSync(
    varsPath,
    [
      ...baseVars,
      `BETTER_AUTH_URL=${appOrigin}`,
      `DEV_APP_PORT=${appPort}`,
      `DEV_SANDBOX_PORT=${sandboxPort}`,
      '',
    ].join('\n'),
  )

  const start = (name, command, args, env) => {
    const log = openSync(join(logDir, `${name}.log`), 'a')
    const child = spawn(command, args, {
      cwd: WEB,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, WRANGLER_LOG_PATH: join(logDir, 'wrangler'), ...env },
    })
    child.unref()
    return child.pid
  }
  const pids = {
    app: start('app', 'pnpm', ['dev:app'], {
      ARTIFACTSHARE_DEV_PERSIST_PATH: stateDir,
      ARTIFACTSHARE_DEV_APP_PORT: String(appPort),
      ARTIFACTSHARE_DEV_SANDBOX_PORT: String(sandboxPort),
      ARTIFACTSHARE_DEV_VARS_PATH: varsPath,
      ARTIFACTSHARE_DEV_INSPECTOR_PORT: String(await freePort()),
    }),
    sandbox: start('sandbox', 'pnpm', [
      'exec',
      'wrangler',
      'dev',
      '-c',
      'wrangler.sandbox.jsonc',
      '--env-file',
      varsPath,
      '--port',
      String(sandboxPort),
      '--persist-to',
      stateDir,
      '--local-protocol',
      'https',
      '--https-key-path',
      join(ROOT, '.dev-certs/key.pem'),
      '--https-cert-path',
      join(ROOT, '.dev-certs/cert.pem'),
      '--inspector-port',
      '0',
    ]),
  }
  const run = {
    id,
    root: ROOT,
    runDir,
    stateDir,
    evidenceDir,
    logDir,
    appOrigin,
    sandboxOrigin,
    pids,
    personas: PERSONAS,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)

  const deadline = Date.now() + 180_000
  let checks = []
  while (Date.now() < deadline) {
    checks = await probe(run, { signIn: true })
    if (checks.every((check) => check.ok)) break
    if (!Object.values(pids).every(groupAlive)) break
    await sleep(2000)
  }
  printChecks(run, checks)
  if (!checks.every((check) => check.ok)) {
    console.error(
      `Stack did not become ready. Logs: ${logDir}. Run \`down --run ${id}\`.`,
    )
    process.exitCode = 1
    return
  }
  console.log(`READY ${id}`)
}

async function doctor(options) {
  const run = readRun(options.run)
  const checks = await probe(run)
  printChecks(run, checks)
  if (!checks.every((check) => check.ok)) process.exitCode = 1
}

async function down(options) {
  const run = readRun(options.run)
  for (const [name, pid] of Object.entries(run.pids)) {
    if (!groupAlive(pid)) continue
    process.kill(-pid, 'SIGTERM')
    const deadline = Date.now() + 15_000
    while (groupAlive(pid) && Date.now() < deadline) await sleep(250)
    if (groupAlive(pid)) process.kill(-pid, 'SIGKILL')
    console.log(`stopped ${name} (process group ${pid})`)
  }
  rmSync(run.stateDir, { recursive: true, force: true })
  rmSync(join(run.runDir, 'dev.vars'), { force: true })
  writeFileSync(
    join(run.runDir, 'run.json'),
    `${JSON.stringify({ ...run, stoppedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  console.log(`removed ${run.stateDir}; kept ${run.evidenceDir} and ${run.logDir}`)
}

const { command, options } = parseArgs(process.argv.slice(2))
const commands = { up, doctor, down }
if (!commands[command]) {
  console.error('Usage: stack.mjs <up|doctor|down> [--run <id>]')
  process.exit(1)
}
try {
  await commands[command](options)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

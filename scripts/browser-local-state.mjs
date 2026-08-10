import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { appFetch } from './lib/dev-sign-in.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const baseUrl = process.env.APP_BASE_URL ?? 'https://localhost:5173'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForServer(server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode != null)
      throw new Error(
        `Dev server exited before readiness (code ${server.exitCode})`,
      )
    try {
      if ((await appFetch(baseUrl, '/dev/sign-in')).ok) return
    } catch {}
    await sleep(1000)
  }
  throw new Error('Dev server did not become ready within 120 seconds')
}

function waitForExit(server, timeoutMs) {
  if (server.exitCode != null || server.signalCode != null)
    return Promise.resolve()
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Dev server did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      server.off('exit', onExit)
    }
    const onExit = () => {
      cleanup()
      done()
    }
    server.once('exit', onExit)
  })
}

async function stopServer(server) {
  if (!server?.pid || server.exitCode != null || server.signalCode != null)
    return
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
    return
  }
  try {
    await waitForExit(server, 10_000)
  } catch {
    try {
      process.kill(-server.pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
      return
    }
    await waitForExit(server, 5_000)
  }
}

function runCheck(script) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, APP_BASE_URL: baseUrl },
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) done()
      else
        reject(
          new Error(
            `${script} failed (${signal ? `signal ${signal}` : `exit code ${code}`})`,
          ),
        )
    })
  })
}

async function main() {
  let server = null
  const isolatedState = await mkdtemp(
    join(tmpdir(), 'artifactshare-browser-local-state-'),
  )
  try {
    const { prepareDevEnvironment } = await import('./dev-setup.mjs')
    const prepared = prepareDevEnvironment({
      reset: false,
      persistTo: isolatedState,
    })
    if (!prepared.ok) throw new Error(`Dev setup failed: ${prepared.reason}`)
    server = spawn('pnpm', ['--filter', '@artifactshare/web', 'dev:app'], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
      env: {
        ...process.env,
        ARTIFACTSHARE_DEV_PERSIST_PATH: isolatedState,
      },
    })
    await waitForServer(server)

    // Keep the anonymous route proof ahead of the navigation proof, which
    // seeds an authenticated persona into this otherwise shared local state.
    await runCheck('scripts/scenario-route-integration.mjs')
    await runCheck('scripts/in-app-navigation.mjs')
  } finally {
    await stopServer(server)
    await rm(isolatedState, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

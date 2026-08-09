import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appFetch } from './lib/dev-sign-in.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const baseUrl = process.env.APP_BASE_URL ?? 'https://localhost:5173'
const require = createRequire(resolve(ROOT, 'apps/web/package.json'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const scenarios = {
  'landing-default': ['main', 'hero', 'footer'],
  'viewer-default': ['main'],
}

async function waitForServer(server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null)
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

function validateServerRenderedShell(html, scenario, requiredRegions) {
  const mainCount = html.match(/<main(?:\s|>)/gu)?.length ?? 0
  if (mainCount !== 1)
    throw new Error(
      `${scenario}: server render expected exactly one main, found ${mainCount}`,
    )
  for (const region of requiredRegions)
    if (!html.includes(`data-regression-region="${region}"`))
      throw new Error(`${scenario}: server render omitted region ${region}`)
}

export async function main() {
  let server = null
  let ownsServer = false
  let browser = null
  let isolatedState = null
  try {
    try {
      if (!(await appFetch(baseUrl, '/dev/sign-in')).ok)
        throw new Error('not ready')
    } catch {
      const { prepareDevEnvironment } = await import('./dev-setup.mjs')
      isolatedState = await mkdtemp(join(tmpdir(), 'artifactshare-routes-'))
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
      ownsServer = true
      await waitForServer(server)
    }

    const { chromium } = require('playwright')
    browser = await chromium.launch(
      process.env.PLAYWRIGHT_CHANNEL
        ? { channel: process.env.PLAYWRIGHT_CHANNEL }
        : undefined,
    )
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: 'en',
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 900 },
    })
    try {
      // A clean checkout may trigger Vite's one-time dependency optimizer
      // reload. Complete that transition before browser errors become test
      // evidence, as the navigation harness does for the application routes.
      const warmupPage = await context.newPage()
      await warmupPage.goto(
        new URL(
          '/dev/scenarios/landing-default?theme=light',
          baseUrl,
        ).toString(),
        { waitUntil: 'networkidle' },
      )
      await warmupPage.locator('main').waitFor()
      await warmupPage.close()

      for (const [scenario, requiredRegions] of Object.entries(scenarios)) {
        const path = `/dev/scenarios/${scenario}?theme=light`
        const serverResponse = await appFetch(baseUrl, path)
        if (!serverResponse.ok)
          throw new Error(
            `${scenario}: route returned HTTP ${serverResponse.status}`,
          )
        validateServerRenderedShell(
          await serverResponse.text(),
          scenario,
          requiredRegions,
        )

        const page = await context.newPage()
        const errors = []
        page.on('console', (message) => {
          if (message.type() === 'error')
            errors.push(`console: ${message.text()}`)
        })
        page.on('pageerror', (error) =>
          errors.push(`pageerror: ${error.message}`),
        )
        const response = await page.goto(new URL(path, baseUrl).toString(), {
          waitUntil: 'networkidle',
        })
        if (!response?.ok())
          throw new Error(
            `${scenario}: browser route returned HTTP ${response?.status() ?? 'unknown'}`,
          )
        await page.locator('main').waitFor()
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all(
            [...document.images].map(async (image) => {
              if (!image.complete)
                await new Promise((done, reject) => {
                  image.addEventListener('load', done, { once: true })
                  image.addEventListener(
                    'error',
                    () =>
                      reject(new Error(`Image failed to load: ${image.src}`)),
                    { once: true },
                  )
                })
              if (image.naturalWidth === 0)
                throw new Error(`Image failed to load: ${image.currentSrc}`)
            }),
          )
        })
        const geometry = await page.locator('main').boundingBox()
        if (!geometry || geometry.width <= 0 || geometry.height <= 0)
          throw new Error(`${scenario}: hydrated main has no visible geometry`)
        if (errors.length)
          throw new Error(`${scenario}: browser errors:\n${errors.join('\n')}`)
        await page.close()
        console.log(`scenario route integration passed: ${scenario}`)
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser?.close().catch(() => {})
    if (ownsServer) await stopServer(server)
    if (isolatedState)
      await rm(isolatedState, { recursive: true, force: true }).catch(() => {})
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })

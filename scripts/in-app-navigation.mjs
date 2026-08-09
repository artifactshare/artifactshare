import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  appFetch,
  cookieHeader,
  cookiesFromHeaders,
} from './lib/dev-sign-in.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const baseUrl = process.env.APP_BASE_URL ?? 'https://localhost:5173'
const require = createRequire(resolve(ROOT, 'apps/web/package.json'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const fetchApp = (path, options = {}) => appFetch(baseUrl, path, options)

async function waitForServer(server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null)
      throw new Error(
        `Dev server exited before readiness (code ${server.exitCode})`,
      )
    try {
      if ((await fetchApp('/dev/sign-in')).ok) return
    } catch {}
    await sleep(1000)
  }
  throw new Error('Dev server did not become ready within 120 seconds')
}

async function waitForHydratedHome(page) {
  await page.goto(baseUrl)
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor()
  await page
    .locator('[data-recent-date-heading]')
    .first()
    .waitFor()
    .catch(() => {
      throw new Error(
        'Hydration did not complete: the recent date heading was not rendered',
      )
    })
}

async function main() {
  let server = null
  let ownsServer = false
  let browser = null
  let context = null
  let isolatedState = null
  try {
    try {
      if (!(await fetchApp('/dev/sign-in')).ok) throw new Error('not ready')
    } catch {
      const { prepareDevEnvironment } = await import('./dev-setup.mjs')
      isolatedState = await mkdtemp(join(tmpdir(), 'artifactshare-navigation-'))
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
    const response = await fetchApp('/api/auth/dev/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        persona: 'free-owner',
        scenario: 'recent/content-rich',
      }),
    })
    if (!response.ok)
      throw new Error(`Dev sign-in failed: HTTP ${response.status}`)
    const cookies = cookiesFromHeaders(response.headers)
    if (!cookies.length)
      throw new Error('Dev sign-in returned no session cookie')
    const sessionResponse = await fetchApp('/api/auth/get-session', {
      headers: { Cookie: cookieHeader(cookies) },
    })
    const session = await sessionResponse.json().catch(() => null)
    if (!sessionResponse.ok || !session?.user)
      throw new Error(
        `Dev sign-in session was not readable: HTTP ${sessionResponse.status}; cookies: ${cookies.map(({ name }) => name).join(', ')}`,
      )
    try {
      const { chromium } = require('playwright')
      browser = await chromium.launch(
        process.env.PLAYWRIGHT_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_CHANNEL }
          : undefined,
      )
    } catch (error) {
      if (
        !process.env.PLAYWRIGHT_CHANNEL &&
        /Executable doesn't exist/i.test(String(error))
      )
        throw new Error(
          'Playwright Chromium is not installed. Run `pnpm --filter @artifactshare/web exec playwright install chromium`, or set PLAYWRIGHT_CHANNEL=chrome.',
        )
      throw error
    }
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: 'en',
      reducedMotion: 'reduce',
    })
    await context.addCookies(
      cookies.map((cookie) => ({ ...cookie, url: baseUrl })),
    )
    const browserSessionResponse = await context.request.get(
      new URL('/api/auth/get-session', baseUrl).toString(),
    )
    const browserSession = await browserSessionResponse.json().catch(() => null)
    if (!browserSessionResponse.ok() || !browserSession?.user) {
      const installedCookies = await context.cookies(baseUrl)
      throw new Error(
        `Browser context could not read the dev session: HTTP ${browserSessionResponse.status()}; cookies: ${installedCookies.map(({ name }) => name).join(', ') || '(none)'}`,
      )
    }
    // A clean CI checkout has an empty Vite dependency optimizer cache. Its
    // first browser request may trigger an optimized-dependency reload, which
    // deliberately invalidates the initial client module URLs. Prime that
    // one-time transition before collecting errors for the navigation proof.
    const warmupPage = await context.newPage()
    await waitForHydratedHome(warmupPage)
    await warmupPage.close()

    const page = await context.newPage()
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    let step = 'open home'
    let waitingFor = 'Home'
    try {
      await waitForHydratedHome(page)
      await page.evaluate(() => {
        window.__inAppNavigation = true
      })
      step = 'open recently seen'
      waitingFor = 'Recently seen'
      await page
        .getByRole('banner')
        .getByRole('link', { name: 'Recently seen', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Recently seen', exact: true })
        .waitFor()
      await page
        .locator('main a[href^="/a/"]')
        .first()
        .waitFor()
        .catch(() => {
          throw new Error(
            'Recently seen did not render an artifact row for the content-rich scenario',
          )
        })
      if (!(await page.evaluate(() => window.__inAppNavigation === true)))
        throw new Error(
          'Recently seen loaded after a document navigation; client navigation did not complete',
        )
      step = 'return to my files'
      waitingFor = 'My files'
      await page
        .getByRole('banner')
        .getByRole('link', { name: 'My files', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'My files', exact: true })
        .waitFor()
      if (!(await page.evaluate(() => window.__inAppNavigation === true)))
        throw new Error(
          'Home loaded after a document navigation; client navigation did not complete',
        )
    } catch (error) {
      const heading = await page
        .locator('h1, h2, h3')
        .allTextContents()
        .catch(() => [])
      const pageSession = await page
        .evaluate(async () => {
          const sessionRequest = await fetch('/api/auth/get-session')
          const body = await sessionRequest.json().catch(() => null)
          return { ok: sessionRequest.ok, hasUser: Boolean(body?.user) }
        })
        .catch(() => ({ ok: false, hasUser: false }))
      const pageCookies = await context.cookies(baseUrl)
      throw new Error(
        `${step} failed while waiting for ${waitingFor} at ${page.url()}; page session: ${pageSession.ok ? 'ok' : 'failed'}/${pageSession.hasUser ? 'user' : 'anonymous'}; cookies: ${pageCookies.map(({ name }) => name).join(', ') || '(none)'}; visible headings: ${heading.join(' | ') || '(none)'}; ${error.message}`,
      )
    } finally {
      await context?.close().catch(() => {})
      context = null
      await browser?.close().catch(() => {})
      browser = null
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    if (ownsServer && server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM')
      } catch {}
    }
    if (isolatedState)
      await rm(isolatedState, { recursive: true, force: true }).catch(() => {})
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

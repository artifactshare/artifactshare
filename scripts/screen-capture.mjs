import { mkdir, rm, writeFile } from 'node:fs/promises'
import { File } from 'node:buffer'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { screens, validateLedger } from './screen-ledger.mjs'
import { auditGaps as auditGapsBrowser } from '../apps/web/app/lib/gap-audit.js'
import {
  appFetch,
  cookieFromHeaders,
  cookieHeader,
  cookiesFromHeaders,
} from './lib/dev-sign-in.mjs'

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}
const THEMES = ['light', 'dark']
const ROUTE_ERROR_SELECTOR = '[data-screen-capture-error]'

export class CaptureFailure extends Error {
  constructor(kind, message, details = {}) {
    super(message)
    this.name = 'CaptureFailure'
    this.kind = kind
    this.details = details
  }
}

export function captureFailure(error) {
  if (error instanceof CaptureFailure)
    return {
      kind: error.kind,
      message: error.message,
      ...error.details,
    }
  return {
    kind: 'capture_failure',
    message: error instanceof Error ? error.message : String(error),
  }
}

export async function assertNoRouteError(page) {
  const error = page.locator(ROUTE_ERROR_SELECTOR)
  if ((await error.count()) === 0) return
  const root = error.first()
  const marker = await root.getAttribute('data-screen-capture-error')
  const heading = await root.locator('h1').first().innerText()
  const details = await root.locator('p').first().innerText()
  throw new CaptureFailure(
    'screen_error',
    `screen rendered ${marker ?? 'an error boundary'}: ${heading} — ${details}`,
    { condition: marker ?? ROUTE_ERROR_SELECTOR },
  )
}

export async function waitForReady(page, ready) {
  if (!ready) return
  try {
    await page.locator(ready.selector).waitFor({
      state: 'visible',
      timeout: ready.timeoutMs ?? 30_000,
    })
  } catch {
    await assertNoRouteError(page)
    throw new CaptureFailure(
      'readiness_timeout',
      `ready condition was not met: ${ready.description}`,
      {
        condition: ready.description,
        selector: ready.selector,
        timeoutMs: ready.timeoutMs ?? 30_000,
      },
    )
  }
}

const usage = () =>
  'Usage: pnpm screens:capture -- [--screen <id>...] [--all] [--label <name>] [--audit-gaps]'

export function screenStateRequestHeaders(state) {
  return state.setup?.scenario
    ? { 'X-ArtifactShare-Dev-Screen-State': state.setup.scenario }
    : {}
}

// The local dev server uses a self-signed certificate; global fetch rejects it.
const requireFromCli = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../packages/cli/package.json'),
)
const requireFromWeb = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../apps/web/package.json'),
)
const { FormData } = requireFromCli('undici')

async function signIn(baseUrl, persona, scenario) {
  const response = await appFetch(baseUrl, '/api/auth/dev/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona, ...(scenario ? { scenario } : {}) }),
  })
  if (!response.ok)
    throw new Error(
      `dev sign-in failed for ${persona}: HTTP ${response.status}`,
    )
  const cookie = cookieFromHeaders(response.headers)
  if (!cookie)
    throw new Error(`dev sign-in returned no session cookie for ${persona}`)
  const cookies = cookiesFromHeaders(response.headers)
  const body = await response.json().catch(() => null)
  return {
    cookie,
    cookies,
    cookieHeader: cookieHeader(cookies),
    workspaceId: body?.workspaceId ?? null,
    containerId: body?.containerId ?? null,
    containerKind: body?.containerKind ?? null,
  }
}

async function uploadArtifact(
  baseUrl,
  cookie,
  html = '<!doctype html><html><body><h1>Screen capture seed</h1></body></html>',
) {
  const form = new FormData()
  form.append(
    'file',
    new File(
      [html],
      '日本語でとても長い成果物タイトルの省略表示を確認する回帰テスト用ドキュメント.html',
      { type: 'text/html' },
    ),
  )
  form.append('visibility', 'private')
  const response = await appFetch(baseUrl, '/api/shareables/uploads', {
    method: 'POST',
    headers: { Cookie: cookie.cookieHeader },
    body: form,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.id)
    throw new Error(
      `artifact seed failed: HTTP ${response.status} ${JSON.stringify(body)}`,
    )
  return body.id
}

const SEED_PROJECT_NAME = 'Screen capture seed'

// Reuse across runs: repeated creation hits the free plan's project limit.
async function ensureProject(baseUrl, cookie) {
  const headers = { Cookie: cookie.cookieHeader }
  const listResponse = await appFetch(baseUrl, '/api/cli/projects', { headers })
  const list = await listResponse.json().catch(() => null)
  const existing = list?.projects?.find(
    (project) => project.name === SEED_PROJECT_NAME,
  )
  if (existing) return existing.id
  const response = await appFetch(baseUrl, '/api/cli/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: SEED_PROJECT_NAME }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.project?.id)
    throw new Error(
      `project seed failed: HTTP ${response.status} ${JSON.stringify(body)}`,
    )
  return body.project.id
}

function screenUsesPlaceholder(screen, placeholder) {
  return Object.values(screen.route).some((path) => path.includes(placeholder))
}

async function resolveSeeds(baseUrl, selected) {
  const cookies = {}
  const scenarioCookies = {}
  const signInFor = async (persona, scenario) => {
    if (scenario) {
      const key = `${persona}:${scenario}`
      scenarioCookies[key] ??= await signIn(baseUrl, persona, scenario)
      return scenarioCookies[key]
    }
    cookies[persona] ??= await signIn(baseUrl, persona)
    return cookies[persona]
  }
  for (const screen of selected)
    if (screen.auth !== 'anonymous') await signInFor(screen.auth)
  // Resolve every scenario before jobs start so parallel captures never sign
  // in or mutate a scenario workspace while another job is running.
  for (const screen of selected)
    for (const state of screen.states)
      if (state.setup?.scenario)
        await signInFor(screen.auth, state.setup.scenario)

  let artifact = null
  if (
    selected.some((screen) => screenUsesPlaceholder(screen, '{seed:artifact}'))
  )
    artifact = await uploadArtifact(baseUrl, await signInFor('team-owner'))

  // The project must belong to the capturing persona's workspace, or the
  // project-detail route renders not-found for a cross-workspace id.
  let project = null
  for (const screen of selected)
    if (screenUsesPlaceholder(screen, '{seed:project}')) {
      project = await ensureProject(baseUrl, await signInFor(screen.auth))
      break
    }

  let update = 'latest'
  if (
    selected.some((screen) => screenUsesPlaceholder(screen, '{seed:update}'))
  ) {
    const updates = await appFetch(baseUrl, '/updates')
    if (updates.ok) {
      const html = await updates.text()
      const match = html.match(/href=["'](?:\/ja)?\/updates\/([^"']+)["']/)
      if (match) update = match[1]
    }
  }

  return {
    artifact,
    project,
    update,
    cookies,
    scenarioCookies,
  }
}

function parseArgs(argv) {
  const ids = []
  let all = false
  let label = 'latest'
  let auditGaps = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') continue
    else if (argv[i] === '--audit-gaps') auditGaps = true
    else if (argv[i] === '--all') all = true
    else if (argv[i] === '--screen') ids.push(argv[++i])
    else if (argv[i] === '--label') label = argv[++i] ?? ''
    else throw new Error(usage())
  }
  if ((all && ids.length) || (!all && !ids.length)) throw new Error(usage())
  if (!/^[a-z0-9-]+$/.test(label))
    throw new Error('--label must match /^[a-z0-9-]+$/')
  const selectedIds = all
    ? screens.map((screen) => screen.id)
    : [...new Set(ids)]
  const unknown = selectedIds.filter(
    (id) => !screens.some((screen) => screen.id === id),
  )
  if (unknown.length)
    throw new Error(
      `Unknown screen id: ${unknown.join(', ')}\nKnown screen ids: ${screens.map((screen) => screen.id).join(', ')}`,
    )
  const selected = selectedIds.map((id) =>
    screens.find((screen) => screen.id === id),
  )
  return { selected, label, auditGaps }
}

function pathFor(screen, locale, seeds, state) {
  const scenarioContainer = state.setup?.scenario
    ? seeds.scenarioCookies?.[`${screen.auth}:${state.setup.scenario}`]
    : null
  // The seed reports the kind, so the scenario list lives in one place only.
  // An inbox container id in a /projects/... path would capture a not-found.
  const projectId =
    scenarioContainer?.containerKind === 'project'
      ? scenarioContainer.containerId
      : seeds.project
  return screen.route[locale]
    .replace('{seed:artifact}', seeds.artifact)
    .replace('{seed:project}', projectId)
    .replace('{seed:update}', seeds.update)
}

function fileName(screen, state, viewport, theme, locale) {
  return `${screen.id}--${state.id}--${viewport}--${theme}--${locale}.png`
}

export async function captureScreens({
  argv = process.argv.slice(2),
  baseUrl = process.env.SCREEN_CAPTURE_BASE_URL ?? 'https://localhost:5173',
} = {}) {
  validateLedger()
  const { selected, label, auditGaps } = parseArgs(argv)
  // Validated before any browser or seed work so bad input fails fast.
  const validatedConcurrency = Number(
    process.env.SCREEN_CAPTURE_CONCURRENCY ?? 6,
  )
  if (!Number.isInteger(validatedConcurrency) || validatedConcurrency < 1)
    throw new Error('SCREEN_CAPTURE_CONCURRENCY must be a positive integer')
  try {
    const response = await appFetch(baseUrl, '/')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch {
    throw new Error(
      `Dev server is unreachable at ${baseUrl}. Please start it with pnpm --filter @artifactshare/web dev:app`,
    )
  }
  let playwright
  try {
    playwright = requireFromWeb('playwright')
  } catch (error) {
    throw new Error(
      `Playwright is unavailable from the web workspace. Run pnpm install and pnpm --filter @artifactshare/web exec playwright install chromium. ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const seeds = await resolveSeeds(baseUrl, selected)
  const outDir = resolve('screen-captures', label)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  let browser
  try {
    browser = await playwright.chromium.launch(
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
  const manifest = []
  let failures = 0
  const gapFailures = []
  // Data-mutating states run after every ordinary capture, so their seeds
  // cannot leak into other screens' default states within a run.
  const jobs = []
  for (const screen of selected)
    for (const locale of Object.keys(screen.route))
      for (const state of screen.states)
        for (const viewport of Object.keys(VIEWPORTS))
          for (const theme of THEMES)
            jobs.push({
              screen,
              locale,
              state,
              viewport,
              theme,
              order: jobs.length,
            })
  const captureJob = async ({
    screen,
    locale,
    state,
    viewport,
    theme,
    order,
  }) => {
    const file = fileName(screen, state, viewport, theme, locale)
    const cookie = state.setup?.scenario
      ? seeds.scenarioCookies[`${screen.auth}:${state.setup.scenario}`]
      : seeds.cookies[screen.auth]
    const context = await browser.newContext({
      viewport: VIEWPORTS[viewport],
      colorScheme: theme,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
      extraHTTPHeaders: screenStateRequestHeaders(state),
    })
    let page
    let url
    try {
      if (cookie)
        await context.addCookies(
          cookie.cookies.map((item) => ({ ...item, url: baseUrl })),
        )
      page = await context.newPage()
      url = new URL(pathFor(screen, locale, seeds, state), baseUrl)
      url.searchParams.set('theme', theme)
      const query = state.setup?.query
      if (query)
        new URLSearchParams(query.replace(/^\?/, '')).forEach((value, key) =>
          url.searchParams.set(key, value),
        )
      const navigation = await page.goto(url.toString(), {
        waitUntil: 'networkidle',
      })
      if (!navigation || !navigation.ok())
        throw new CaptureFailure(
          'navigation_failure',
          `navigation failed: HTTP ${navigation?.status() ?? 'none'}`,
        )
      await assertNoRouteError(page)
      await waitForReady(page, state.setup?.ready ?? screen.ready)
      const interactions = state.setup?.interactions ?? []
      for (const interaction of interactions) {
        if ((await page.locator(interaction.selector).count()) === 0)
          throw new CaptureFailure(
            'interaction_precondition',
            `interaction target was not found: ${interaction.selector}`,
            {
              action: interaction.action,
              selector: interaction.selector,
            },
          )
        try {
          if (interaction.action === 'hover')
            await page.hover(interaction.selector)
          else if (interaction.action === 'click')
            await page.click(interaction.selector)
        } catch (error) {
          throw new CaptureFailure(
            'interaction_failure',
            `interaction failed: ${interaction.action} ${interaction.selector}: ${error instanceof Error ? error.message : String(error)}`,
            {
              action: interaction.action,
              selector: interaction.selector,
            },
          )
        }
        await page.waitForTimeout(400)
      }
      // goto already waited for networkidle; only re-settle after interactions.
      if (interactions.length > 0) await page.waitForLoadState('networkidle')
      await assertNoRouteError(page)
      await waitForReady(page, state.setup?.ready ?? screen.ready)
      await page.screenshot({
        path: join(outDir, file),
        fullPage: true,
      })
      const findings = auditGaps
        ? await page.evaluate(auditGapsBrowser, {
            rootSelector: 'body',
            minGap: 4,
          })
        : []
      if (findings.length)
        gapFailures.push({
          screen: screen.id,
          state: state.id,
          viewport,
          theme,
          locale,
          findings,
        })
      manifest.push({
        order,
        status: 'success',
        screen: screen.id,
        state: state.id,
        viewport,
        theme,
        locale,
        file,
        url: url.toString(),
        ...(auditGaps
          ? {
              gapAudit: {
                result: findings.length ? 'failed' : 'passed',
                findings,
              },
            }
          : {}),
      })
    } catch (error) {
      failures++
      const failure = captureFailure(error)
      const diagnosticFile = file.replace(/\.png$/, '--failed.png')
      let savedDiagnostic = false
      if (page)
        try {
          await page.screenshot({
            path: join(outDir, diagnosticFile),
            fullPage: true,
          })
          savedDiagnostic = true
        } catch {}
      manifest.push({
        order,
        status: 'failed',
        screen: screen.id,
        state: state.id,
        viewport,
        theme,
        locale,
        url: url?.toString() ?? null,
        ...(savedDiagnostic ? { diagnosticFile } : {}),
        failure,
      })
      console.error(
        `capture failed: ${screen.id}/${state.id}/${viewport}/${theme}/${locale} [${failure.kind}]: ${failure.message}`,
      )
    } finally {
      await context.close()
    }
  }

  const runPool = async (pool, concurrency) => {
    let next = 0
    const workers = Array.from(
      { length: Math.min(concurrency, pool.length) },
      async () => {
        while (next < pool.length) await captureJob(pool[next++])
      },
    )
    await Promise.all(workers)
  }

  const concurrency = validatedConcurrency
  try {
    // Seeded states run strictly after the plain pass, and their data
    // mutation happens once, serially, before their own parallel captures.
    const plainJobs = jobs.filter((job) => !job.state.setup?.scenario)
    const seededJobs = jobs.filter((job) => job.state.setup?.scenario)
    await runPool(plainJobs, concurrency)
    await runPool(seededJobs, concurrency)
  } finally {
    await browser.close()
  }
  // Parallel workers finish in nondeterministic order; restore ledger order.
  manifest.sort((a, b) => a.order - b.order)
  for (const entry of manifest) delete entry.order
  await writeFile(
    join(outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  const groups = selected
    .map(
      (screen) =>
        `<section><h2>${screen.id}</h2><div class="grid">${manifest
          .filter((item) => item.screen === screen.id)
          .map((item) => {
            const file = item.file ?? item.diagnosticFile
            const displayLabel = `${item.state} · ${item.viewport} · ${item.theme} · ${item.locale}`
            if (!file)
              return `<article><span>${displayLabel} · failed: ${item.failure.kind}</span></article>`
            return `<a href="${file}"><img src="${file}" loading="lazy"><span>${displayLabel}${item.status === 'failed' ? ` · failed: ${item.failure.kind}` : ''}</span></a>`
          })
          .join('')}</div></section>`,
    )
    .join('')
  await writeFile(
    join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Screen captures: ${label}</title><style>body{font:14px system-ui;margin:24px;background:#eee}section{margin:24px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}a{color:#111;text-decoration:none;background:white;padding:8px}img{width:100%;height:180px;object-fit:contain;background:#ddd;display:block}span{display:block;padding:8px 0}</style>${groups}`,
  )
  const successes = manifest.filter((item) => item.status === 'success').length
  console.log(
    `Screen captures: ${successes} succeeded, ${failures} failed. Output: ${outDir}`,
  )
  if (gapFailures.length)
    console.error(
      `Gap audit findings (vertical + interactive): ${JSON.stringify(gapFailures, null, 2)}`,
    )
  if (failures) throw new Error(`${failures} capture(s) failed`)
  if (gapFailures.length)
    throw new Error(`${gapFailures.length} gap audit(s) failed`)
  return manifest
}

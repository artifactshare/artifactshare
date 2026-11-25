// Shared driving helpers for verify-artifactshare. Import from a journey script:
//
//   import { openRun, signIn, capture, createApiToken, runCli } from './harness.mjs'
//
// Everything a helper writes goes under the run's evidence directory
// (`.verify-artifactshare/runs/<id>/evidence/<feature>/`), which `stack.mjs down`
// keeps.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../../../..')
const RUNS = join(ROOT, '.verify-artifactshare/runs')
const CLI = join(ROOT, 'packages/cli/dist/index.js')
const require = createRequire(join(ROOT, 'apps/web/package.json'))

/** Load run.json for `id`, or the newest run (by startedAt) not yet stopped. */
export function openRun(id = process.env.VERIFY_RUN) {
  const runs = (existsSync(RUNS) ? readdirSync(RUNS) : [])
    .filter((name) => existsSync(join(RUNS, name, 'run.json')))
    .map((name) => JSON.parse(readFileSync(join(RUNS, name, 'run.json'), 'utf8')))
  const run = id
    ? runs.find((candidate) => candidate.id === id)
    : runs
        .filter((candidate) => !candidate.stoppedAt)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .at(-1)
  if (!run) throw new Error(`No running verification stack${id ? ` named ${id}` : ''}. Run stack.mjs up.`)
  if (run.stoppedAt) throw new Error(`Run ${run.id} was stopped at ${run.stoppedAt}`)
  return run
}

export function evidenceDir(run, feature) {
  const dir = join(run.evidenceDir, feature)
  mkdirSync(dir, { recursive: true })
  return dir
}

const catalogs = new Map()

/**
 * The copy the app shows for `key` in `locale`, read from
 * `apps/web/app/i18n/<locale>.json`. Use it for a value a journey asserts (a
 * count, a state label) so rewritten wording does not fail the journey, and
 * keep literal English for the role names a feature file lists as handles.
 */
export function uiText(locale, key, vars = {}) {
  if (!catalogs.has(locale)) {
    const path = join(ROOT, `apps/web/app/i18n/${locale}.json`)
    catalogs.set(locale, JSON.parse(readFileSync(path, 'utf8')))
  }
  const raw = catalogs.get(locale)[key]
  if (raw === undefined) throw new Error(`No ${locale} copy for ${key}`)
  return raw.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))
}

/** The copy for a counted label: `<stem>One` at 1, `<stem>Other` otherwise. */
export function countedLabel(locale, stem, n) {
  return uiText(locale, `${stem}${n === 1 ? 'One' : 'Other'}`, { n })
}

/**
 * Launch Chromium with a fresh context (no cookies), for a signed-out
 * visitor. Returns { browser, context, page }.
 */
export async function launchBrowser() {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'en',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 860 },
  })
  return { browser, context, page: await context.newPage() }
}

/**
 * Launch Chromium and sign in through the `/dev/sign-in` persona buttons, the
 * local stand-in for Google sign-in. Returns { browser, context, page }.
 */
export async function signIn(run, { persona = 'Free owner', next = '/' } = {}) {
  const { browser, context, page } = await launchBrowser()
  page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`))
  await page.goto(
    `${run.appOrigin}/dev/sign-in?next=${encodeURIComponent(next)}`,
  )
  await page
    .getByRole('button', { name: new RegExp(`^${persona}`) })
    .click()
  await page.waitForURL((url) => !url.pathname.startsWith('/dev/sign-in'))
  // The account button in the top bar appears once the signed-in page renders.
  await page
    .getByRole('button', { name: /@artifactshare\.local$/ })
    .first()
    .waitFor()
  return { browser, context, page }
}

/**
 * The locator's box once it stops moving, rounded, with `right` and `bottom`.
 * Panels and toasts slide in, so a box read right after `waitFor` can be a
 * frame of the animation rather than where the user sees the element.
 */
export async function stableBox(locator, { tries = 40, interval = 100 } = {}) {
  let previous
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const box = await locator.boundingBox()
    const current = box && {
      left: Math.round(box.x),
      top: Math.round(box.y),
      right: Math.round(box.x + box.width),
      bottom: Math.round(box.y + box.height),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
    const key = current && JSON.stringify(current)
    if (key && key === previous) return current
    previous = key
    await locator.page().waitForTimeout(interval)
  }
  throw new Error(`the element never settled: ${previous ?? 'no box'}`)
}

// An API token is shown in full exactly once, on the Settings page, and a red
// nightly run uploads this evidence where anyone can read it, so no capture may
// carry a usable credential. The pattern is the whole token: `ast_` and the
// base64url of its 32 random bytes.
const API_TOKEN = /ast_[A-Za-z0-9_-]+/u
const API_TOKENS = new RegExp(API_TOKEN, 'gu')
const REDACTED = '[redacted api token]'

function redactSecrets(text) {
  return text.replaceAll(API_TOKENS, REDACTED)
}

/**
 * Save `<name>.png` and `<name>.aria.yml` for the page (or a locator), with any
 * API token on screen masked out of the image and rewritten out of the text.
 */
export async function capture(run, feature, name, page, locator) {
  const dir = evidenceDir(run, feature)
  await page.screenshot({
    path: join(dir, `${name}.png`),
    fullPage: true,
    mask: [page.getByText(API_TOKEN)],
  })
  const aria = redactSecrets(
    await (locator ?? page.locator('body')).ariaSnapshot(),
  )
  writeFileSync(
    join(dir, `${name}.aria.yml`),
    `# ${page.url()}\n${aria}\n`,
  )
  return { png: join(dir, `${name}.png`), aria }
}

/**
 * Run `act`, then wait for `settled`. A page that renders server times or
 * hydrates late can discard the server HTML and re-render right after load, and
 * a click in that window is lost with no trace, so a longer wait alone never
 * finds the dialog. Waiting for the network to go idle closes most of the
 * window; the second attempt covers the rest.
 */
export async function actUntil(
  page,
  act,
  settled,
  { attempts = 2, timeout = 10_000 } = {},
) {
  await page.waitForLoadState('networkidle')
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await act()
    try {
      await settled.waitFor({ timeout })
      return
    } catch (error) {
      if (attempt === attempts) throw error
    }
  }
}

/**
 * Create an API token from Settings > AI tools and CLI, the way a user does
 * for non-interactive CLI use. Returns the token value shown once on screen.
 */
export async function createApiToken(page, run, name) {
  await page.goto(`${run.appOrigin}/settings/tokens`)
  const created = page
    .getByRole('status')
    .filter({ has: page.getByRole('heading', { name: `Token created: ${name}` }) })
  await actUntil(
    page,
    async () => {
      await page.getByRole('textbox', { name: 'Name' }).fill(name)
      await page.getByRole('button', { name: 'Create token' }).click()
    },
    created,
  )
  const token = (await created.locator('code').innerText()).trim()
  if (!token.startsWith('ast_')) throw new Error(`Unexpected token text: ${token}`)
  return token
}

// The journeys run packages/cli/dist. Refuse a build older than its sources,
// so a CLI change is never "proven" with the previous build.
function assertCliBuildCurrent() {
  const rebuild = 'pnpm --filter @artifactshare/cli build'
  if (!existsSync(CLI)) throw new Error(`CLI not built. Run: ${rebuild}`)
  const built = statSync(CLI).mtimeMs
  const sources = ['packages/cli/src', 'packages/contract/src']
  for (const dir of sources)
    for (const file of readdirSync(join(ROOT, dir), { recursive: true })) {
      const path = join(ROOT, dir, file)
      if (statSync(path).isFile() && statSync(path).mtimeMs > built)
        throw new Error(`CLI build is older than ${dir}/${file}. Run: ${rebuild}`)
    }
}

/**
 * Run the built CLI against this run's app with a throwaway HOME and config
 * dir, so the developer's saved production credentials are never read.
 * Writes `<name>.cli.json` (command, exit code, stdout, stderr) as evidence.
 *
 * The run's certificate is the local development one, so every call passes
 * `--insecure-localhost`. Pass `insecureLocalhost: false` to leave it out and
 * see what a user sees without it.
 */
export function runCli(
  run,
  feature,
  name,
  args,
  { token, cwd, insecureLocalhost = true } = {},
) {
  assertCliBuildCurrent()
  const home = join(run.runDir, 'cli-home')
  mkdirSync(home, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(?:XDG_|ARTIFACTSHARE_)/u.test(key),
    ),
  )
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    ARTIFACTSHARE_CONFIG_HOME: join(home, '.config/artifactshare'),
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    ARTIFACTSHARE_BASE_URL: run.appOrigin,
    ...(token ? { ARTIFACTSHARE_TOKEN: token } : {}),
  })
  const argv = insecureLocalhost ? [...args, '--insecure-localhost'] : [...args]
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: cwd ?? home,
    env,
    encoding: 'utf8',
  })
  const record = {
    command: redactSecrets(`artifactshare ${argv.join(' ')}`),
    baseUrl: run.appOrigin,
    exitCode: result.status,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
  }
  writeFileSync(
    join(evidenceDir(run, feature), `${name}.cli.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  // `--json` prints a success to stdout and a failure to stderr.
  let json
  for (const text of [result.stdout, result.stderr])
    if (json === undefined)
      try {
        json = JSON.parse(text)
      } catch {}
  return { ...record, json }
}

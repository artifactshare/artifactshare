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

/**
 * Launch Chromium and sign in through the `/dev/sign-in` persona buttons, the
 * local stand-in for Google sign-in. Returns { browser, context, page }.
 */
export async function signIn(run, { persona = 'Free owner', next = '/' } = {}) {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'en',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 860 },
  })
  const page = await context.newPage()
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

/** Save `<name>.png` and `<name>.aria.yml` for the page (or a locator). */
export async function capture(run, feature, name, page, locator) {
  const dir = evidenceDir(run, feature)
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
  const aria = await (locator ?? page.locator('body')).ariaSnapshot()
  writeFileSync(
    join(dir, `${name}.aria.yml`),
    `# ${page.url()}\n${aria}\n`,
  )
  return { png: join(dir, `${name}.png`), aria }
}

/**
 * Create an API token from Settings > AI tools and CLI, the way a user does
 * for non-interactive CLI use. Returns the token value shown once on screen.
 */
export async function createApiToken(page, run, name) {
  await page.goto(`${run.appOrigin}/settings/tokens`)
  await page.getByRole('textbox', { name: 'Name' }).fill(name)
  await page.getByRole('button', { name: 'Create token' }).click()
  const created = page
    .getByRole('status')
    .filter({ has: page.getByRole('heading', { name: `Token created: ${name}` }) })
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
 */
export function runCli(run, feature, name, args, { token, cwd } = {}) {
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
  const argv = [...args, '--insecure-localhost']
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: cwd ?? home,
    env,
    encoding: 'utf8',
  })
  const record = {
    command: `artifactshare ${argv.join(' ')}`,
    baseUrl: run.appOrigin,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
  writeFileSync(
    join(evidenceDir(run, feature), `${name}.cli.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {}
  return { ...record, json }
}

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { appFetch, closeAppFetch, cookieHeader } from './lib/dev-sign-in.mjs'
import {
  assertCaptureServerHead,
  cleanCaptureHead,
  devShareableId,
} from './screen-capture.mjs'
import { personas, tasks } from './task-ledger.mjs'
import {
  championLoopTaskIds,
  checkTaskWalkthroughs,
  taskWalkthroughs,
  walkthroughActionKinds,
} from './task-walkthroughs.mjs'

const execFileAsync = promisify(execFile)
const requireFromWeb = createRequire(
  resolve(import.meta.dirname, '../apps/web/package.json'),
)
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
}
const ROUTE_ERROR_SELECTOR = '[data-screen-capture-error]'

const usage = () =>
  'Usage: pnpm walkthroughs:capture -- [--task <id>...] [--champion-loop] [--label <name>]'

export function parseWalkthroughArgs(argv) {
  const taskIds = []
  let championLoop = false
  let label = 'walkthrough'
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--champion-loop') championLoop = true
    else if (arg === '--task') taskIds.push(argv[++index])
    else if (arg === '--label') label = argv[++index] ?? ''
    else throw new Error(usage())
  }
  if (championLoop && taskIds.length) throw new Error(usage())
  if (!championLoop && taskIds.length === 0) throw new Error(usage())
  if (!/^[a-z0-9-]+$/.test(label))
    throw new Error('--label must match /^[a-z0-9-]+$/')
  const selected = championLoop ? championLoopTaskIds : [...new Set(taskIds)]
  const known = new Set(
    taskWalkthroughs.map((walkthrough) => walkthrough.taskId),
  )
  const unknown = selected.filter((id) => !known.has(id))
  if (unknown.length)
    throw new Error(`Unknown walkthrough task: ${unknown.join(', ')}`)
  return { selected, label }
}

export function shouldWaitForViewerReady(path, waitUntil) {
  return path.startsWith('/a/') && waitUntil !== 'domcontentloaded'
}

export function clickSettleMilliseconds(action) {
  return action.captureDuringNavigation ? 0 : 500
}

export async function isSheetVisible(page) {
  const sheet = page.locator('[data-slot="sheet-content"]')
  return (await sheet.count()) > 0 && (await sheet.isVisible())
}

export async function recordCaptureRevision(
  failures,
  baseUrl,
  head,
  { assertServerHead = assertCaptureServerHead, close = closeAppFetch } = {},
) {
  try {
    await assertServerHead(baseUrl, head)
  } catch (error) {
    failures.push(
      `revision: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await close()
  }
}

async function preflight(baseUrl, head) {
  const failures = []
  for (const [name, path] of [
    ['app', '/'],
    ['sandbox', 'https://localhost:5174/'],
  ]) {
    try {
      const response = path.startsWith('http')
        ? await appFetch(path, '/')
        : await appFetch(baseUrl, path)
      if (name === 'app' && !response.ok)
        failures.push(`${name}: HTTP ${response.status}`)
      if (name === 'sandbox' && response.status >= 500)
        failures.push(`${name}: HTTP ${response.status}`)
      await response.body?.cancel()
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  try {
    await stat(resolve('packages/cli/dist/index.js'))
  } catch {
    failures.push(
      'cli: packages/cli/dist/index.js is missing; run pnpm --filter @artifactshare/cli build',
    )
  }
  // A second app request catches the dependency-optimization reload window
  // before any browser or scenario state is created.
  try {
    const first = await appFetch(baseUrl, '/')
    await first.body?.cancel()
    const second = await appFetch(baseUrl, '/')
    await second.body?.cancel()
    if (!first.ok || !second.ok || first.url !== second.url)
      failures.push('app: dependency optimization has not converged')
  } catch (error) {
    failures.push(
      `app: convergence check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  await recordCaptureRevision(failures, baseUrl, head)
  if (failures.length)
    throw new Error(
      `Walkthrough preflight failed; no capture started:\n${failures.join('\n')}`,
    )
}

async function signIn(baseUrl, persona, scenario) {
  const response = await appFetch(baseUrl, '/api/auth/dev/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona, scenario }),
  })
  const body = await response.json().catch(() => null)
  const cookies = []
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const pair = value.split(';')[0]
    const separator = pair.indexOf('=')
    if (separator > 0)
      cookies.push({
        name: pair.slice(0, separator),
        value: pair.slice(separator + 1),
      })
  }
  if (!response.ok || !body?.userId || cookies.length === 0)
    throw new Error(
      `dev sign-in failed for ${persona}/${scenario}: HTTP ${response.status}`,
    )
  return { ...body, cookies, cookieHeader: cookieHeader(cookies) }
}

function artifactIdFor(session, index) {
  return devShareableId(
    `${session.workspaceId}-${session.userId}-file-${index}`,
  )
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function redactEvidenceUrl(value) {
  try {
    const url = new URL(value)
    if (url.searchParams.has('t')) url.searchParams.set('t', '[redacted]')
    return url.toString()
  } catch {
    return value
  }
}

export function redactEvidenceText(value) {
  return String(value).replaceAll(/([?&]t=)[^&\s"<>]+/gu, '$1[redacted]')
}

async function collectPageEvidence(page, failedRequests) {
  const notifications = await page
    .locator('[data-sonner-toast], [role="status"], [role="alert"]')
    .allInnerTexts()
    .catch(() => [])
  const frames = await Promise.all(
    page
      .frames()
      .slice(1)
      .map(async (frame) => ({
        url: redactEvidenceUrl(frame.url()),
        title: redactEvidenceText(await frame.title().catch(() => '')),
        loaded: Boolean(frame.url() && frame.url() !== 'about:blank'),
      })),
  )
  return { notifications, frames, failedRequests }
}

async function writeTaskIndex(outDir, record) {
  const rows = record.runs
    .flatMap((run) =>
      run.steps.map((step) => ({ ...step, viewport: run.viewport })),
    )
    .map(
      (
        step,
      ) => `<article><h2>${htmlEscape(step.phase)} · ${htmlEscape(step.viewport)}</h2>
<p>${htmlEscape(step.description)}</p>
${step.file ? `<img src="${htmlEscape(step.file)}" alt="${htmlEscape(`${step.phase} ${step.viewport}`)}">` : ''}
<details><summary>裏取りデータ</summary><pre>${htmlEscape(JSON.stringify(step.evidence, null, 2))}</pre></details></article>`,
    )
    .join('\n')
  const videos = record.runs
    .flatMap((run) =>
      run.videos.map(
        (video) =>
          `<li><a href="${htmlEscape(video.file)}">${htmlEscape(`${run.viewport} · ${video.branch}`)}</a></li>`,
      ),
    )
    .join('')
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(record.task.title)}</title><style>body{font-family:system-ui;max-width:1100px;margin:auto;padding:24px}img{max-width:100%;border:1px solid #ccc}article{margin:32px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>${htmlEscape(record.task.title)}</h1><p>${htmlEscape(record.task.goal)}</p><h2>動画</h2><ul>${videos}</ul>${rows}</html>`
  await writeFile(join(outDir, 'index.html'), html)
}

async function executeCli({ kind, baseUrl, session, tempDir, state }) {
  const tokenCookie = session.cookies.find((cookie) =>
    cookie.name.includes('session_token'),
  )
  const token = decodeURIComponent(tokenCookie?.value ?? '').split('.')[0]
  if (!token)
    throw new Error('dev sign-in returned no CLI-compatible session token')
  const initialFile = join(tempDir, 'walkthrough.html')
  const updatedFile = join(tempDir, 'walkthrough-updated.html')
  const recoveryFile = join(tempDir, 'walkthrough-recovered.html')
  await writeFile(
    initialFile,
    '<!doctype html><h1>Champion loop walkthrough</h1><p>Initial version</p>',
  )
  await writeFile(
    updatedFile,
    '<!doctype html><h1>Champion loop walkthrough</h1><p>Updated version</p>',
  )
  await writeFile(
    recoveryFile,
    '<!doctype html><h1>Champion loop walkthrough</h1><p>Recovered version</p>',
  )
  let args
  if (kind === 'cliShare' || kind === 'cliShareAndGoto')
    args = [
      'share',
      initialFile,
      '--visibility',
      state.cliShareVisibility ?? 'private',
      '--base-url',
      baseUrl,
      '--json',
    ]
  else if (kind === 'cliUpdate')
    args = [
      'update',
      state.cliArtifactId,
      updatedFile,
      '--base-url',
      baseUrl,
      '--json',
    ]
  else if (kind === 'cliUpdateMissing')
    args = [
      'update',
      'missing-walkthrough-artifact',
      updatedFile,
      '--base-url',
      baseUrl,
      '--json',
    ]
  else if (kind === 'cliUpdateRecovery')
    args = [
      'update',
      state.cliArtifactId,
      recoveryFile,
      '--base-url',
      baseUrl,
      '--json',
    ]
  else if (kind === 'cliDelete')
    args = ['delete', state.cliArtifactId, '--base-url', baseUrl, '--json']
  else return null
  try {
    const result = await execFileAsync(
      process.execPath,
      [resolve('packages/cli/dist/index.js'), ...args],
      {
        env: {
          ...process.env,
          ARTIFACTSHARE_TOKEN: token,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const parsed = JSON.parse(result.stdout)
    if (kind === 'cliShare' || kind === 'cliShareAndGoto') {
      state.cliArtifactId = parsed.data?.artifact?.id
      state.cliArtifactUrl = parsed.data?.artifact?.url
      state.cliArtifactIds.push(state.cliArtifactId)
    }
    return {
      command: args[0],
      exitCode: 0,
      ...((kind === 'cliShare' || kind === 'cliShareAndGoto') && {
        visibility: state.cliShareVisibility ?? 'private',
      }),
      stdout: parsed,
      stderr: result.stderr,
    }
  } catch (error) {
    const stdout = error?.stdout ?? ''
    const stderr = error?.stderr ?? ''
    const parsed = parseCliJsonOutput(stderr, stdout)
    const expected = isExpectedMissingTargetFailure(kind, parsed)
    if (!expected)
      throw new Error(`CLI ${args[0]} failed: ${stderr || stdout || error}`)
    return {
      command: args[0],
      exitCode: error.code ?? 1,
      expectedFailure: true,
      output: parsed ?? String(stderr || stdout),
    }
  }
}

export function isExpectedMissingTargetFailure(kind, output) {
  return (
    kind === 'cliUpdateMissing' &&
    output?.ok === false &&
    output.error?.code === 'target_not_found'
  )
}

export function parseCliJsonOutput(...outputs) {
  for (const output of outputs) {
    const json = String(output ?? '').match(/\{[\s\S]*\}\s*$/u)?.[0]
    if (!json) continue
    try {
      return JSON.parse(json)
    } catch {}
  }
  return null
}

export function requestOriginPhase(requestPhases, request, activePhase) {
  return requestPhases.get(request) ?? activePhase
}

export function combineWalkthroughAndCleanupErrors(
  walkthroughError,
  cleanupError,
) {
  return new AggregateError(
    [walkthroughError, cleanupError],
    `Walkthrough failed: ${walkthroughError instanceof Error ? walkthroughError.message : walkthroughError}; cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
    { cause: walkthroughError },
  )
}

export async function cleanupCliArtifacts({
  artifactIds,
  state,
  deleteArtifact,
}) {
  const errors = []
  for (const artifactId of artifactIds) {
    state.cliArtifactId = artifactId
    try {
      await deleteArtifact(artifactId)
    } catch (error) {
      errors.push(error)
    }
  }
  state.cliArtifactId = null
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1)
    throw new AggregateError(errors, 'Multiple CLI artifact deletions failed')
}

async function applyAction({ action, page, baseUrl, session, state, tempDir }) {
  let cliEvidence = null
  if (
    [
      'cliShare',
      'cliShareAndGoto',
      'cliUpdate',
      'cliUpdateMissing',
      'cliUpdateRecovery',
      'cliDelete',
    ].includes(action.kind)
  ) {
    if (action.kind === 'cliShare' || action.kind === 'cliShareAndGoto')
      state.cliShareVisibility = action.visibility
    const cli = await executeCli({
      kind: action.kind,
      baseUrl,
      session,
      tempDir,
      state,
    })
    cliEvidence = cli
    if (action.kind !== 'cliShareAndGoto') return { cli }
  }
  const goto = async (path, waitUntil = 'networkidle') => {
    if (path.startsWith('/a/') && waitUntil === 'domcontentloaded')
      await page.route(
        (url) => url.hostname.endsWith('.sandbox.localhost'),
        async (route) => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500))
          await route.continue()
        },
        { times: 1 },
      )
    const navigationWaitUntil = path.startsWith('/a/')
      ? 'domcontentloaded'
      : waitUntil
    const response = await page.goto(new URL(path, baseUrl).toString(), {
      waitUntil: navigationWaitUntil,
    })
    if (!response?.ok())
      throw new Error(`navigation failed: HTTP ${response?.status() ?? 'none'}`)
    await page
      .locator(ROUTE_ERROR_SELECTOR)
      .waitFor({ state: 'detached', timeout: 1_000 })
      .catch(async () => {
        if (await page.locator(ROUTE_ERROR_SELECTOR).count())
          throw new Error('route rendered an error boundary')
      })
    if (shouldWaitForViewerReady(new URL(page.url()).pathname, waitUntil))
      await page
        .locator('[data-sandbox-state="ready"]')
        .waitFor({ state: 'visible', timeout: 30_000 })
  }
  if (action.kind === 'goto')
    await goto(
      action.path,
      action.captureDuringNavigation ? 'domcontentloaded' : 'networkidle',
    )
  else if (
    action.kind === 'gotoArtifact' ||
    action.kind === 'gotoArtifactAndClick'
  ) {
    await goto(
      `/a/${artifactIdFor(session, state.artifactIndex)}`,
      action.captureDuringNavigation ? 'domcontentloaded' : 'networkidle',
    )
    if (action.kind === 'gotoArtifactAndClick') {
      const locator = page.locator(action.selector)
      await locator.waitFor({ state: 'visible' })
      await locator.click()
      return {
        clicked: {
          selector: action.selector,
          sheetVisible: await isSheetVisible(page),
        },
      }
    }
  } else if (
    action.kind === 'gotoCliArtifact' ||
    action.kind === 'cliShareAndGoto'
  ) {
    if (!state.cliArtifactId) throw new Error('CLI artifact is unavailable')
    await goto(
      `/a/${state.cliArtifactId}`,
      action.captureDuringNavigation ? 'domcontentloaded' : 'networkidle',
    )
  } else if (action.kind === 'gotoUnreadArtifact') {
    const artifactId = artifactIdFor(session, state.artifactIndex)
    await goto('/recent?unread=1')
    const selector = `main a[href="/a/${artifactId}"]`
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: 'visible' })
    return { inspected: { selector, visible: true } }
  } else if (
    action.kind === 'clickArtifact' ||
    action.kind === 'clickUnreadArtifact'
  ) {
    const artifactId = artifactIdFor(session, state.artifactIndex)
    const baseSelector = `main a[href="/a/${artifactId}"]`
    const selector =
      action.kind === 'clickUnreadArtifact'
        ? `${baseSelector}[aria-label*="Unread"], ${baseSelector}[aria-label*="未読"]`
        : baseSelector
    await page.waitForLoadState('networkidle')
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: 'visible' })
    await Promise.all([
      page.waitForURL(new URL(`/a/${artifactId}`, baseUrl).toString()),
      locator.click(),
    ])
    await page
      .locator('[data-sandbox-state="ready"]')
      .waitFor({ state: 'visible', timeout: 30_000 })
    return { clicked: { selector, destination: `/a/${artifactId}` } }
  } else if (
    action.kind === 'click' ||
    action.kind === 'clickWithClipboardFailure'
  ) {
    if (action.kind === 'clickWithClipboardFailure')
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: () => Promise.reject(new Error('clipboard unavailable')),
          },
        })
        document.execCommand = () => false
      })
    const locator = page.locator(action.selector)
    await locator.waitFor({ state: 'visible' })
    await locator.click()
    const settleMilliseconds = clickSettleMilliseconds(action)
    if (settleMilliseconds > 0) await page.waitForTimeout(settleMilliseconds)
    return {
      clicked: {
        selector: action.selector,
        sheetVisible: await isSheetVisible(page),
      },
    }
  } else if (action.kind === 'inspect') {
    await page.locator(action.selector).first().waitFor({ state: 'visible' })
    return { inspected: { selector: action.selector, visible: true } }
  } else if (action.kind === 'inspectOptional') {
    const locator = page.locator(action.selector).first()
    const present = (await locator.count()) > 0
    return {
      inspected: {
        selector: action.selector,
        present,
        visible: present && (await locator.isVisible()),
      },
    }
  } else if (action.kind === 'wait')
    await page.waitForTimeout(action.milliseconds)
  else if (action.kind === 'readClipboard') {
    const clipboard = await page
      .evaluate(() => navigator.clipboard.readText())
      .catch(() => null)
    if (action.expectedCurrentUrl && clipboard !== page.url())
      throw new Error(
        `clipboard URL mismatch: expected ${page.url()}, received ${clipboard || 'empty'}`,
      )
    return { clipboard }
  } else if (!walkthroughActionKinds.has(action.kind))
    throw new Error(`Unknown walkthrough action: ${action.kind}`)
  return cliEvidence ? { cli: cliEvidence } : {}
}

async function captureRun({
  browser,
  walkthrough,
  task,
  persona,
  baseUrl,
  outDir,
  viewport,
  session,
  tempDir,
  sharedState,
}) {
  const videoDir = join(outDir, 'video')
  await mkdir(videoDir, { recursive: true })
  let activePhase = null
  const videos = []
  const openBranch = async (branchSession, branchName) => {
    const context = await browser.newContext({
      viewport: VIEWPORTS[viewport],
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
      recordVideo: { dir: videoDir, size: VIEWPORTS[viewport] },
      extraHTTPHeaders: {
        'X-ArtifactShare-Dev-Screen-State': walkthrough.scenario,
      },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    await context.addCookies(
      branchSession.cookies.map((cookie) => ({ ...cookie, url: baseUrl })),
    )
    await context.addInitScript(() => {
      let clipboardText = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (value) => {
            clipboardText = String(value)
            globalThis.__taskWalkthroughClipboard = clipboardText
            return Promise.resolve()
          },
          readText: () => Promise.resolve(clipboardText),
        },
      })
    })
    const page = await context.newPage()
    const requestPhases = new WeakMap()
    const failedRequestsByPhase = new Map()
    const phaseFailures = (phase) => {
      if (!failedRequestsByPhase.has(phase))
        failedRequestsByPhase.set(phase, [])
      return failedRequestsByPhase.get(phase)
    }
    page.on('request', (request) => requestPhases.set(request, activePhase))
    page.on('requestfailed', (request) =>
      phaseFailures(
        requestOriginPhase(requestPhases, request, activePhase),
      ).push({
        url: redactEvidenceUrl(request.url()),
        method: request.method(),
        failure: request.failure()?.errorText ?? 'failed',
      }),
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        phaseFailures(
          requestOriginPhase(requestPhases, response.request(), activePhase),
        ).push({
          url: redactEvidenceUrl(response.url()),
          method: response.request().method(),
          status: response.status(),
        })
    })
    return { branchName, closed: false, context, page, phaseFailures }
  }
  const closeBranch = async (branch) => {
    if (branch.closed) return
    const video = branch.page.video()
    await branch.context.close()
    branch.closed = true
    const file = `video/${viewport}-${branch.branchName}.webm`
    await rename(await video.path(), join(outDir, file))
    videos.push({ branch: branch.branchName, file })
  }

  let activeSession = session
  let branch = await openBranch(activeSession, 'success')
  const steps = []
  try {
    for (let index = 0; index < walkthrough.steps.length; index++) {
      const step = walkthrough.steps[index]
      activePhase = step.phase
      if (step.phase === 'failure') {
        await closeBranch(branch)
        activeSession = await signIn(
          baseUrl,
          persona.auth,
          walkthrough.scenario,
        )
        branch = await openBranch(activeSession, 'failure-recovery')
        if (walkthrough.failureStart)
          await applyAction({
            action: walkthrough.failureStart,
            page: branch.page,
            baseUrl,
            session: activeSession,
            state: sharedState,
            tempDir,
          })
      }
      const actionEvidence = await applyAction({
        action: step.action,
        page: branch.page,
        baseUrl,
        session: activeSession,
        state: sharedState,
        tempDir,
      })
      if (
        !step.action.captureDuringNavigation &&
        !new URL(branch.page.url()).pathname.startsWith('/a/')
      )
        await branch.page.waitForLoadState('networkidle').catch(() => {})
      const file = `${String(index + 1).padStart(2, '0')}-${step.phase}-${viewport}.png`
      await branch.page.screenshot({ path: join(outDir, file), fullPage: true })
      steps.push({
        phase: step.phase,
        description: step.description,
        file,
        evidence: {
          url: redactEvidenceUrl(branch.page.url()),
          ...actionEvidence,
          ...(await collectPageEvidence(
            branch.page,
            branch.phaseFailures(step.phase),
          )),
        },
      })
    }
    return { viewport, status: 'success', videos, steps }
  } finally {
    await closeBranch(branch)
  }
}

export async function captureTaskWalkthroughs({
  argv = process.argv.slice(2),
  baseUrl = process.env.SCREEN_CAPTURE_BASE_URL ?? 'https://localhost:5173',
} = {}) {
  const contractFailures = checkTaskWalkthroughs()
  if (contractFailures.length) throw new Error(contractFailures.join('\n'))
  const head = cleanCaptureHead()
  const { selected, label } = parseWalkthroughArgs(argv)
  await preflight(baseUrl, head)
  const playwright = requireFromWeb('playwright')
  const browser = await playwright.chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
    args: ['--host-resolver-rules=MAP *.sandbox.localhost 127.0.0.1'],
  })
  const rootDir = resolve('screen-captures', label)
  const tempDir = resolve('.tmp-task-walkthrough')
  await rm(rootDir, { recursive: true, force: true })
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(rootDir, { recursive: true })
  await mkdir(tempDir, { recursive: true })
  const manifest = []
  try {
    for (const taskId of selected) {
      const walkthrough = taskWalkthroughs.find(
        (item) => item.taskId === taskId,
      )
      const task = tasks.find((item) => item.id === taskId)
      const persona = personas.find((item) => item.id === task.persona)
      const session = await signIn(baseUrl, persona.auth, walkthrough.scenario)
      const outDir = join(rootDir, taskId)
      await mkdir(outDir, { recursive: true })
      const record = { task, persona, scenario: walkthrough.scenario, runs: [] }
      const sharedState = {
        artifactIndex: walkthrough.artifactIndex,
        cliArtifactIds: [],
      }
      let walkthroughError = null
      try {
        for (const viewport of Object.keys(VIEWPORTS)) {
          const viewportSession = await signIn(
            baseUrl,
            persona.auth,
            walkthrough.scenario,
          )
          record.runs.push(
            await captureRun({
              browser,
              walkthrough,
              task,
              persona,
              baseUrl,
              outDir,
              viewport,
              session: viewportSession,
              tempDir,
              sharedState,
            }),
          )
        }
      } catch (error) {
        walkthroughError = error
      }
      let cleanupError = null
      try {
        await cleanupCliArtifacts({
          artifactIds: sharedState.cliArtifactIds,
          state: sharedState,
          deleteArtifact: () =>
            executeCli({
              kind: 'cliDelete',
              baseUrl,
              session,
              tempDir,
              state: sharedState,
            }),
        })
      } catch (error) {
        cleanupError = error
      }
      if (walkthroughError && cleanupError)
        throw combineWalkthroughAndCleanupErrors(walkthroughError, cleanupError)
      if (walkthroughError) throw walkthroughError
      if (cleanupError) throw cleanupError
      await writeTaskIndex(outDir, record)
      await writeFile(
        join(outDir, 'evidence.json'),
        JSON.stringify(record, null, 2),
      )
      manifest.push({
        taskId,
        title: task.title,
        persona: persona.id,
        mediation: persona.mediation,
        auth: persona.auth,
        status: 'success',
        index: `${taskId}/index.html`,
      })
    }
  } finally {
    await browser.close()
    await closeAppFetch()
    await rm(tempDir, { recursive: true, force: true })
  }
  if (cleanCaptureHead() !== head)
    throw new Error('HEAD or worktree changed during task walkthrough capture.')
  await writeFile(
    join(rootDir, 'manifest.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), baseUrl, head, tasks: manifest },
      null,
      2,
    ),
  )
  const links = manifest
    .map(
      (item) =>
        `<li><a href="${htmlEscape(item.index)}">${htmlEscape(item.title)}</a></li>`,
    )
    .join('')
  await writeFile(
    join(rootDir, 'index.html'),
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Task walkthroughs</title><h1>Task walkthroughs</h1><ul>${links}</ul></html>`,
  )
  console.log(
    `task walkthrough capture ok: ${manifest.length} tasks -> ${rootDir}`,
  )
  return { rootDir, manifest }
}

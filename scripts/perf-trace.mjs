import { constants } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appFetch, cookiesFromHeaders } from './lib/dev-sign-in.mjs'

const scenarios = new Set(['home-hover', 'recent-hover', 'project-hover'])
const projectRowSelector =
  '[data-slot="project-row"] a[href^="/projects/"]:not([href="/projects/archived"])'
const fileRowSelector = '[data-slot="file-row"]'

function usage() {
  return `Usage: pnpm perf:trace <scenario> [options]

Scenarios:
  home-hover
  recent-hover
  project-hover

Options:
  --base-url <url>       App URL. Default: PERF_BASE_URL or https://localhost:5173
  --out-dir <path>       Trace output directory. Default: .perf-traces
  --cdp-url <url>        Existing Chrome remote debugging URL, for example http://127.0.0.1:9222
  --chrome-path <path>   Chrome executable path. Default: PERF_CHROME_PATH or common local paths
  --headed               Launch Chrome with a visible window
  --dev-persona <name>   Sign in through the local dev-only persona endpoint
  --dev-scenario <name>  Seed a named local scenario with --dev-persona

Authenticated local pages usually need either --cdp-url connected to a logged-in Chrome,
or a Chrome profile launched manually with remote debugging enabled.`
}

function parseArgs(argv) {
  const [scenario, ...rest] = argv
  if (!scenario || scenario === '-h' || scenario === '--help') {
    console.log(usage())
    process.exit(scenario ? 0 : 1)
  }
  if (!scenarios.has(scenario)) {
    throw new Error(`Unknown scenario: ${scenario}\n\n${usage()}`)
  }

  const options = {
    baseUrl: process.env.PERF_BASE_URL ?? 'https://localhost:5173',
    outDir: process.env.PERF_TRACE_DIR ?? '.perf-traces',
    cdpUrl: process.env.PERF_CDP_URL ?? null,
    chromePath: process.env.PERF_CHROME_PATH ?? null,
    headed: false,
    devPersona: null,
    devScenario: null,
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--') continue
    if (arg === '--headed') {
      options.headed = true
      continue
    }
    if (
      arg === '--base-url' ||
      arg === '--out-dir' ||
      arg === '--cdp-url' ||
      arg === '--chrome-path' ||
      arg === '--dev-persona' ||
      arg === '--dev-scenario'
    ) {
      const value = rest[i + 1]
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${arg}`)
      i += 1
      if (arg === '--base-url') options.baseUrl = value
      if (arg === '--out-dir') options.outDir = value
      if (arg === '--cdp-url') options.cdpUrl = value
      if (arg === '--chrome-path') options.chromePath = value
      if (arg === '--dev-persona') options.devPersona = value
      if (arg === '--dev-scenario') options.devScenario = value
      continue
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`)
  }

  return { scenario, options }
}

function commonChromePaths() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

async function pathExists(path, mode = constants.F_OK) {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

async function findChrome(chromePath) {
  if (chromePath) return chromePath
  for (const candidate of commonChromePaths()) {
    if (await pathExists(candidate, constants.X_OK)) return candidate
  }
  throw new Error(
    'Chrome executable not found. Pass --chrome-path or set PERF_CHROME_PATH.',
  )
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function getFreePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a Chrome remote debugging port.')
  }
  return address.port
}

async function launchChrome(options) {
  if (options.cdpUrl) {
    return { cdpUrl: options.cdpUrl.replace(/\/$/, ''), close: async () => {} }
  }

  const chromePath = await findChrome(options.chromePath)
  const remoteDebuggingPort = await getFreePort()
  const userDataDir = await mkdtemp(join(tmpdir(), 'artifactshare-perf-'))
  const cdpUrl = `http://127.0.0.1:${remoteDebuggingPort}`
  const args = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--ignore-certificate-errors',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-default-browser-check',
    '--no-first-run',
    'about:blank',
  ]
  if (!options.headed) args.unshift('--headless=new')

  const child = spawn(chromePath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`)
      if (response.ok) {
        return {
          cdpUrl,
          close: async () => {
            child.kill()
            await new Promise((resolveClose) => {
              if (child.exitCode !== null) {
                resolveClose()
                return
              }
              const fallback = setTimeout(resolveClose, 3000)
              fallback.unref?.()
              child.once('exit', () => {
                clearTimeout(fallback)
                resolveClose()
              })
            })
            await rm(userDataDir, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 200,
            })
          },
        }
      }
    } catch {
      // Chrome is still starting.
    }
    if (child.exitCode !== null) {
      await rm(userDataDir, { recursive: true, force: true })
      throw new Error(`Chrome exited before DevTools was ready.\n${stderr}`)
    }
    await delay(100)
  }

  child.kill()
  await rm(userDataDir, { recursive: true, force: true })
  throw new Error(`Timed out waiting for Chrome DevTools.\n${stderr}`)
}

async function createTarget(cdpUrl) {
  const targetUrl = 'about:blank'
  let response = await fetch(
    `${cdpUrl}/json/new?${encodeURIComponent(targetUrl)}`,
    {
      method: 'PUT',
    },
  )
  if (!response.ok) {
    response = await fetch(
      `${cdpUrl}/json/new?${encodeURIComponent(targetUrl)}`,
    )
  }
  if (!response.ok) {
    throw new Error(`Failed to create Chrome target: ${response.status}`)
  }
  return response.json()
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.waiters = new Set()
    this.webSocket = new WebSocket(webSocketUrl)
    const rejectPending = () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('CDP WebSocket closed'))
      }
      this.pending.clear()
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error('CDP WebSocket closed'))
      }
      this.waiters.clear()
    }
    this.webSocket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        rejectPending()
        this.webSocket.close()
        return
      }
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)))
        } else {
          pending.resolve(message.result ?? {})
        }
        return
      }
      const listeners = this.listeners.get(message.method) ?? []
      for (const listener of listeners) listener(message.params ?? {})
    })
    this.webSocket.addEventListener('close', rejectPending)
    this.webSocket.addEventListener('error', rejectPending)
  }

  async open() {
    if (this.webSocket.readyState === WebSocket.OPEN) return
    if (this.webSocket.readyState === WebSocket.CLOSED) {
      throw new Error('CDP WebSocket is closed')
    }
    if (this.webSocket.readyState === WebSocket.CLOSING) {
      throw new Error('CDP WebSocket is closing')
    }
    await new Promise((resolveOpen, rejectOpen) => {
      this.webSocket.addEventListener('open', resolveOpen, { once: true })
      this.webSocket.addEventListener('close', rejectOpen, { once: true })
      this.webSocket.addEventListener('error', rejectOpen, { once: true })
    })
  }

  send(method, params = {}) {
    if (this.webSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'))
    }
    const id = this.nextId
    this.nextId += 1
    this.webSocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend })
    })
  }

  waitFor(method, { timeoutMs = 15000 } = {}) {
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        method,
        listener: null,
        reject: rejectWait,
        timeout: null,
      }
      const removeWaiter = () => {
        clearTimeout(waiter.timeout)
        const listeners = this.listeners.get(method) ?? []
        this.listeners.set(
          method,
          listeners.filter((item) => item !== waiter.listener),
        )
        this.waiters.delete(waiter)
      }
      const listener = (params) => {
        removeWaiter()
        resolveWait(params)
      }
      waiter.listener = listener
      waiter.timeout = setTimeout(() => {
        removeWaiter()
        rejectWait(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      this.waiters.add(waiter)
      this.on(method, listener)
    })
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? []
    listeners.push(listener)
    this.listeners.set(method, listeners)
  }

  close() {
    this.webSocket.close()
  }
}

async function evaluate(cdp, expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: options.awaitPromise ?? false,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed')
  }
  return result.result?.value
}

async function navigate(cdp, url) {
  const load = cdp.waitFor('Page.loadEventFired')
  let result
  try {
    result = await cdp.send('Page.navigate', { url })
  } catch (error) {
    load.catch(() => {})
    throw error
  }
  if (result.errorText) {
    load.catch(() => {})
    throw new Error(`Navigation failed for ${url}: ${result.errorText}`)
  }
  await load
  const status = await evaluate(
    cdp,
    `performance.getEntriesByType('navigation')[0]?.responseStatus ?? 200`,
  )
  if (status >= 400) {
    throw new Error(`Navigation failed for ${url}: HTTP ${status}`)
  }
}

async function signInWithDevPersona(cdp, baseUrl, persona, scenario) {
  const url = new URL(baseUrl)
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('--dev-persona is restricted to localhost targets.')
  }
  const response = await appFetch(baseUrl, '/api/auth/dev/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona, ...(scenario ? { scenario } : {}) }),
  })
  if (!response.ok) {
    throw new Error(`Dev persona sign-in failed with HTTP ${response.status}.`)
  }
  const cookies = cookiesFromHeaders(response.headers)
  if (cookies.length === 0) {
    throw new Error('Dev persona sign-in returned no session cookies.')
  }
  await cdp.send('Network.setCookies', {
    cookies: cookies.map(({ name, value }) => ({ name, value, url: baseUrl })),
  })
}

async function waitForSelector(cdp, selector, description) {
  const value = await evaluate(
    cdp,
    `new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        if (document.querySelector(${JSON.stringify(selector)})) {
          resolve({ ok: true });
          return;
        }
        if (Date.now() - startedAt > 10000) {
          resolve({
            ok: false,
            url: location.href,
            title: document.title,
            text: document.body?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 500) ?? ''
          });
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    })`,
    { awaitPromise: true },
  )
  if (!value?.ok) {
    const text = value?.text ?? ''
    const lowerText = text.toLowerCase()
    const authHint =
      text.includes('Google') &&
      (text.includes('ログイン') ||
        lowerText.includes('sign in') ||
        lowerText.includes('continue with google'))
        ? '\nThis page looks unauthenticated. Start a logged-in Chrome with remote debugging and pass --cdp-url, or sign in in that Chrome profile first.'
        : ''
    const emptyHint =
      selector === fileRowSelector && !authHint
        ? '\nThis scenario needs at least one visible file row on the target page.'
        : ''
    throw new Error(
      `Could not find ${description} (${selector}). ` +
        `Current page: ${value?.title ?? 'unknown'} ${value?.url ?? 'unknown'}${authHint}${emptyHint}\n${text}`,
    )
  }
}

function firstRowRect(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const row = document.querySelector(${JSON.stringify(fileRowSelector)});
      if (!row) return null;
      row.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = row.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        text: row.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? ''
      };
    })()`,
  )
}

async function hoverFirstRow(cdp, cycles = 10) {
  const rect = await firstRowRect(cdp)
  if (!rect) throw new Error('No file row found for hover scenario.')
  const clampPoint = (x, y) => ({
    x: Math.max(1, Math.min(rect.viewportWidth - 1, x)),
    y: Math.max(1, Math.min(rect.viewportHeight - 1, y)),
  })
  const inside = clampPoint(
    Math.round(rect.x + rect.width / 2),
    Math.round(rect.y + rect.height / 2),
  )
  const isInsideRow = (point) =>
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  const outsideCandidates = [
    clampPoint(20, 20),
    clampPoint(rect.viewportWidth - 20, 20),
    clampPoint(20, rect.viewportHeight - 20),
    clampPoint(rect.viewportWidth - 20, rect.viewportHeight - 20),
  ]
  const outside = outsideCandidates.find((point) => !isInsideRow(point))
  if (!outside) {
    throw new Error(
      'Could not find a viewport point outside the first file row.',
    )
  }
  for (let i = 0; i < cycles; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: inside.x,
      y: inside.y,
    })
    await delay(80)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: outside.x,
      y: outside.y,
    })
    await delay(80)
  }
  return rect
}

async function runScenario(cdp, scenario, baseUrl) {
  const url = new URL(baseUrl)
  if (scenario === 'recent-hover') url.pathname = '/recent'
  if (scenario === 'project-hover') url.pathname = '/projects'

  await navigate(cdp, url.href)
  await waitForSelector(
    cdp,
    scenario === 'project-hover' ? projectRowSelector : fileRowSelector,
    'scenario starting point',
  )

  if (scenario === 'project-hover') {
    const projectPath = await evaluate(
      cdp,
      `Array.from(document.querySelectorAll(${JSON.stringify(projectRowSelector)}))
        .map((link) => link.getAttribute('href'))
        .find((href) => href && href !== '/projects' && href !== '/projects/archived') ?? null`,
    )
    if (!projectPath)
      throw new Error('No project link found for project-hover.')
    await navigate(cdp, new URL(projectPath, baseUrl).href)
    await waitForSelector(cdp, fileRowSelector, 'project file row')
  }

  const row = await hoverFirstRow(cdp)
  const page = await evaluate(
    cdp,
    `({
      url: location.href,
      title: document.querySelector('h1')?.textContent ?? document.title,
      rowCount: document.querySelectorAll(${JSON.stringify(fileRowSelector)}).length
    })`,
  )
  return { page, row }
}

async function readTraceStream(cdp, stream) {
  let trace = ''
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream })
    trace += chunk.data ?? ''
    if (chunk.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  return trace
}

function traceConfig() {
  return {
    recordMode: 'recordAsMuchAsPossible',
    traceBufferSizeInKb: 100000,
    includedCategories: [
      'devtools.timeline',
      'v8.execute',
      'blink.user_timing',
      'loading',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-v8.cpu_profiler',
    ],
  }
}

async function writeTraceOutput(options, scenario, trace, summary) {
  const outDir = resolve(options.outDir)
  await mkdir(outDir, { recursive: true })
  const recordedAt = new Date().toISOString()
  const filenameTimestamp = recordedAt.replaceAll(':', '-')
  const tracePath = join(outDir, `${filenameTimestamp}-${scenario}.json`)
  const summaryPath = join(
    outDir,
    `${filenameTimestamp}-${scenario}.summary.json`,
  )
  await writeFile(tracePath, trace)
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        scenario,
        baseUrl: options.baseUrl,
        traceFile: basename(tracePath),
        recordedAt,
        ...summary,
      },
      null,
      2,
    )}\n`,
  )
  return { tracePath, summaryPath }
}

async function main() {
  const { scenario, options } = parseArgs(process.argv.slice(2))
  let chrome = null
  let target = null
  let cdp = null
  const errors = []

  try {
    chrome = await launchChrome(options)
    target = await createTarget(chrome.cdpUrl)
    cdp = new CdpClient(target.webSocketDebuggerUrl)

    cdp.on('Runtime.exceptionThrown', (params) => {
      errors.push(params.exceptionDetails?.text ?? 'Runtime exception')
    })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        errors.push(
          params.args?.map((arg) => arg.value ?? arg.description).join(' ') ??
            'Console error',
        )
      }
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') errors.push(params.entry.text)
    })

    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    if (options.devPersona) {
      await signInWithDevPersona(
        cdp,
        options.baseUrl,
        options.devPersona,
        options.devScenario,
      )
    }

    try {
      await cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
        traceConfig: traceConfig(),
      })
    } catch (error) {
      throw new Error(
        `Could not start Chrome tracing. Another Performance recording may already be active. ${error.message}`,
      )
    }

    let result = null
    let scenarioError = null
    try {
      result = await runScenario(cdp, scenario, options.baseUrl)
      await delay(250)
    } catch (error) {
      scenarioError = error
    }

    const tracingComplete = cdp.waitFor('Tracing.tracingComplete', {
      timeoutMs: 30000,
    })
    try {
      await cdp.send('Tracing.end')
    } catch (error) {
      tracingComplete.catch(() => {})
      throw error
    }
    const { stream } = await tracingComplete
    const trace = await readTraceStream(cdp, stream)

    const { tracePath, summaryPath } = await writeTraceOutput(
      options,
      scenario,
      trace,
      {
        ok: !scenarioError,
        error: scenarioError?.message,
        page: result?.page,
        row: result?.row,
        consoleErrors: errors,
      },
    )

    console.log(`Trace written: ${tracePath}`)
    console.log(`Summary written: ${summaryPath}`)
    if (errors.length > 0) {
      console.log(`Console errors captured: ${errors.length}`)
    }
    if (scenarioError) throw scenarioError
  } finally {
    cdp?.close()
    if (options.cdpUrl && target?.id && chrome) {
      await fetch(`${chrome.cdpUrl}/json/close/${target.id}`).catch(() => {})
    }
    await chrome?.close()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})

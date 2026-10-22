import { pathToFileURL } from 'node:url'

const artifact = 'probe00000'
const version = '70726f6265'
const marker = 'artifactshare-sandbox-probe-v1'
const probePath = '/__artifactshare_probe'

/** Only definitive stage responses may select a production deployment path. */
export async function readContentDeliveryStage(
  fetcher = fetch,
  log = console.info,
) {
  const response = await fetcher(
    'https://artifactshare.com/__artifactshare_delivery_stage',
    {
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    },
  )
  let stage = 'refuse'
  if (response.status !== 404) {
    if (response.status !== 200)
      throw new Error(`Content delivery stage check failed: ${response.status}`)
    const body = await response.text()
    if (body !== 'usercontent' && body !== 'refuse')
      throw new Error('Content delivery stage check returned a malformed body')
    stage = body
  }
  log('Content delivery stage check', { status: response.status, stage })
  return stage
}

/** Read-only checks used between protected deployment stages. */
export async function verifyContentCutover(
  stage,
  fetcher = fetch,
  {
    clock = () => performance.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.info,
    timeoutMs = 75_000,
    intervalMs = 2_000,
    requestTimeoutMs = 10_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (!['app-refusal', 'sandbox-ready'].includes(stage)) {
    throw new Error('Expected app-refusal or sandbox-ready')
  }
  const checks = []
  const legacyLink = `https://${artifact}--v-${version}.artifactshare.link`
  const legacySandbox = `https://${artifact}--v-${version}.sandbox.artifactshare.com`
  const paths = ['/', '/style.css', '/download', probePath]
  for (const origin of stage === 'app-refusal'
    ? [legacyLink]
    : [legacyLink, legacySandbox]) {
    for (const path of paths) checks.push({ url: origin + path, status: 404 })
  }
  if (stage === 'sandbox-ready') {
    for (const kind of ['a', 'l']) {
      checks.push({
        url: `https://${kind}-${artifact}--v-${version}.artifactshareusercontent.com${probePath}`,
        status: 200,
        origin:
          kind === 'a'
            ? 'https://artifactshare.com'
            : `https://${artifact}.artifactshare.link`,
        probe: true,
      })
    }
  }
  const deadline = clock() + timeoutMs
  const remaining = () => Math.max(0, deadline - clock())

  // Race both fetch and body consumption: abort alone cannot bound a fetcher
  // that ignores its signal. Inject timers as well as the clock for stalled I/O.
  async function checkOnce(check) {
    const controller = new AbortController()
    const requestDeadline = Math.min(deadline, clock() + requestTimeoutMs)
    let status = 'transport-error'
    let timer
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimer(
          () => {
            controller.abort()
            reject(new Error('Request deadline'))
          },
          Math.min(requestTimeoutMs, remaining()),
        )
      })
      const valid = await Promise.race([
        expired,
        (async () => {
          const response = await fetcher(check.url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: check.origin ? { Origin: check.origin } : {},
          })
          status = response.status
          if (controller.signal.aborted || clock() >= requestDeadline)
            return false
          const body = await response.text()
          return (
            response.status === check.status &&
            (check.probe
              ? body === marker &&
                response.headers.get('X-ArtifactShare-Sandbox-Probe') ===
                  marker &&
                response.headers.get('Cross-Origin-Resource-Policy') ===
                  'cross-origin' &&
                response.headers.get('Access-Control-Allow-Origin') ===
                  check.origin
              : !response.headers.has('X-ArtifactShare-Sandbox-Probe'))
          )
        })(),
      ])
      return { valid: valid && clock() < requestDeadline, status }
    } catch {
      return { valid: false, status }
    } finally {
      clearTimer(timer)
    }
  }

  let lastFailure
  for (let attempt = 1; remaining() > 0; attempt++) {
    const failures = []
    let completed = 0
    for (const check of checks) {
      if (remaining() <= 0) break
      const result = await checkOnce(check)
      completed++
      if (!result.valid) {
        const url = new URL(check.url)
        failures.push({
          stage,
          attempt,
          hostname: url.hostname,
          path: url.pathname,
          status: result.status,
        })
      }
    }
    for (const failure of failures) {
      log('Content cutover verification attempt failed', failure)
      lastFailure = failure
    }
    if (completed === checks.length && failures.length === 0 && remaining() > 0)
      return
    if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
  }
  const last = lastFailure ?? {
    hostname: new URL(checks[0].url).hostname,
    path: new URL(checks[0].url).pathname,
    status: 'transport-error',
  }
  throw new Error(
    `Content cutover verification failed: ${stage} ${last.hostname}${last.path} (${last.status})`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await verifyContentCutover(process.argv[2])
    console.log(`Content cutover verified: ${process.argv[2]}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

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
    expectedDeliveryStage,
  } = {},
) {
  if (!['app-refusal', 'sandbox-ready'].includes(stage)) {
    throw new Error('Expected app-refusal or sandbox-ready')
  }
  if (
    expectedDeliveryStage !== undefined &&
    !['refuse', 'usercontent'].includes(expectedDeliveryStage)
  ) {
    throw new Error('Expected refuse or usercontent delivery confirmation')
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
  if (expectedDeliveryStage) {
    checks.push({
      url: 'https://artifactshare.com/__artifactshare_delivery_stage',
      status: 200,
      deliveryStage: expectedDeliveryStage,
    })
  }
  const deadline = clock() + timeoutMs
  const remaining = () => Math.max(0, deadline - clock())

  // Race both fetch and body consumption: abort alone cannot bound a fetcher
  // that ignores its signal. Inject timers as well as the clock for stalled I/O.
  async function checkOnce(check) {
    const controller = new AbortController()
    const requestDeadline = Math.min(deadline, clock() + requestTimeoutMs)
    let status = 'transport-error'
    let bodyClass
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
            ...(check.deliveryStage ? { cache: 'no-store' } : {}),
          })
          status = response.status
          if (controller.signal.aborted || clock() >= requestDeadline) {
            status = 'transport-error'
            return false
          }
          const body = await response.text()
          if (check.deliveryStage) {
            bodyClass =
              body === 'refuse' || body === 'usercontent' ? body : 'malformed'
            return (
              response.status === check.status && body === check.deliveryStage
            )
          }
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
      if (controller.signal.aborted || clock() >= requestDeadline)
        return { valid: false, status: 'transport-error' }
      return { valid, status, ...(bodyClass ? { bodyClass } : {}) }
    } catch {
      return { valid: false, status: 'transport-error' }
    } finally {
      // Also release I/O when the clock expires before the timer callback runs.
      controller.abort()
      clearTimer(timer)
    }
  }

  let lastFailure
  for (let attempt = 1; remaining() > 0; attempt++) {
    const results = await Promise.all(
      checks.map(async (check) => {
        if (remaining() <= 0) return undefined
        const result = await checkOnce(check)
        if (!result.valid) {
          const url = new URL(check.url)
          const failure = {
            stage,
            attempt,
            hostname: url.hostname,
            path: url.pathname,
            status: result.status,
            ...(result.bodyClass ? { bodyClass: result.bodyClass } : {}),
          }
          log('Content cutover verification attempt failed', failure)
          return { ...result, failure }
        }
        return result
      }),
    )
    // Results retain check order even when responses complete out of order.
    for (const result of results) {
      if (result?.failure) lastFailure = result.failure
    }
    // Each check already validated its deadline. Do not reject a completed
    // passing attempt because time elapsed while collecting its results.
    if (results.every((result) => result?.valid)) return
    if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
  }
  const detail = lastFailure
    ? `${lastFailure.hostname}${lastFailure.path} (${lastFailure.status}${lastFailure.bodyClass ? `, ${lastFailure.bodyClass}` : ''})`
    : 'deadline exhausted before a complete check set; no failing check observed'
  throw new Error(`Content cutover verification failed: ${stage} ${detail}`)
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

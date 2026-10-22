import { pathToFileURL } from 'node:url'

const artifact = 'probe00000'
const version = '70726f6265'
const marker = 'artifactshare-sandbox-probe-v1'
const probePath = '/__artifactshare_probe'

const deliveryStageUrl =
  'https://artifactshare.com/__artifactshare_delivery_stage'
const deliveryStageRequest = { redirect: 'manual', cache: 'no-store' }
const classifyDeliveryStage = (body) =>
  body === 'refuse' || body === 'usercontent' ? body : 'malformed'

// Keep only a small prefix, plus an overflow indication: a matching prefix is
// never sufficient to pass an exact-body check. Cancellation must not extend
// the request deadline, even if the underlying stream ignores it.
async function readVerificationBody(response, signal) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const bytes = new Uint8Array(64)
  let length = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return new TextDecoder().decode(bytes.subarray(0, length))
      if (value.byteLength > bytes.length - length) return undefined
      bytes.set(value, length)
      length += value.byteLength
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

/** Only definitive stage responses may select a production deployment path. */
export async function readContentDeliveryStage(
  fetcher = fetch,
  log = console.info,
) {
  const signal = AbortSignal.timeout(10_000)
  const response = await fetcher(deliveryStageUrl, {
    ...deliveryStageRequest,
    signal,
  })
  let stage = 'refuse'
  if (response.status !== 404) {
    if (response.status !== 200)
      throw new Error(`Content delivery stage check failed: ${response.status}`)
    const body = await readVerificationBody(response, signal)
    if (classifyDeliveryStage(body) === 'malformed')
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
  if (!['app-refusal', 'sandbox-ready', 'final'].includes(stage)) {
    throw new Error('Expected app-refusal, sandbox-ready, or final')
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
  if (stage !== 'app-refusal') {
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
  if (stage !== 'sandbox-ready') {
    checks.push({
      url: deliveryStageUrl,
      status: 200,
      deliveryStage: stage === 'app-refusal' ? 'refuse' : 'usercontent',
    })
  }
  const deadline = clock() + timeoutMs
  const remaining = () => Math.max(0, deadline - clock())

  // Race both fetch and body consumption: abort alone cannot bound a fetcher
  // that ignores its signal. Inject timers as well as the clock for stalled I/O.
  async function checkOnce(check) {
    const controller = new AbortController()
    const requestDeadline = Math.min(deadline, clock() + requestTimeoutMs)
    const assertActive = () => {
      if (controller.signal.aborted || clock() >= requestDeadline)
        throw new Error('Request deadline')
    }
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
      const result = await Promise.race([
        expired,
        (async () => {
          const response = await fetcher(check.url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: check.origin ? { Origin: check.origin } : {},
            ...(check.deliveryStage ? deliveryStageRequest : {}),
          })
          assertActive()
          const body = await readVerificationBody(response, controller.signal)
          if (check.deliveryStage) {
            return {
              status: response.status,
              bodyClass: classifyDeliveryStage(body),
              valid:
                response.status === check.status &&
                body === check.deliveryStage,
            }
          }
          return {
            status: response.status,
            valid:
              response.status === check.status &&
              (check.probe
                ? body === marker &&
                  response.headers.get('X-ArtifactShare-Sandbox-Probe') ===
                    marker &&
                  response.headers.get('Cross-Origin-Resource-Policy') ===
                    'cross-origin' &&
                  response.headers.get('Access-Control-Allow-Origin') ===
                    check.origin
                : !response.headers.has('X-ArtifactShare-Sandbox-Probe')),
          }
        })(),
      ])
      assertActive()
      return result
    } catch {
      return { valid: false, status: 'transport-error' }
    } finally {
      // Also release I/O when the clock expires before the timer callback runs.
      controller.abort()
      clearTimer(timer)
    }
  }

  // Reserve at least one second of useful I/O time (or the configured request
  // cap when smaller). Do not replace observed failures with a token attempt.
  const minimumRequestMs = Math.min(1_000, requestTimeoutMs)
  let lastFailure
  for (
    let attempt = 1;
    remaining() >= minimumRequestMs && remaining() > 0;
    attempt++
  ) {
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
    if (remaining() < intervalMs + minimumRequestMs) break
    await wait(intervalMs)
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

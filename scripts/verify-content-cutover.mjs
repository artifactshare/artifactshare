import { pathToFileURL } from 'node:url'

const artifact = 'probe00000'
const version = '70726f6265'
const marker = 'artifactshare-sandbox-probe-v1'
const probePath = '/__artifactshare_probe'

/** Unknown responses never opt into the steady-state deployment path. */
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
  const stage =
    response.status === 200 && (await response.text()) === 'usercontent'
      ? 'usercontent'
      : 'refuse'
  log('Content delivery stage check', { status: response.status, stage })
  return stage
}

/** Read-only checks used between protected deployment stages. */
export async function verifyContentCutover(stage, fetcher = fetch) {
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
  for (const check of checks) {
    const response = await fetcher(check.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: check.origin ? { Origin: check.origin } : {},
    })
    const body = await response.text()
    if (
      response.status !== check.status ||
      (check.probe &&
        (body !== marker ||
          response.headers.get('X-ArtifactShare-Sandbox-Probe') !== marker ||
          response.headers.get('Cross-Origin-Resource-Policy') !==
            'cross-origin' ||
          response.headers.get('Access-Control-Allow-Origin') !==
            check.origin)) ||
      (!check.probe && response.headers.has('X-ArtifactShare-Sandbox-Probe'))
    ) {
      throw new Error(
        `Content cutover verification failed: ${stage} ${new URL(check.url).hostname}${new URL(check.url).pathname}`,
      )
    }
  }
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

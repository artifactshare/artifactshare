import { pathToFileURL } from 'node:url'

export const WORKER_NAMES = Object.freeze([
  'artifactshare',
  'artifactshare-alerts',
])
export const QUERY_ID = 'artifactshare-observability-token-probe'
export const QUERY_WINDOW_MS = 5 * 60 * 1000
export const FETCH_TIMEOUT_MS = 15 * 1000

export const FAILURE_CLASSIFICATIONS = Object.freeze({
  CONFIGURATION: 'configuration',
  TIMEOUT: 'timeout',
  NETWORK: 'network_error',
  HTTP: 'http_error',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  MALFORMED_JSON: 'malformed_json',
  MALFORMED_RESPONSE: 'malformed_response',
  API_FAILURE: 'api_failure',
  ERROR_ENVELOPE: 'error_envelope',
  MISSING_RESULT: 'missing_result',
  MISSING_RUN: 'missing_run',
  MISSING_CALCULATIONS: 'missing_calculations',
  PROBE_FAILED: 'probe_failed',
})

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu
const ENDPOINT_PREFIX = 'https://api.cloudflare.com/client/v4/accounts/'
const ENDPOINT_SUFFIX = '/workers/observability/telemetry/query'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return value !== ''
}

function hasErrorEnvelope(payload) {
  if ('errors' in payload) {
    if (!Array.isArray(payload.errors) || payload.errors.length > 0) return true
  }
  return nonEmpty(payload.error)
}

function parseConfiguration(env) {
  const token =
    typeof env?.CLOUDFLARE_API_TOKEN === 'string'
      ? env.CLOUDFLARE_API_TOKEN.trim()
      : ''
  const accountId =
    typeof env?.CLOUDFLARE_ACCOUNT_ID === 'string'
      ? env.CLOUDFLARE_ACCOUNT_ID.trim()
      : ''
  if (!token || !ACCOUNT_ID_PATTERN.test(accountId)) return null
  return { accountId, token }
}

function makeTimeframe(now) {
  let to
  try {
    to = now()
  } catch {
    return null
  }
  if (!Number.isSafeInteger(to) || to < QUERY_WINDOW_MS) return null
  return { from: to - QUERY_WINDOW_MS, to }
}

export function buildProbeBody(worker, timeframe) {
  if (!WORKER_NAMES.includes(worker)) throw new Error('Unknown worker')
  return {
    queryId: QUERY_ID,
    timeframe,
    dry: true,
    view: 'calculations',
    chartType: 'aggregate',
    parameters: {
      calculations: [{ operator: 'count', alias: 'events' }],
      filterCombination: 'and',
      filters: [
        {
          key: '$metadata.service',
          operation: 'eq',
          type: 'string',
          value: worker,
        },
      ],
    },
  }
}

function safeStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined
}

function httpClassification(status) {
  if (status === 401) return FAILURE_CLASSIFICATIONS.UNAUTHORIZED
  if (status === 403) return FAILURE_CLASSIFICATIONS.FORBIDDEN
  return FAILURE_CLASSIFICATIONS.HTTP
}

function isTimeout(error, signal) {
  return signal?.aborted === true || error?.name === 'TimeoutError'
}

function failure(worker, classification, status) {
  return {
    worker,
    success: false,
    classification,
    ...(safeStatus(status) === undefined ? {} : { status: safeStatus(status) }),
  }
}

async function probeWorker({ worker, input, timeframe, fetchImpl }) {
  const endpoint = `${ENDPOINT_PREFIX}${input.accountId}${ENDPOINT_SUFFIX}`
  const body = buildProbeBody(worker, timeframe)
  let signal
  let response
  try {
    signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    return failure(
      worker,
      isTimeout(error, signal)
        ? FAILURE_CLASSIFICATIONS.TIMEOUT
        : FAILURE_CLASSIFICATIONS.NETWORK,
    )
  }

  if (!response || typeof response.ok !== 'boolean')
    return failure(worker, FAILURE_CLASSIFICATIONS.MALFORMED_RESPONSE)
  if (!response.ok) {
    const status = safeStatus(response.status)
    return failure(worker, httpClassification(status), status)
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return failure(worker, FAILURE_CLASSIFICATIONS.MALFORMED_JSON)
  }
  if (!isRecord(payload))
    return failure(worker, FAILURE_CLASSIFICATIONS.MALFORMED_RESPONSE)
  if (hasErrorEnvelope(payload))
    return failure(worker, FAILURE_CLASSIFICATIONS.ERROR_ENVELOPE)
  if (payload.success !== true)
    return failure(worker, FAILURE_CLASSIFICATIONS.API_FAILURE)
  if (!isRecord(payload.result))
    return failure(worker, FAILURE_CLASSIFICATIONS.MISSING_RESULT)
  if (!isRecord(payload.result.run))
    return failure(worker, FAILURE_CLASSIFICATIONS.MISSING_RUN)
  if (!Array.isArray(payload.result.calculations))
    return failure(worker, FAILURE_CLASSIFICATIONS.MISSING_CALCULATIONS)
  return { worker, success: true }
}

export async function probeObservabilityToken({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const input = parseConfiguration(env)
  const timeframe = input ? makeTimeframe(now) : null
  const results = []
  for (const worker of WORKER_NAMES) {
    if (!input || !timeframe) {
      results.push(failure(worker, FAILURE_CLASSIFICATIONS.CONFIGURATION))
      continue
    }
    try {
      results.push(await probeWorker({ worker, input, timeframe, fetchImpl }))
    } catch {
      results.push(failure(worker, FAILURE_CLASSIFICATIONS.PROBE_FAILED))
    }
  }
  return results
}

function safeClassification(classification) {
  return Object.values(FAILURE_CLASSIFICATIONS).includes(classification)
    ? classification
    : FAILURE_CLASSIFICATIONS.PROBE_FAILED
}

export function formatProbeResults(results) {
  return WORKER_NAMES.map((worker, index) => {
    const result = results[index]
    if (result?.success === true) return `${worker}: success`
    const classification = safeClassification(result?.classification)
    const status = safeStatus(result?.status)
    return status === undefined
      ? `${worker}: failure (${classification})`
      : `${worker}: failure (HTTP ${status}; ${classification})`
  }).join('\n')
}

export async function runCli({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  stdout = process.stdout,
} = {}) {
  let results
  try {
    results = await probeObservabilityToken({ env, fetchImpl, now })
  } catch {
    results = WORKER_NAMES.map((worker) =>
      failure(worker, FAILURE_CLASSIFICATIONS.PROBE_FAILED),
    )
  }
  stdout.write(`${formatProbeResults(results)}\n`)
  return results.every((result) => result.success === true) ? 0 : 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await runCli()
  process.exitCode = exitCode
}

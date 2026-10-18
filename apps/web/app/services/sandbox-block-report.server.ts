import { isIP } from 'node:net'
import {
  isSandboxArtifactId,
  isSandboxBlockFailureType,
  isUtcIsoMilliseconds,
} from '~/lib/sandbox-block-report'
import { isSameOriginRequest } from '~/lib/same-origin-request'
import { createDb } from '~/services/db.server'
import type { ViewerRateLimiter } from './viewer-rate-limit.server'

// Total deadlines for auxiliary telemetry, never renewed by incoming chunks.
export const REPORT_ADMISSION_MS = 1_000
export const REPORT_BODY_MS = 2_000
export const REPORT_MAX_BYTES = 1024
const reportCooldownMs = 60_000
const reportCooldowns = new Map<string, number>()

export function reportResponse(status: number, body: object) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    },
  })
}

export function reportMethodNotAllowed() {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

function invalid() {
  return reportResponse(400, { error: 'invalid-payload' })
}
function unavailable() {
  return reportResponse(503, { error: 'report-unavailable' })
}

// Never wait for user-controlled cancellation, including synchronous throws.
export function cancelReportBody(request: Request) {
  cancel(() => request.body?.cancel())
}
function cancel(operation: () => Promise<unknown> | undefined) {
  try {
    void operation()?.catch(() => {})
  } catch {
    /* Cancellation is best effort. */
  }
}

export function reportArtifactId(pathname: string): string | null {
  const singleFetch = pathname.endsWith('.data')
  const path = singleFetch ? pathname.slice(0, -5) : pathname
  let segments: string[]
  try {
    segments = path.split('/').slice(1).map(decodeURIComponent)
    while (segments.at(-1) === '') segments.pop()
  } catch {
    return null
  }
  if (singleFetch && segments.at(-1) === '_') {
    segments.pop()
    while (segments.at(-1) === '') segments.pop()
  }
  if (
    segments.length !== 4 ||
    segments[0]?.toLowerCase() !== 'api' ||
    segments[1]?.toLowerCase() !== 'shareables' ||
    segments[3]?.toLowerCase() !== 'sandbox-block-report'
  )
    return null
  return segments[2] ?? null
}

export function reportSourceKey(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip || ip.includes('%')) return null
  const version = isIP(ip)
  if (version === 4) return ip
  if (version === 6) {
    try {
      return new URL(`http://[${ip}]/`).hostname
    } catch {
      return null
    }
  }
  return null
}

class ReportFailure extends Error {
  constructor(readonly response: Response) {
    super('Report rejected')
  }
}

function deadline(signal: AbortSignal, ms: number, timeout: () => Response) {
  let reject!: (reason: ReportFailure) => void
  const terminal = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise
  })
  // An already-aborted signal can reject before the caller reaches race().
  // Observe it immediately while preserving the rejected promise for races.
  void terminal.catch(() => {})
  const abort = () => reject(new ReportFailure(invalid()))
  const timer = setTimeout(() => reject(new ReportFailure(timeout())), ms)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    race<T>(operation: Promise<T>) {
      // A previously observed deadline/abort wins over an immediately ready read.
      return Promise.race([terminal, operation])
    },
    close() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    },
  }
}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('Content-Length')
  if (length && /^\d+$/.test(length) && Number(length) > REPORT_MAX_BYTES)
    throw new ReportFailure(reportResponse(413, { error: 'payload-too-large' }))
  if (!request.body) throw new ReportFailure(invalid())
  const reader = request.body.getReader()
  const clock = deadline(request.signal, REPORT_BODY_MS, () =>
    reportResponse(408, { error: 'request-timeout' }),
  )
  const bytes = new Uint8Array(REPORT_MAX_BYTES)
  let size = 0
  let complete = false
  try {
    for (let chunks = 0; ; chunks++) {
      if (request.signal.aborted) throw new ReportFailure(invalid())
      // Yield to deadline/abort tasks even for an endless stream of empty chunks.
      if (chunks > 0 && chunks % 32 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const { done, value } = await clock.race(reader.read())
      if (done) {
        complete = true
        break
      }
      if (!(value instanceof Uint8Array)) throw new ReportFailure(invalid())
      if (size + value.byteLength > REPORT_MAX_BYTES)
        throw new ReportFailure(
          reportResponse(413, { error: 'payload-too-large' }),
        )
      bytes.set(value, size)
      size += value.byteLength
    }
    if (request.signal.aborted) throw new ReportFailure(invalid())
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
    )
  } finally {
    clock.close()
    if (!complete) cancel(() => reader.cancel())
    reader.releaseLock()
  }
}

export async function prepareSandboxBlockReport(
  request: Request,
  id: string | undefined,
  limiter: ViewerRateLimiter | undefined,
) {
  const reject = (response: Response) => {
    cancelReportBody(request)
    return response
  }
  if (request.method !== 'POST') return reject(reportMethodNotAllowed())
  if (!isSameOriginRequest(request))
    return reject(reportResponse(403, { error: 'forbidden' }))
  if (request.signal.aborted) return reject(invalid())
  const key = reportSourceKey(request)
  if (!key || typeof limiter?.limit !== 'function') return reject(unavailable())
  const clock = deadline(request.signal, REPORT_ADMISSION_MS, unavailable)
  try {
    const result = await clock.race(
      Promise.resolve().then(() => limiter.limit({ key })),
    )
    if (!result || typeof result.success !== 'boolean')
      return reject(unavailable())
    if (!result.success)
      return reject(reportResponse(429, { error: 'rate-limited' }))
  } catch (error) {
    return reject(
      error instanceof ReportFailure ? error.response : unavailable(),
    )
  } finally {
    clock.close()
  }
  let body: unknown
  try {
    body = await readBody(request)
  } catch (error) {
    return reject(error instanceof ReportFailure ? error.response : invalid())
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
    'artifactId,confirmedAt,failureType'
  )
    return invalid()
  if (
    typeof record.artifactId !== 'string' ||
    id !== record.artifactId ||
    !isSandboxArtifactId(record.artifactId)
  )
    return invalid()
  if (!isSandboxBlockFailureType(record.failureType)) return invalid()
  if (!isUtcIsoMilliseconds(record.confirmedAt)) return invalid()
  return {
    artifactId: record.artifactId,
    failureType: record.failureType,
    confirmedAt: record.confirmedAt,
  }
}

export async function finishSandboxBlockReport(
  request: Request,
  record: Exclude<
    Awaited<ReturnType<typeof prepareSandboxBlockReport>>,
    Response
  >,
) {
  if (request.signal.aborted) return invalid()
  const shareable = await createDb()
    .selectFrom('shareables')
    .select('id')
    .where('id', '=', record.artifactId)
    .executeTakeFirst()
  if (!shareable) return reportResponse(200, { accepted: true })
  const cooldownKey = `${record.artifactId}:${record.failureType}`
  const now = Date.now()
  const lastReportedAt = reportCooldowns.get(cooldownKey)
  if (lastReportedAt !== undefined && now - lastReportedAt < reportCooldownMs)
    return reportResponse(200, { accepted: true })
  if (reportCooldowns.size >= 512) {
    const oldestKey = reportCooldowns.keys().next().value
    if (oldestKey !== undefined) reportCooldowns.delete(oldestKey)
  }
  reportCooldowns.set(cooldownKey, now)
  console.warn('artifactshare_sandbox_block_report', {
    artifactId: record.artifactId,
    failureType: record.failureType,
    confirmedAt: record.confirmedAt,
  })
  return reportResponse(200, { accepted: true })
}

export async function handleSandboxBlockReport(
  request: Request,
  id: string | undefined,
  limiter: ViewerRateLimiter | undefined,
) {
  const prepared = await prepareSandboxBlockReport(request, id, limiter)
  return prepared instanceof Response
    ? prepared
    : finishSandboxBlockReport(request, prepared)
}

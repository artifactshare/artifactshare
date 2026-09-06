import { env } from 'cloudflare:workers'
import { isLinkReportReason } from '~/lib/link-report'
import { isProduction, linkViewerUrl } from '~/lib/hosts'
import { isSandboxArtifactId } from '~/lib/sandbox-block-report'
import { isSameOriginRequest } from '~/lib/same-origin-request'
import { linkDomainContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { recordLinkReport } from '~/services/link-reports.server'
import { anonymousReportViewerId } from '~/services/views.server'
import type { Route } from './+types/api.shareables.$id.report'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const
const MAX_NOTE_LENGTH = 500
const reportCooldownMs = 60_000
export const REPORT_COOLDOWN_CAPACITY = 4_096

export class ReportCooldownCache {
  readonly #entries = new Map<string, number>()

  constructor(readonly capacity: number) {}

  get(key: string): number | undefined {
    const value = this.#entries.get(key)
    if (value === undefined) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  set(key: string, value: number): void {
    this.#entries.delete(key)
    if (this.#entries.size >= this.capacity) {
      const leastRecentlyUsedKey = this.#entries.keys().next().value
      if (leastRecentlyUsedKey !== undefined) {
        this.#entries.delete(leastRecentlyUsedKey)
      }
    }
    this.#entries.set(key, value)
  }
}

const reportCooldowns = new ReportCooldownCache(REPORT_COOLDOWN_CAPACITY)

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const linkDomain = context.get(linkDomainContext)
  if (!linkDomain || linkDomain.shareableId !== params.id) return notFound()
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: 'forbidden' },
      { status: 403, headers: NO_STORE_HEADERS },
    )
  }
  if (!isSandboxArtifactId(params.id)) return notFound()

  const report = parseReport(await request.json().catch(() => null))
  if (!report) {
    return Response.json(
      { error: 'invalid-report' },
      { status: 400, headers: NO_STORE_HEADERS },
    )
  }

  const now = Date.now()
  const viewerId = await anonymousReportViewerId(
    request,
    env.BETTER_AUTH_SECRET,
  )
  const cooldownKey = `${params.id}:${viewerId}`
  const lastReportedAt = reportCooldowns.get(cooldownKey)
  if (lastReportedAt !== undefined && now - lastReportedAt < reportCooldownMs) {
    return reported()
  }

  const result = await recordLinkReport(createDb(), params.id, {
    ...report,
    viewerUrl: linkViewerUrl(isProduction(env), params.id),
  })
  if (result === 'not-found') return notFound()
  reportCooldowns.set(cooldownKey, now)
  return reported()
}

function parseReport(body: unknown): {
  reason: import('~/lib/link-report').LinkReportReason
  note: string | null
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (!Object.keys(record).every((key) => key === 'reason' || key === 'note')) {
    return null
  }
  if (!isLinkReportReason(record.reason)) return null
  if (
    record.note !== undefined &&
    (typeof record.note !== 'string' || record.note.length > MAX_NOTE_LENGTH)
  ) {
    return null
  }
  const note = typeof record.note === 'string' ? record.note.trim() : ''
  return {
    reason: record.reason,
    note: note.length > 0 ? note : null,
  }
}

function notFound() {
  return Response.json(
    { error: 'not-found' },
    { status: 404, headers: NO_STORE_HEADERS },
  )
}

function reported() {
  return Response.json({ reported: true }, { headers: NO_STORE_HEADERS })
}

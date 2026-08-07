import type { Route } from './+types/api.shareables.$id.sandbox-block-report'
import {
  isSandboxArtifactId,
  isSandboxBlockFailureType,
  isUtcIsoMilliseconds,
} from '~/lib/sandbox-block-report'
import { createDb } from '~/services/db.server'

const reportCooldownMs = 60_000
const reportCooldowns = new Map<string, number>()

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  if (!isSameOriginRequest(request))
    return Response.json({ error: 'forbidden' }, { status: 403 })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
    'artifactId,confirmedAt,failureType'
  )
    return invalid()
  if (
    typeof record.artifactId !== 'string' ||
    params.id !== record.artifactId ||
    !isSandboxArtifactId(record.artifactId)
  )
    return invalid()
  if (!isSandboxBlockFailureType(record.failureType)) return invalid()
  if (!isUtcIsoMilliseconds(record.confirmedAt)) return invalid()
  const shareable = await createDb()
    .selectFrom('shareables')
    .select('id')
    .where('id', '=', record.artifactId)
    .executeTakeFirst()
  if (!shareable) return Response.json({ accepted: true })
  const cooldownKey = `${record.artifactId}:${record.failureType}`
  const now = Date.now()
  const lastReportedAt = reportCooldowns.get(cooldownKey)
  if (lastReportedAt !== undefined && now - lastReportedAt < reportCooldownMs)
    return Response.json({ accepted: true })
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
  return Response.json({ accepted: true })
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (origin !== new URL(request.url).origin) return false
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  return fetchSite === null || fetchSite === 'same-origin'
}

function invalid() {
  return Response.json({ error: 'invalid-payload' }, { status: 400 })
}

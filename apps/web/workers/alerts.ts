type AlertEnv = {
  ALERT_STATE: KVNamespace
  APP_ENV: string
  SLACK_ALERT_WEBHOOK_URL?: string
  LINK_OPS_ACTION_SECRET?: string
}

type SlackBlock = {
  type: 'section'
  text: {
    type: 'mrkdwn'
    text: string
  }
}

type Alert = {
  key: string
  title: string
  summary: string
  fields: string[]
  cooldownSeconds: number | null
}
import {
  isSandboxArtifactId,
  isSandboxBlockFailureType,
  isUtcIsoMilliseconds,
} from '../app/lib/sandbox-block-report'
import { isLinkReportReason } from '../app/lib/link-report'
import { linkOpsUrl, signLinkOpsToken } from '../app/lib/link-ops-token'
import { nanoid } from 'nanoid'

const alertPrefix = 'ops-alerts'
const authHangLogMarker = 'artifactshare_auth_hang'
const sandboxBlockReportMarker = 'artifactshare_sandbox_block_report'
const linkReportMarker = 'artifactshare_link_report'
const linkAbuseJudgmentMarker = 'artifactshare_link_abuse_judgment'
const linkSuspensionMarker = 'artifactshare_link_suspension'
const linkAppealMarker = 'artifactshare_link_appeal'
const workspaceMigrationWaitMarker = 'artifactshare_workspace_migration_wait'
const fiveXxWindowSeconds = 300
const fiveXxBucketSeconds = 30
const fiveXxThreshold = 5
const fiveXxCooldownSeconds = 900
const immediateCooldownSeconds = 300
const slackFailureBackoffSeconds = 60

export default {
  async tail(events, env) {
    // cooldown 判定と 5xx バケット加算の KV read-modify-write が順序依存のため
    // sequential が仕様。
    for (const event of events) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const alert = await alertFromTrace(event, env)
        if (alert) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await sendAlertWithCooldown(alert, env)
        }
      } catch {
        console.error('slack_alert_event_failed', {
          worker: safeScriptName(event),
          outcome: escapeSlackText(event.outcome),
        })
      }
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const migrationWait = workspaceMigrationWaitFromLogs(event)
        if (migrationWait) {
          await sendAlertWithCooldown(
            {
              key: `workspace-migration-wait:${migrationWait.revision}`,
              title: 'Artifact Share workspace migration waiting',
              summary: 'Workspace migrations require operator review.',
              fields: ['action: Review the protected operations dashboard.'],
              cooldownSeconds: null,
            },
            env,
          )
        }
      } catch {
        console.error('slack_alert_event_failed', {
          worker: safeScriptName(event),
          outcome: escapeSlackText(event.outcome),
        })
      }
    }
  },
} satisfies ExportedHandler<AlertEnv>

async function alertFromTrace(
  item: TraceItem,
  env: AlertEnv,
): Promise<Alert | null> {
  const scheduled = scheduledEvent(item)
  if (scheduled && item.outcome !== 'ok') {
    return {
      key: `cron:${safeScriptName(item)}:${scheduled.cron}`,
      title: 'Artifact Share cron failed',
      summary: 'Scheduled Worker invocation finished with a failed outcome.',
      fields: [
        `worker: ${safeScriptName(item)}`,
        `cron: ${escapeSlackText(scheduled.cron)}`,
        `outcome: ${escapeSlackText(item.outcome)}`,
        `scheduled: ${new Date(scheduled.scheduledTime).toISOString()}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  }

  if (item.exceptions.length > 0) {
    const exceptionFields = [
      `worker: ${safeScriptName(item)}`,
      `outcome: ${escapeSlackText(item.outcome)}`,
      `exceptions: ${exceptionSummary(item.exceptions)}`,
    ]
    const fetchInfo = fetchEvent(item)
    if (fetchInfo)
      exceptionFields.push(`path: ${safePath(fetchInfo.request.url)}`)

    return {
      key: `exception:${safeScriptName(item)}:${item.outcome}`,
      title: 'Artifact Share uncaught exception',
      summary: 'Worker invocation recorded an exception.',
      fields: exceptionFields,
      cooldownSeconds: immediateCooldownSeconds,
    }
  }

  const fetchInfo = fetchEvent(item)
  const status = fetchInfo?.response?.status
  const sandboxReport = sandboxBlockReportFromLogs(item)
  if (sandboxReport)
    return {
      key: `sandbox-block:${sandboxReport.artifactId}:${sandboxReport.failureType}`,
      title: 'Artifact Share sandbox blocked',
      summary: 'A browser confirmed that sandbox delivery was blocked.',
      fields: [
        `artifact: ${escapeSlackText(sandboxReport.artifactId)}`,
        `failure: ${escapeSlackText(sandboxReport.failureType)}`,
        `confirmed: ${escapeSlackText(sandboxReport.confirmedAt)}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }

  const linkReport = linkReportFromLogs(item)
  if (linkReport)
    return {
      key: `link-report:${linkReport.shareableId}`,
      title: 'Artifact Share link reported',
      summary: 'A visitor reported user-shared content.',
      fields: [
        `artifact: ${escapeSlackText(linkReport.shareableId)}`,
        `workspace: ${escapeSlackText(linkReport.workspaceId)}`,
        `reason: ${escapeSlackText(linkReport.reason)}`,
        `viewer: ${escapeSlackText(linkReport.viewerUrl)}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  const linkSuspension = linkSuspensionFromLogs(item)
  if (linkSuspension)
    return {
      key: `link-suspension:${linkSuspension.shareableId}:${linkSuspension.action}`,
      title:
        linkSuspension.action === 'suspend'
          ? 'Artifact Share link paused'
          : 'Artifact Share link resumed',
      summary:
        linkSuspension.action === 'suspend'
          ? 'An operator paused link sharing.'
          : 'An operator resumed link sharing.',
      fields: [
        `artifact: ${escapeSlackText(linkSuspension.shareableId)}`,
        `workspace: ${escapeSlackText(linkSuspension.workspaceId)}`,
        `owner email: ${linkSuspension.ownerNotice}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  const linkAppeal = linkAppealFromLogs(item)
  if (linkAppeal) {
    const actionUrl = await linkOpsActionUrl(linkAppeal, env)
    return {
      key: `link-appeal:${linkAppeal.shareableId}`,
      title: 'Artifact Share link appeal',
      summary: 'The owner of a paused link asked for it to be shared again.',
      fields: [
        `artifact: ${escapeSlackText(linkAppeal.shareableId)}`,
        `workspace: ${escapeSlackText(linkAppeal.workspaceId)}`,
        `appeal: ${escapeSlackText(linkAppeal.message)}`,
        `manage: <${linkAppeal.manageUrl}|file page>`,
        actionUrl
          ? `operate: <${actionUrl}|resume link sharing>`
          : 'operate: no signed link in this notification',
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  }
  const linkAbuseJudgment = linkAbuseJudgmentFromLogs(item)
  if (linkAbuseJudgment) {
    const artifactUrl = `https://${linkAbuseJudgment.shareableId}.artifactshare.link/`
    const actionUrl = await linkOpsActionUrl(linkAbuseJudgment, env)
    const listedTargets = linkAbuseJudgment.externalTargets.slice(0, 10)
    const remainingTargets = linkAbuseJudgment.externalTargets.length - 10
    return {
      key: `link-abuse:${linkAbuseJudgment.shareableId}:${linkAbuseJudgment.risk}`,
      title: 'Artifact Share link abuse judgment',
      summary:
        linkAbuseJudgment.risk === 'low'
          ? 'A triggered review found no concern; visibility was not changed.'
          : 'A triggered review requires operator attention; visibility was not changed.',
      fields: [
        `risk: ${linkAbuseJudgment.risk}`,
        `trigger: ${linkAbuseJudgment.trigger}`,
        `reason: ${escapeSlackText(truncateCodePoints(linkAbuseJudgment.reason, 300))}`,
        `artifact: <${artifactUrl}|anonymous link>`,
        `manage: <${linkAbuseJudgment.manageUrl}|visibility controls>`,
        actionUrl
          ? `operate: <${actionUrl}|pause or resume link sharing>`
          : 'operate: no signed link in this notification',
        `impersonated brand: ${escapeSlackText(linkAbuseJudgment.impersonatedBrand ?? 'none')}`,
        `external targets: ${listedTargets.length > 0 ? `${escapeSlackText(truncateCodePoints(listedTargets.join(', '), 500))}${remainingTargets > 0 ? `, +${remainingTargets} more` : ''}` : 'none'}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  }

  // Checked only for non-5xx fetch traces so a 5xx that also carries the
  // marker still feeds the 5xx burst counter below.
  const authHang =
    fetchInfo && (!status || status < 500) ? authHangFromLogs(item) : null
  if (authHang) {
    return {
      key: `auth-hang:${authHang.recovered}`,
      title: 'Artifact Share auth hang recovery',
      summary: 'getSession hung and the auth instance was rebuilt.',
      fields: [
        `worker: ${safeScriptName(item)}`,
        `recovered: ${authHang.recovered}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  }

  if (!status || status < 500) {
    if (!fetchInfo || item.outcome === 'ok') return null
    return {
      key: `fetch-outcome:${safeScriptName(item)}:${item.outcome}`,
      title: 'Artifact Share request failed',
      summary: 'Fetch Worker invocation finished with a failed outcome.',
      fields: [
        `worker: ${safeScriptName(item)}`,
        `outcome: ${escapeSlackText(item.outcome)}`,
        `path: ${safePath(fetchInfo.request.url)}`,
      ],
      cooldownSeconds: immediateCooldownSeconds,
    }
  }

  const count = await incrementFiveXxCount(item, env)
  if (count < fiveXxThreshold) return null

  return {
    key: `5xx:${safeScriptName(item)}`,
    title: 'Artifact Share 5xx burst',
    summary: `HTTP 5xx reached ${count} events in ${fiveXxWindowSeconds / 60} minutes.`,
    fields: [
      `worker: ${safeScriptName(item)}`,
      `status: ${status}`,
      `path: ${safePath(fetchInfo.request.url)}`,
      `window: ${fiveXxWindowSeconds / 60} minutes`,
    ],
    cooldownSeconds: fiveXxCooldownSeconds,
  }
}

async function sendAlertWithCooldown(
  alert: Alert,
  env: AlertEnv,
): Promise<void> {
  if (!env.SLACK_ALERT_WEBHOOK_URL) {
    console.error('slack_alert_webhook_missing', {
      alert: alert.key,
      appEnv: env.APP_ENV,
    })
    return
  }

  const cooldownKey = `${alertPrefix}/cooldown/${alert.key}`
  if (await env.ALERT_STATE.get(cooldownKey)) return

  const failureBackoffKey = `${alertPrefix}/slack-failure/${alert.key}`
  if (await env.ALERT_STATE.get(failureBackoffKey)) return

  try {
    const response = await fetch(env.SLACK_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slackPayload(alert)),
    })
    if (response.ok) {
      await env.ALERT_STATE.put(
        cooldownKey,
        new Date().toISOString(),
        alert.cooldownSeconds === null
          ? undefined
          : { expirationTtl: alert.cooldownSeconds },
      )
      return
    }
    console.error('slack_alert_webhook_failed', {
      alert: alert.key,
      status: response.status,
    })
  } catch {
    console.error('slack_alert_webhook_failed', { alert: alert.key })
  }
  await env.ALERT_STATE.put(failureBackoffKey, new Date().toISOString(), {
    expirationTtl: slackFailureBackoffSeconds,
  })
}

function slackPayload(alert: Alert): { text: string; blocks: SlackBlock[] } {
  const body = [
    `*${escapeSlackText(alert.title)}*`,
    escapeSlackText(alert.summary),
    ...alert.fields.map((field) => `• ${field}`),
  ].join('\n')
  return {
    text: `${alert.title}: ${alert.summary}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: body,
        },
      },
    ],
  }
}

async function incrementFiveXxCount(
  item: TraceItem,
  env: AlertEnv,
): Promise<number> {
  const timestamp = item.eventTimestamp ?? Date.now()
  const bucket = Math.floor(timestamp / (fiveXxBucketSeconds * 1000))
  const currentKey = fiveXxBucketKey(item, bucket)
  const current = Number.parseInt(
    (await env.ALERT_STATE.get(currentKey)) ?? '0',
    10,
  )
  const next = Number.isFinite(current) ? current + 1 : 1

  const bucketsToRead = Math.ceil(fiveXxWindowSeconds / fiveXxBucketSeconds)
  const pastBucketValues = (
    await Promise.all([
      env.ALERT_STATE.put(currentKey, String(next), {
        expirationTtl: fiveXxWindowSeconds + fiveXxBucketSeconds * 2,
      }),
      ...Array.from({ length: bucketsToRead }, (_, index) =>
        env.ALERT_STATE.get(fiveXxBucketKey(item, bucket - (index + 1))),
      ),
    ])
  ).slice(1)
  let count = next
  for (const value of pastBucketValues) {
    count += Number.parseInt(value ?? '0', 10) || 0
  }
  return count
}

function fiveXxBucketKey(item: TraceItem, bucket: number): string {
  return `${alertPrefix}/5xx/${safeScriptName(item)}/${bucket}`
}

function authHangFromLogs(item: TraceItem): { recovered: string } | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (marker !== authHangLogMarker) continue
    const raw = (detail ?? {}) as { recovered?: unknown }
    return { recovered: escapeSlackText(String(raw.recovered ?? '?')) }
  }
  return null
}

function sandboxBlockReportFromLogs(
  item: TraceItem,
): { artifactId: string; failureType: string; confirmedAt: string } | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (
      marker !== sandboxBlockReportMarker ||
      !detail ||
      typeof detail !== 'object'
    )
      continue
    const raw = detail as Record<string, unknown>
    if (
      Object.keys(raw).sort().join(',') !== 'artifactId,confirmedAt,failureType'
    )
      continue
    if (!isSandboxArtifactId(raw.artifactId)) continue
    if (!isSandboxBlockFailureType(raw.failureType)) continue
    if (!isUtcIsoMilliseconds(raw.confirmedAt)) continue
    return {
      artifactId: raw.artifactId,
      failureType: raw.failureType,
      confirmedAt: raw.confirmedAt,
    }
  }
  return null
}

function linkReportFromLogs(item: TraceItem): {
  shareableId: string
  workspaceId: string
  reason: string
  viewerUrl: string
} | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (marker !== linkReportMarker || !detail || typeof detail !== 'object')
      continue
    const raw = detail as Record<string, unknown>
    if (
      Object.keys(raw).sort().join(',') !==
      'reason,shareableId,viewerUrl,workspaceId'
    )
      continue
    if (!isSandboxArtifactId(raw.shareableId)) continue
    if (
      typeof raw.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{21}$/.test(raw.workspaceId)
    )
      continue
    if (!isLinkReportReason(raw.reason)) continue
    if (raw.viewerUrl !== `https://${raw.shareableId}.artifactshare.link/`)
      continue
    return {
      shareableId: raw.shareableId,
      workspaceId: raw.workspaceId,
      reason: raw.reason,
      viewerUrl: raw.viewerUrl,
    }
  }
  return null
}

function workspaceMigrationWaitFromLogs(
  item: TraceItem,
): { revision: number } | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (
      marker !== workspaceMigrationWaitMarker ||
      !detail ||
      typeof detail !== 'object'
    )
      continue
    const raw = detail as Record<string, unknown>
    if (Object.keys(raw).join(',') !== 'revision') continue
    if (
      typeof raw.revision !== 'number' ||
      !Number.isInteger(raw.revision) ||
      raw.revision < 1
    )
      continue
    return { revision: raw.revision }
  }
  return null
}

function fetchEvent(item: TraceItem): TraceItemFetchEventInfo | null {
  return item.event && 'request' in item.event ? item.event : null
}

function scheduledEvent(item: TraceItem): TraceItemScheduledEventInfo | null {
  return item.event && 'cron' in item.event ? item.event : null
}

function safeScriptName(item: TraceItem): string {
  return escapeSlackText(item.scriptName ?? 'unknown-worker')
}

function safePath(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    return escapeSlackText(url.pathname || '/')
  } catch {
    return 'unknown-path'
  }
}

function exceptionSummary(exceptions: TraceException[]): string {
  const names = exceptions
    .map((exception) => exception.name || 'Error')
    .slice(0, 3)
    .map(escapeSlackText)
  const suffix =
    exceptions.length > names.length
      ? ` +${exceptions.length - names.length}`
      : ''
  return `${names.join(', ')}${suffix}`
}

function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * The signed operator link is interpolated into Slack link markup, so beyond
 * the origin and path only the token alphabet (base64url plus '.') passes.
 */
function isLinkOpsActionUrl(value: unknown, shareableId: string): boolean {
  if (value === null) return true
  if (typeof value !== 'string' || value.length > 2_000) return false
  const prefix = `https://artifactshare.com/ops/link/${shareableId}?token=`
  return (
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_.-]+$/.test(value.slice(prefix.length))
  )
}

function linkSuspensionFromLogs(item: TraceItem): {
  action: 'suspend' | 'resume'
  shareableId: string
  workspaceId: string
  ownerNotice: string
} | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (
      marker !== linkSuspensionMarker ||
      !detail ||
      typeof detail !== 'object'
    )
      continue
    const raw = detail as Record<string, unknown>
    const keys = Object.keys(raw).sort().join(',')
    const legacy = keys === 'action,ownerNotice,shareableId,workspaceId'
    const current =
      keys === 'action,notifications,shareableId,source,workspaceId'
    if (!legacy && !current) continue
    if (raw.action !== 'suspend' && raw.action !== 'resume') continue
    let ownerNotice: string
    if (legacy) {
      if (
        raw.ownerNotice !== 'sent' &&
        raw.ownerNotice !== 'skipped' &&
        raw.ownerNotice !== 'failed'
      )
        continue
      ownerNotice = raw.ownerNotice
    } else {
      if (!parseLinkOpsSource(raw.source)) continue
      const counts = notificationCounts(raw.notifications)
      if (!counts) continue
      ownerNotice = `sent ${counts.sent}, failed ${counts.failed}, skipped ${counts.skipped}`
    }
    if (!isSandboxArtifactId(raw.shareableId)) continue
    if (
      typeof raw.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{21}$/.test(raw.workspaceId)
    )
      continue
    return {
      action: raw.action,
      shareableId: raw.shareableId,
      workspaceId: raw.workspaceId,
      ownerNotice,
    }
  }
  return null
}

function linkAppealFromLogs(item: TraceItem): {
  shareableId: string
  workspaceId: string
  manageUrl: string
  message: string
  source: LinkOpsSource | null
} | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (marker !== linkAppealMarker || !detail || typeof detail !== 'object')
      continue
    const raw = detail as Record<string, unknown>
    const keys = Object.keys(raw).sort().join(',')
    const legacy =
      keys === 'actionUrl,manageUrl,message,shareableId,workspaceId'
    const current = keys === 'manageUrl,message,shareableId,source,workspaceId'
    if (!legacy && !current) continue
    if (!isSandboxArtifactId(raw.shareableId)) continue
    if (
      typeof raw.workspaceId !== 'string' ||
      !/^[A-Za-z0-9_-]{21}$/.test(raw.workspaceId)
    )
      continue
    if (raw.manageUrl !== `https://artifactshare.com/a/${raw.shareableId}`)
      continue
    if (typeof raw.message !== 'string' || Array.from(raw.message).length > 300)
      continue
    if (legacy && !isLinkOpsActionUrl(raw.actionUrl, raw.shareableId)) continue
    const source = current ? parseLinkOpsSource(raw.source, 'appeal') : null
    if (current && !source) continue
    return {
      shareableId: raw.shareableId,
      workspaceId: raw.workspaceId,
      manageUrl: raw.manageUrl,
      message: raw.message,
      source,
    }
  }
  return null
}

function linkAbuseJudgmentFromLogs(item: TraceItem): {
  shareableId: string
  trigger: 'view_spike' | 'ad_click' | 'publish_burst' | 'manual'
  risk: 'low' | 'medium' | 'high'
  reason: string
  impersonatedBrand: string | null
  externalTargets: string[]
  manageUrl: string
  source: LinkOpsSource | null
} | null {
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (
      marker !== linkAbuseJudgmentMarker ||
      !detail ||
      typeof detail !== 'object'
    )
      continue
    const raw = detail as Record<string, unknown>
    const keys = Object.keys(raw).sort().join(',')
    const legacy =
      keys ===
      'actionUrl,externalTargets,impersonatedBrand,manageUrl,reason,risk,shareableId,trigger,workspaceId'
    const current =
      keys ===
      'externalTargets,impersonatedBrand,manageUrl,reason,risk,shareableId,source,trigger,workspaceId'
    if (!legacy && !current) continue
    if (!isSandboxArtifactId(raw.shareableId)) continue
    if (
      !['view_spike', 'ad_click', 'publish_burst', 'manual'].includes(
        String(raw.trigger),
      )
    )
      continue
    if (!['low', 'medium', 'high'].includes(String(raw.risk))) continue
    if (
      typeof raw.reason !== 'string' ||
      raw.reason.length < 1 ||
      raw.reason.length > 500
    )
      continue
    if (
      raw.impersonatedBrand !== null &&
      (typeof raw.impersonatedBrand !== 'string' ||
        raw.impersonatedBrand.length > 100)
    )
      continue
    if (
      !Array.isArray(raw.externalTargets) ||
      raw.externalTargets.length > 50 ||
      !raw.externalTargets.every(isSafeHostname)
    )
      continue
    const expectedManageUrl = `https://artifactshare.com/a/${raw.shareableId}`
    if (raw.manageUrl !== expectedManageUrl) continue
    if (legacy && !isLinkOpsActionUrl(raw.actionUrl, raw.shareableId)) continue
    const source = current ? parseLinkOpsSource(raw.source, 'judgment') : null
    if (current && !source) continue
    if (typeof raw.workspaceId !== 'string' || raw.workspaceId.length === 0)
      continue
    return {
      shareableId: raw.shareableId,
      trigger: raw.trigger as
        | 'view_spike'
        | 'ad_click'
        | 'publish_burst'
        | 'manual',
      risk: raw.risk as 'low' | 'medium' | 'high',
      reason: raw.reason,
      impersonatedBrand: raw.impersonatedBrand as string | null,
      externalTargets: raw.externalTargets,
      manageUrl: raw.manageUrl,
      source,
    }
  }
  return null
}

type LinkOpsSource = { kind: 'judgment' | 'appeal'; id: string }

function parseLinkOpsSource(
  value: unknown,
  expectedKind?: LinkOpsSource['kind'],
): LinkOpsSource | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).sort().join(',') !== 'id,kind') return null
  if (
    (raw.kind !== 'judgment' && raw.kind !== 'appeal') ||
    (expectedKind && raw.kind !== expectedKind)
  )
    return null
  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128)
    return null
  return { kind: raw.kind, id: raw.id }
}

function notificationCounts(
  value: unknown,
): { sent: number; failed: number; skipped: number } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).sort().join(',') !== 'failed,sent,skipped') return null
  if (
    !['sent', 'failed', 'skipped'].every(
      (key) => Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0,
    )
  )
    return null
  return {
    sent: Number(raw.sent),
    failed: Number(raw.failed),
    skipped: Number(raw.skipped),
  }
}

async function linkOpsActionUrl(
  input: { shareableId: string; source: LinkOpsSource | null },
  env: AlertEnv,
): Promise<string | null> {
  if (
    env.APP_ENV !== 'production' ||
    !env.LINK_OPS_ACTION_SECRET ||
    !input.source
  )
    return null
  return linkOpsUrl(
    'https://artifactshare.com',
    input.shareableId,
    await signLinkOpsToken(
      {
        shareableId: input.shareableId,
        credentialId: nanoid(24),
        source: input.source,
      },
      env.LINK_OPS_ACTION_SECRET,
    ),
  )
}

function isSafeHostname(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253)
    return false
  try {
    const url = new URL(`https://${value}`)
    return url.hostname === value && url.pathname === '/'
  } catch {
    return false
  }
}

function truncateCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}

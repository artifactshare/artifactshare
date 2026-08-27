type AlertEnv = {
  ALERT_STATE: KVNamespace
  APP_ENV: string
  SLACK_ALERT_WEBHOOK_URL?: string
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

const alertPrefix = 'ops-alerts'
const authHangLogMarker = 'artifactshare_auth_hang'
const sandboxBlockReportMarker = 'artifactshare_sandbox_block_report'
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
      for (const migrationWait of workspaceMigrationWaitsFromLogs(event)) {
        try {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await sendAlertWithCooldown(
            {
              key: `workspace-migration-wait:${migrationWait.waitId}:${migrationWait.generation}`,
              title: 'Artifact Share workspace migration waiting',
              summary: 'A workspace migration requires operator review.',
              fields: ['action: Review the protected operations dashboard.'],
              cooldownSeconds: null,
            },
            env,
          )
        } catch {
          console.error('slack_alert_event_failed', {
            worker: safeScriptName(event),
            outcome: escapeSlackText(event.outcome),
          })
        }
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

function workspaceMigrationWaitsFromLogs(
  item: TraceItem,
): { waitId: string; generation: number }[] {
  const waits: { waitId: string; generation: number }[] = []
  for (const log of item.logs) {
    const [marker, detail] = log.message ?? []
    if (
      marker !== workspaceMigrationWaitMarker ||
      !detail ||
      typeof detail !== 'object'
    )
      continue
    const raw = detail as Record<string, unknown>
    if (Object.keys(raw).sort().join(',') !== 'generation,waitId') continue
    if (typeof raw.waitId !== 'string' || !/^[\w-]{16}$/u.test(raw.waitId))
      continue
    if (
      typeof raw.generation !== 'number' ||
      !Number.isInteger(raw.generation) ||
      raw.generation < 1
    )
      continue
    waits.push({ waitId: raw.waitId, generation: raw.generation })
  }
  return waits
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

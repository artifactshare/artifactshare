import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'

type D1ExportStartResult = {
  at_bookmark?: string
}

type D1ExportPollResult = {
  at_bookmark?: string
  signed_url?: string
  filename?: string
  status?: 'complete' | 'error' | 'active'
  error?: string
}

type D1ExportApiResponse<T> = {
  success?: boolean
  error?: string
  errors?: Array<{ message?: string }>
  result?: (T & { success?: boolean; result?: T }) | T
} & Partial<T>

const d1ExportPollTimeoutMs = 60_000

const d1ExportDumpOptions = {
  no_schema: false,
  no_data: false,
  tables: [],
}

export type D1BackupWorkflowResult = {
  backup_key: string
}

export class D1BackupWorkflow extends WorkflowEntrypoint<Cloudflare.Env> {
  async run(
    event: Readonly<WorkflowEvent<unknown>>,
    step: WorkflowStep,
  ): Promise<D1BackupWorkflowResult> {
    try {
      return await runD1Backup(event, step, this.env)
    } catch (error) {
      await step.do('notify d1 backup failure', async () => {
        await notifyD1BackupFailure(this.env, event, error)
      })
      throw error
    }
  }
}

async function runD1Backup(
  event: Readonly<WorkflowEvent<unknown>>,
  step: WorkflowStep,
  env: Cloudflare.Env,
): Promise<D1BackupWorkflowResult> {
  const backupKey = d1BackupKey(
    event.schedule?.scheduledTime ?? event.timestamp.getTime(),
  )
  const exportUrl = d1ExportUrl(env)
  const headers = d1ExportHeaders(env)

  const bookmark = await step.do(
    'start d1 export',
    {
      retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    },
    async () => {
      const result = await fetchD1Export<D1ExportStartResult>(exportUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          output_format: 'polling',
          dump_options: d1ExportDumpOptions,
        }),
      })
      if (!result.at_bookmark) throw new Error('D1 export did not start')
      return result.at_bookmark
    },
  )

  let currentBookmark = bookmark
  const exportResult = await step.do(
    'poll d1 export',
    {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    },
    async () => {
      const deadline = Date.now() + d1ExportPollTimeoutMs
      while (Date.now() < deadline) {
        const result = await fetchD1Export<D1ExportPollResult>(exportUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            output_format: 'polling',
            dump_options: d1ExportDumpOptions,
            current_bookmark: currentBookmark,
          }),
        })
        if (result.signed_url) return result
        if (result.at_bookmark) currentBookmark = result.at_bookmark
        await wait(250)
      }
      throw new Error('D1 export did not finish')
    },
  )

  await step.do(
    'download d1 export and save to r2',
    {
      retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
      timeout: '15 minutes',
    },
    async () => {
      const dump = await fetch(exportResult.signed_url!)
      if (!dump.ok) {
        throw new Error(`D1 export download failed: HTTP ${dump.status}`)
      }
      if (!dump.body) throw new Error('D1 export download returned no body')

      await env.BACKUP_BUCKET.put(backupKey, dump.body, {
        httpMetadata: { contentType: 'application/sql' },
        customMetadata: {
          database_id: env.D1_BACKUP_DATABASE_ID,
          source_filename: exportResult.filename ?? '',
        },
      })
    },
  )
  return { backup_key: backupKey }
}

async function notifyD1BackupFailure(
  env: Cloudflare.Env,
  event: Readonly<WorkflowEvent<unknown>>,
  error: unknown,
): Promise<void> {
  if (!env.SLACK_ALERT_WEBHOOK_URL) return

  const errorName = error instanceof Error ? error.name : 'Error'
  const scheduledTime = event.schedule?.scheduledTime
    ? new Date(event.schedule.scheduledTime).toISOString()
    : event.timestamp.toISOString()
  const text = [
    '*Artifact Share D1 backup workflow failed*',
    'Cloudflare Workflow failed before saving the scheduled D1 export.',
    `• workflow: ${slackEscape(event.workflowName)}`,
    `• scheduled: ${scheduledTime}`,
    `• error: ${slackEscape(errorName)}`,
  ].join('\n')

  try {
    const response = await fetch(env.SLACK_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Artifact Share D1 backup workflow failed',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text,
            },
          },
        ],
      }),
    })
    if (!response.ok) {
      console.error('d1_backup_slack_alert_failed', { status: response.status })
    }
  } catch {
    console.error('d1_backup_slack_alert_failed')
  }
}

function d1ExportUrl(env: Cloudflare.Env): string {
  return `https://api.cloudflare.com/client/v4/accounts/${env.D1_BACKUP_ACCOUNT_ID}/d1/database/${env.D1_BACKUP_DATABASE_ID}/export`
}

function d1ExportHeaders(env: Cloudflare.Env): Headers {
  const headers = new Headers()
  headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${env.D1_REST_API_TOKEN}`)
  return headers
}

async function fetchD1Export<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response
    .json()
    .catch(() => null)) as D1ExportApiResponse<T> | null
  if (!response.ok || !body?.success) {
    const message =
      body?.errors
        ?.flatMap((error) => (error.message ? [error.message] : []))
        .join('; ') ||
      body?.error ||
      `HTTP ${response.status}`
    throw new Error(`D1 export API failed: ${message}`)
  }
  const result = body.result as
    | (T & { success?: boolean; result?: T; error?: string; status?: string })
    | undefined
  if (result?.success === false || result?.status === 'error') {
    throw new Error(
      `D1 export API failed: ${result.error ?? body.error ?? 'unknown error'}`,
    )
  }
  return {
    ...body,
    ...result,
    ...result?.result,
  } as T
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function d1BackupKey(timestamp: number): string {
  const date = new Date(timestamp)
  const iso = date.toISOString()
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const day = iso.slice(0, 10).replace(/-/g, '/')
  return `d1/artifactshare/${day}/artifactshare-${stamp}.sql`
}

function slackEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

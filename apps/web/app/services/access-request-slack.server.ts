import type { AnyMessageBlock } from 'slack-cloudflare-workers'
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '~/i18n/messages'
import { t } from '~/lib/i18n'
import type { AccessRequestApprover } from './access-requests.server'
import type { Db } from './db.server'
import { hasSlackBotScope, postSlackDirectMessage } from './slack.server'

interface SlackAccessRequestClient {
  postMessage(payload: {
    channel: string
    text: string
    blocks: AnyMessageBlock[]
  }): Promise<void>
}

// One additional binding is used by workspace_id; D1 permits 100 total.
const APPROVER_LOOKUP_CHUNK_SIZE = 99

export async function sendAccessRequestSlackNotifications(
  db: Db,
  input: {
    requestId: string
    requesterName: string | null
    requesterEmail: string
    shareableTitle: string
    workspaceId: string
    approvers: ReadonlyArray<AccessRequestApprover>
    origin: string
  },
  clientFactory: (botToken: string) => SlackAccessRequestClient = (
    botToken,
  ) => ({
    postMessage: (payload) => postSlackDirectMessage(botToken, payload),
  }),
): Promise<void> {
  try {
    await sendAccessRequestSlackNotificationsBestEffort(
      db,
      input,
      clientFactory,
    )
  } catch {
    console.error(
      JSON.stringify({
        event: 'access_request_slack_failed',
        requestId: input.requestId,
      }),
    )
  }
}

async function sendAccessRequestSlackNotificationsBestEffort(
  db: Db,
  input: {
    requestId: string
    requesterName: string | null
    requesterEmail: string
    shareableTitle: string
    workspaceId: string
    approvers: ReadonlyArray<AccessRequestApprover>
    origin: string
  },
  clientFactory: (botToken: string) => SlackAccessRequestClient,
): Promise<void> {
  const approvers = new Map(
    input.approvers.map((approver) => [approver.userId, approver]),
  )
  if (approvers.size === 0) return

  const approverIds = [...approvers.keys()]
  const rows = (
    await Promise.all(
      chunkArray(approverIds, APPROVER_LOOKUP_CHUNK_SIZE).map((ids) =>
        db
          .selectFrom('slack_user_links as link')
          .innerJoin(
            'slack_workspaces as slack',
            'slack.team_id',
            'link.slack_team_id',
          )
          .select([
            'link.artifactshare_user_id as artifactshareUserId',
            'link.slack_user_id as slackUserId',
            'slack.team_id as teamId',
            'slack.bot_token as botToken',
            'slack.bot_scopes as botScopes',
          ])
          .where('link.artifactshare_user_id', 'in', ids)
          .where('slack.workspace_id', '=', input.workspaceId)
          .execute(),
      ),
    )
  ).flat()

  const recipients = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (!hasSlackBotScope(row.botScopes, 'chat:write')) continue
    recipients.set(`${row.teamId}:${row.slackUserId}`, row)
  }

  const recipientList = [...recipients.values()]
  const results = await Promise.allSettled(
    recipientList.map(async (recipient) => {
      const approver = approvers.get(recipient.artifactshareUserId)
      if (!approver) return
      const locale: Locale = isSupportedLocale(approver.locale)
        ? approver.locale
        : DEFAULT_LOCALE
      await clientFactory(recipient.botToken).postMessage(
        accessRequestSlackPayload({
          channel: recipient.slackUserId,
          locale,
          requester: requesterIdentity(
            input.requesterName,
            input.requesterEmail,
          ),
          shareableTitle: input.shareableTitle,
          requestUrl: accessRequestUrl(input.origin, input.requestId),
        }),
      )
    }),
  )

  results.forEach((result, index) => {
    if (result.status !== 'rejected') return
    const recipient = recipientList[index]
    console.error(
      JSON.stringify({
        event: 'access_request_slack_failed',
        requestId: input.requestId,
        teamId: recipient?.teamId,
        slackUserId: recipient?.slackUserId,
      }),
    )
  })
}

function requesterIdentity(name: string | null, email: string): string {
  const trimmedName = name?.trim()
  return trimmedName ? `${trimmedName} (${email})` : email
}

export function accessRequestSlackPayload(input: {
  channel: string
  locale: Locale
  requester: string
  shareableTitle: string
  requestUrl: string
}): { channel: string; text: string; blocks: AnyMessageBlock[] } {
  const requester = normalizeSlackPlainText(input.requester)
  const file = normalizeSlackPlainText(input.shareableTitle)
  const vars = { requester, file }
  const fallback = escapeSlackMrkdwn(
    t(input.locale, 'slack.accessRequest.fallback', vars),
  )
  return {
    channel: input.channel,
    text: fallback,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: t(input.locale, 'slack.accessRequest.title', vars),
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: t(input.locale, 'slack.accessRequest.body', vars),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: t(input.locale, 'slack.accessRequest.review'),
            },
            url: input.requestUrl,
          },
        ],
      },
    ],
  }
}

function accessRequestUrl(origin: string, requestId: string): string {
  const url = new URL('/access-requests', origin)
  url.searchParams.set('request', requestId)
  return url.toString()
}

function normalizeSlackPlainText(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}

function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function chunkArray<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

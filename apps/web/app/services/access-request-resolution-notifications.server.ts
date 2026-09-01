import { env } from 'cloudflare:workers'
import type { AnyMessageBlock } from 'slack-cloudflare-workers'
import { APEX_HOST } from '~/lib/hosts'
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '~/i18n/messages'
import { t } from '~/lib/i18n'
import { deliverAuditedAccessRequestNotification } from './access-request-audit.server'
import type { Db } from './db.server'
import { hasSlackBotScope, postSlackDirectMessage } from './slack.server'

type ResolutionStatus = 'approved' | 'rejected'

interface SlackResolutionClient {
  postMessage(payload: {
    channel: string
    text: string
    blocks: AnyMessageBlock[]
  }): Promise<void>
}

interface ResolutionContext {
  requestId: string
  status: ResolutionStatus
  requesterUserId: string
  requesterEmail: string
  requesterLocale: string | null
  shareableId: string
  shareableTitle: string
  workspaceId: string
}

export async function sendAccessRequestResolutionNotifications(
  db: Db,
  input: {
    requestId: string
    status: ResolutionStatus
    resolvedByUserId: string
    origin?: string
  },
  slackClientFactory: (botToken: string) => SlackResolutionClient = (
    botToken,
  ) => ({
    postMessage: (payload) => postSlackDirectMessage(botToken, payload),
  }),
): Promise<void> {
  try {
    const resolution = await loadResolutionContext(db, input)
    if (!resolution) return
    const origin = input.origin ?? `https://${APEX_HOST}`
    const outcomes = await Promise.allSettled([
      sendResolutionEmail(db, resolution, origin),
      sendResolutionSlack(db, resolution, origin, slackClientFactory),
    ])
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    ).length
    if (rejected > 0) {
      console.error(
        JSON.stringify({
          event: 'access_request_resolution_notification_failed',
          requestId: input.requestId,
          failedBranches: rejected,
        }),
      )
    }
  } catch {
    console.error(
      JSON.stringify({
        event: 'access_request_resolution_notification_failed',
        requestId: input.requestId,
      }),
    )
  }
}

async function loadResolutionContext(
  db: Db,
  input: {
    requestId: string
    status: ResolutionStatus
    resolvedByUserId: string
  },
): Promise<ResolutionContext | null> {
  const row = await db
    .selectFrom('access_requests as request')
    .innerJoin(
      'shareables as shareable',
      'shareable.id',
      'request.shareable_id',
    )
    .innerJoin(
      'users as requester',
      'requester.id',
      'request.requester_user_id',
    )
    .select([
      'request.id as requestId',
      'request.status',
      'requester.id as requesterUserId',
      'requester.email as requesterEmail',
      'requester.locale as requesterLocale',
      'shareable.id as shareableId',
      'shareable.name',
      'shareable.derived_title as derivedTitle',
      'shareable.title_override as titleOverride',
      'shareable.workspace_id as workspaceId',
    ])
    .where('request.id', '=', input.requestId)
    .where('request.status', '=', input.status)
    .where('request.resolved_by_user_id', '=', input.resolvedByUserId)
    .executeTakeFirst()
  if (!row || (row.status !== 'approved' && row.status !== 'rejected')) {
    return null
  }
  return {
    requestId: row.requestId,
    status: row.status,
    requesterUserId: row.requesterUserId,
    requesterEmail: row.requesterEmail,
    requesterLocale: row.requesterLocale,
    shareableId: row.shareableId,
    shareableTitle: row.titleOverride ?? row.derivedTitle ?? row.name,
    workspaceId: row.workspaceId,
  }
}

async function sendResolutionEmail(
  db: Db,
  resolution: ResolutionContext,
  origin: string,
): Promise<void> {
  const email: SendEmail | undefined = env.EMAIL
  if (!email) return
  const url = new URL(
    `/a/${encodeURIComponent(resolution.shareableId)}`,
    origin,
  )
  const approved = resolution.status === 'approved'
  const subject = approved
    ? '閲覧リクエストが承認されました / Access request approved'
    : '閲覧リクエストは却下されました / Access request rejected'
  const text = approved
    ? [
        `「${resolution.shareableTitle}」の閲覧リクエストが承認されました。`,
        `Your request to view “${resolution.shareableTitle}” was approved.`,
        '',
        `ファイルを開く: ${url.toString()}`,
        `Open the file: ${url.toString()}`,
      ].join('\n')
    : [
        `「${resolution.shareableTitle}」の閲覧リクエストは却下されました。`,
        `Your request to view “${resolution.shareableTitle}” was rejected.`,
        '',
        `現在の状態を確認: ${url.toString()}`,
        `View the current status: ${url.toString()}`,
      ].join('\n')

  const outcome = await deliverAuditedAccessRequestNotification(
    db,
    {
      requestId: resolution.requestId,
      channel: 'email',
      endpointKey: resolution.requesterUserId,
      recipientUserId: resolution.requesterUserId,
      recipientEmail: resolution.requesterEmail,
      purpose: 'resolution',
    },
    async () => {
      await email.send({
        to: resolution.requesterEmail,
        from: `noreply@${APEX_HOST}`,
        subject,
        text,
      })
    },
  )
  if (outcome === 'failed') {
    console.error(
      JSON.stringify({
        event: 'access_request_resolution_email_failed',
        requestId: resolution.requestId,
      }),
    )
  }
}

async function sendResolutionSlack(
  db: Db,
  resolution: ResolutionContext,
  origin: string,
  clientFactory: (botToken: string) => SlackResolutionClient,
): Promise<void> {
  const rows = await db
    .selectFrom('slack_user_links as link')
    .innerJoin(
      'slack_workspaces as slack',
      'slack.team_id',
      'link.slack_team_id',
    )
    .select([
      'link.id as linkId',
      'link.slack_user_id as slackUserId',
      'slack.team_id as teamId',
      'slack.bot_token as botToken',
      'slack.bot_scopes as botScopes',
    ])
    .where('link.artifactshare_user_id', '=', resolution.requesterUserId)
    .where('slack.workspace_id', '=', resolution.workspaceId)
    .execute()
  const recipients = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (!hasSlackBotScope(row.botScopes, 'chat:write')) continue
    recipients.set(`${row.teamId}:${row.slackUserId}`, row)
  }
  const locale: Locale = isSupportedLocale(resolution.requesterLocale)
    ? resolution.requesterLocale
    : DEFAULT_LOCALE
  const requestUrl = new URL(
    `/a/${encodeURIComponent(resolution.shareableId)}`,
    origin,
  ).toString()

  await Promise.all(
    [...recipients.values()].map(async (recipient) => {
      const outcome = await deliverAuditedAccessRequestNotification(
        db,
        {
          requestId: resolution.requestId,
          channel: 'slack',
          endpointKey: recipient.linkId,
          recipientUserId: resolution.requesterUserId,
          recipientEmail: resolution.requesterEmail,
          purpose: 'resolution',
        },
        () =>
          clientFactory(recipient.botToken).postMessage(
            accessRequestResolutionSlackPayload({
              channel: recipient.slackUserId,
              locale,
              status: resolution.status,
              shareableTitle: resolution.shareableTitle,
              requestUrl,
            }),
          ),
      )
      if (outcome === 'failed') {
        console.error(
          JSON.stringify({
            event: 'access_request_resolution_slack_failed',
            requestId: resolution.requestId,
            teamId: recipient.teamId,
            slackUserId: recipient.slackUserId,
          }),
        )
      }
    }),
  )
}

export function accessRequestResolutionSlackPayload(input: {
  channel: string
  locale: Locale
  status: ResolutionStatus
  shareableTitle: string
  requestUrl: string
}): { channel: string; text: string; blocks: AnyMessageBlock[] } {
  const file = normalizeSlackPlainText(input.shareableTitle)
  const statusKey = input.status === 'approved' ? 'approved' : 'rejected'
  const vars = { file }
  return {
    channel: input.channel,
    text: escapeSlackMrkdwn(
      t(
        input.locale,
        `slack.accessRequestResolution.${statusKey}.fallback`,
        vars,
      ),
    ),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: t(
            input.locale,
            `slack.accessRequestResolution.${statusKey}.title`,
            vars,
          ),
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: t(
            input.locale,
            `slack.accessRequestResolution.${statusKey}.body`,
            vars,
          ),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: t(input.locale, 'slack.accessRequestResolution.open'),
            },
            url: input.requestUrl,
          },
        ],
      },
    ],
  }
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

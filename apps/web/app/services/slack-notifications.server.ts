import { sql, type Compilable, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import type { Visibility } from '~/lib/shareable-types'
import { DEFAULT_LOCALE, isSupportedLocale, MESSAGES } from '~/i18n/messages'
import type { DB } from '~/types/db'

export async function getContainerSlackChannel(
  db: Kysely<DB>,
  containerId: string,
) {
  const channel = await db
    .selectFrom('container_slack_channels as c')
    .leftJoin('users as u', 'u.id', 'c.updated_by')
    .select([
      'c.container_id as containerId',
      'c.channel_id as channelId',
      'c.channel_name as channelName',
      'c.slack_team_name as teamName',
      'c.slack_team_id as slackTeamId',
      'u.name as updatedBy',
      'c.updated_at as updatedAt',
      sql<number>`c.last_error_status = 404`.as('requiresReauthorization'),
    ])
    .where('c.container_id', '=', containerId)
    .executeTakeFirst()
  return channel
    ? {
        ...channel,
        requiresReauthorization: channel.requiresReauthorization === 1,
      }
    : undefined
}

export type SlackNotificationWarning = {
  code: 'slack_reauthorization_required'
  message: string
}

export function slackReauthorizationWarnings(
  suppressed: boolean | undefined,
  locale: string | null | undefined,
): SlackNotificationWarning[] | undefined {
  if (!suppressed) return undefined
  const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE
  return [
    {
      code: 'slack_reauthorization_required',
      message: MESSAGES[lang]['project.slack.reauthorizationWarning'],
    },
  ]
}

export async function setContainerSlackChannel(
  db: Kysely<DB>,
  args: {
    containerId: string
    webhookUrl: string
    channelId: string
    channelName: string
    slackTeamId: string
    slackTeamName: string
    configurationUrl: string | null
    userId: string
    now: string
  },
) {
  await db
    .insertInto('container_slack_channels')
    .values({
      container_id: args.containerId,
      webhook_url: args.webhookUrl,
      channel_id: args.channelId,
      channel_name: args.channelName,
      slack_team_id: args.slackTeamId,
      slack_team_name: args.slackTeamName,
      configuration_url: args.configurationUrl,
      created_by: args.userId,
      updated_by: args.userId,
      created_at: args.now,
      updated_at: args.now,
    })
    .onConflict((oc) =>
      oc.column('container_id').doUpdateSet({
        webhook_url: args.webhookUrl,
        channel_id: args.channelId,
        channel_name: args.channelName,
        slack_team_id: args.slackTeamId,
        slack_team_name: args.slackTeamName,
        configuration_url: args.configurationUrl,
        updated_by: args.userId,
        updated_at: args.now,
        last_error_at: null,
        last_error_status: null,
      }),
    )
    .execute()
  await db
    .deleteFrom('slack_notification_outbox')
    .where('container_id', '=', args.containerId)
    .where('claimed_at', 'is', null)
    .execute()
  return { kind: 'ok' as const }
}

export async function clearContainerSlackChannel(
  db: Kysely<DB>,
  containerId: string,
) {
  await db
    .deleteFrom('container_slack_channels')
    .where('container_id', '=', containerId)
    .execute()
  await db
    .deleteFrom('slack_notification_outbox')
    .where('container_id', '=', containerId)
    .where('claimed_at', 'is', null)
    .execute()
}

export function scheduledJobForCron(
  cron: string,
): 'reconciliation' | 'slack-notifications' {
  return cron === '*/5 * * * *' ? 'slack-notifications' : 'reconciliation'
}

// D1 の 1 文あたりの bind 変数上限 (100) に収まるよう、1 回の cron で
// claim する行数を抑える。残りは次回 (5 分後) に回る。
const CLAIM_LIMIT = 50

// タイトル・投稿者名などの利用者入力を Slack の mrkdwn 制御列 (<!channel>、
// <@USER>、偽装リンク) として解釈させないためのエスケープ。
// https://api.slack.com/reference/surfaces/formatting#escaping
function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export async function processSlackNotificationOutbox(
  db: Kysely<DB>,
  args: { origin: string; now: Date; claimToken: string },
): Promise<void> {
  const { postSlackWebhook } = await import('./slack.server')
  const now = args.now.toISOString()
  const expired = new Date(
    args.now.getTime() - 24 * 60 * 60 * 1000,
  ).toISOString()
  const claimExpired = new Date(
    args.now.getTime() - 15 * 60 * 1000,
  ).toISOString()
  await db
    .deleteFrom('slack_notify_nonces')
    .where(
      'created_at',
      '<',
      new Date(args.now.getTime() - 60 * 60 * 1000).toISOString(),
    )
    .execute()

  await db
    .deleteFrom('slack_notification_outbox')
    .where('created_at', '<', expired)
    .execute()
  const claimed = await db
    .updateTable('slack_notification_outbox')
    .set({ claimed_at: now, claim_token: args.claimToken })
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('slack_notification_outbox')
        .select('id')
        .where((web) =>
          web.or([
            web('claimed_at', 'is', null),
            web('claimed_at', '<', claimExpired),
          ]),
        )
        .orderBy('created_at')
        .orderBy('id')
        .limit(CLAIM_LIMIT),
    )
    .returningAll()
    .execute()
  if (claimed.length === 0) return

  const rows = await db
    .selectFrom('slack_notification_outbox as o')
    .innerJoin(
      'container_slack_channels as c',
      'c.container_id',
      'o.container_id',
    )
    .innerJoin('shareables as s', 's.id', 'o.shareable_id')
    .innerJoin('artifact_containers as p', 'p.id', 'o.container_id')
    .leftJoin('users as u', 'u.id', 's.owner_user_id')
    .select([
      'o.id',
      'o.container_id',
      'o.shareable_id',
      'o.claim_token',
      'c.channel_id',
      'c.webhook_url',
      's.derived_title',
      's.title_override',
      's.name',
      'u.name as owner_name',
      'p.name as project_name',
    ])
    .where('o.claim_token', '=', args.claimToken)
    .execute()

  const claimedIds = new Set(claimed.map((row) => row.id))
  const joined = rows.filter((row) => claimedIds.has(row.id))
  const joinedIds = new Set(joined.map((row) => row.id))
  // 紐付け消失で join に落ちた行は明示的な id 列挙で消す。bind 変数の数が
  // 孤児側 (通常ほぼ 0 件) に比例し、not in の全 claim 分列挙を避けられる。
  const orphanIds: string[] = []
  for (const row of claimed) {
    if (!joinedIds.has(row.id)) orphanIds.push(row.id)
  }
  if (orphanIds.length > 0) {
    await db
      .deleteFrom('slack_notification_outbox')
      .where('claim_token', '=', args.claimToken)
      .where('id', 'in', orphanIds)
      .execute()
  }

  const groups = new Map<string, typeof joined>()
  for (const row of joined) {
    const key = `${row.container_id}:${row.channel_id}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const visible = group.slice(0, 20)
      const projectUrl = new URL(
        `/projects/${group[0].container_id}`,
        args.origin,
      ).toString()
      const lines = visible.map((row) => {
        const title = escapeSlackText(
          row.title_override ?? row.derived_title ?? row.name,
        )
        const owner = escapeSlackText(row.owner_name ?? '不明')
        const url = new URL(`/a/${row.shareable_id}`, args.origin).toString()
        return `${title} — ${owner} ${url}`
      })
      const text =
        group.length === 1
          ? lines[0]
          : `「${escapeSlackText(group[0].project_name)}」に ${group.length} 件の新着\n${lines.join('\n')}${group.length > 20 ? `\nほか ${group.length - 20} 件 ${projectUrl}` : ''}`
      const result = await postSlackWebhook(group[0].webhook_url, text)
      // 429 以外の 4xx は恒久エラー (404 no_service / 410 archived / 400 系の
      // payload 不正など)。再送しても成功しないため行を破棄し、24 時間の
      // 無言リトライを避ける。429 と 5xx とネットワーク断 (status 0) は再試行。
      const permanent =
        !result.ok &&
        result.status >= 400 &&
        result.status < 500 &&
        result.status !== 429
      if (result.ok || permanent) {
        if (!result.ok && result.status === 404) {
          try {
            const expiry = await db
              .updateTable('container_slack_channels')
              .set({ last_error_at: now, last_error_status: 404 })
              .where('container_id', '=', group[0].container_id)
              .where('webhook_url', '=', group[0].webhook_url)
              .execute()
            if (Number(expiry[0]?.numUpdatedRows ?? 0n) > 0) {
              await db
                .deleteFrom('slack_notification_outbox')
                .where('container_id', '=', group[0].container_id)
                .execute()
            }
          } catch (err) {
            console.error('slack_notification_expiry_record_failed', {
              container_id: group[0].container_id,
              err,
            })
          }
        }
        if (!result.ok)
          console.error('Slack notification dropped', `status_${result.status}`)
        await db
          .deleteFrom('slack_notification_outbox')
          .where('claim_token', '=', args.claimToken)
          .where(
            'id',
            'in',
            group.map((row) => row.id),
          )
          .execute()
      }
    }),
  )
}

type SlackNotificationEnqueueArgs = {
  containerId: string | null
  visibility: Visibility
  slackNotify: boolean
  shareableId: string
  now: string
}

export async function slackNotificationEnqueueQuery(
  db: Kysely<DB>,
  args: SlackNotificationEnqueueArgs,
): Promise<{ query: Compilable<unknown> | null; suppressed: boolean }> {
  if (
    args.containerId === null ||
    !args.slackNotify ||
    args.visibility === 'private'
  )
    return { query: null, suppressed: false }
  const channel = await db
    .selectFrom('container_slack_channels')
    .select(['container_id', 'last_error_status'])
    .where('container_id', '=', args.containerId)
    .executeTakeFirst()
  if (!channel) return { query: null, suppressed: false }
  if (channel.last_error_status === 404)
    return { query: null, suppressed: true }
  return {
    query: db
      .insertInto('slack_notification_outbox')
      .values({
        id: nanoid(16),
        container_id: args.containerId,
        shareable_id: args.shareableId,
        created_at: args.now,
        claimed_at: null,
        claim_token: null,
      })
      .onConflict((oc) => oc.column('shareable_id').doNothing()),
    suppressed: false,
  }
}

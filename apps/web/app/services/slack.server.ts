import { env } from 'cloudflare:workers'
import type { AnyMessageBlock } from 'slack-cloudflare-workers'
import { nanoid } from 'nanoid'
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  MESSAGES,
  type Locale,
  type TKey,
} from '~/i18n/messages'
import { nowIso } from '~/lib/datetime'
import { displayTitle } from '~/lib/display-title'
import {
  bodyPreviewEligible,
  isVisibility,
  type ArtifactKind,
  type Visibility,
} from '~/lib/shareable-types'
import { loadPreviewExcerpt } from '~/services/content.server'
import type { Db } from './db.server'
import { viewerDisplayCheck } from './access.server'
import {
  requireWorkspaceAdmin,
  type TeamMutationResult,
} from './team-management.server'

export interface SlackLinkSharedEvent {
  team_id?: string
  user: string
  channel: string
  message_ts: string
  links: Array<{ url: string }>
}

export interface SlackUnfurlClient {
  chatUnfurl(payload: SlackUnfurlPayload): Promise<unknown>
  usersInfo(user: string): Promise<{ ok: boolean; email: string | null }>
}

export type SlackUnfurlPayload =
  | {
      channel: string
      ts: string
      unfurls: Record<string, never>
      user_auth_required: true
      user_auth_url: string
      user_auth_message: string
      user_auth_blocks: AnyMessageBlock[]
    }
  | {
      channel: string
      ts: string
      unfurls: Record<string, { fallback: string; blocks: AnyMessageBlock[] }>
      user_auth_required?: never
    }

interface ShareableForUnfurl {
  id: string
  name: string
  derived_title: string | null
  title_override: string | null
  artifact_kind: ArtifactKind
  visibility: Visibility
  workspace_id: string
  owner_user_id: string
  container_id: string | null
  container_kind: 'project' | 'inbox' | null
  container_base_visibility: 'workspace' | 'private' | null
  container_name: string | null
  owner_email: string | null
  owner_name: string | null
  owner_locale: string | null
  current_version_id: string
  r2_key: string
  created_at: string
}

interface ResolvedSlackUser {
  id: string
  email: string | null
  emailVerified: boolean
  workspaceId: string | null
}

class SlackWebClient implements SlackUnfurlClient {
  constructor(private readonly botToken: string) {}

  chatUnfurl(payload: SlackUnfurlPayload): Promise<unknown> {
    return slackApi(this.botToken, 'chat.unfurl', payload)
  }

  async usersInfo(
    user: string,
  ): Promise<{ ok: boolean; email: string | null }> {
    const result = (await slackApi(this.botToken, 'users.info', {
      user,
    })) as {
      ok?: boolean
      user?: { profile?: { email?: string } }
    }
    return {
      ok: result.ok === true,
      email: result.user?.profile?.email ?? null,
    }
  }
}

export async function processSlackLinkShared(
  db: Db,
  event: SlackLinkSharedEvent,
  requestUrl: string,
  clientFactory: (botToken: string) => SlackUnfurlClient = (botToken) =>
    new SlackWebClient(botToken),
): Promise<void> {
  const teamId = event.team_id
  if (!teamId) return

  const workspace = await db
    .selectFrom('slack_workspaces')
    .select(['team_id', 'bot_token'])
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  if (!workspace) return

  const links = event.links
    .map((link) => ({ url: link.url, shortId: extractShareableId(link.url) }))
    .filter((link): link is { url: string; shortId: string } =>
      Boolean(link.shortId),
    )
  if (links.length === 0) return

  const client = clientFactory(workspace.bot_token)

  // 各 link は理論上独立で Promise.all 並列化可能だが、(1) Slack
  // chat.unfurl の rate limit (tier 4、50 req/min) を 1 イベント burst で
  // 食う、(2) 既存テストが calls[0] index 順を assert する、(3) 典型的に
  // links は 1-3 件で sequential のレイテンシ差が小さい、の 3 点から
  // sequential のまま残す。
  for (const link of links) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const shareable = await getShareableForUnfurl(db, link.shortId)
    if (!shareable) continue

    const user = await resolveSlackUser(db, client, teamId, event.user)
    if (!user) {
      await client.chatUnfurl(await buildConnectCtaPayload(event, requestUrl))
      continue
    }
    if (!isVisibility(shareable.visibility)) continue

    const displayCheck = await viewerDisplayCheck(
      db,
      shareable.visibility,
      user.id,
      {
        id: shareable.id,
        modifiedTime: shareable.created_at,
        name: shareable.name,
        mimeType: 'text/html',
        ownerEmail: shareable.owner_email,
      },
      {
        shareableId: shareable.id,
        ownerUserId: shareable.owner_user_id,
        artifactWorkspaceId: shareable.workspace_id,
        viewerWorkspaceId: user.workspaceId,
        viewerEmail: user.email,
        viewerEmailVerified: user.emailVerified,
        containerId: shareable.container_id,
        containerKind: shareable.container_kind,
        containerBaseVisibility: shareable.container_base_visibility,
      },
    )
    if (displayCheck.kind !== 'access-granted') continue

    // 本文抜粋は広い共有範囲だけ出す。種別アイコン (中身を晒さない) は
    // buildRichUnfurlPayload 側で全共有範囲に付ける。
    const excerpt = bodyPreviewEligible(
      shareable.visibility,
      shareable.container_base_visibility,
    )
      ? await loadPreviewExcerpt(shareable.r2_key, shareable.artifact_kind)
      : null

    await client.chatUnfurl(
      buildRichUnfurlPayload(event, link.url, shareable, requestUrl, {
        excerpt,
      }),
    )
  }
}

export async function upsertSlackUserLink(
  db: Db,
  teamId: string,
  slackUserId: string,
  artifactshareUserId: string,
): Promise<void> {
  const now = nowIso()
  const existing = await db
    .selectFrom('slack_user_links')
    .select('id')
    .where('slack_team_id', '=', teamId)
    .where('slack_user_id', '=', slackUserId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('slack_user_links')
      .set({ artifactshare_user_id: artifactshareUserId, linked_at: now })
      .where('id', '=', existing.id)
      .execute()
    return
  }

  await db
    .insertInto('slack_user_links')
    .values({
      id: nanoid(),
      slack_team_id: teamId,
      slack_user_id: slackUserId,
      artifactshare_user_id: artifactshareUserId,
      linked_at: now,
    })
    .execute()
}

export function slackOauthCallbackUrl(requestUrl: string | URL): string {
  return new URL('/api/slack/oauth/callback', requestUrl).toString()
}

export function slackNotifyOauthCallbackUrl(requestUrl: string | URL): string {
  return new URL('/api/slack/notify/callback', requestUrl).toString()
}

export async function exchangeSlackOauthCode(
  code: string,
  redirectUri: string,
): Promise<{
  teamId: string
  teamName: string
  botUserId: string
  botToken: string
}> {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    throw new Error('Missing Slack OAuth secrets')
  }

  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  })
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const result = (await response.json()) as {
    ok?: boolean
    error?: string
    access_token?: string
    bot_user_id?: string
    team?: { id?: string; name?: string }
  }
  if (!response.ok || result.ok !== true) {
    throw new Error(`Slack OAuth failed: ${result.error ?? response.status}`)
  }
  if (!result.team?.id || !result.access_token || !result.bot_user_id) {
    throw new Error('Slack OAuth response missing installation fields')
  }
  return {
    teamId: result.team.id,
    teamName: result.team.name ?? result.team.id,
    botUserId: result.bot_user_id,
    botToken: result.access_token,
  }
}

export async function signSlackLinkState(
  payload: { team_id: string; slack_user_id: string },
  secret = env.SLACK_LINK_STATE_SECRET,
): Promise<string> {
  if (!secret) throw new Error('Missing Slack link state secret')
  const body = {
    purpose: 'link' as const,
    ...payload,
    nonce: nanoid(12),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  }
  const encoded = base64UrlEncode(JSON.stringify(body))
  const sig = await hmacSha256(encoded, secret)
  return `${encoded}.${sig}`
}

export async function verifySlackLinkState(
  state: string,
  secret = env.SLACK_LINK_STATE_SECRET,
): Promise<{ team_id: string; slack_user_id: string } | null> {
  if (!secret) throw new Error('Missing Slack link state secret')
  const [encoded, sig] = state.split('.')
  if (!encoded || !sig) return null
  const expected = await hmacSha256(encoded, secret)
  if (sig !== expected) return null

  const payload = JSON.parse(base64UrlDecode(encoded)) as {
    purpose?: string
    team_id?: string
    slack_user_id?: string
    exp?: number
  }
  if (payload.purpose !== 'link') return null
  if (!payload.team_id || !payload.slack_user_id || !payload.exp) return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null
  return { team_id: payload.team_id, slack_user_id: payload.slack_user_id }
}

// workspace install 用の signed state (CSRF / なりすまし防止)。spec §5.5.3。
// `purpose` claim で per-user link state と区別、同じ SLACK_LINK_STATE_SECRET を流用。
export async function signSlackInstallState(
  payload: { admin_user_id: string; workspace_id: string },
  secret = env.SLACK_LINK_STATE_SECRET,
): Promise<string> {
  if (!secret) throw new Error('Missing Slack link state secret')
  const body = {
    purpose: 'install' as const,
    ...payload,
    nonce: nanoid(12),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  }
  const encoded = base64UrlEncode(JSON.stringify(body))
  const sig = await hmacSha256(encoded, secret)
  return `${encoded}.${sig}`
}

export async function exchangeSlackWebhookOauthCode(
  code: string,
  redirectUri: string,
) {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET)
    throw new Error('Missing Slack OAuth secrets')
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const result = (await response.json()) as {
    ok?: boolean
    error?: string
    incoming_webhook?: {
      url?: string
      channel_id?: string
      channel?: string
      configuration_url?: string
    }
    team?: { id?: string; name?: string }
  }
  const hook = result.incoming_webhook
  if (!response.ok || result.ok !== true)
    throw new Error(`Slack OAuth failed: ${result.error ?? response.status}`)
  if (!hook?.url || !hook.channel_id || !hook.channel || !result.team?.id)
    throw new Error('Slack OAuth response missing incoming webhook')
  return {
    webhookUrl: hook.url,
    channelId: hook.channel_id,
    // incoming_webhook.channel は「#general」のように # 付きで返る。
    // 表示側が # を付けるため、ここで正規化して二重の ## を防ぐ。
    channelName: hook.channel.replace(/^#/, ''),
    configurationUrl: hook.configuration_url ?? null,
    teamId: result.team.id,
    teamName: result.team.name ?? result.team.id,
  }
}

export async function signSlackNotifyState(
  payload: { user_id: string; workspace_id: string; container_id: string },
  secret = env.SLACK_LINK_STATE_SECRET,
) {
  if (!secret) throw new Error('Missing Slack link state secret')
  const body = {
    purpose: 'notify' as const,
    ...payload,
    nonce: nanoid(12),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  }
  const encoded = base64UrlEncode(JSON.stringify(body))
  return `${encoded}.${await hmacSha256(encoded, secret)}`
}

export async function verifySlackNotifyState(
  state: string,
  secret = env.SLACK_LINK_STATE_SECRET,
): Promise<{
  user_id: string
  workspace_id: string
  container_id: string
  nonce: string
} | null> {
  if (!secret) throw new Error('Missing Slack link state secret')
  try {
    const [encoded, sig] = state.split('.')
    if (!encoded || !sig || sig !== (await hmacSha256(encoded, secret)))
      return null
    const p = JSON.parse(base64UrlDecode(encoded)) as {
      purpose?: string
      user_id?: string
      workspace_id?: string
      container_id?: string
      nonce?: string
      exp?: number
    }
    if (
      p.purpose !== 'notify' ||
      !p.user_id ||
      !p.workspace_id ||
      !p.container_id ||
      !p.nonce ||
      !p.exp ||
      p.exp < Math.floor(Date.now() / 1000)
    )
      return null
    return {
      user_id: p.user_id,
      workspace_id: p.workspace_id,
      container_id: p.container_id,
      nonce: p.nonce,
    }
  } catch {
    return null
  }
}

export interface SlackConnectionListItem {
  id: string
  teamName: string
  installedAt: string
  installedByName: string | null
}

export async function listWorkspaceSlackConnections(
  db: Db,
  workspaceId: string,
): Promise<SlackConnectionListItem[]> {
  const rows = await db
    .selectFrom('slack_workspaces')
    .leftJoin('users', 'users.id', 'slack_workspaces.installed_by_user_id')
    .select([
      'slack_workspaces.id as id',
      'slack_workspaces.team_name as teamName',
      'slack_workspaces.installed_at as installedAt',
      'users.name as userName',
      'users.email as userEmail',
    ])
    .where('slack_workspaces.workspace_id', '=', workspaceId)
    .orderBy('slack_workspaces.installed_at', 'desc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    teamName: row.teamName,
    installedAt: row.installedAt,
    installedByName: row.userEmail
      ? row.userName?.trim() || row.userEmail
      : null,
  }))
}

export async function deleteWorkspaceSlackConnection(
  db: Db,
  actor: { id: string; workspaceId: string },
  connectionId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized

  const connection = await db
    .selectFrom('slack_workspaces')
    .select(['id', 'bot_token'])
    .where('id', '=', connectionId)
    .where('workspace_id', '=', actor.workspaceId)
    .executeTakeFirst()
  if (!connection) return { kind: 'not-found' }

  const revoked = await revokeSlackBotToken(connection.bot_token)
  if (!revoked) return { kind: 'external-failed' }

  const result = await db
    .deleteFrom('slack_workspaces')
    .where('id', '=', connectionId)
    .where('workspace_id', '=', actor.workspaceId)
    .executeTakeFirst()

  if (Number(result.numDeletedRows) === 0) {
    return { kind: 'not-found' }
  }
  return { kind: 'ok' }
}

async function revokeSlackBotToken(botToken: string): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({}),
    })
    const result = (await response.json()) as {
      ok?: boolean
      error?: string
      revoked?: boolean
    }
    if (response.ok && result.ok !== false) return result.revoked === true
    return (
      result.error === 'invalid_auth' || result.error === 'account_inactive'
    )
  } catch {
    return false
  }
}

export async function verifySlackInstallState(
  state: string,
  secret = env.SLACK_LINK_STATE_SECRET,
): Promise<{ admin_user_id: string; workspace_id: string } | null> {
  if (!secret) throw new Error('Missing Slack link state secret')
  const [encoded, sig] = state.split('.')
  if (!encoded || !sig) return null
  const expected = await hmacSha256(encoded, secret)
  if (sig !== expected) return null

  const payload = JSON.parse(base64UrlDecode(encoded)) as {
    purpose?: string
    admin_user_id?: string
    workspace_id?: string
    exp?: number
  }
  if (payload.purpose !== 'install') return null
  if (!payload.admin_user_id || !payload.workspace_id || !payload.exp)
    return null
  if (payload.exp < Math.floor(Date.now() / 1000)) return null
  return {
    admin_user_id: payload.admin_user_id,
    workspace_id: payload.workspace_id,
  }
}

function extractShareableId(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'a') return null
  return parts[1] || null
}

async function buildConnectCtaPayload(
  event: SlackLinkSharedEvent,
  requestUrl: string,
): Promise<SlackUnfurlPayload> {
  const url = new URL('/connect/slack', requestUrl)
  url.searchParams.set(
    'state',
    await signSlackLinkState({
      team_id: event.team_id ?? '',
      slack_user_id: event.user,
    }),
  )
  const authUrl = url.toString()
  return {
    channel: event.channel,
    ts: event.message_ts,
    unfurls: {},
    user_auth_required: true,
    user_auth_url: authUrl,
    user_auth_message: MESSAGES[DEFAULT_LOCALE]['slack.connect.text'],
    user_auth_blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: MESSAGES[DEFAULT_LOCALE]['slack.connect.text'],
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: MESSAGES[DEFAULT_LOCALE]['slack.connect.button'],
            },
            url: authUrl,
            style: 'primary',
          },
        ],
      },
    ],
  }
}

async function getShareableForUnfurl(
  db: Db,
  id: string,
): Promise<ShareableForUnfurl | null> {
  const row = await db
    .selectFrom('shareables')
    .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin(
      'artifact_containers as project_container',
      'project_container.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.artifact_kind',
      'shareables.visibility',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.container_id',
      'project_container.kind as container_kind',
      'project_container.base_visibility as container_base_visibility',
      'project_container.name as container_name',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.locale as owner_locale',
      'shareables.current_version_id',
      'versions.r2_key',
      'versions.created_at',
    ])
    .where('shareables.id', '=', id)
    .executeTakeFirst()
  if (!row?.current_version_id) return null
  return row as ShareableForUnfurl
}

async function resolveSlackUser(
  db: Db,
  client: SlackUnfurlClient,
  teamId: string,
  slackUserId: string,
): Promise<ResolvedSlackUser | null> {
  const linked = await db
    .selectFrom('slack_user_links')
    .innerJoin('users', 'users.id', 'slack_user_links.artifactshare_user_id')
    .select([
      'users.id',
      'users.email',
      'users.email_verified',
      'users.workspace_id as workspaceId',
    ])
    .where('slack_team_id', '=', teamId)
    .where('slack_user_id', '=', slackUserId)
    .executeTakeFirst()
  if (linked) {
    return {
      id: linked.id,
      email: linked.email,
      emailVerified: linked.email_verified === 1,
      workspaceId: linked.workspaceId,
    }
  }

  // users.info がメールを返すのは bot token に users:read.email がある場合だけ。
  // scope が無いと email は null になり Connect CTA に落ちる (token は scope 追加後
  // 再インストールしないと更新されない)。
  const info = await client.usersInfo(slackUserId).catch(() => null)
  if (!info?.ok || !info.email) return null

  // users.email はサインイン時に小文字で保存される (auth.server.ts)。Slack
  // プロフィールのメールは大文字を含み得るので、照合前に小文字へ揃える。
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'email_verified', 'workspace_id as workspaceId'])
    .where('email', '=', info.email.toLowerCase())
    .executeTakeFirst()
  return user
    ? {
        id: user.id,
        email: user.email,
        emailVerified: user.email_verified === 1,
        workspaceId: user.workspaceId,
      }
    : null
}

function resolveOwnerName(shareable: ShareableForUnfurl): string {
  const name = shareable.owner_name?.trim()
  if (name) return name
  const email = shareable.owner_email?.trim()
  if (email) {
    const local = email.split('@')[0]?.trim()
    if (local) return local
  }
  return ''
}

// 種別 → 配信する種別アイコン (apps/web/public/file-types/<icon>.png)。
// Record で全 ArtifactKind を網羅し、kind 追加時に型で漏れを検出する。
const TYPE_ICON: Record<ArtifactKind, 'html' | 'md' | 'site'> = {
  markdown_page: 'md',
  html_page: 'html',
  static_site: 'site',
  spa: 'site',
  workspace_app: 'site',
}

const SLACK_KIND_KEY: Record<ArtifactKind, TKey> = {
  markdown_page: 'slack.kind.markdown_page',
  html_page: 'slack.kind.html_page',
  static_site: 'slack.kind.static_site',
  spa: 'slack.kind.spa',
  workspace_app: 'slack.kind.workspace_app',
}

function slackKindLabel(locale: Locale, kind: ArtifactKind): string {
  return MESSAGES[locale][SLACK_KIND_KEY[kind]]
}

function escapeSlackLinkText(text: string): string {
  let truncated = text
  if (text.length > 150) {
    truncated = text.slice(0, 150)
    const lastUnit = truncated.charCodeAt(truncated.length - 1)
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      truncated = truncated.slice(0, -1)
    }
    truncated = `${truncated}…`
  }
  return escapeSlackText(truncated).replaceAll('|', ' ')
}

function escapeSlackText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function buildRichUnfurlPayload(
  event: SlackLinkSharedEvent,
  url: string,
  shareable: ShareableForUnfurl,
  requestUrl: string,
  opts: { excerpt: string | null },
): SlackUnfurlPayload {
  const artifactUrl = new URL(`/a/${shareable.id}`, requestUrl).toString()
  const locale = isSupportedLocale(shareable.owner_locale)
    ? shareable.owner_locale
    : DEFAULT_LOCALE

  const title = displayTitle({
    titleOverride: shareable.title_override,
    derivedTitle: shareable.derived_title,
    name: shareable.name,
  })

  let titleText = `*<${artifactUrl}|${escapeSlackLinkText(title)}>*`
  if (opts.excerpt) {
    titleText += `\n${escapeSlackText(opts.excerpt)}`
  }

  // 種別アイコンは中身を晒さないので全共有範囲で出す。Slack は accessory を
  // 正方形クロップするため、配信 PNG は正方形・中央配置 (docs/brand/file-types/build.sh)。
  const iconUrl = new URL(
    `/file-types/${TYPE_ICON[shareable.artifact_kind]}.png`,
    requestUrl,
  ).toString()

  const titleSection: AnyMessageBlock = {
    type: 'section',
    text: { type: 'mrkdwn', text: titleText },
    accessory: {
      type: 'image' as const,
      image_url: iconUrl,
      alt_text: slackKindLabel(locale, shareable.artifact_kind),
    },
  }

  const ownerName = resolveOwnerName(shareable)
  const metaParts = [
    shareable.container_name ? escapeSlackText(shareable.container_name) : null,
    slackKindLabel(locale, shareable.artifact_kind),
    ownerName ? escapeSlackText(ownerName) : null,
    slackDate(shareable.created_at),
  ].filter((part): part is string => Boolean(part))

  const blocks: AnyMessageBlock[] = [
    {
      type: 'context',
      elements: [
        {
          type: 'image',
          image_url: new URL('/apple-touch-icon.png', requestUrl).toString(),
          alt_text: 'Artifact Share',
        },
        { type: 'mrkdwn', text: 'Artifact Share' },
      ],
    },
    titleSection,
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: metaParts.join(' · ') }],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: MESSAGES[locale]['slack.open'],
          },
          url: artifactUrl,
        },
      ],
    },
  ]
  return {
    channel: event.channel,
    ts: event.message_ts,
    unfurls: {
      [url]: {
        fallback: title,
        blocks,
      },
    },
  }
}

function slackDate(iso: string): string {
  const ts = Math.floor(new Date(iso).getTime() / 1000)
  return `<!date^${ts}^{date_short_pretty} {time}|${iso}>`
}

async function slackApi(
  botToken: string,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  })
  const result = (await response.json()) as { ok?: boolean; error?: string }
  if (!response.ok || result.ok === false) {
    throw new Error(
      `Slack API ${method} failed: ${result.error ?? response.status}`,
    )
  }
  return result
}

export async function postSlackWebhook(
  webhookUrl: string,
  text: string,
): Promise<{ ok: true } | { ok: false; status: number }> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
    })
    return response.ok ? { ok: true } : { ok: false, status: response.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

const SLACK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

export async function verifySlackRequestSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  if (!secret) return false
  const timestamp = headers.get('x-slack-request-timestamp')
  const signature = headers.get('x-slack-signature')
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > SLACK_TIMESTAMP_TOLERANCE_SECONDS) {
    return false
  }
  const expected = `v0=${await hmacSha256Hex(`v0:${timestamp}:${rawBody}`, secret)}`
  return timingSafeEqual(signature, expected)
}

async function hmacSha256Hex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  )
  return base64UrlEncode(signature)
}

function base64UrlEncode(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === 'string'
      ? new TextEncoder().encode(value)
      : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  )
  const binary = atob(padded)
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  )
}

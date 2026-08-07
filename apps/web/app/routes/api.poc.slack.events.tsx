import { env } from 'cloudflare:workers'
import {
  SlackApp,
  type AnyMessageBlock,
  type LinkUnfurls,
  type SlackAppLogLevel,
  type SlackEdgeAppEnv,
} from 'slack-cloudflare-workers'
import { APEX_HOST, WWW_HOST } from '~/lib/hosts'
import { ctxContext } from '~/middleware/context'
import type { Route } from './+types/api.poc.slack.events'

// PoC: Slack chat.unfurl の挙動を観察する。Codex review 指摘に従い 3 経路を
// 分離して、A 単独 / B 単独 / A→B 連続 のどれが per-user か broadcast か
// 切り分けて確認できる構造にしている。Slack App の Event Request URL は
//   <preview>/api/poc/slack/events?path=auth_required (= A only)
//   <preview>/api/poc/slack/events?path=rich (= B only)
//   <preview>/api/poc/slack/events?path=both (= A then B)
// のいずれかで設定し、test channel で URL を post して挙動を観察する。

type PocPath = 'auth_required' | 'rich' | 'both'

const POC_PATHS = new Set<PocPath>(['auth_required', 'rich', 'both'])

export const loader = ({ request }: Route.LoaderArgs) => {
  if (isProductionHost(request))
    return new Response('Not found', { status: 404 })

  return Response.json({
    ok: true,
    route: '/api/poc/slack/events',
    purpose: 'Slack chat.unfurl behavior PoC',
    supportedPaths: [...POC_PATHS],
  })
}

export const action = ({ request, context }: Route.ActionArgs) => {
  if (isProductionHost(request))
    return new Response('Not found', { status: 404 })
  if (!env.SLACK_SIGNING_SECRET || !env.SLACK_BOT_TOKEN) {
    return Response.json({ error: 'missing-slack-secrets' }, { status: 500 })
  }

  // Slack の event subscription URL を `?path=auth_required|rich|both` で
  // 切り替えて PoC 経路を変えたいので、SlackApp は毎 request 新規構築する
  // (cache してしまうと最初の request URL の path に固定されてしまう)。
  // PoC scope では verification overhead は許容。
  const slackApp = createPocSlackApp(request.url, {
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
  })
  return slackApp.run(request, context.get(ctxContext))
}

function getPocPath(request: Request): PocPath {
  const raw = new URL(request.url).searchParams.get('path')
  return raw && POC_PATHS.has(raw as PocPath)
    ? (raw as PocPath)
    : 'auth_required'
}

function createPocSlackApp(
  initialUrl: string,
  secrets: { SLACK_SIGNING_SECRET: string; SLACK_BOT_TOKEN: string },
) {
  const appEnv: SlackEdgeAppEnv = {
    ...env,
    SLACK_SIGNING_SECRET: secrets.SLACK_SIGNING_SECRET,
    SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
    SLACK_LOGGING_LEVEL:
      (env.SLACK_LOGGING_LEVEL as SlackAppLogLevel | undefined) ?? 'INFO',
  }
  const app = new SlackApp<SlackEdgeAppEnv>({ env: appEnv })

  app.event('link_shared', async ({ payload, context }) => {
    const linkUrls = payload.links.map((link) => link.url)
    // PoC path は handler 起動時の SlackApp.run() に渡された request URL から
    // 取り直さないと取れないが、SlackApp の API 上は payload 経由のみのため
    // initialUrl (module-load 時の request.url) を hint として使う。
    // module-cache の 2 回目以降は別 path で叩いても initialUrl 固定なので、
    // path 切替時は preview deploy ごとに module evict させる (preview URL 自体は
    // 変わらないが、新しい version で別 isolate が起動する)。
    const pocPath = getPocPath(new Request(initialUrl))

    console.log('[poc.slack.unfurl] link_shared', {
      pocPath,
      channel: payload.channel,
      messageTs: payload.message_ts,
      user: payload.user,
      unfurlId: payload.unfurl_id ?? null,
      source: payload.source ?? null,
      links: linkUrls,
    })

    if (linkUrls.length === 0) return

    const authUrl = buildAuthUrl(linkUrls[0], payload.user, initialUrl)
    const richUnfurls = buildRichUnfurls(linkUrls, payload.user)

    if (pocPath === 'auth_required' || pocPath === 'both') {
      const authResponse = await context.client.chat.unfurl({
        channel: payload.channel,
        ts: payload.message_ts,
        unfurls: buildAuthRequiredUnfurls(linkUrls),
        user_auth_required: true,
        user_auth_url: authUrl,
        user_auth_message: 'Connect Artifact Share to inspect this link.',
      })
      console.log('[poc.slack.unfurl] auth_required_response', {
        pocPath,
        ok: authResponse.ok,
        error: authResponse.error ?? null,
      })
    }

    if (pocPath === 'rich' || pocPath === 'both') {
      const richResponse = await context.client.chat.unfurl({
        channel: payload.channel,
        ts: payload.message_ts,
        unfurls: richUnfurls,
      })
      console.log('[poc.slack.unfurl] rich_followup_response', {
        pocPath,
        ok: richResponse.ok,
        error: richResponse.error ?? null,
      })
    }

    // `source` + `unfurl_id` API は rich を送る経路なので、auth_required path
    // のときは観察を汚さないようスキップする (前回 commit までは常時実行して
    // しまい、?path=auth_required でも rich blocks が channel に broadcast されて
    // PoC の挙動分離ができなかった)。rich / both のときだけ叩いて挙動を観察。
    if (
      (pocPath === 'rich' || pocPath === 'both') &&
      payload.unfurl_id &&
      payload.source
    ) {
      const sourceResponse = await context.client.chat.unfurl({
        source:
          payload.source === 'composer' ? 'composer' : 'conversations_history',
        unfurl_id: payload.unfurl_id,
        unfurls: richUnfurls,
      })
      console.log('[poc.slack.unfurl] source_unfurl_id_response', {
        pocPath,
        ok: sourceResponse.ok,
        error: sourceResponse.error ?? null,
        source: payload.source,
        unfurlId: payload.unfurl_id,
      })
    }
  })

  return app
}

function buildAuthRequiredUnfurls(urls: string[]): LinkUnfurls {
  return Object.fromEntries(
    urls.map((url) => [
      url,
      {
        fallback: 'Artifact Share auth-required PoC',
        color: '#64748b',
        blocks: [
          sectionBlock(
            '*Artifact Share PoC A*\nInitial `chat.unfurl` with `user_auth_required: true`.',
          ),
          actionsBlock(url, 'Open posted URL'),
        ],
      },
    ]),
  )
}

function buildRichUnfurls(urls: string[], slackUserId: string): LinkUnfurls {
  return Object.fromEntries(
    urls.map((url) => [
      url,
      {
        fallback: 'Artifact Share rich follow-up PoC',
        color: '#16a34a',
        blocks: [
          sectionBlock(
            `*Artifact Share PoC B*\nRich follow-up blocks sent after auth-required unfurl.\nPosted by Slack user: \`${slackUserId}\``,
          ),
          sectionBlock(
            'Observe from another channel member whether this rich block is broadcast or per-user.',
          ),
          actionsBlock(url, 'Open posted URL'),
        ],
      },
    ]),
  )
}

function sectionBlock(text: string): AnyMessageBlock {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text,
    },
  }
}

function actionsBlock(url: string, text: string): AnyMessageBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text,
        },
        url,
      },
    ],
  }
}

function buildAuthUrl(
  linkUrl: string,
  slackUserId: string,
  requestUrl: string,
): string {
  // request の origin を base にする (=  preview deploy で叩かれた URL の origin)。
  // linkUrl (任意の posted URL) を base にすると wrong origin に飛ぶ。
  const base = new URL(requestUrl)
  const url = new URL('/api/poc/slack/events', base.origin)
  url.searchParams.set('auth', 'mock')
  url.searchParams.set('slack_user_id', slackUserId)
  url.searchParams.set('link', linkUrl)
  return url.toString()
}

function isProductionHost(request: Request): boolean {
  const host = new URL(request.url).hostname
  return host === APEX_HOST || host === WWW_HOST
}

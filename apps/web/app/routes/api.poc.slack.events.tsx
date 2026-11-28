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

import { env } from 'cloudflare:workers'
import {
  SlackApp,
  type SlackAppLogLevel,
  type SlackEdgeAppEnv,
} from 'slack-cloudflare-workers'
import { ctxContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { processSlackLinkShared } from '~/services/slack.server'
import type { Route } from './+types/api.slack.events'

export const loader = () => new Response('Not found', { status: 404 })

export const action = ({ request, context }: Route.ActionArgs) => {
  if (!env.SLACK_SIGNING_SECRET) {
    return Response.json(
      { error: 'missing-slack-signing-secret' },
      { status: 500 },
    )
  }
  const ctx = context.get(ctxContext)
  return createSlackEventsApp(ctx).run(request, ctx)
}

function createSlackEventsApp(ctx: ExecutionContext) {
  const appEnv: SlackEdgeAppEnv = {
    ...env,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET ?? '',
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_LOGGING_LEVEL:
      (env.SLACK_LOGGING_LEVEL as SlackAppLogLevel | undefined) ?? 'INFO',
  }

  const app = new SlackApp<SlackEdgeAppEnv>({
    env: appEnv,
    routes: { events: '/api/slack/events' },
    authorize: async (req) => {
      const teamId = req.context.teamId ?? req.body.team_id
      const row = teamId
        ? await createDb()
            .selectFrom('slack_workspaces')
            .select(['bot_token', 'bot_user_id'])
            .where('team_id', '=', teamId)
            .executeTakeFirst()
        : null
      return {
        enterpriseId: undefined,
        teamId,
        team: teamId,
        botToken: row?.bot_token ?? 'xoxb-uninstalled',
        botId: 'N/A',
        botUserId: row?.bot_user_id ?? 'N/A',
        botScopes: [],
        userId: req.context.actorUserId,
        user: req.context.actorUserId,
        userToken: undefined,
        userScopes: [],
      }
    },
  })

  app.event('link_shared', ({ payload, body }) => {
    // Slack の 3 秒 timeout を確実に守るため、handler は即時 return し、
    // 重い処理は waitUntil で background 実行
    ctx.waitUntil(
      processSlackLinkShared(
        createDb(),
        {
          team_id: body.team_id,
          user: payload.user,
          channel: payload.channel,
          message_ts: payload.message_ts,
          links: payload.links,
        },
        'https://artifactshare.com/api/slack/events',
      ),
    )
    return Promise.resolve()
  })

  return app
}

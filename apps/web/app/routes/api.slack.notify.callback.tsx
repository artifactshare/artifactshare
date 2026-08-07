import { redirect } from 'react-router'
import { requireUserMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { findWorkspaceProject } from '~/services/projects.server'
import {
  exchangeSlackWebhookOauthCode,
  slackNotifyOauthCallbackUrl,
  verifySlackNotifyState,
} from '~/services/slack.server'
import { setContainerSlackChannel } from '~/services/slack-notifications.server'
import type { Route } from './+types/api.slack.notify.callback'

export const middleware = [requireUserMiddleware]

const errorUrl = '/projects?slack=error'

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const params = new URL(request.url).searchParams
  const state = await verifySlackNotifyState(params.get('state') ?? '')
  if (
    !state ||
    state.user_id !== user.id ||
    state.workspace_id !== user.workspaceId
  )
    return redirect(errorUrl)
  const db = createDb()
  if (
    !(await findWorkspaceProject(
      db,
      state.workspace_id,
      state.container_id,
      user,
    ))
  ) {
    return redirect(errorUrl)
  }
  try {
    await db
      .insertInto('slack_notify_nonces')
      .values({
        nonce: state.nonce,
        created_at: new Date().toISOString(),
      })
      .execute()
  } catch {
    return redirect(errorUrl)
  }
  const projectError = `/projects/${encodeURIComponent(state.container_id)}?slack=error`
  if (params.get('error')) return redirect(projectError)
  const code = params.get('code')
  if (!code) return redirect(projectError)
  try {
    const webhook = await exchangeSlackWebhookOauthCode(
      code,
      slackNotifyOauthCallbackUrl(request.url),
    )
    await setContainerSlackChannel(db, {
      containerId: state.container_id,
      webhookUrl: webhook.webhookUrl,
      channelId: webhook.channelId,
      channelName: webhook.channelName,
      slackTeamId: webhook.teamId,
      slackTeamName: webhook.teamName,
      configurationUrl: webhook.configurationUrl,
      userId: user.id,
      now: new Date().toISOString(),
    })
    return redirect(
      `/projects/${encodeURIComponent(state.container_id)}?slack=connected&channel=${encodeURIComponent(webhook.channelName)}`,
    )
  } catch {
    return redirect(projectError)
  }
}

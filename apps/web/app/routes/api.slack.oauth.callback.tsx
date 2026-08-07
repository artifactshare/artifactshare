import { nanoid } from 'nanoid'
import { redirect } from 'react-router'
import { nowIso } from '~/lib/datetime'
import { createDb } from '~/services/db.server'
import {
  exchangeSlackOauthCode,
  slackOauthCallbackUrl,
  verifySlackInstallState,
} from '~/services/slack.server'
import { requireWorkspaceAdmin } from '~/services/team-management.server'
import type { Route } from './+types/api.slack.oauth.callback'

export async function loader({ request }: Route.LoaderArgs): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) return new Response('Missing Slack OAuth code', { status: 400 })
  if (!state) return new Response('Missing Slack OAuth state', { status: 400 })

  const verified = await verifySlackInstallState(state)
  if (!verified) {
    return new Response('Invalid or expired Slack OAuth state', { status: 400 })
  }

  const db = createDb()
  const adminCheck = await requireWorkspaceAdmin(db, {
    id: verified.admin_user_id,
    workspaceId: verified.workspace_id,
  })
  if (adminCheck.kind !== 'ok') {
    return redirect(`/settings/integrations?status=${adminCheck.kind}`)
  }

  // redirect_uri は Slack App 登録 URL と完全一致が必要 (query を除いた path)。
  const install = await exchangeSlackOauthCode(
    code,
    slackOauthCallbackUrl(url.origin),
  )
  const existing = await db
    .selectFrom('slack_workspaces')
    .select('id')
    .where('team_id', '=', install.teamId)
    .executeTakeFirst()

  const values = {
    team_id: install.teamId,
    team_name: install.teamName,
    bot_user_id: install.botUserId,
    bot_token: install.botToken,
    installed_by_user_id: verified.admin_user_id,
    workspace_id: verified.workspace_id,
    installed_at: nowIso(),
  }

  if (existing) {
    await db
      .updateTable('slack_workspaces')
      .set(values)
      .where('id', '=', existing.id)
      .execute()
  } else {
    await db
      .insertInto('slack_workspaces')
      .values({ id: nanoid(12), ...values })
      .execute()
  }

  return redirect('/settings/integrations?connected=slack')
}

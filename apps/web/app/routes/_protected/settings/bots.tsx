import { errorResponse } from '~/lib/api-errors'
import { isBotMembersEnabled } from '~/lib/bot-members-flag.server'
import { requireUser } from '~/middleware/context'
import {
  cancelWorkspaceBot,
  createWorkspaceBot,
  listWorkspaceBots,
  reissueWorkspaceBotCredential,
  stopWorkspaceBot,
} from '~/services/bot-members.server'
import { createDb } from '~/services/db.server'
import { loadSettingsShell } from '~/services/team-management.server'
import { SettingsPage } from '~/components/form/settings-page'
import { BotSection, type BotProjectOption } from './+components/bot-section'
import type { Route } from './+types/bots'

// Dedicated JSON action for bot management. Tokens are returned only in this
// action's response body — never via redirect, flash/session storage, URL
// parameters, or logs. The bot-members feature flag gates creation only:
// stop/reissue keep working for existing bots regardless of the flag.

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const shell = await loadSettingsShell(db, user)
  if (!shell.currentUserIsAdmin) {
    throw new Response('Forbidden', { status: 403 })
  }
  const [bots, botCreationEnabled, projects] = await Promise.all([
    listWorkspaceBots(db, user.workspaceId),
    isBotMembersEnabled(user.workspaceId),
    loadBotDestinationOptions(db, user.workspaceId),
  ])
  return { bots, botCreationEnabled, projects }
}

// Creation candidates: every non-archived project in the workspace
// (workspace-visible and private alike).
async function loadBotDestinationOptions(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
): Promise<BotProjectOption[]> {
  return await db
    .selectFrom('artifact_containers')
    .select(['id', 'name'])
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .orderBy('name', 'asc')
    .execute()
}

export default function BotsPage({ loaderData }: Route.ComponentProps) {
  return (
    <SettingsPage>
      <BotSection
        bots={loaderData.bots}
        projects={loaderData.projects}
        canCreate={loaderData.botCreationEnabled}
      />
    </SettingsPage>
  )
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    intent?: unknown
    name?: unknown
    projectId?: unknown
    botUserId?: unknown
  } | null
  if (!body || typeof body !== 'object') {
    return errorResponse('invalid-body', 'Invalid request body.', 400)
  }
  const db = createDb()
  const actor = { id: user.id, workspaceId: user.workspaceId }

  if (body.intent === 'create') {
    if (!(await isBotMembersEnabled(user.workspaceId))) {
      return errorResponse(
        'feature-not-available',
        'Bot members are not enabled for this workspace.',
        403,
      )
    }
    if (typeof body.name !== 'string' || typeof body.projectId !== 'string') {
      return errorResponse('invalid-body', 'Invalid request body.', 400)
    }
    const result = await createWorkspaceBot(db, actor, {
      name: body.name,
      projectId: body.projectId,
    })
    switch (result.kind) {
      case 'ok':
        return Response.json({
          ok: true,
          botUserId: result.botUserId,
          email: result.email,
          token: result.token,
        })
      case 'forbidden':
        return errorResponse('forbidden', 'Forbidden.', 403)
      case 'bot-name-invalid':
        return errorResponse(
          'bot-name-invalid',
          'The bot name is invalid or already used by an active bot.',
          400,
        )
      case 'bot-destination-invalid':
        return errorResponse(
          'bot-destination-invalid',
          'The destination project cannot be used.',
          400,
        )
      case 'bot-limit-reached':
        return errorResponse(
          'bot-limit-reached',
          'The workspace has reached its active bot limit.',
          409,
        )
      case 'bot-conflict':
        return errorResponse(
          'bot-conflict',
          'Bot creation collided with another request. Retry.',
          409,
        )
    }
  }

  if (
    body.intent === 'stop' ||
    body.intent === 'reissue' ||
    body.intent === 'cancel'
  ) {
    if (typeof body.botUserId !== 'string' || !body.botUserId) {
      return errorResponse('invalid-body', 'Invalid request body.', 400)
    }
    if (body.intent === 'stop') {
      const result = await stopWorkspaceBot(db, actor, body.botUserId)
      switch (result.kind) {
        case 'ok':
          return Response.json({ ok: true })
        case 'forbidden':
          return errorResponse('forbidden', 'Forbidden.', 403)
        case 'not-found':
          return errorResponse('not-found', 'Bot not found.', 404)
      }
    }
    if (body.intent === 'cancel') {
      const result = await cancelWorkspaceBot(db, actor, body.botUserId)
      switch (result.kind) {
        case 'ok':
          return Response.json({ ok: true })
        case 'forbidden':
          return errorResponse('forbidden', 'Forbidden.', 403)
        case 'not-found':
          return errorResponse('not-found', 'Bot not found.', 404)
        case 'bot-used':
          return errorResponse(
            'bot-used',
            'This bot has already been used and cannot be canceled.',
            409,
          )
      }
    }
    const result = await reissueWorkspaceBotCredential(
      db,
      actor,
      body.botUserId,
    )
    switch (result.kind) {
      case 'ok':
        return Response.json({ ok: true, token: result.token })
      case 'forbidden':
        return errorResponse('forbidden', 'Forbidden.', 403)
      case 'not-found':
        return errorResponse('not-found', 'Bot not found.', 404)
      case 'bot-stopped':
        return errorResponse('bot-stopped', 'This bot has been stopped.', 409)
      case 'bot-destination-invalid':
        return errorResponse(
          'bot-destination-invalid',
          'The destination project has been deleted. Create a new bot.',
          400,
        )
      case 'bot-conflict':
        return errorResponse(
          'bot-conflict',
          'The reissue hit a temporary conflict. Retry.',
          409,
        )
    }
  }

  return errorResponse('invalid-body', 'Invalid request body.', 400)
}

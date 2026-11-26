import { updateWorkspaceBotDestinations } from '~/services/bot-destinations.server'
import { data } from 'react-router'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
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
import { requireSettingsAdminPage } from '../+lib/settings-admin.server'
import BotsPage, { type BotsLoaderData } from '../+components/bots-page'
import type { Route } from './+types/bots'

// React Router passes loaderData only to a default export declared here.
export default BotsPage

// Settings action for bot management. Tokens are returned only in this
// action's response body — never via redirect, flash/session storage, URL
// parameters, or logs. The bot-members feature flag gates creation only:
// stop/reissue keep working for existing bots regardless of the flag.

export async function loader({
  context,
}: Route.LoaderArgs): Promise<BotsLoaderData> {
  requireSettingsAdminPage(context)
  const user = requireUser(context)
  const db = createDb()
  const [bots, botCreationEnabled] = await Promise.all([
    listWorkspaceBots(db, user.workspaceId),
    isBotMembersEnabled(user.workspaceId),
  ])
  return { bots, botCreationEnabled }
}

async function botRequestBody(request: {
  json: () => Promise<unknown>
}): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null)
  return isObject(body) ? body : {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isConfirmation(intent: unknown) {
  return intent === 'stop' || intent === 'cancel' || intent === 'reissue'
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const body = await botRequestBody(request.clone())
  return isConfirmation(body?.intent)
    ? confirmationResult(body.intent, serverAction)
    : serverAction()
}

export async function action({ request, context }: Route.ActionArgs) {
  requireSettingsAdminPage(context)
  if (request.method !== 'POST')
    return data(
      { ok: false, code: 'method-not-allowed', intent: '' },
      { status: 405 },
    )
  const body = await botRequestBody(request)
  const intent = typeof body.intent === 'string' ? body.intent : ''
  const submit = () => submitBotForm(context, body, intent)
  return isConfirmation(intent) ? runConfirmedMutation(submit) : submit()
}

async function submitBotForm(
  context: Route.ActionArgs['context'],
  body: Record<string, unknown>,
  intent: string,
) {
  const user = requireUser(context)
  const fail = (code: string, status: number) =>
    data({ ok: false as const, code, intent }, { status })
  const db = createDb()
  const actor = { id: user.id, workspaceId: user.workspaceId }
  const submit = async () => {
    switch (intent) {
      case 'destinations':
        if (
          typeof body.botUserId !== 'string' ||
          typeof body.projectId !== 'string' ||
          typeof body.revision !== 'string'
        )
          return { kind: 'invalid-body' } as const
        return updateWorkspaceBotDestinations(db, actor, {
          botUserId: body.botUserId,
          projectId: body.projectId,
          projectIds: body.projectIds,
          revision: body.revision,
        })
      case 'create':
        if (!(await isBotMembersEnabled(user.workspaceId)))
          return { kind: 'feature-not-available' } as const
        if (typeof body.name !== 'string' || typeof body.projectId !== 'string')
          return { kind: 'invalid-body' } as const
        return createWorkspaceBot(db, actor, {
          name: body.name,
          projectId: body.projectId,
          projectIds: body.projectIds,
        })
      case 'stop':
      case 'reissue':
      case 'cancel':
        if (typeof body.botUserId !== 'string' || !body.botUserId)
          return { kind: 'invalid-body' } as const
        if (intent === 'stop')
          return stopWorkspaceBot(db, actor, body.botUserId)
        if (intent === 'cancel')
          return cancelWorkspaceBot(db, actor, body.botUserId)
        return reissueWorkspaceBotCredential(db, actor, body.botUserId)
      default:
        return { kind: 'invalid-body' } as const
    }
  }
  const result = await submit()
  if (result.kind === 'ok') {
    const { kind, ...payload } = result
    return data(
      { ok: true as const, code: kind, intent, ...payload },
      { status: 200 },
    )
  }
  const code = result.kind
  if (code === 'forbidden' || code === 'feature-not-available')
    return fail(code, 403)
  if (code === 'not-found') return fail(code, 404)
  if (
    ['bot-conflict', 'bot-stopped', 'bot-used', 'bot-limit-reached'].includes(
      code,
    )
  )
    return fail(code, 409)
  return fail(code, 400)
}

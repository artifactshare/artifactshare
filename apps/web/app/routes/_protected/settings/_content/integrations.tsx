import { data } from 'react-router'
import { readSlackInstallFailure } from '~/lib/slack-install-notice.server'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import type { Route } from './+types/integrations'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  deleteWorkspaceSlackConnection,
  listWorkspaceSlackConnections,
} from '~/services/slack.server'
import IntegrationsPage, {
  type IntegrationsLoaderData,
} from '../+components/integrations-page'

// React Router passes loaderData only to a default export declared here.
export default IntegrationsPage

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const [connections, notice] = await Promise.all([
    listWorkspaceSlackConnections(createDb(), user.workspaceId),
    readSlackInstallFailure(request),
  ])
  return data<IntegrationsLoaderData>(
    { connections, ...(notice && { launchFailure: notice.code }) },
    notice ? { headers: { 'Set-Cookie': notice.clearCookie } } : {},
  )
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  const submit = async () => {
    const user = requireUser(context)
    if (intent !== 'disconnect-slack') return settingsFailure(intent, 'invalid')
    const connectionId = stringValue(form.get('connectionId'))
    if (!connectionId) return settingsFailure(intent, 'invalid')
    const result = await deleteWorkspaceSlackConnection(
      createDb(),
      user,
      connectionId,
    )
    if (result.kind !== 'ok') return settingsFailure(intent, result.kind)
    return data(
      { ok: true as const, code: 'slack-disconnected', intent, connectionId },
      { status: 200 },
    )
  }
  return intent === 'disconnect-slack' ? runConfirmedMutation(submit) : submit()
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const intent = (await request.clone().formData()).get('intent')
  return intent === 'disconnect-slack'
    ? confirmationResult(intent, serverAction)
    : serverAction()
}

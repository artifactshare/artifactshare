import { data } from 'react-router'
import type { Route } from './+types/general'
import { stringValue } from '~/lib/form'
import { settingsFailure } from '~/lib/settings-submission'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceOwner,
  updateWorkspaceName,
} from '~/services/team-management.server'
import GeneralPage, {
  type GeneralLoaderData,
} from '../+components/general-page'

// React Router passes loaderData only to a default export declared here.
export default GeneralPage

export async function loader({
  context,
}: Route.LoaderArgs): Promise<GeneralLoaderData> {
  const user = requireUser(context)
  const db = createDb()
  return { owner: await loadWorkspaceOwner(db, user.workspaceId) }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  if (intent !== 'update-workspace-name') {
    return data({ ok: false, intent, code: 'invalid' }, { status: 400 })
  }
  const result = await updateWorkspaceName(
    createDb(),
    user,
    stringValue(form.get('workspaceName')) ?? '',
  )
  return result.kind === 'ok'
    ? data({ ok: true as const, intent, code: result.kind }, { status: 200 })
    : settingsFailure(intent, result.kind)
}

import type { Route } from './+types/projects.$id.slack'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { findWorkspaceProject } from '~/services/projects.server'
import {
  clearContainerSlackChannel,
  getContainerSlackChannel,
} from '~/services/slack-notifications.server'

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const id = params.id
  if (!id || !(await findWorkspaceProject(db, user.workspaceId, id, user)))
    throw new Response('Not found', { status: 404 })
  // getContainerSlackChannel は webhook_url を select しない (全 loader 共通の
  // 露出防止)。送信側は自前の join で読む。
  const current = await getContainerSlackChannel(db, id)
  return { current: current ?? null }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const db = createDb()
  const id = params.id
  if (!id || !(await findWorkspaceProject(db, user.workspaceId, id, user)))
    throw new Response('Not found', { status: 404 })
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  if (intent !== 'clear-slack-channel')
    throw new Response('Unknown intent', { status: 400 })
  await clearContainerSlackChannel(db, id)
  return { intent, ok: true }
}

export default function SlackProjectRoute() {
  return null
}

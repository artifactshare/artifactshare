import { env } from 'cloudflare:workers'
import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { isWorkspaceAdmin } from '~/services/access.server'
import { createDb } from '~/services/db.server'
import { startLinkAbuseJudgment } from '~/services/link-abuse-signals.server'
import type { Route } from './+types/api.shareables.$id.abuse-check'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return errorResponse('method-not-allowed', 'Method not allowed.', 405)
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return loader()
  }
  const user = requireUser(context)
  const db = createDb()
  const shareable = await db
    .selectFrom('shareables')
    .select(['owner_user_id', 'workspace_id', 'visibility'])
    .where('id', '=', params.id)
    .executeTakeFirst()
  if (
    !shareable ||
    shareable.visibility !== 'link' ||
    (shareable.owner_user_id !== user.id &&
      !(await isWorkspaceAdmin(db, user, shareable.workspace_id)))
  ) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }

  const result = await startLinkAbuseJudgment(db, env, {
    shareableId: params.id,
    trigger: 'manual',
    detail: 'owner_requested',
  })
  if (result.kind === 'started') {
    return Response.json({ status: 'accepted' }, { status: 202 })
  }
  if (result.kind === 'cooldown') {
    return errorResponse('cooldown', 'Try again later.', 429, {
      headers: { 'Retry-After': String(result.retryAfterSeconds) },
    })
  }
  return errorResponse(
    'service-unavailable',
    'The abuse review could not be started.',
    503,
  )
}

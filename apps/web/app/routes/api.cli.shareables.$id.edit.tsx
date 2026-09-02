import { errorResponse } from '~/lib/api-errors'
import {
  cliEditErrorResponse,
  cliEditSuccessBody,
  parseCliEditPayload,
} from '~/lib/shareable-settings-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { editShareableSettings } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.shareables.$id.edit'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)

  const body = await request.json().catch(() => null)
  const parsed = parseCliEditPayload(body)
  if (!parsed) {
    return errorResponse('validation-failed', 'Invalid edit payload.', 400)
  }

  const result = await withDb(
    async (db) =>
      await editShareableSettings(
        db,
        user,
        params.id,
        parsed,
        getCliAuthority(context),
      ),
  )
  switch (result.kind) {
    case 'ok':
      return Response.json(cliEditSuccessBody(request.url, result.shareable))
    default:
      return cliEditErrorResponse(result)
  }
}

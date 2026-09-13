import {
  ArtifactIdParamsSchema,
  CliEditRequestSchema,
  CliEditResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import {
  cliEditErrorResponse,
  cliEditSuccessBody,
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
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }

  const body = await request.json().catch(() => null)
  const parsedBody = CliEditRequestSchema.safeParse(body)
  if (!parsedBody.success) {
    return errorResponse('validation-failed', 'Invalid edit payload.', 400)
  }
  const parsed = cliEditInput(parsedBody.data)

  const result = await withDb(
    async (db) =>
      await editShareableSettings(
        db,
        user,
        parsedParams.data.id,
        parsed,
        getCliAuthority(context),
      ),
  )
  switch (result.kind) {
    case 'ok':
      return Response.json(
        CliEditResponseSchema.parse(
          cliEditSuccessBody(request.url, result.shareable),
        ),
      )
    default:
      return cliEditErrorResponse(result)
  }
}

function cliEditInput(payload: ReturnType<typeof CliEditRequestSchema.parse>) {
  return {
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.visibility !== undefined
      ? { visibility: payload.visibility }
      : {}),
    ...(payload.link_expires_at !== undefined
      ? { linkExpiresAt: payload.link_expires_at }
      : {}),
    ...(payload.add_emails !== undefined
      ? { addEmails: payload.add_emails }
      : {}),
    ...(payload.remove_emails !== undefined
      ? { removeEmails: payload.remove_emails }
      : {}),
    ...(payload.destination !== undefined
      ? {
          destination:
            payload.destination === 'home'
              ? { type: 'inbox' as const }
              : {
                  type: 'project' as const,
                  projectId: payload.destination.project_id,
                },
        }
      : {}),
  }
}

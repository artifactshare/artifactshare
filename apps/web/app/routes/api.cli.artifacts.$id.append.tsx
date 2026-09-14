import {
  ArtifactAppendRequestSchema,
  ArtifactAppendResponseSchema,
  ArtifactIdParamsSchema,
} from '@artifactshare/contract'
import { env } from 'cloudflare:workers'
import { errorResponse } from '~/lib/api-errors'
import { createVersionFailureResponse } from '~/lib/create-version-response.server'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import { publish, publishPrincipal } from '~/modules/publish'
import { isProduction, shareableUrl } from '~/lib/hosts'
import type { Route } from './+types/api.cli.artifacts.$id.append'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const { id } = parsedParams.data
  const body = await request.json().catch(() => null)
  const parsedBody = ArtifactAppendRequestSchema.safeParse(body)
  if (!parsedBody.success)
    return errorResponse(
      'validation_failed',
      'Non-empty UTF-8 content is required.',
      400,
    )
  const actor = publishPrincipal(user, getCliAuthority(context))
  if (!actor) {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this update.',
      403,
    )
  }
  const ctx = context.get(ctxContext)
  const result = await publish({
    actor,
    target: { kind: 'append', artifactId: id },
    content: { kind: 'append', content: parsedBody.data.content },
    waitUntil: (promise) => ctx.waitUntil(promise),
  })
  if (result.kind === 'ok') {
    return Response.json(
      ArtifactAppendResponseSchema.parse({
        id,
        versionId: result.versionId,
        shareUrl: shareableUrl(
          new URL(request.url).origin,
          id,
          result.visibility,
          isProduction(env),
        ),
        artifactKind: result.artifactKind,
      }),
    )
  }
  if (result.kind === 'version-conflict')
    return Response.json(
      {
        error: {
          code: 'version_conflict',
          message: `The artifact changed before append. Current version: ${result.currentVersionId ?? 'unknown'}.`,
          details: { current_version_id: result.currentVersionId },
        },
      },
      { status: 409 },
    )
  if (result.kind === 'forbidden') {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this update.',
      403,
    )
  }
  if (result.kind === 'self-upload-disabled')
    return uploadPermissionFailureResponse(result)
  return createVersionFailureResponse(result, () =>
    errorResponse(
      'copy-forbidden',
      'Static sites are not supported; append only works for a single Markdown or HTML artifact. Use update to replace the full source.',
      403,
    ),
  )
}

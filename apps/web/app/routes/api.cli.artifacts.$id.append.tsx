import { errorResponse } from '~/lib/api-errors'
import { createVersionFailureResponse } from '~/lib/create-version-response.server'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import { isAgentOwnedArtifact } from '~/services/agent-scope.server'
import { createDb } from '~/services/db.server'
import { appendShareable } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.artifacts.$id.append'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const user = requireUser(context)
  const db = createDb()
  const authority = getCliAuthority(context)
  if (
    authority?.kind === 'agent' &&
    !(await isAgentOwnedArtifact(db, authority, params.id ?? ''))
  ) {
    return errorResponse('forbidden', 'CLI agent scope does not allow this update.', 403)
  }
  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed')
    return uploadPermissionFailureResponse(permission)
  const ctx = context.get(ctxContext)
  const body = (await request.json().catch(() => null)) as {
    content?: unknown
  } | null
  if (typeof body?.content !== 'string' || body.content.length === 0)
    return errorResponse(
      'validation_failed',
      'Non-empty UTF-8 content is required.',
      400,
    )
  const result = await appendShareable(
    db,
    user,
    params.id ?? '',
    body.content,
    { waitUntil: (promise) => ctx.waitUntil(promise) },
  )
  if (result.kind === 'ok')
    return Response.json({
      id: params.id,
      versionId: result.versionId,
      shareUrl: `${new URL(request.url).origin}/a/${params.id}`,
      artifactKind: result.artifactKind,
    })
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
  return createVersionFailureResponse(result, () =>
    errorResponse(
      'copy-forbidden',
      'Static sites are not supported; append only works for a single Markdown or HTML artifact. Use update to replace the full source.',
      403,
    ),
  )
}

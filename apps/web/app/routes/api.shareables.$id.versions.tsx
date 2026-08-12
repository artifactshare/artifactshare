import { errorResponse } from '~/lib/api-errors'
import { createVersionFailureResponse } from '~/lib/create-version-response.server'
import { runStaticSiteVersionUpload } from '~/lib/static-site-version-upload.server'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import {
  isAgentOwnedArtifact,
  isAgentReadableArtifact,
} from '~/services/agent-scope.server'
import {
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { createDb } from '~/services/db.server'
import { updateShareable } from '~/services/shareables.server'
import type { Route } from './+types/api.shareables.$id.versions'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const authority = getCliAuthority(context)
  if (
    authority?.kind === 'agent' &&
    !(await isAgentReadableArtifact(db, user, authority, params.id))
  ) {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this update.',
      403,
    )
  }
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin(
      'artifact_containers as project_container',
      'project_container.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.visibility',
      'shareables.container_id',
      'shareables.current_version_id',
      'project_container.kind as project_container_kind',
      'project_container.base_visibility as project_container_base_visibility',
      'versions.r2_key',
      'versions.artifact_kind',
    ])
    .where('shareables.id', '=', params.id)
    .executeTakeFirst()
  if (!shareable?.r2_key) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }

  const snapshot: ArtifactSnapshot = {
    id: shareable.r2_key,
    name: shareable.name,
    mimeType:
      shareable.artifact_kind === 'markdown_page'
        ? 'text/markdown'
        : 'text/html',
    modifiedTime: null,
    ownerEmail: null,
  }
  const check = await viewerDisplayCheck(
    db,
    shareable.visibility,
    user.id,
    snapshot,
    {
      shareableId: shareable.id,
      ownerUserId: shareable.owner_user_id,
      artifactWorkspaceId: shareable.workspace_id,
      viewerWorkspaceId: user.workspaceId,
      viewerEmail: user.email,
      viewerEmailVerified: user.emailVerified,
      containerId: shareable.container_id,
      containerKind: shareable.project_container_kind,
      containerBaseVisibility: shareable.project_container_base_visibility,
    },
  )
  if (check.kind !== 'access-granted') {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }

  return Response.json({
    id: params.id,
    currentVersionId: shareable.current_version_id,
  })
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const user = requireUser(context)
  const db = createDb()
  const authority = getCliAuthority(context)
  if (
    authority?.kind === 'agent' &&
    !(await isAgentOwnedArtifact(db, user, authority, params.id))
  ) {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this update.',
      403,
    )
  }
  const ctx = context.get(ctxContext)
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed') {
    return uploadPermissionFailureResponse(permission)
  }
  const kindHint = new URL(request.url).searchParams.get('artifact_kind')
  if (kindHint === 'static_site') {
    return await runStaticSiteVersionUpload(db, request, user, params.id, {
      waitUntil,
    })
  }

  const form = await request.formData()
  const file = form.get('file')
  if (!(file instanceof File)) {
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const result = await updateShareable(db, user, params.id, file, {
    waitUntil,
  })
  if (result.kind === 'ok') {
    return Response.json({
      id: params.id,
      versionId: result.versionId,
      shareUrl: `${new URL(request.url).origin}/a/${params.id}`,
    })
  }
  return createVersionFailureResponse(result, () =>
    errorResponse('copy-forbidden', 'This file cannot be copied.', 403),
  )
}

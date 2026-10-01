import { publicationChannel } from '~/middleware/context'
import { conflictDetails } from '~/services/version-safety.server'
import {
  ArtifactIdParamsSchema,
  ArtifactVersionLookupResponseSchema,
  ArtifactVersionUpdateFormSchema,
  ArtifactVersionUpdateQuerySchema,
  ArtifactVersionUpdateResponseSchema,
} from '@artifactshare/contract'
import { env } from 'cloudflare:workers'
import { sql } from 'kysely'
import { errorResponse } from '~/lib/api-errors'
import { createVersionFailureResponse } from '~/lib/create-version-response.server'
import { runStaticSiteVersionUpload } from '~/lib/static-site-version-upload.server'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import {
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { createDb, type Db } from '~/services/db.server'
import { publish, publishPrincipal } from '~/modules/publish'
import { isProduction, shareableUrl } from '~/lib/hosts'
import type { Route } from './+types/api.shareables.$id.versions'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  const { id } = parsedParams.data
  const db = createDb()
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
    .where('shareables.id', '=', id)
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

  return Response.json(
    ArtifactVersionLookupResponseSchema.parse({
      id,
      currentVersionId: shareable.current_version_id,
    }),
  )
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  const { id } = parsedParams.data
  const db = createDb()
  const authority = getCliAuthority(context)
  const searchParams = new URL(request.url).searchParams
  const labels = searchParams.getAll('label')
  if (labels.length > 1) {
    return errorResponse(
      'validation-failed',
      'Label must be specified only once.',
      400,
    )
  }
  const rawKindHint = searchParams.get('artifact_kind')
  const parsedQuery = ArtifactVersionUpdateQuerySchema.safeParse({
    label: labels[0],
    force: searchParams.get('force') ?? undefined,
    expected_version: searchParams.get('expected_version') ?? undefined,
    // Unknown hints historically fell through to the single-file path. Keep
    // that compatibility while asserting recognized query fields through the
    // shared contract.
    ...(rawKindHint === null || rawKindHint === 'static_site'
      ? { artifact_kind: rawKindHint ?? undefined }
      : {}),
  })
  if (!parsedQuery.success) {
    return errorResponse('validation-failed', 'Invalid version query.', 400)
  }
  const expectedCurrentVersionId =
    parsedQuery.data.expected_version?.trim() || null
  const ctx = context.get(ctxContext)
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed') {
    return uploadPermissionFailureResponse(permission)
  }
  const kindHint = parsedQuery.data.artifact_kind
  if (kindHint === 'static_site') {
    return contractVersionResponse(
      db,
      id,
      await runStaticSiteVersionUpload(db, request, user, id, {
        createdVia: publicationChannel(context, request),
        force: parsedQuery.data.force === 'true',
        waitUntil,
        ...(parsedQuery.data.label !== undefined
          ? { label: parsedQuery.data.label }
          : {}),
        ...(authority ? { authority } : {}),
        ...(expectedCurrentVersionId ? { expectedCurrentVersionId } : {}),
        ...(authority?.kind === 'agent'
          ? { agentProfileId: authority.agentProfileId }
          : {}),
      }),
      parsedQuery.data.label ?? null,
    )
  }

  const form = await request.formData()
  const parsedForm = ArtifactVersionUpdateFormSchema.safeParse({
    file: [form.get('file')],
  })
  if (!parsedForm.success) {
    return errorResponse('missing-file', 'File is required.', 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const actor = publishPrincipal(user, authority)
  if (!actor) return errorResponse('not-found', 'Shareable not found.', 404)
  const result = await publish({
    db,
    actor,
    createdVia: publicationChannel(context, request),
    target: {
      kind: 'update',
      force: parsedQuery.data.force === 'true',
      ...(parsedQuery.data.label !== undefined
        ? { label: parsedQuery.data.label }
        : {}),
      artifactId: id,
      ...(expectedCurrentVersionId
        ? { expectedVersionId: expectedCurrentVersionId }
        : {}),
    },
    content: {
      kind: 'file',
      path: file.name,
      bytes: file,
      mediaType: file.type,
    },
    waitUntil,
  })
  if (result.kind === 'forbidden') {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  if (result.kind === 'expected-version-required') {
    return errorResponse(
      'expected-version-required',
      'Agent updates require the current version id.',
      400,
    )
  }
  if (result.kind === 'ok') {
    const shareable = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return Response.json(
      ArtifactVersionUpdateResponseSchema.parse({
        id,
        versionId: result.versionId,
        number: await versionNumber(db, id, result.versionId),
        label: parsedQuery.data.label ?? null,
        shareUrl: shareableUrl(
          new URL(request.url).origin,
          id,
          shareable.visibility,
          isProduction(env),
        ),
      }),
    )
  }
  if (result.kind === 'version-conflict')
    return Response.json(
      {
        error: {
          code: 'version_conflict',
          message: 'The artifact changed before the update was committed.',
          details: conflictDetails(result),
        },
      },
      { status: 409 },
    )
  return createVersionFailureResponse(result, () =>
    errorResponse('copy-forbidden', 'This file cannot be copied.', 403),
  )
}

async function contractVersionResponse(
  db: Db,
  artifactId: string,
  response: Response,
  label: string | null,
): Promise<Response> {
  if (!response.ok) return response
  const parsed = ArtifactVersionUpdateResponseSchema.parse(
    await response.json(),
  )
  const body = ArtifactVersionUpdateResponseSchema.parse({
    ...parsed,
    number: await versionNumber(db, artifactId, parsed.versionId),
    label,
  })
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: response.headers,
  })
}

// Keep the ordinal aligned with the Viewer's published version history.
async function versionNumber(db: Db, artifactId: string, versionId: string) {
  try {
    const version = await db
      .selectFrom('versions')
      .select((eb) => [
        eb
          .selectFrom('versions as older')
          .select((sub) => sub.fn.count<number>('older.id').as('count'))
          .whereRef('older.shareable_id', '=', 'versions.shareable_id')
          .where('older.status', '=', 'published')
          .where('older.published_at', 'is not', null)
          .where(
            sql<boolean>`(
              older.created_at < versions.created_at
              OR (older.created_at = versions.created_at AND older.id <= versions.id)
            )`,
          )
          .as('ordinal'),
      ])
      .where('versions.shareable_id', '=', artifactId)
      .where('versions.id', '=', versionId)
      .where('versions.status', '=', 'published')
      .where('versions.published_at', 'is not', null)
      .executeTakeFirst()
    return version ? Number(version.ordinal) : undefined
  } catch {
    // Publication already succeeded; optional metadata must not prompt a retry.
    return undefined
  }
}

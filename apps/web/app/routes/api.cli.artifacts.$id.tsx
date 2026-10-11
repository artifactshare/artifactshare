import {
  allowsHumanCliMutation,
  cliReadAuthority,
} from '~/lib/cli-authority-policy'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import {
  ArtifactDeleteResponseSchema,
  ArtifactIdParamsSchema,
  ArtifactIncludeSchema,
  ArtifactReadQueryParamsSchema,
  ArtifactReadQuerySchema,
  ArtifactReadResponseSchema,
  PublisherArtifactReadResponseSchema,
} from '@artifactshare/contract'
import { cliArtifactErrorResponse, errorResponse } from '~/lib/api-errors'
import {
  cliDeleteArtifactErrorResponse,
  deleteArtifactSuccessBody,
} from '~/lib/project-actions-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { authorizeAgentArtifactRead } from '~/services/agent-scope.server'
import {
  getArtifactReadback,
  getPublisherArtifactReadback,
  type ArtifactReadbackInclude,
} from '~/services/artifact-readback-service.server'
import { withDb } from '~/services/db.server'
import { deleteShareable } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.artifacts.$id'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const url = new URL(request.url)
  const parsedQueryParams = ArtifactReadQueryParamsSchema.safeParse({
    offset: url.searchParams.get('offset') ?? undefined,
    include: url.searchParams.getAll('include'),
  })
  if (!parsedQueryParams.success) {
    const hasOffsetError = parsedQueryParams.error.issues.some(
      (issue) => issue.path[0] === 'offset',
    )
    if (hasOffsetError) {
      return errorResponse(
        'invalid-offset',
        'Offset must be a non-negative integer.',
        400,
      )
    }
    return errorResponse(
      'invalid-include',
      'Include must be versions or comments.',
      400,
    )
  }
  const parsedQuery = ArtifactReadQuerySchema.safeParse({
    offset:
      parsedQueryParams.data.offset === undefined
        ? undefined
        : Number(parsedQueryParams.data.offset),
    include: normalizeInclude(parsedQueryParams.data.include),
  })
  if (!parsedQuery.success) {
    return errorResponse(
      'invalid-offset',
      'Offset must be a non-negative integer.',
      400,
    )
  }
  const { id } = parsedParams.data
  const { offset, include } = parsedQuery.data

  return await withDb(async (db) => {
    const resolved = getCliAuthority(context)
    if (resolved?.kind === 'publisher') {
      if (url.searchParams.has('include')) return cliScopeDeniedResponse()
      const result = await getPublisherArtifactReadback(db, user, resolved, {
        id,
        baseUrl: url.origin,
        ...(url.searchParams.has('offset') ? { offset } : {}),
      })
      if (result.kind === 'ok')
        return Response.json(
          PublisherArtifactReadResponseSchema.parse(result.data),
        )
      if (result.kind === 'invalid-offset')
        return errorResponse(
          'invalid-offset',
          'Static-site readback has no source offset.',
          400,
        )
      return cliArtifactErrorResponse(result, 'Source unavailable.')
    }
    const authority = cliReadAuthority(resolved)
    if (authority === 'denied') return cliScopeDeniedResponse()
    const agentRead =
      authority !== null
        ? await authorizeAgentArtifactRead(db, user, authority, id)
        : null
    if (agentRead?.kind === 'missing-viewer') {
      return new Response('Unauthorized', { status: 401 })
    }
    if (agentRead?.kind === 'denied') {
      return errorResponse('not-found', 'Artifact not found.', 404)
    }
    const result = await getArtifactReadback(db, user, {
      id,
      baseUrl: url.origin,
      offset,
      include,
      includeSharedVersions: true,
      ...(agentRead?.kind === 'authorized'
        ? { agentReadAuthorization: agentRead.authorization }
        : {}),
    })
    if (result.kind === 'ok') {
      return Response.json(ArtifactReadResponseSchema.parse(result.data))
    }
    return cliArtifactErrorResponse(
      result,
      'This artifact cannot be read as a single source file.',
    )
  })
}

export async function action({ context, params, request }: Route.ActionArgs) {
  if (request.method !== 'DELETE') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const user = requireUser(context)
  const authority = getCliAuthority(context)
  if (authority?.kind !== 'publisher' && !allowsHumanCliMutation(authority))
    return cliScopeDeniedResponse()
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const { id } = parsedParams.data
  return await withDb(async (db) => {
    const result = await deleteShareable(
      db,
      user,
      id,
      ...(authority?.kind === 'publisher'
        ? [{ publisherAuthority: authority }]
        : []),
    )
    if (result.kind !== 'ok') return cliDeleteArtifactErrorResponse(result)
    return Response.json(
      ArtifactDeleteResponseSchema.parse(deleteArtifactSuccessBody(id)),
    )
  })
}

function normalizeInclude(
  values: string[] | undefined,
): ArtifactReadbackInclude[] {
  return [
    ...new Set(
      (values ?? []).flatMap((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .map((item) => ArtifactIncludeSchema.parse(item)),
      ),
    ),
  ]
}

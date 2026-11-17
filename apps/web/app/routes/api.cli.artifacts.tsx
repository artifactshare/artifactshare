import { env } from 'cloudflare:workers'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import { cliReadAuthority } from '~/lib/cli-authority-policy'
import {
  ArtifactsListQuerySchema,
  ArtifactsListResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import { artifactsListForClient } from '~/lib/cli-artifact-kinds'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import {
  isArtifactsSearch,
  searchCliArtifacts,
  listAgentReadableArtifacts,
  listCliArtifacts,
} from '~/services/cli-artifacts.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const url = new URL(request.url)
  const queryParams = ArtifactsListQuerySchema.safeParse({
    ...Object.fromEntries(
      ['q', 'date_field', 'days', 'from', 'to'].map((key) => [
        key,
        url.searchParams.get(key) ?? undefined,
      ]),
    ),
    owner_user_ids: url.searchParams.has('owner_user_ids')
      ? url.searchParams.getAll('owner_user_ids')
      : undefined,
    project_id: url.searchParams.get('project_id') ?? undefined,
    query: url.searchParams.get('query')?.trim() || undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
  })
  if (
    !queryParams.success ||
    (url.searchParams.has('query') && isArtifactsSearch(queryParams.data))
  ) {
    return errorResponse(
      'validation_failed',
      'Invalid artifact list query. Use q for body search or query for titles, not both; check owner and period filters.',
      400,
    )
  }
  const { project_id: projectId, query, cursor } = queryParams.data
  const resolved = getCliAuthority(context)
  const authority = cliReadAuthority(resolved)
  if (authority === 'denied') return cliScopeDeniedResponse()
  const search = isArtifactsSearch(queryParams.data)
  // Bridge and bootstrap credentials keep the plain list they had; search is
  // refused to them because their range is not capped like an agent's.
  if (search && (resolved?.kind === 'bridge' || resolved?.kind === 'bootstrap'))
    return cliScopeDeniedResponse()

  return await withDb(async (db) => {
    if (search) {
      const result = await searchCliArtifacts(
        db,
        (workspace) => env.WORKSPACE_SEARCH_INDEX.getByName(`${workspace}:0`),
        user,
        {
          ...queryParams.data,
          baseUrl: url.origin,
          source: 'cli',
          authority: authority ?? undefined,
          includeVersionSummaries: true,
        },
      )
      if (result.kind === 'capacity-exceeded')
        return errorResponse(
          'search_capacity_exceeded',
          'Search capacity exceeded. Narrow the query or filters and search again.',
          503,
        )
      if (result.kind !== 'ok')
        return errorResponse(
          'validation_failed',
          'Invalid search filters or cursor. Restart the search without cursor.',
          400,
        )
      return Response.json(
        artifactsListForClient(
          ArtifactsListResponseSchema.parse(result.data),
          request,
        ),
      )
    }
    if (authority !== null) {
      const result = await listAgentReadableArtifacts(db, user, authority, {
        baseUrl: url.origin,
        projectId,
        query,
        cursor,
      })
      if (result.kind === 'invalid-cursor') {
        return errorResponse(
          'validation_failed',
          'The cursor is invalid or does not match the requested filters.',
          400,
        )
      }
      if (result.kind === 'missing-viewer') {
        return new Response('Unauthorized', { status: 401 })
      }
      if (result.kind !== 'ok') {
        return errorResponse('invalid-destination', 'Invalid project.', 400)
      }
      return Response.json(
        artifactsListForClient(
          ArtifactsListResponseSchema.parse(result.data),
          request,
        ),
      )
    }
    const result = await listCliArtifacts(db, user, {
      includeVersionSummaries: true,
      baseUrl: url.origin,
      projectId,
      query,
      cursor,
    })
    switch (result.kind) {
      case 'ok':
        return Response.json(
          artifactsListForClient(
            ArtifactsListResponseSchema.parse(result.data),
            request,
          ),
        )
      case 'invalid-project':
        return errorResponse(
          'invalid-destination',
          'The project ID does not exist or is not available in this workspace.',
          400,
        )
      case 'invalid-cursor':
        return errorResponse(
          'validation_failed',
          'The cursor is invalid or does not match the requested filters.',
          400,
        )
      default: {
        const _exhaustive: never = result
        return _exhaustive
      }
    }
  })
}

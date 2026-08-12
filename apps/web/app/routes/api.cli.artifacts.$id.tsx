import { cliArtifactErrorResponse, errorResponse } from '~/lib/api-errors'
import {
  cliDeleteArtifactErrorResponse,
  deleteArtifactSuccessBody,
} from '~/lib/project-actions-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { isAgentReadableArtifact } from '~/services/agent-scope.server'
import {
  getArtifactReadback,
  type ArtifactReadbackInclude,
} from '~/services/artifact-readback-service.server'
import { withDb } from '~/services/db.server'
import { deleteShareable } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.artifacts.$id'

export const middleware = [requireUserApiWithBearerMiddleware]

const INCLUDE_VALUES = new Set<ArtifactReadbackInclude>([
  'versions',
  'comments',
])

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const url = new URL(request.url)
  const offset = parseOffset(url.searchParams.get('offset'))
  if (offset === null) {
    return errorResponse(
      'invalid-offset',
      'Offset must be a non-negative integer.',
      400,
    )
  }
  const include = parseInclude(url.searchParams.getAll('include'))
  if (include === null) {
    return errorResponse(
      'invalid-include',
      'Include must be versions or comments.',
      400,
    )
  }

  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (
      authority?.kind === 'agent' &&
      !(await isAgentReadableArtifact(db, user, authority, params.id))
    ) {
      return errorResponse('not-found', 'Artifact not found.', 404)
    }
    const result = await getArtifactReadback(db, user, {
      id: params.id,
      baseUrl: url.origin,
      offset,
      include,
    })
    if (result.kind === 'ok') return Response.json(result.data)
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
  return await withDb(async (db) => {
    const result = await deleteShareable(db, user, params.id)
    if (result.kind !== 'ok') return cliDeleteArtifactErrorResponse(result)
    return Response.json(deleteArtifactSuccessBody(params.id))
  })
}

function parseOffset(value: string | null): number | undefined | null {
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) return null
  return Number(value)
}

function parseInclude(values: string[]): ArtifactReadbackInclude[] | null {
  const result: ArtifactReadbackInclude[] = []
  for (const value of values) {
    for (const item of value.split(',')) {
      const trimmed = item.trim()
      if (!trimmed) continue
      if (!INCLUDE_VALUES.has(trimmed as ArtifactReadbackInclude)) return null
      result.push(trimmed as ArtifactReadbackInclude)
    }
  }
  return [...new Set(result)]
}

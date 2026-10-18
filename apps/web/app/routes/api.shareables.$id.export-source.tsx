import { exportNoStoreMiddleware } from '~/middleware/export-no-store'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  exportSourceErrorResponse,
  getExportSource,
} from '~/services/export-source.server'
import type { Route } from './+types/api.shareables.$id.export-source'

export const middleware = [exportNoStoreMiddleware, requireUserApiMiddleware]

async function loadSource({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const path = new URL(request.url).searchParams.get('path')
  const result = await getExportSource(db, user, {
    id: params.id,
    path,
    versionId: new URL(request.url).searchParams.get('versionId'),
  })
  const response =
    result.kind === 'ok'
      ? Response.json(result.data)
      : exportSourceErrorResponse(result)
  response.headers.set('cache-control', 'no-store')
  return response
}

export async function loader(args: Route.LoaderArgs) {
  try {
    return await loadSource(args)
  } catch (error) {
    if (error instanceof Response) {
      error.headers.set('cache-control', 'no-store')
      return error
    }
    const response = exportSourceErrorResponse({ kind: 'source-unavailable' })
    response.headers.set('cache-control', 'no-store')
    return response
  }
}

import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  exportSourceErrorResponse,
  getExportSource,
} from '~/services/export-source.server'
import type { Route } from './+types/api.shareables.$id.export-source'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const path = new URL(request.url).searchParams.get('path')
  const result = await getExportSource(db, user, {
    id: params.id,
    path,
  })
  if (result.kind === 'ok') return Response.json(result.data)
  return exportSourceErrorResponse(result)
}

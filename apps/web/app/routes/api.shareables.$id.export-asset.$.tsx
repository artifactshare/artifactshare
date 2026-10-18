import { exportNoStoreMiddleware } from '~/middleware/export-no-store'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { errorResponse } from '~/lib/api-errors'
import { createDb } from '~/services/db.server'
import {
  exportSourceErrorResponse,
  getExportAsset,
  isPassiveExportAssetContent,
} from '~/services/export-source.server'
import type { Route } from './+types/api.shareables.$id.export-asset.$'

export const middleware = [exportNoStoreMiddleware, requireUserApiMiddleware]

async function loadAsset({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const path = `/${params['*'] ?? ''}`
  const result = await getExportAsset(createDb(), user, {
    id: params.id,
    path,
    versionId: new URL(request.url).searchParams.get('versionId'),
  })
  if (result.kind === 'ok') {
    if (!result.object.body) {
      return exportSourceErrorResponse({ kind: 'source-unavailable' })
    }
    if (!isPassiveExportAssetContent(result.path, result.contentType)) {
      return errorResponse(
        'unsafe-export-asset',
        'This export asset type is not served from the app origin.',
        400,
      )
    }
    return new Response(result.object.body, {
      headers: {
        'content-type': result.contentType,
        'content-length': String(result.object.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }
  return exportSourceErrorResponse(result)
}

export async function loader(args: Route.LoaderArgs) {
  const response = await loadAsset(args).catch((error: unknown) =>
    error instanceof Response
      ? error
      : exportSourceErrorResponse({ kind: 'source-unavailable' }),
  )
  response.headers.set('cache-control', 'no-store')
  return response
}

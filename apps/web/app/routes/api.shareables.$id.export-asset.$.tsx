import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { errorResponse } from '~/lib/api-errors'
import { splitAssetRef } from '~/lib/asset-ref'
import { createDb } from '~/services/db.server'
import {
  exportSourceErrorResponse,
  getExportAsset,
  isPassiveExportAssetContent,
} from '~/services/export-source.server'
import type { Route } from './+types/api.shareables.$id.export-asset.$'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const path = `/${params['*'] ?? ''}`
  const result = await getExportAsset(createDb(), user, {
    id: params.id,
    path,
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
    if (isCssContent(result.contentType)) {
      const css = rewriteRootRelativeCssAssetUrls(
        await result.object.text(),
        params.id,
        new URL(request.url).origin,
      )
      return new Response(css, {
        headers: {
          'content-type': result.contentType,
          'cache-control': 'private, max-age=300',
          'x-content-type-options': 'nosniff',
        },
      })
    }
    return new Response(result.object.body, {
      headers: {
        'content-type': result.contentType,
        'content-length': String(result.object.size),
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    })
  }
  return exportSourceErrorResponse(result)
}

function isCssContent(contentType: string): boolean {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/css'
}

export function rewriteRootRelativeCssAssetUrls(
  value: string,
  shareableId: string,
  origin: string,
): string {
  return value.replace(
    /url\((["']?)(\/(?!\/)[^"')]+)\1\)/g,
    (_match, _quote, ref: string) => {
      const { pathname, suffix } = splitAssetRef(ref)
      const encodedPath = pathname
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')
      return `url("${origin}/api/shareables/${encodeURIComponent(shareableId)}/export-asset${encodedPath}${suffix}")`
    },
  )
}

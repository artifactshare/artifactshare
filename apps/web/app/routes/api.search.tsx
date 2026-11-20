import {
  searchErrorResponse,
  searchNoStoreMiddleware,
} from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { parseSearchInput } from '~/services/search-input'
import { search } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import type { Route } from './+types/api.search'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function loader({ url, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const input = parseSearchInput(url.searchParams)
  const headers = { 'Cache-Control': 'private, no-store' }
  if ('error' in input) return Response.json(input, { status: 400, headers })
  const { value: result, serverTiming } = await withSearchTiming(
    'api-search',
    (db, indexes) => search(db, indexes, user.id, input),
    searchErrorResponse,
  )
  if (result instanceof Response) {
    result.headers.set('Server-Timing', serverTiming)
    return result
  }
  return Response.json(result, {
    status: 'error' in result ? 400 : 200,
    headers: { ...headers, 'Server-Timing': serverTiming },
  })
}

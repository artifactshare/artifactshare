import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import { SearchDailyLimitError } from '~/services/search-quota.server'
import {
  searchErrorResponse,
  searchNoStoreMiddleware,
} from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { parseSearchInput } from '~/services/search-input'
import { searchSuggestions } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import type { Route } from './+types/api.search-suggestions'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function loader({ url, context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const input = parseSearchInput(url.searchParams)
  const headers = { 'Cache-Control': 'private, no-store' }
  if ('error' in input) return Response.json(input, { status: 400, headers })
  if (
    input.query.trim() &&
    isDevScreenStateRequest(request, 'search/palette-daily-limit')
  )
    return searchErrorResponse(
      new SearchDailyLimitError('2026-11-20T12:00:00.000Z'),
    )
  const { value: result, serverTiming } = await withSearchTiming(
    'suggestions',
    (db, indexes) => searchSuggestions(db, indexes, user, input),
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

import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { env } from 'cloudflare:workers'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { parseSearchInput } from '~/services/search-input'
import { searchSuggestions } from '~/services/search.server'
import type { Route } from './+types/api.search-suggestions'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function loader({ url, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const input = parseSearchInput(url.searchParams)
  const headers = { 'Cache-Control': 'private, no-store' }
  if ('error' in input) return Response.json(input, { status: 400, headers })
  const result = await withDb((db) =>
    searchSuggestions(
      db,
      (workspace) => env.WORKSPACE_SEARCH_INDEX.getByName(`${workspace}:0`),
      user,
      input,
    ),
  )
  return Response.json(result, {
    status: 'error' in result ? 400 : 200,
    headers,
  })
}

import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { searchGroup } from '~/services/search.server'
import { withSearchTiming } from '~/services/search-timing.server'
import type { Route } from './+types/api.search-groups'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function loader({ url, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const fields = ['receipt', 'cursor'].filter(
    (key) =>
      url.searchParams.has(key) &&
      (!url.searchParams.get(key) ||
        url.searchParams.get(key)!.length > 1024 ||
        url.searchParams.getAll(key).length > 1),
  )
  if (!url.searchParams.has('receipt')) fields.push('receipt')
  if (fields.length)
    return Response.json(
      { error: { code: 'validation_error', fields } },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    )
  const { value: result, serverTiming } = await withSearchTiming(
    'search-groups',
    (db, indexes) =>
      searchGroup(
        db,
        indexes,
        user.id,
        url.searchParams.get('receipt') ?? '',
        url.searchParams.get('cursor') ?? undefined,
      ),
  )
  return Response.json(result, {
    status: 'error' in result ? 400 : 200,
    headers: {
      'Cache-Control': 'private, no-store',
      'Server-Timing': serverTiming,
    },
  })
}

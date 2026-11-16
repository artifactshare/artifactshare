import { env } from 'cloudflare:workers'
import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { searchGroup } from '~/services/search.server'
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
  const result = await withDb((db) =>
    searchGroup(
      db,
      (workspace) => env.WORKSPACE_SEARCH_INDEX.getByName(`${workspace}:0`),
      user.id,
      url.searchParams.get('receipt') ?? '',
      url.searchParams.get('cursor') ?? undefined,
    ),
  )
  return Response.json(result, {
    status: 'error' in result ? 400 : 200,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

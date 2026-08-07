import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { searchPalette } from '~/services/search-palette.server'
import type { Route } from './+types/api.search-palette'
export const middleware = [requireUserApiMiddleware]
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  return Response.json(
    await searchPalette(
      createDb(),
      user,
      new URL(request.url).searchParams.get('q'),
    ),
  )
}

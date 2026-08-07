import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import type { Route } from './+types/api.cli.whoami'

export const middleware = [requireUserApiWithBearerMiddleware]

export function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  return Response.json({
    user: {
      id: user.id,
      email: user.email,
    },
    workspace: {
      id: user.workspaceId,
      hosted_domain: user.hd,
    },
    auth: {
      kind: 'bearer_or_session',
    },
  })
}

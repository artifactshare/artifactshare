import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { loadAgentApprovalContext } from '~/services/cli-device-authority.server'
import type { Route } from './+types/api.cli.device-approval'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const userCode = new URL(request.url).searchParams
    .get('user_code')
    ?.replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
  if (!userCode || userCode.length !== 8) {
    return Response.json({ agentApproval: null })
  }
  return Response.json({
    agentApproval: await loadAgentApprovalContext(
      userCode,
      user.id,
      user.workspaceId,
      user.email,
    ),
  })
}

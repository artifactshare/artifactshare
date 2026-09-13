import {
  DeviceApprovalQuerySchema,
  DeviceApprovalResponseSchema,
} from '@artifactshare/contract'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { loadAgentApprovalContext } from '~/services/cli-device-authority.server'
import type { Route } from './+types/api.cli.device-approval'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const rawUserCode = new URL(request.url).searchParams.get('user_code')
  const userCode = rawUserCode?.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const query = DeviceApprovalQuerySchema.safeParse({ user_code: userCode })
  if (!query.success || query.data.user_code.length !== 8) {
    return Response.json(
      DeviceApprovalResponseSchema.parse({ agentApproval: null }),
    )
  }
  return Response.json(
    DeviceApprovalResponseSchema.parse({
      agentApproval: await loadAgentApprovalContext(
        query.data.user_code,
        user.id,
        user.workspaceId,
        user.email,
      ),
    }),
  )
}

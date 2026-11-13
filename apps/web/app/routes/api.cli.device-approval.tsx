import {
  DeviceApprovalQuerySchema,
  DeviceApprovalResponseSchema,
} from '@artifactshare/contract'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import {
  isPendingUnrestrictedDeviceApproval,
  loadAgentApprovalContext,
  loadPublisherApprovalContext,
} from '~/services/cli-device-authority.server'
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
  const [publisherApproval, agentApproval] = await Promise.all([
    loadPublisherApprovalContext(
      query.data.user_code,
      user.id,
      user.workspaceId,
    ),
    loadAgentApprovalContext(
      query.data.user_code,
      user.id,
      user.workspaceId,
      user.email,
    ),
  ])
  if (
    !publisherApproval &&
    !agentApproval &&
    !(await isPendingUnrestrictedDeviceApproval(query.data.user_code, user.id))
  ) {
    return new Response(null, {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  return Response.json(
    DeviceApprovalResponseSchema.parse({
      ...(publisherApproval ? { publisherApproval } : {}),
      agentApproval,
    }),
  )
}

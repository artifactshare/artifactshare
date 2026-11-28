import { handleMcpRequest } from '~/services/mcp/transport.server'
import { ctxContext } from '~/middleware/context'
import type { Route } from './+types/mcp'

export function loader({ context, request }: Route.LoaderArgs) {
  return handleMcpRequest(request, context.get(ctxContext))
}

export function action({ context, request }: Route.ActionArgs) {
  return handleMcpRequest(request, context.get(ctxContext))
}

import { handleMcpRequest } from '~/services/mcp/transport.server'
import { ctxContext } from '~/middleware/context'
import type { Route } from './+types/mcp'

// React Router splits methods between loader/action. Keep every method on the
// same MCP entrypoint so unsupported methods can be rejected before auth.
export function loader({ context, request }: Route.LoaderArgs) {
  return handleMcpRequest(request, context.get(ctxContext))
}

export function action({ context, request }: Route.ActionArgs) {
  return handleMcpRequest(request, context.get(ctxContext))
}

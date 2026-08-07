import { isProduction, requestHostname, SANDBOX_HOST } from '../app/lib/hosts'
import {
  handleArtifactSandboxRequest,
  sandboxNotFoundResponse,
} from './bundle-sandbox'

export default {
  fetch(
    request: Request,
    env: Env,
    _ctx?: ExecutionContext,
  ): Promise<Response> | Response {
    const hostname = requestHostname(request, env)
    if (hostname === SANDBOX_HOST || hostname === 'sandbox.localhost') {
      return sandboxNotFoundResponse(hostname)
    }
    if (
      hostname.endsWith(`.${SANDBOX_HOST}`) ||
      (!isProduction(env) && hostname.endsWith('.sandbox.localhost'))
    ) {
      return handleArtifactSandboxRequest(request)
    }
    return sandboxNotFoundResponse(hostname)
  },
}

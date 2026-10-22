import {
  requestHostname,
  sandboxVersionIdentityFromHostname,
} from '../app/lib/hosts'
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
    if (sandboxVersionIdentityFromHostname(hostname, env)) {
      return handleArtifactSandboxRequest(request)
    }
    return sandboxNotFoundResponse(hostname)
  },
}

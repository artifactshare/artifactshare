import { AGENT_SURFACE_HEADERS_JSON, agentSurface } from '~/lib/agent-surface'

const body = JSON.stringify(agentSurface)

export function loader() {
  return new Response(body, { headers: AGENT_SURFACE_HEADERS_JSON })
}

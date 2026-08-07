import { AGENT_SURFACE_HEADERS_MD, capabilitiesMd } from '~/lib/agent-surface'

export function loader() {
  return new Response(capabilitiesMd, { headers: AGENT_SURFACE_HEADERS_MD })
}

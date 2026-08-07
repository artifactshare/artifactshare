import { AGENT_SURFACE_HEADERS_JSON, openapiStub } from '~/lib/agent-surface'

const body = JSON.stringify(openapiStub)

export function loader() {
  return new Response(body, { headers: AGENT_SURFACE_HEADERS_JSON })
}

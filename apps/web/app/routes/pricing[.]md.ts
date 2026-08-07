import { AGENT_SURFACE_HEADERS_MD, pricingMarkdown } from '~/lib/agent-surface'

export function loader() {
  return new Response(pricingMarkdown, { headers: AGENT_SURFACE_HEADERS_MD })
}

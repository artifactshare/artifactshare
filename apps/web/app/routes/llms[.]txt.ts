import { AGENT_SURFACE_HEADERS_TXT, llmsTxt } from '~/lib/agent-surface'

export function loader() {
  return new Response(llmsTxt, { headers: AGENT_SURFACE_HEADERS_TXT })
}

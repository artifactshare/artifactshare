import { env } from 'cloudflare:workers'
import { PUBLIC_CACHEABLE_CORS_HEADERS } from '~/lib/agent-surface'
import { protectedResourceMetadata } from '~/lib/mcp-metadata'
import type { Route } from './+types/[.]well-known.oauth-protected-resource.$'

// RFC 9728 protected-resource metadata. A splat so both the bare path and the
// resource-suffixed form (`/.well-known/oauth-protected-resource/mcp`) resolve,
// since clients construct the URL either way for a resource that has a path.
export function loader(_: Route.LoaderArgs) {
  return Response.json(protectedResourceMetadata(env.BETTER_AUTH_URL), {
    headers: PUBLIC_CACHEABLE_CORS_HEADERS,
  })
}

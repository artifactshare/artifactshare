import { oauthAuthServerMetadataHandler } from '~/services/auth.server'
import type { Route } from './+types/[.]well-known.oauth-authorization-server.$'

// RFC 8414 authorization server metadata. A splat so the path-aware form
export function loader({ request }: Route.LoaderArgs) {
  return oauthAuthServerMetadataHandler(request)
}

import { oauthAuthServerMetadataHandler } from '~/services/auth.server'
import type { Route } from './+types/[.]well-known.oauth-authorization-server.$'

// RFC 8414 authorization server metadata. A splat so the path-aware form
// (`/.well-known/oauth-authorization-server/api/auth`, for the issuer that
// lives under better-auth's base path) resolves alongside the bare path.
// better-auth also serves it natively at `/api/auth/.well-known/...`.
export function loader({ request }: Route.LoaderArgs) {
  return oauthAuthServerMetadataHandler(request)
}

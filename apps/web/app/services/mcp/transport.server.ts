import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { env } from 'cloudflare:workers'
import { isProduction } from '~/lib/hosts'
import { mcpResourceUrl, oauthIssuer } from '~/lib/mcp-metadata'
import { getLocalJwksWithHangDetection } from '~/services/auth.server'
import { createDb } from '~/services/db.server'
import type { McpIdentity } from './identity.server'
import { createMcpServer } from './server.server'

async function runMcp(
  request: Request,
  identity: McpIdentity,
  executionContext: ExecutionContext,
): Promise<Response> {
  // One D1 connection per request, shared across the tool calls in it. The
  // tools resolve the workspace-scoped user from it; closing it after the body
  // is buffered keeps the per-request resources from outliving the response.
  const db = createDb()
  try {
    const server = createMcpServer({
      identity,
      db,
      executionContext,
      baseUrl: env.BETTER_AUTH_URL,
      rateLimiters: {
        perUser: env.MCP_RATELIMIT_USER,
        perWorkspace: env.MCP_RATELIMIT_WORKSPACE,
      },
    })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session persistence on Workers
      enableJsonResponse: true,
    })
    await server.connect(transport)
    // JSON-response mode buffers the full body, so awaiting here means every
    // tool handler has run (and finished its D1 reads) before we close `db`.
    return await transport.handleRequest(request)
  } finally {
    // Swallow a close error so it can't replace an already-computed (successful)
    // response with a thrown 500.
    await db.destroy().catch((err) => {
      console.error('mcp_db_destroy_failed', err)
    })
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

function scopesFromJwt(jwt: Record<string, unknown>): string[] {
  // OAuth/JWT access tokens carry scopes as a space-delimited `scope` claim.
  const scope = jwt['scope']
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : []
}

function clientIdFromJwt(jwt: Record<string, unknown>): string | null {
  // oauth-provider sets `azp` = client.clientId on the access token; fall back
  // to `client_id` for resilience against other issuers.
  const azp = jwt['azp']
  if (typeof azp === 'string' && azp) return azp
  const clientId = jwt['client_id']
  return typeof clientId === 'string' && clientId ? clientId : null
}

// The signing keys live in the D1 `jwks` table. A Worker can't `fetch` its own
// public hostname (the loopback subrequest fails), so reading the JWKS over HTTP
// from `/api/auth/jwks` breaks token verification. Read the keys in-process
// instead. better-auth caches the `jwksFetch` result for 300 seconds and
// refetches on a kid miss, so this function should return the current D1-backed
// JWKS whenever the library asks for it.
//
// `getJwks` is cast in: erasing the plugin api types (to keep them portable)
// drops it from the inferred `auth.api`. The shape comes from the library's own
// `jwksFetch` signature so it can't silently drift.
type JwksFetch = Extract<
  Parameters<typeof verifyJwsAccessToken>[1]['jwksFetch'],
  () => unknown
>

function localJwks(): ReturnType<JwksFetch> {
  return getLocalJwksWithHangDetection() as ReturnType<JwksFetch>
}

function unauthorized(resource: string): Response {
  const url = new URL(resource)
  const path = url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${path}"`,
    },
  })
}

function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST' },
  })
}

/**
 * Protect /mcp with the OAuth 2.1 access token (JWT). The token is verified
 * locally against the JWKS read from D1 (no remote fetch, no introspection D1
 * read on the hot path), and unauthenticated requests get a `WWW-Authenticate`
 * header pointing at the protected-resource metadata.
 *
 * A hardcoded dev token bypasses OAuth for protocol smoke tests without a
 * browser login. It authenticates as `dev-user`; the workspace-scoped tools
 * still resolve their identity from D1, so they return data only when a matching
 * user row exists — otherwise OAuth is the real path. Gated to non-production.
 */
export async function handleMcpRequest(
  request: Request,
  executionContext: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()

  const baseUrl = env.BETTER_AUTH_URL
  const resource = mcpResourceUrl(baseUrl)

  if (!isProduction(env) && env.MCP_DEV_TOKEN) {
    const presented = bearerToken(request)
    if (presented && presented === env.MCP_DEV_TOKEN) {
      return runMcp(
        request,
        {
          userId: 'dev-user',
          clientId: null,
          scopes: ['openid'],
          mode: 'dev',
        },
        executionContext,
      )
    }
  }

  const token = bearerToken(request)
  if (!token) return unauthorized(resource)

  let jwt: Record<string, unknown>
  try {
    jwt = await verifyJwsAccessToken(token, {
      jwksFetch: localJwks,
      // MCP clients send the RFC 8707 `resource` (this endpoint's URL), so the
      // token's `aud` is the MCP resource and `iss` is the auth base URL.
      verifyOptions: { audience: resource, issuer: oauthIssuer(baseUrl) },
    })
  } catch {
    return unauthorized(resource)
  }

  const clientId = clientIdFromJwt(jwt)
  if (!clientId) return unauthorized(resource)

  return runMcp(
    request,
    {
      userId: typeof jwt.sub === 'string' ? jwt.sub : '',
      clientId,
      scopes: scopesFromJwt(jwt),
      mode: 'oauth',
    },
    executionContext,
  )
}

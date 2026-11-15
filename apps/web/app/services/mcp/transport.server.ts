import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyOAuthJwt, verifyOAuthBinding } from './oauth-verification.server'
import { env } from 'cloudflare:workers'
import { isProduction } from '~/lib/hosts'
import { mcpResourceUrl } from '~/lib/mcp-metadata'
import { getLocalJwksWithHangDetection } from '~/services/auth.server'
import { createDb } from '~/services/db.server'
import type { McpIdentity } from './identity.server'
import { createMcpServer } from './server.server'

const REQUIRED_PRODUCT_SCOPE = 'artifactshare:access'

async function runMcp(
  request: Request,
  identity: McpIdentity,
  executionContext: ExecutionContext,
  version?: { claim: unknown; resource: string; sessionId: unknown },
): Promise<Response> {
  // One D1 connection per request, shared across the tool calls in it. The
  // tools resolve the workspace-scoped user from it; closing it after the body
  // is buffered keeps the per-request resources from outliving the response.
  const db = createDb()
  try {
    if (version) {
      try {
        if (
          !(await verifyOAuthBinding(
            db,
            identity.userId,
            version.claim,
            version.sessionId,
          ))
        )
          return unauthorized(version.resource)
      } catch {
        return new Response('Service unavailable', { status: 503 })
      }
    }
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

function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource)
  const path = url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname
  return `${url.origin}/.well-known/oauth-protected-resource${path}`
}

function unauthorized(resource: string): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`,
    },
  })
}

function insufficientScope(resource: string): Response {
  return new Response('Forbidden', {
    status: 403,
    headers: {
      'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${REQUIRED_PRODUCT_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(resource)}"`,
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
 * locally against the JWKS read from D1, then checked against the current
 * user token version, and unauthenticated requests get a `WWW-Authenticate`
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
          scopes: ['openid', REQUIRED_PRODUCT_SCOPE],
          mode: 'dev',
        },
        executionContext,
      )
    }
  }

  const token = bearerToken(request)
  if (!token) return unauthorized(resource)

  const verified = await verifyOAuthJwt(
    token,
    baseUrl,
    getLocalJwksWithHangDetection,
  )
  if (verified.kind === 'scope') return insufficientScope(resource)
  if (verified.kind !== 'verified') return unauthorized(resource)
  return runMcp(request, verified.identity, executionContext, {
    claim: verified.claim,
    resource,
    sessionId: verified.sessionId,
  })
}

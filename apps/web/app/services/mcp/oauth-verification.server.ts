import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { mcpResourceUrl, oauthIssuer } from '~/lib/mcp-metadata'
import type { Db } from '../db.server'
import type { McpIdentity } from './identity.server'

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

export async function verifyOAuthJwt(
  token: string,
  baseUrl: string,
  getKeys: () => Promise<unknown>,
): Promise<
  | {
      kind: 'verified'
      identity: McpIdentity
      claim: unknown
      sessionId: unknown
    }
  | { kind: 'invalid' | 'scope' | 'unavailable' }
> {
  let keyFailure = false
  try {
    const jwt = await verifyJwsAccessToken(token, {
      jwksFetch: async () => {
        try {
          return (await getKeys()) as { keys: JsonWebKey[] }
        } catch {
          keyFailure = true
          throw new Error('keys unavailable')
        }
      },
      verifyOptions: {
        audience: mcpResourceUrl(baseUrl),
        issuer: oauthIssuer(baseUrl),
      },
    })
    const clientId = clientIdFromJwt(jwt)
    if (!clientId) return { kind: 'invalid' }
    const scopes = scopesFromJwt(jwt)
    if (!scopes.includes('artifactshare:access')) return { kind: 'scope' }
    return {
      kind: 'verified',
      identity: {
        userId: typeof jwt.sub === 'string' ? jwt.sub : '',
        clientId,
        scopes,
        mode: 'oauth',
      },
      claim: jwt.oauth_token_version,
      sessionId: jwt.sid,
    }
  } catch {
    return { kind: keyFailure ? 'unavailable' : 'invalid' }
  }
}

export async function verifyOAuthBinding(
  db: Db,
  userId: string,
  version: unknown,
  sessionId: unknown,
) {
  const claim = version === undefined ? 0 : version
  if (
    typeof claim !== 'number' ||
    !Number.isSafeInteger(claim) ||
    claim < 0 ||
    !userId.trim()
  )
    return false
  const user = await db
    .selectFrom('users')
    .select('oauth_token_version')
    .where('id', '=', userId)
    .executeTakeFirst()
  if (!user || user.oauth_token_version !== claim) return false
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return false
    const session = await db
      .selectFrom('sessions')
      .select('user_id')
      .where('id', '=', sessionId)
      .executeTakeFirst()
    if (!session || session.user_id !== userId) return false
  }
  return true
}

/** Same default key algorithm and 30-day expiry grace as pinned Better Auth;
 * SELECT public columns only, never invoke getJwks (which can create keys). */
export async function readOnlyOAuthKeys(db: Db) {
  const keys = await db
    .selectFrom('jwks')
    .select(['id', 'publicKey', 'alg', 'crv', 'expiresAt'])
    .execute()
  const live = keys.filter(
    (key) =>
      !key.expiresAt || Date.parse(key.expiresAt) + 30 * 86400000 > Date.now(),
  )
  if (!live.length) throw new Error('keys unavailable')
  return {
    keys: live.map((key) => ({
      alg: key.alg ?? 'EdDSA',
      crv: key.crv ?? undefined,
      ...JSON.parse(key.publicKey),
      kid: key.id,
    })),
  }
}

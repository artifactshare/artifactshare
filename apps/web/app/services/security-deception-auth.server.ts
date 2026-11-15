import { env } from 'cloudflare:workers'
import { AUTH_SESSION_TOKEN_COOKIE_NAMES } from '~/lib/auth-cookies'
import { isProduction } from '~/lib/hosts'
import { readBearerSessionToken } from './auth.server'
import { findApiTokenIdentity, isApiToken } from './api-tokens.server'
import { resolveCliAuthorityIdentifiers } from './cli-authority.server'
import type { Db } from './db.server'
import {
  readOnlyOAuthKeys,
  verifyOAuthBinding,
  verifyOAuthJwt,
} from './mcp/oauth-verification.server'

export interface DeceptionPrincipal {
  actor_kind: 'human' | 'bot'
  actor_id: string
  workspace_id: string
  auth_route: 'cookie' | 'api_token' | 'cli_session' | 'oauth'
  client_kind:
    | 'api_token'
    | 'oauth_client'
    | 'agent_profile'
    | 'publisher_client'
    | null
  client_id: string | null
  authority_kind:
    | 'unrestricted'
    | 'bootstrap'
    | 'agent'
    | 'publisher'
    | 'bridge'
    | null
  agent_profile_id: string | null
  publisher_client_id: string | null
}
export type DeceptionIdentity =
  | { kind: 'trusted'; principal: DeceptionPrincipal }
  | { kind: 'unauthenticated' | 'workspace-denied' | 'unavailable' }

async function cookieToken(request: Request): Promise<string | null> {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) =>
      AUTH_SESSION_TOKEN_COOKIE_NAMES.some((name) =>
        part.startsWith(`${name}=`),
      ),
    )
  if (cookies.length !== 1) return null
  const cookie = cookies[0]!
  if (
    isProduction(env) &&
    !cookie.startsWith(`${AUTH_SESSION_TOKEN_COOKIE_NAMES[0]}=`)
  )
    return null
  let value: string
  try {
    value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
  } catch {
    return null
  }
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const token = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return null
  if (!env.BETTER_AUTH_SECRET) throw new Error('auth unavailable')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return (await crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(token),
  ))
    ? token
    : null
}

/** This boundary never calls a session endpoint or product resolver. */
export async function resolveDeceptionIdentity(
  db: Db,
  request: Request,
): Promise<DeceptionIdentity> {
  try {
    let userId: string | undefined
    let authRoute: DeceptionPrincipal['auth_route'] = 'cookie'
    let clientKind: DeceptionPrincipal['client_kind'] = null
    let clientId: string | null = null
    let authority: Awaited<ReturnType<typeof resolveCliAuthorityIdentifiers>> =
      null
    if (request.headers.has('authorization')) {
      const header = request.headers.get('authorization')!
      if (!/^Bearer /i.test(header)) return { kind: 'unauthenticated' }
      let raw = header.slice(7).trim()
      try {
        raw = decodeURIComponent(raw)
      } catch {
        return { kind: 'unauthenticated' }
      }
      if (!raw) return { kind: 'unauthenticated' }
      // JWTs must never be truncated into a session credential.
      if (raw.split('.').length >= 3) {
        const result = await verifyOAuthJwt(raw, env.BETTER_AUTH_URL, () =>
          readOnlyOAuthKeys(db),
        )
        if (result.kind === 'unavailable') return { kind: 'unavailable' }
        if (result.kind !== 'verified') return { kind: 'unauthenticated' }
        if (
          !(await verifyOAuthBinding(
            db,
            result.identity.userId,
            result.claim,
            result.sessionId,
          ))
        )
          return { kind: 'unauthenticated' }
        userId = result.identity.userId
        authRoute = 'oauth'
        clientKind = 'oauth_client'
        clientId = result.identity.clientId
      } else if (isApiToken(raw)) {
        const token = await findApiTokenIdentity(db, raw)
        if (!token || token.kind === 'bot') return { kind: 'unauthenticated' }
        userId = token.userId
        authRoute = 'api_token'
        clientKind = 'api_token'
        clientId = token.tokenId
      } else {
        const token = readBearerSessionToken(request)
        if (!token) return { kind: 'unauthenticated' }
        const session = await db
          .selectFrom('sessions')
          .select('user_id')
          .where('token', '=', token)
          .where('expires_at', '>', new Date().toISOString())
          .executeTakeFirst()
        if (!session) return { kind: 'unauthenticated' }
        authority = await resolveCliAuthorityIdentifiers(token)
        if (!authority || authority === 'denied')
          return { kind: 'unauthenticated' }
        userId = session.user_id
        authRoute = 'cli_session'
        clientKind = authority.publisherClientId
          ? 'publisher_client'
          : authority.agentProfileId
            ? 'agent_profile'
            : null
        clientId = authority.publisherClientId ?? authority.agentProfileId
      }
    } else {
      const token = await cookieToken(request)
      if (!token) return { kind: 'unauthenticated' }
      const session = await db
        .selectFrom('sessions')
        .select('user_id')
        .where('token', '=', token)
        .where('expires_at', '>', new Date().toISOString())
        .executeTakeFirst()
      userId = session?.user_id
    }
    if (!userId) return { kind: 'unauthenticated' }
    const user = await db
      .selectFrom('users')
      .select(['id', 'kind', 'workspace_id'])
      .where('id', '=', userId)
      .executeTakeFirst()
    if (!user || (user.kind === 'bot' && authRoute !== 'cli_session'))
      return { kind: 'unauthenticated' }
    const membership = await db
      .selectFrom('workspace_members')
      .innerJoin(
        'workspaces',
        'workspaces.id',
        'workspace_members.workspace_id',
      )
      .select('workspaces.id')
      .where('workspace_members.user_id', '=', user.id)
      .where('workspace_members.workspace_id', '=', user.workspace_id)
      .where('workspace_members.status', '=', 'active')
      .executeTakeFirst()
    if (
      !membership ||
      (authority &&
        authority.workspaceId &&
        authority.workspaceId !== membership.id)
    )
      return { kind: 'workspace-denied' }
    return {
      kind: 'trusted',
      principal: {
        actor_kind: user.kind,
        actor_id: user.id,
        workspace_id: membership.id,
        auth_route: authRoute,
        client_kind: clientKind,
        client_id: clientId,
        authority_kind: authority ? authority.kind : null,
        agent_profile_id: authority ? authority.agentProfileId : null,
        publisher_client_id: authority ? authority.publisherClientId : null,
      },
    }
  } catch {
    return { kind: 'unavailable' }
  }
}

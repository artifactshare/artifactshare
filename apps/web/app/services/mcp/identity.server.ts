import type { Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'

/** Resolved caller identity for one MCP request. */
export interface McpIdentity {
  /** better-auth user id (the access token's `sub`). */
  userId: string
  /** OAuth client that holds the token (the `azp` claim); null for the dev bypass. */
  clientId: string | null
  /** Scopes granted to the token. */
  scopes: string[]
  /** How the caller authenticated. `dev` is the local-only bypass. */
  mode: 'oauth' | 'dev'
}

/**
 * The slice of Cloudflare's native Rate Limiting binding the tools use. Kept
 * structural so the binding (`env.MCP_RATELIMIT_*`) satisfies it directly and a
 * fake can stand in for tests.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** Everything one stateless MCP request needs to serve its tools. */
export interface McpRequestContext {
  identity: McpIdentity
  db: Kysely<DB>
  executionContext: ExecutionContext
  /** App origin (BETTER_AUTH_URL); the base for `/a/:id` share links. */
  baseUrl: string
  // Per-caller and per-workspace rate limiters. null disables a limit (tests, or
  // a not-yet-configured binding) — the guard treats a missing limiter as allow.
  rateLimiters: {
    perUser: RateLimiter | null
    perWorkspace: RateLimiter | null
  }
}

/**
 * The full user the tools need, reconstructed from the token's `userId`.
 *
 * The route layer gets this from the session cookie; without a cookie the MCP
 * handler reads it from D1. `loadWorkspaceContextByUserId` (auth.server) only
 * returns workspaceId + hd, so this query additionally pulls email / name /
 * locale and the workspace plan + storage for `whoami`.
 */
// The identity fields are exactly `SessionUser` (minus the avatar `image`, which
// the tools never need), so they share one definition; the rest is the workspace
// summary `whoami` reports.
export type McpUser = Omit<SessionUser, 'image'> & {
  plan: string
  workspaceName: string
  storageUsedBytes: number
  storageQuotaBytes: number
}

export async function loadMcpUser(
  db: Kysely<DB>,
  userId: string,
): Promise<McpUser | null> {
  const row = await db
    .selectFrom('users')
    .innerJoin('workspaces', 'workspaces.id', 'users.workspace_id')
    .leftJoin(
      'workspace_domain_claims',
      'workspace_domain_claims.workspace_id',
      'workspaces.id',
    )
    .select([
      'users.id as id',
      'users.email as email',
      'users.email_verified as email_verified',
      'users.name as name',
      'users.workspace_id as workspace_id',
      'users.locale as locale',
      'users.kind as kind',
      'workspaces.hd as hd',
      'workspace_domain_claims.domain as claimed_domain',
      'workspaces.ms_tenant_id as ms_tenant_id',
      'workspaces.name as workspace_name',
      'workspaces.plan as plan',
      'workspaces.storage_used_bytes as storage_used_bytes',
      'workspaces.storage_quota_bytes as storage_quota_bytes',
      'workspaces.self_upload_enabled as self_upload_enabled',
    ])
    .where('users.id', '=', userId)
    .executeTakeFirst()
  if (!row) return null
  // MCP OAuth is cookie-session based; a bot identity here is impossible via
  // the product flows and is rejected outright as defense in depth.
  if (row.kind === 'bot') return null
  return {
    kind: row.kind,
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified === 1,
    name: row.name,
    workspaceId: row.workspace_id,
    hd: row.hd ?? row.claimed_domain ?? null,
    msTenantId: row.ms_tenant_id ?? null,
    locale: row.locale ?? null,
    plan: row.plan,
    workspaceName: row.workspace_name,
    storageUsedBytes: row.storage_used_bytes,
    storageQuotaBytes: row.storage_quota_bytes,
    selfUploadEnabled: row.self_upload_enabled === 1,
  }
}

// The comments service is written against the cookie-session `SessionUser`; the
// MCP identity is the same minus the avatar `image` the tools never load. Fill
// it with null so comment access checks (which key off id / workspace / email)
// run unchanged.
export function mcpUserAsSessionUser(user: McpUser): SessionUser {
  return { ...user, image: null }
}

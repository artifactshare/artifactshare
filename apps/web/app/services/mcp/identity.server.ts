import { type Kysely, sql } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'

export interface McpIdentity {
  userId: string
  clientId: string | null
  scopes: string[]
  mode: 'oauth' | 'dev'
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface McpRequestContext {
  identity: McpIdentity
  db: Kysely<DB>
  executionContext: ExecutionContext
  baseUrl: string
  rateLimiters: {
    perUser: RateLimiter | null
    perWorkspace: RateLimiter | null
  }
}

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
    .select([
      'users.id as id',
      'users.email as email',
      'users.email_verified as email_verified',
      'users.name as name',
      'users.workspace_id as workspace_id',
      'users.locale as locale',
      'users.kind as kind',
      'workspaces.hd as hd',
      sql<string | null>`(
        SELECT claims.domain
        FROM workspace_domain_claims AS claims
        WHERE (
          claims.source = 'google_hd'
          AND claims.workspace_id = workspaces.id
        ) OR (
          claims.source = 'microsoft_verified_domain'
          AND claims.domain = lower(substr(users.email, instr(users.email, '@') + 1))
          AND (
            claims.workspace_id = workspaces.id
            OR claims.provider_tenant_id = workspaces.ms_tenant_id
          )
        )
        ORDER BY CASE WHEN claims.source = 'google_hd' THEN 0 ELSE 1 END,
                 claims.domain
        LIMIT 1
      )`.as('claimed_domain'),
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

export function mcpUserAsSessionUser(user: McpUser): SessionUser {
  return { ...user, image: null }
}

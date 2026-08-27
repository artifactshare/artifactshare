import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import {
  isPublicEmailDomain,
  normalizeEmailDomain,
} from '~/lib/workspace-domains'
import type { DB } from '~/types/db'
import { ensureWorkspaceAdmin } from './team-management.server'

export type WorkspaceDomainClaimSource =
  | 'google_hd'
  | 'microsoft_verified_domain'

export interface WorkspaceDomainClaimInput {
  domain: string
  workspaceId: string
  source: WorkspaceDomainClaimSource
  providerTenantId?: string | null
  now: string
}

export async function ensureWorkspaceDomainClaim(
  db: Kysely<DB>,
  input: WorkspaceDomainClaimInput,
): Promise<string> {
  const domain = normalizeEmailDomain(input.domain)
  if (!domain || isPublicEmailDomain(domain)) return input.workspaceId

  const inserted = await db
    .insertInto('workspace_domain_claims')
    .values({
      domain,
      workspace_id: input.workspaceId,
      source: input.source,
      provider_tenant_id: input.providerTenantId ?? null,
      created_at: input.now,
      updated_at: input.now,
    })
    .onConflict((oc) => oc.column('domain').doNothing())
    .returning('workspace_id')
    .executeTakeFirst()
  if (inserted) return inserted.workspace_id

  const existing = await db
    .selectFrom('workspace_domain_claims')
    .select('workspace_id')
    .where('domain', '=', domain)
    .executeTakeFirst()
  return existing?.workspace_id ?? input.workspaceId
}

export async function findWorkspaceIdByDomainClaim(
  db: Kysely<DB>,
  domain: string | null,
): Promise<string | null> {
  const normalized = normalizeEmailDomain(domain)
  if (!normalized || isPublicEmailDomain(normalized)) return null

  const claim = await db
    .selectFrom('workspace_domain_claims')
    .select(['workspace_id', 'source', 'provider_tenant_id'])
    .where('domain', '=', normalized)
    .executeTakeFirst()
  if (
    claim?.source === 'microsoft_verified_domain' &&
    claim.provider_tenant_id
  ) {
    return await resolveMicrosoftClaimWorkspace(db, {
      domain: normalized,
      workspaceId: claim.workspace_id,
      providerTenantId: claim.provider_tenant_id,
    })
  }
  return claim?.workspace_id ?? null
}

export async function findWorkspaceIdForMicrosoftTenantDomain(
  db: Kysely<DB>,
  providerTenantId: string,
  domain: string | null,
): Promise<string | null> {
  const normalized = normalizeEmailDomain(domain)
  if (normalized && !isPublicEmailDomain(normalized)) {
    const claim = await db
      .selectFrom('workspace_domain_claims')
      .select(['workspace_id', 'source', 'provider_tenant_id'])
      .where('domain', '=', normalized)
      .executeTakeFirst()
    if (
      claim?.source === 'microsoft_verified_domain' &&
      claim.provider_tenant_id
    ) {
      return await resolveMicrosoftClaimWorkspace(db, {
        domain: normalized,
        workspaceId: claim.workspace_id,
        providerTenantId: claim.provider_tenant_id,
      })
    }
    if (claim) return claim.workspace_id
  }
  return await findWorkspaceIdByProviderTenant(db, providerTenantId)
}

async function resolveMicrosoftClaimWorkspace(
  db: Kysely<DB>,
  input: {
    domain: string
    workspaceId: string
    providerTenantId: string
  },
): Promise<string> {
  const tenantWorkspaceId = await findWorkspaceIdByProviderTenant(
    db,
    input.providerTenantId,
  )
  if (!tenantWorkspaceId || tenantWorkspaceId === input.workspaceId) {
    return input.workspaceId
  }

  const disposableDuplicate = await db
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', input.workspaceId)
    .where(
      sql<boolean>`
        hd IS NULL
        AND ms_tenant_id IS NULL
        AND plan = 'free'
        AND storage_used_bytes = 0
        AND stripe_customer_id IS NULL
        AND stripe_subscription_id IS NULL
        AND stripe_subscription_status = 'none'
        AND link_sharing_enabled = 0
        AND external_posting_enabled = 0
        AND link_expiry_default_days = 30
        AND link_expiry_max_days = 90
        AND (
          (self_upload_enabled = 1 AND storage_quota_bytes = 104857600)
          OR (self_upload_enabled = 0 AND storage_quota_bytes = 0)
        )
        AND NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (
          SELECT 1 FROM workspace_domain_claims
          WHERE workspace_id = ${input.workspaceId} AND domain != ${input.domain}
        )
        AND NOT EXISTS (
          SELECT 1 FROM workspace_storage_daily_usage
          WHERE workspace_id = ${input.workspaceId}
            AND (used_bytes != 0 OR billable_overage_gb != 0)
        )
        AND NOT EXISTS (SELECT 1 FROM billing_overage_charges WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM artifact_containers WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM shareables WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM agent_profiles WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM cli_family_authorities WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM cli_session_authorities WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM bridge_authorities WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM slack_workspaces WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM mcp_artifact_posts WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM artifact_keys WHERE workspace_id = ${input.workspaceId})
        AND NOT EXISTS (SELECT 1 FROM events WHERE workspace_id = ${input.workspaceId})
      `,
    )
    .executeTakeFirst()
  return disposableDuplicate ? tenantWorkspaceId : input.workspaceId
}

export async function findWorkspaceIdByProviderTenant(
  db: Kysely<DB>,
  providerTenantId: string | null | undefined,
): Promise<string | null> {
  if (!providerTenantId) return null

  // The workspace column is the canonical Microsoft tenant identity. Prefer
  // it over a claim row so legacy duplicate data cannot route a sign-in to an
  // empty claim-only workspace.
  const tenantWorkspace = await db
    .selectFrom('workspaces')
    .select('id')
    .where('ms_tenant_id', '=', providerTenantId)
    .executeTakeFirst()
  return tenantWorkspace?.id ?? null
}

export async function ensureDomainClaimWorkspace(
  db: Kysely<DB>,
  input: {
    domain: string
    source: WorkspaceDomainClaimSource
    providerTenantId?: string | null
    now: string
    creation?: {
      self_upload_enabled: number
      storage_quota_bytes: number
    }
  },
): Promise<string | null> {
  const domain = normalizeEmailDomain(input.domain)
  if (!domain || isPublicEmailDomain(domain)) return null

  const existingClaim = await findWorkspaceIdByDomainClaim(db, domain)
  if (existingClaim) return existingClaim

  const existingTenantWorkspace = await findWorkspaceIdByProviderTenant(
    db,
    input.providerTenantId,
  )
  if (existingTenantWorkspace) {
    return await ensureWorkspaceDomainClaim(db, {
      domain,
      workspaceId: existingTenantWorkspace,
      source: input.source,
      providerTenantId: input.providerTenantId ?? null,
      now: input.now,
    })
  }

  const workspaceId = nanoid()
  let insertWorkspace = db.insertInto('workspaces').values({
    id: workspaceId,
    hd: null,
    ms_tenant_id:
      input.source === 'microsoft_verified_domain'
        ? (input.providerTenantId ?? null)
        : null,
    name: domain,
    created_at: input.now,
    email_domain: domain,
    ...input.creation,
  })
  if (input.source === 'microsoft_verified_domain' && input.providerTenantId) {
    insertWorkspace = insertWorkspace.onConflict((oc) =>
      oc.column('ms_tenant_id').doNothing(),
    )
  }
  const insertedWorkspace = await insertWorkspace
    .returning('id')
    .executeTakeFirst()
  if (!insertedWorkspace) {
    const concurrentTenantWorkspace = await findWorkspaceIdByProviderTenant(
      db,
      input.providerTenantId,
    )
    if (!concurrentTenantWorkspace) return null
    return await ensureWorkspaceDomainClaim(db, {
      domain,
      workspaceId: concurrentTenantWorkspace,
      source: input.source,
      providerTenantId: input.providerTenantId ?? null,
      now: input.now,
    })
  }

  const claimedWorkspaceId = await ensureWorkspaceDomainClaim(db, {
    domain,
    workspaceId: insertedWorkspace.id,
    source: input.source,
    providerTenantId: input.providerTenantId ?? null,
    now: input.now,
  })
  if (claimedWorkspaceId !== insertedWorkspace.id) {
    await deleteWorkspaceIfUnreferenced(db, insertedWorkspace.id).execute()
  }
  return claimedWorkspaceId
}

function deleteWorkspaceIfUnreferenced(db: Kysely<DB>, workspaceId: string) {
  return db
    .deleteFrom('workspaces')
    .where('id', '=', workspaceId)
    .where(
      sql<boolean>`
        NOT EXISTS (SELECT 1 FROM users WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM workspace_domain_claims WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM workspace_storage_daily_usage WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM billing_overage_charges WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM artifact_containers WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM shareables WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM agent_profiles WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM cli_family_authorities WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM cli_session_authorities WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM bridge_authorities WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM slack_workspaces WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM mcp_artifact_posts WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM artifact_keys WHERE workspace_id = ${workspaceId})
        AND NOT EXISTS (SELECT 1 FROM events WHERE workspace_id = ${workspaceId})
      `,
    )
}

export async function maybeMoveUserToClaimedWorkspace(
  db: Kysely<DB>,
  input: { userId: string; email: string; currentWorkspaceId: string },
): Promise<string | null> {
  // Human-only: a bot's workspace_id is its host workspace and every agent
  // authority and member row depends on it staying put.
  const mover = await db
    .selectFrom('users')
    .select('kind')
    .where('id', '=', input.userId)
    .executeTakeFirst()
  if (mover?.kind !== 'human') return null
  const domain = normalizeEmailDomain(input.email)
  const targetWorkspaceId = await findWorkspaceIdByDomainClaim(db, domain)
  if (!targetWorkspaceId) return null
  if (targetWorkspaceId === input.currentWorkspaceId) {
    await ensureWorkspaceAdmin(db, targetWorkspaceId, nowIso())
    return null
  }

  return await moveUserToWorkspaceIfSafe(
    db,
    {
      ...input,
      targetWorkspaceId,
    },
    {
      allowCurrentWorkspaceAdmin: input.currentWorkspaceId,
    },
  )
}

export async function moveUserToWorkspaceForOAuth(
  db: Kysely<DB>,
  input: {
    userId: string
    email: string
    currentWorkspaceId: string
    targetWorkspaceId: string
  },
): Promise<string | null> {
  if (input.targetWorkspaceId === input.currentWorkspaceId) {
    await ensureWorkspaceAdmin(db, input.targetWorkspaceId, nowIso())
    return null
  }
  return await moveUserToWorkspaceIfSafe(db, input, {
    allowCurrentWorkspaceAdmin: input.currentWorkspaceId,
  })
}

async function moveUserToWorkspaceIfSafe(
  db: Kysely<DB>,
  input: {
    userId: string
    email: string
    currentWorkspaceId: string
    targetWorkspaceId: string
  },
  options: { allowCurrentWorkspaceAdmin?: string } = {},
): Promise<string | null> {
  const reasons = await workspaceMigrationBlockReasons(db, input.userId, {
    ...options,
    targetWorkspaceId: input.targetWorkspaceId,
  })
  if (reasons.length > 0) return null

  const now = nowIso()
  const userUpdate = db
    .updateTable('users')
    .set({ workspace_id: input.targetWorkspaceId })
    .where('id', '=', input.userId)
    .where('workspace_id', '=', input.currentWorkspaceId)
    .where(
      sql<boolean>`
        EXISTS (
          SELECT 1
          FROM workspaces AS source
          WHERE source.id = ${input.currentWorkspaceId}
            AND source.hd IS NULL
            AND source.ms_tenant_id IS NULL
            AND source.plan = 'free'
            AND source.storage_used_bytes = 0
            AND source.stripe_customer_id IS NULL
            AND source.stripe_subscription_id IS NULL
            AND source.stripe_subscription_status = 'none'
            AND source.link_sharing_enabled = 0
            AND source.external_posting_enabled = 0
            AND source.link_expiry_default_days = 30
            AND source.link_expiry_max_days = 90
            AND lower(source.name) = lower((
              SELECT email || '''s workspace'
              FROM users
              WHERE id = ${input.userId}
                AND workspace_id = source.id
            ))
            AND (
              (source.self_upload_enabled = 1 AND source.storage_quota_bytes = 104857600)
              OR (source.self_upload_enabled = 0 AND source.storage_quota_bytes = 0)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM users
            WHERE workspace_id = ${input.currentWorkspaceId} AND id != ${input.userId}
          UNION ALL SELECT 1 FROM workspace_members
            WHERE workspace_id = ${input.currentWorkspaceId} AND user_id != ${input.userId}
          UNION ALL SELECT 1 FROM workspace_domain_claims
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM workspace_storage_daily_usage
            WHERE workspace_id = ${input.currentWorkspaceId}
              AND (used_bytes != 0 OR billable_overage_gb != 0)
          UNION ALL SELECT 1 FROM billing_overage_charges
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM artifact_containers
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM shareables
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM agent_profiles
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM cli_family_authorities
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM cli_session_authorities
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM bridge_authorities
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM slack_workspaces
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM mcp_artifact_posts
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM artifact_keys
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM events
            WHERE workspace_id = ${input.currentWorkspaceId}
          UNION ALL SELECT 1 FROM api_tokens
            WHERE user_id = ${input.userId}
          UNION ALL SELECT 1 FROM cli_refresh_credentials
            WHERE user_id = ${input.userId}
          UNION ALL SELECT 1 FROM oauthAccessToken
            WHERE userId = ${input.userId}
              AND (expiresAt IS NULL OR expiresAt > ${now})
          UNION ALL SELECT 1 FROM oauthRefreshToken
            WHERE userId = ${input.userId}
              AND revoked IS NULL
              AND (expiresAt IS NULL OR expiresAt > ${now})
          UNION ALL SELECT 1 FROM oauthConsent
            WHERE userId = ${input.userId}
          UNION ALL SELECT 1 FROM comment_threads
            WHERE created_by_id = ${input.userId}
          UNION ALL SELECT 1 FROM comment_messages
            WHERE created_by_id = ${input.userId}
          UNION ALL SELECT 1 FROM workspace_members
            WHERE user_id = ${input.userId}
              AND workspace_id != ${input.currentWorkspaceId}
              AND status = 'active'
              AND role IN ('owner', 'admin')
        )
      `,
    )
  const membershipUpsert = db
    .insertInto('workspace_members')
    .columns([
      'workspace_id',
      'user_id',
      'role',
      'status',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('id', '=', input.userId)
        .where('workspace_id', '=', input.targetWorkspaceId)
        .select([
          eb.val(input.targetWorkspaceId).as('workspace_id'),
          eb.val(input.userId).as('user_id'),
          eb.val('member').as('role'),
          eb.val('active').as('status'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )
    .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
  const targetMembershipGuard = sql`
    INSERT INTO audit_events (
      id, workspace_id, action, subject_type, subject_id, created_at
    )
    SELECT
      ${`workspace-move-guard:${input.userId}:${now}`},
      ${input.targetWorkspaceId},
      NULL,
      'user',
      ${input.userId},
      ${now}
    WHERE NOT EXISTS (
      SELECT 1
      FROM users
      INNER JOIN workspace_members
        ON workspace_members.workspace_id = users.workspace_id
        AND workspace_members.user_id = users.id
      WHERE users.id = ${input.userId}
        AND users.workspace_id = ${input.targetWorkspaceId}
        AND workspace_members.status = 'active'
    )
  `
  const targetMembershipGuardQuery = {
    compile: () => targetMembershipGuard.compile(db),
    execute: () => targetMembershipGuard.execute(db),
  }
  const sourceMembershipDelete = db
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', input.currentWorkspaceId)
    .where('user_id', '=', input.userId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('users')
            .select('id')
            .where('id', '=', input.userId)
            .where('workspace_id', '=', input.currentWorkspaceId),
        ),
      ),
    )
  const emptySourceWorkspaceDelete = db
    .deleteFrom('workspaces')
    .where('id', '=', input.currentWorkspaceId)
    .where('hd', 'is', null)
    .where('ms_tenant_id', 'is', null)
    .where('plan', '=', 'free')
    .where('storage_used_bytes', '=', 0)
    .where('stripe_customer_id', 'is', null)
    .where('stripe_subscription_id', 'is', null)
    .where('stripe_subscription_status', '=', 'none')
    .where('link_sharing_enabled', '=', 0)
    .where('external_posting_enabled', '=', 0)
    .where('link_expiry_default_days', '=', 30)
    .where('link_expiry_max_days', '=', 90)
    .where(
      sql<boolean>`lower(name) = lower((
        SELECT email || '''s workspace'
        FROM users
        WHERE id = ${input.userId}
      ))`,
    )
    .where((eb) =>
      eb.or([
        eb.and([
          eb('self_upload_enabled', '=', 1),
          eb('storage_quota_bytes', '=', 104857600),
        ]),
        eb.and([
          eb('self_upload_enabled', '=', 0),
          eb('storage_quota_bytes', '=', 0),
        ]),
      ]),
    )
    .where((eb) =>
      eb.and([
        eb.not(
          eb.exists(
            eb
              .selectFrom('users')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('workspace_domain_claims')
              .select('domain')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('artifact_containers')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('shareables')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('agent_profiles')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('cli_family_authorities')
              .select('family_id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('cli_session_authorities')
              .select('session_id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('bridge_authorities')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('workspace_members')
              .select('user_id')
              .where('workspace_id', '=', input.currentWorkspaceId)
              .where('user_id', '!=', input.userId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('workspace_storage_daily_usage')
              .select('date')
              .where('workspace_id', '=', input.currentWorkspaceId)
              .where((usage) =>
                usage.or([
                  usage('used_bytes', '!=', 0),
                  usage('billable_overage_gb', '!=', 0),
                ]),
              ),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('billing_overage_charges')
              .select('month')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('slack_workspaces')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('mcp_artifact_posts')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('artifact_keys')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('events')
              .select('id')
              .where('workspace_id', '=', input.currentWorkspaceId),
          ),
        ),
      ]),
    )
  await runD1Batch(
    db,
    userUpdate,
    membershipUpsert,
    targetMembershipGuardQuery,
    sourceMembershipDelete,
    emptySourceWorkspaceDelete,
  )
  await ensureWorkspaceAdmin(db, input.targetWorkspaceId, now)
  return input.targetWorkspaceId
}

export async function canAutoMoveUserWorkspace(
  db: Kysely<DB>,
  userId: string,
  options: { allowCurrentWorkspaceAdmin?: string } = {},
): Promise<boolean> {
  return (
    (await workspaceMigrationBlockReasons(db, userId, options)).length === 0
  )
}

export type WorkspaceMigrationBlockReason =
  | 'target_membership_removed'
  | 'source_workspace_configured'
  | 'source_workspace_has_other_users'
  | 'source_workspace_has_other_members'
  | 'source_workspace_has_usage'
  | 'source_workspace_has_content'
  | 'source_workspace_has_integrations'
  | 'email_not_verified'
  | 'user_administers_another_workspace'
  | 'user_has_shareables'
  | 'user_has_projects'
  | 'user_has_comments'
  | 'user_has_api_tokens'
  | 'user_has_cli_credentials'
  | 'user_has_oauth_tokens'
  | 'user_has_oauth_consents'

export async function workspaceMigrationBlockReasons(
  db: Kysely<DB>,
  userId: string,
  options: {
    allowCurrentWorkspaceAdmin?: string
    targetWorkspaceId?: string
  } = {},
): Promise<WorkspaceMigrationBlockReason[]> {
  const reasons: WorkspaceMigrationBlockReason[] = []
  if (options.targetWorkspaceId) {
    const removedMembership = await db
      .selectFrom('workspace_members')
      .select('status')
      .where('workspace_id', '=', options.targetWorkspaceId)
      .where('user_id', '=', userId)
      .where('status', '=', 'removed')
      .executeTakeFirst()
    if (removedMembership) reasons.push('target_membership_removed')
  }

  if (options.allowCurrentWorkspaceAdmin) {
    const workspace = await db
      .selectFrom('workspaces')
      .innerJoin('users as workspace_user', (join) =>
        join
          .onRef('workspace_user.workspace_id', '=', 'workspaces.id')
          .on('workspace_user.id', '=', userId),
      )
      .leftJoin(
        'workspace_domain_claims',
        'workspace_domain_claims.workspace_id',
        'workspaces.id',
      )
      .select([
        'workspaces.hd',
        'workspaces.name',
        'workspaces.ms_tenant_id',
        'workspaces.plan',
        'workspaces.storage_used_bytes',
        'workspaces.self_upload_enabled',
        'workspaces.storage_quota_bytes',
        'workspaces.stripe_customer_id',
        'workspaces.stripe_subscription_id',
        'workspaces.stripe_subscription_status',
        'workspaces.link_sharing_enabled',
        'workspaces.external_posting_enabled',
        'workspaces.link_expiry_default_days',
        'workspaces.link_expiry_max_days',
        'workspace_user.email as user_email',
        'workspace_domain_claims.domain',
      ])
      .where('workspaces.id', '=', options.allowCurrentWorkspaceAdmin)
      .executeTakeFirst()
    const disposableProvisioning =
      workspace &&
      ((workspace.self_upload_enabled === 1 &&
        workspace.storage_quota_bytes === 104857600) ||
        (workspace.self_upload_enabled === 0 &&
          workspace.storage_quota_bytes === 0))
    if (
      !workspace ||
      workspace.hd ||
      workspace.ms_tenant_id ||
      workspace.domain ||
      workspace.plan !== 'free' ||
      workspace.storage_used_bytes !== 0 ||
      workspace.stripe_customer_id ||
      workspace.stripe_subscription_id ||
      workspace.stripe_subscription_status !== 'none' ||
      workspace.link_sharing_enabled !== 0 ||
      workspace.external_posting_enabled !== 0 ||
      workspace.link_expiry_default_days !== 30 ||
      workspace.link_expiry_max_days !== 90 ||
      workspace.name.toLowerCase() !==
        `${workspace.user_email.toLowerCase()}'s workspace` ||
      !disposableProvisioning
    ) {
      reasons.push('source_workspace_configured')
    }
    const workspaceId = options.allowCurrentWorkspaceAdmin
    // Keep each category as independent EXISTS predicates. D1 applies a low
    // compound-SELECT term limit, so extending a UNION ALL list as new
    // workspace-owned tables are added can make this login-time check fail.
    const residual = await sql<{
      has_other_users: number
      has_other_members: number
      has_usage: number
      has_content: number
      has_integrations: number
    }>`
      SELECT
        EXISTS (SELECT 1 FROM users WHERE workspace_id = ${workspaceId} AND id != ${userId}) AS has_other_users,
        EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id != ${userId}) AS has_other_members,
        (
          EXISTS (
            SELECT 1 FROM workspace_storage_daily_usage
            WHERE workspace_id = ${workspaceId}
              AND (used_bytes != 0 OR billable_overage_gb != 0)
          )
          OR EXISTS (SELECT 1 FROM billing_overage_charges WHERE workspace_id = ${workspaceId})
        ) AS has_usage,
        (
          EXISTS (SELECT 1 FROM artifact_containers WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM shareables WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM artifact_keys WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM events WHERE workspace_id = ${workspaceId})
        ) AS has_content,
        (
          EXISTS (SELECT 1 FROM agent_profiles WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM cli_family_authorities WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM cli_session_authorities WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM bridge_authorities WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM slack_workspaces WHERE workspace_id = ${workspaceId})
          OR EXISTS (SELECT 1 FROM mcp_artifact_posts WHERE workspace_id = ${workspaceId})
        ) AS has_integrations
    `.execute(db)
    const state = residual.rows[0]
    if (Number(state?.has_other_users ?? 0) !== 0)
      reasons.push('source_workspace_has_other_users')
    if (Number(state?.has_other_members ?? 0) !== 0)
      reasons.push('source_workspace_has_other_members')
    if (Number(state?.has_usage ?? 0) !== 0)
      reasons.push('source_workspace_has_usage')
    if (Number(state?.has_content ?? 0) !== 0)
      reasons.push('source_workspace_has_content')
    if (Number(state?.has_integrations ?? 0) !== 0)
      reasons.push('source_workspace_has_integrations')
  }

  reasons.push(...(await userWorkspaceChangeBlockReasons(db, userId, options)))
  return [...new Set(reasons)]
}

export async function canEnableOAuthWorkspaceSelfUpload(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await db
    .selectFrom('workspaces')
    .leftJoin(
      'workspace_domain_claims',
      'workspace_domain_claims.workspace_id',
      'workspaces.id',
    )
    .select([
      'workspaces.hd',
      'workspaces.ms_tenant_id',
      'workspace_domain_claims.domain',
    ])
    .where('workspaces.id', '=', workspaceId)
    .executeTakeFirst()
  if (
    !workspace ||
    workspace.hd ||
    workspace.ms_tenant_id ||
    workspace.domain
  ) {
    return false
  }
  return await hasSafeUserStateForWorkspaceChange(db, userId, {
    allowCurrentWorkspaceAdmin: workspaceId,
  })
}

async function hasSafeUserStateForWorkspaceChange(
  db: Kysely<DB>,
  userId: string,
  options: { allowCurrentWorkspaceAdmin?: string },
): Promise<boolean> {
  return (
    (await userWorkspaceChangeBlockReasons(db, userId, options)).length === 0
  )
}

async function userWorkspaceChangeBlockReasons(
  db: Kysely<DB>,
  userId: string,
  options: { allowCurrentWorkspaceAdmin?: string },
): Promise<WorkspaceMigrationBlockReason[]> {
  const activeTokenCutoff = nowIso()
  const adminWorkspaceFilter = options.allowCurrentWorkspaceAdmin
    ? sql<boolean>`
        AND (
          admins.workspace_id != ${options.allowCurrentWorkspaceAdmin}
          OR EXISTS (
            SELECT 1
            FROM workspace_members AS peers
            WHERE peers.workspace_id = admins.workspace_id
              AND peers.user_id != ${userId}
              AND peers.status = 'active'
          )
        )
      `
    : sql<boolean>``
  const row = await db
    .selectFrom('users')
    .select((eb) => [
      'email_verified',
      sql<boolean>`EXISTS (
        SELECT 1
        FROM workspace_members AS admins
        WHERE admins.user_id = ${userId}
          AND admins.role IN ('owner', 'admin')
          AND admins.status = 'active'
          ${adminWorkspaceFilter}
      )`.as('has_admin'),
      eb
        .exists(
          eb
            .selectFrom('shareables')
            .select('id')
            .where('shareables.owner_user_id', '=', userId),
        )
        .as('has_shareables'),
      eb
        .exists(
          eb
            .selectFrom('artifact_containers')
            .select('id')
            .where('artifact_containers.kind', '=', 'project')
            .where((inner) =>
              inner.or([
                inner('artifact_containers.owner_user_id', '=', userId),
                inner('artifact_containers.created_by_id', '=', userId),
              ]),
            ),
        )
        .as('has_projects'),
      eb
        .exists(
          eb
            .selectFrom('comment_messages')
            .select('id')
            .where('comment_messages.created_by_id', '=', userId),
        )
        .as('has_comment_messages'),
      eb
        .exists(
          eb
            .selectFrom('comment_threads')
            .select('id')
            .where('comment_threads.created_by_id', '=', userId),
        )
        .as('has_comment_threads'),
      eb
        .exists(
          eb
            .selectFrom('api_tokens')
            .select('id')
            .where('api_tokens.user_id', '=', userId),
        )
        .as('has_api_tokens'),
      eb
        .exists(
          eb
            .selectFrom('cli_refresh_credentials')
            .select('id')
            .where('cli_refresh_credentials.user_id', '=', userId),
        )
        .as('has_cli_refresh_credentials'),
      sql<boolean>`EXISTS (
        SELECT 1 FROM oauthAccessToken
        WHERE userId = ${userId}
          AND (expiresAt IS NULL OR expiresAt > ${activeTokenCutoff})
      )`.as('has_oauth_access_tokens'),
      sql<boolean>`EXISTS (
        SELECT 1 FROM oauthRefreshToken
        WHERE userId = ${userId}
          AND revoked IS NULL
          AND (expiresAt IS NULL OR expiresAt > ${activeTokenCutoff})
      )`.as('has_oauth_refresh_tokens'),
      sql<boolean>`EXISTS (
        SELECT 1 FROM oauthConsent
        WHERE userId = ${userId}
      )`.as('has_oauth_consents'),
    ])
    .where('id', '=', userId)
    .executeTakeFirst()

  const reasons: WorkspaceMigrationBlockReason[] = []
  if (row?.email_verified !== 1) reasons.push('email_not_verified')
  if (row?.has_admin) reasons.push('user_administers_another_workspace')
  if (row?.has_shareables) reasons.push('user_has_shareables')
  if (row?.has_projects) reasons.push('user_has_projects')
  if (row?.has_comment_messages || row?.has_comment_threads)
    reasons.push('user_has_comments')
  if (row?.has_api_tokens) reasons.push('user_has_api_tokens')
  if (row?.has_cli_refresh_credentials) reasons.push('user_has_cli_credentials')
  if (row?.has_oauth_access_tokens || row?.has_oauth_refresh_tokens)
    reasons.push('user_has_oauth_tokens')
  if (row?.has_oauth_consents) reasons.push('user_has_oauth_consents')
  return reasons
}

export interface WorkspaceMigrationCandidate {
  domain: string
  claimWorkspaceId: string
  personalWorkspaceId: string
  userId: string
  email: string
  shareablesCount: number
  projectsCount: number
  commentThreadsCount: number
  commentMessagesCount: number
  apiTokensCount: number
  cliRefreshCredentialsCount: number
  oauthAccessTokensCount: number
  oauthRefreshTokensCount: number
  oauthConsentsCount: number
  reasonCodes: WorkspaceMigrationBlockReason[]
}

interface WorkspaceMigrationCandidateRow extends Omit<
  WorkspaceMigrationCandidate,
  'reasonCodes'
> {
  emailVerified: number
  targetMembershipRemoved: number
  sourceWorkspaceConfigured: number
  sourceWorkspaceHasOtherUsers: number
  sourceWorkspaceHasOtherMembers: number
  sourceWorkspaceHasUsage: number
  sourceWorkspaceHasContent: number
  sourceWorkspaceHasIntegrations: number
  userAdministersAnotherWorkspace: number
}

export async function listWorkspaceMigrationCandidates(
  db: Kysely<DB>,
): Promise<WorkspaceMigrationCandidate[]> {
  const activeTokenCutoff = nowIso()
  const rows = await sql<WorkspaceMigrationCandidateRow>`
    SELECT
      claims.domain AS domain,
      claims.workspace_id AS claimWorkspaceId,
      personal_ws.id AS personalWorkspaceId,
      users.id AS userId,
      users.email AS email,
      users.email_verified AS emailVerified,
      EXISTS (
        SELECT 1 FROM workspace_members
        WHERE workspace_id = claims.workspace_id
          AND user_id = users.id
          AND status = 'removed'
      ) AS targetMembershipRemoved,
      COALESCE(NOT (
        personal_ws.hd IS NULL
        AND personal_ws.ms_tenant_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM workspace_domain_claims AS source_claim
          WHERE source_claim.workspace_id = personal_ws.id
        )
        AND personal_ws.plan = 'free'
        AND personal_ws.storage_used_bytes = 0
        AND personal_ws.stripe_customer_id IS NULL
        AND personal_ws.stripe_subscription_id IS NULL
        AND personal_ws.stripe_subscription_status = 'none'
        AND personal_ws.link_sharing_enabled = 0
        AND personal_ws.external_posting_enabled = 0
        AND personal_ws.link_expiry_default_days = 30
        AND personal_ws.link_expiry_max_days = 90
        AND lower(personal_ws.name) = lower(users.email || '''s workspace')
        AND (
          (personal_ws.self_upload_enabled = 1 AND personal_ws.storage_quota_bytes = 104857600)
          OR (personal_ws.self_upload_enabled = 0 AND personal_ws.storage_quota_bytes = 0)
        )
      ), 1) AS sourceWorkspaceConfigured,
      EXISTS (
        SELECT 1 FROM users AS source_user
        WHERE source_user.workspace_id = personal_ws.id
          AND source_user.id != users.id
      ) AS sourceWorkspaceHasOtherUsers,
      EXISTS (
        SELECT 1 FROM workspace_members AS source_member
        WHERE source_member.workspace_id = personal_ws.id
          AND source_member.user_id != users.id
      ) AS sourceWorkspaceHasOtherMembers,
      (
        EXISTS (
          SELECT 1 FROM workspace_storage_daily_usage
          WHERE workspace_id = personal_ws.id
            AND (used_bytes != 0 OR billable_overage_gb != 0)
        )
        OR EXISTS (
          SELECT 1 FROM billing_overage_charges
          WHERE workspace_id = personal_ws.id
        )
      ) AS sourceWorkspaceHasUsage,
      (
        EXISTS (SELECT 1 FROM artifact_containers WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM shareables WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM artifact_keys WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM events WHERE workspace_id = personal_ws.id)
      ) AS sourceWorkspaceHasContent,
      (
        EXISTS (SELECT 1 FROM agent_profiles WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM cli_family_authorities WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM cli_session_authorities WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM bridge_authorities WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM slack_workspaces WHERE workspace_id = personal_ws.id)
        OR EXISTS (SELECT 1 FROM mcp_artifact_posts WHERE workspace_id = personal_ws.id)
      ) AS sourceWorkspaceHasIntegrations,
      EXISTS (
        SELECT 1 FROM workspace_members AS admins
        WHERE admins.user_id = users.id
          AND admins.role IN ('owner', 'admin')
          AND admins.status = 'active'
          AND (
            admins.workspace_id != personal_ws.id
            OR EXISTS (
              SELECT 1 FROM workspace_members AS peers
              WHERE peers.workspace_id = admins.workspace_id
                AND peers.user_id != users.id
                AND peers.status = 'active'
            )
          )
      ) AS userAdministersAnotherWorkspace,
      (
        SELECT count(*)
        FROM shareables
        WHERE shareables.owner_user_id = users.id
      ) AS shareablesCount,
      (
        SELECT count(*)
        FROM artifact_containers
        WHERE artifact_containers.kind = 'project'
          AND (
            artifact_containers.owner_user_id = users.id
            OR artifact_containers.created_by_id = users.id
          )
      ) AS projectsCount,
      (
        SELECT count(*)
        FROM comment_threads
        WHERE comment_threads.created_by_id = users.id
      ) AS commentThreadsCount,
      (
        SELECT count(*)
        FROM comment_messages
        WHERE comment_messages.created_by_id = users.id
      ) AS commentMessagesCount,
      (
        SELECT count(*)
        FROM api_tokens
        WHERE api_tokens.user_id = users.id
      ) AS apiTokensCount,
      (
        SELECT count(*)
        FROM cli_refresh_credentials
        WHERE cli_refresh_credentials.user_id = users.id
      ) AS cliRefreshCredentialsCount,
      (
        SELECT count(*)
        FROM oauthAccessToken
        WHERE oauthAccessToken.userId = users.id
          AND (oauthAccessToken.expiresAt IS NULL OR oauthAccessToken.expiresAt > ${activeTokenCutoff})
      ) AS oauthAccessTokensCount,
      (
        SELECT count(*)
        FROM oauthRefreshToken
        WHERE oauthRefreshToken.userId = users.id
          AND oauthRefreshToken.revoked IS NULL
          AND (oauthRefreshToken.expiresAt IS NULL OR oauthRefreshToken.expiresAt > ${activeTokenCutoff})
      ) AS oauthRefreshTokensCount,
      (
        SELECT count(*)
        FROM oauthConsent
        WHERE oauthConsent.userId = users.id
      ) AS oauthConsentsCount
    FROM workspace_domain_claims AS claims
    INNER JOIN users
      ON lower(substr(users.email, instr(users.email, '@') + 1)) = claims.domain
    INNER JOIN workspaces AS personal_ws
      ON personal_ws.id = users.workspace_id
    WHERE users.workspace_id <> claims.workspace_id
      AND users.kind = 'human'
    ORDER BY claims.domain, users.email
  `.execute(db)

  const candidates = rows.rows.map((row) => {
    const reasonCodes: WorkspaceMigrationBlockReason[] = []
    if (Number(row.targetMembershipRemoved) !== 0)
      reasonCodes.push('target_membership_removed')
    if (Number(row.sourceWorkspaceConfigured) !== 0)
      reasonCodes.push('source_workspace_configured')
    if (Number(row.sourceWorkspaceHasOtherUsers) !== 0)
      reasonCodes.push('source_workspace_has_other_users')
    if (Number(row.sourceWorkspaceHasOtherMembers) !== 0)
      reasonCodes.push('source_workspace_has_other_members')
    if (Number(row.sourceWorkspaceHasUsage) !== 0)
      reasonCodes.push('source_workspace_has_usage')
    if (Number(row.sourceWorkspaceHasContent) !== 0)
      reasonCodes.push('source_workspace_has_content')
    if (Number(row.sourceWorkspaceHasIntegrations) !== 0)
      reasonCodes.push('source_workspace_has_integrations')
    if (Number(row.emailVerified) !== 1) reasonCodes.push('email_not_verified')
    if (Number(row.userAdministersAnotherWorkspace) !== 0)
      reasonCodes.push('user_administers_another_workspace')
    if (Number(row.shareablesCount) !== 0)
      reasonCodes.push('user_has_shareables')
    if (Number(row.projectsCount) !== 0) reasonCodes.push('user_has_projects')
    if (
      Number(row.commentThreadsCount) !== 0 ||
      Number(row.commentMessagesCount) !== 0
    )
      reasonCodes.push('user_has_comments')
    if (Number(row.apiTokensCount) !== 0)
      reasonCodes.push('user_has_api_tokens')
    if (Number(row.cliRefreshCredentialsCount) !== 0)
      reasonCodes.push('user_has_cli_credentials')
    if (
      Number(row.oauthAccessTokensCount) !== 0 ||
      Number(row.oauthRefreshTokensCount) !== 0
    )
      reasonCodes.push('user_has_oauth_tokens')
    if (Number(row.oauthConsentsCount) !== 0)
      reasonCodes.push('user_has_oauth_consents')
    return {
      domain: row.domain,
      claimWorkspaceId: row.claimWorkspaceId,
      personalWorkspaceId: row.personalWorkspaceId,
      userId: row.userId,
      email: row.email,
      shareablesCount: Number(row.shareablesCount),
      projectsCount: Number(row.projectsCount),
      commentThreadsCount: Number(row.commentThreadsCount),
      commentMessagesCount: Number(row.commentMessagesCount),
      apiTokensCount: Number(row.apiTokensCount),
      cliRefreshCredentialsCount: Number(row.cliRefreshCredentialsCount),
      oauthAccessTokensCount: Number(row.oauthAccessTokensCount),
      oauthRefreshTokensCount: Number(row.oauthRefreshTokensCount),
      oauthConsentsCount: Number(row.oauthConsentsCount),
      reasonCodes,
    }
  })
  return candidates.filter((candidate) => candidate.reasonCodes.length > 0)
}

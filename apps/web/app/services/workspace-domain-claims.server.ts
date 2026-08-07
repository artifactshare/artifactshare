import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { env } from 'cloudflare:workers'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import {
  isPublicEmailDomain,
  normalizeEmailDomain,
} from '~/lib/workspace-domains'
import type { DB } from '~/types/db'

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
    .select('workspace_id')
    .where('domain', '=', normalized)
    .executeTakeFirst()
  return claim?.workspace_id ?? null
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

  const workspaceId = nanoid()
  const insertedWorkspace = await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      hd: null,
      ms_tenant_id: null,
      name: domain,
      created_at: input.now,
      email_domain: domain,
      ...input.creation,
    })
    .returning('id')
    .executeTakeFirst()
  if (!insertedWorkspace) return null

  const claimedWorkspaceId = await ensureWorkspaceDomainClaim(db, {
    domain,
    workspaceId: insertedWorkspace.id,
    source: input.source,
    providerTenantId: input.providerTenantId ?? null,
    now: input.now,
  })
  if (claimedWorkspaceId !== insertedWorkspace.id) {
    await db
      .deleteFrom('workspaces')
      .where('id', '=', insertedWorkspace.id)
      .execute()
  }
  return claimedWorkspaceId
}

export async function maybeMoveUserToClaimedWorkspace(
  db: Kysely<DB>,
  input: { userId: string; email: string; currentWorkspaceId: string },
): Promise<string | null> {
  const domain = normalizeEmailDomain(input.email)
  const targetWorkspaceId = await findWorkspaceIdByDomainClaim(db, domain)
  if (!targetWorkspaceId || targetWorkspaceId === input.currentWorkspaceId) {
    return null
  }

  return await moveUserToWorkspaceIfSafe(db, {
    ...input,
    targetWorkspaceId,
  })
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
  if (input.targetWorkspaceId === input.currentWorkspaceId) return null
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
  const removedMembership = await db
    .selectFrom('workspace_members')
    .select('status')
    .where('workspace_id', '=', input.targetWorkspaceId)
    .where('user_id', '=', input.userId)
    .where('status', '=', 'removed')
    .executeTakeFirst()
  if (removedMembership) return null

  const canMove = await canAutoMoveUserWorkspace(db, input.userId, options)
  if (!canMove) return null

  const now = nowIso()
  const userUpdate = db
    .updateTable('users')
    .set({ workspace_id: input.targetWorkspaceId })
    .where('id', '=', input.userId)
    .where('workspace_id', '=', input.currentWorkspaceId)
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
      FROM workspace_members
      WHERE workspace_id = ${input.targetWorkspaceId}
        AND user_id = ${input.userId}
        AND status = 'active'
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
              .where('workspace_id', '=', input.currentWorkspaceId),
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
      ]),
    )
  if ((env as { DB?: unknown }).DB) {
    await runD1Batch(
      userUpdate,
      membershipUpsert,
      targetMembershipGuardQuery,
      sourceMembershipDelete,
      emptySourceWorkspaceDelete,
    )
  } else {
    await userUpdate.execute()
    await membershipUpsert.execute()
    await targetMembershipGuardQuery.execute()
    await sourceMembershipDelete.execute()
    await emptySourceWorkspaceDelete.execute()
  }
  return input.targetWorkspaceId
}

export async function canAutoMoveUserWorkspace(
  db: Kysely<DB>,
  userId: string,
  options: { allowCurrentWorkspaceAdmin?: string } = {},
): Promise<boolean> {
  if (options.allowCurrentWorkspaceAdmin) {
    const workspace = await db
      .selectFrom('workspaces')
      .leftJoin(
        'workspace_domain_claims',
        'workspace_domain_claims.workspace_id',
        'workspaces.id',
      )
      .select(['workspaces.hd', 'workspace_domain_claims.domain'])
      .where('workspaces.id', '=', options.allowCurrentWorkspaceAdmin)
      .executeTakeFirst()
    if (workspace?.hd || workspace?.domain) return false
  }

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
    ])
    .where('id', '=', userId)
    .executeTakeFirst()

  return Boolean(
    row?.email_verified === 1 &&
    !row.has_admin &&
    !row.has_shareables &&
    !row.has_projects &&
    !row.has_comment_messages &&
    !row.has_comment_threads &&
    !row.has_api_tokens &&
    !row.has_cli_refresh_credentials,
  )
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
}

export async function listWorkspaceMigrationCandidates(
  db: Kysely<DB>,
): Promise<WorkspaceMigrationCandidate[]> {
  const rows = await sql<WorkspaceMigrationCandidate>`
    SELECT
      claims.domain AS domain,
      claims.workspace_id AS claimWorkspaceId,
      personal_ws.id AS personalWorkspaceId,
      users.id AS userId,
      users.email AS email,
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
      ) AS cliRefreshCredentialsCount
    FROM workspace_domain_claims AS claims
    INNER JOIN users
      ON lower(substr(users.email, instr(users.email, '@') + 1)) = claims.domain
    INNER JOIN workspaces AS personal_ws
      ON personal_ws.id = users.workspace_id
    WHERE users.workspace_id <> claims.workspace_id
      AND (
        shareablesCount > 0
        OR projectsCount > 0
        OR commentThreadsCount > 0
        OR commentMessagesCount > 0
        OR apiTokensCount > 0
        OR cliRefreshCredentialsCount > 0
      )
    ORDER BY claims.domain, users.email
  `.execute(db)

  return rows.rows.map((row) => ({
    ...row,
    shareablesCount: Number(row.shareablesCount),
    projectsCount: Number(row.projectsCount),
    commentThreadsCount: Number(row.commentThreadsCount),
    commentMessagesCount: Number(row.commentMessagesCount),
    apiTokensCount: Number(row.apiTokensCount),
    cliRefreshCredentialsCount: Number(row.cliRefreshCredentialsCount),
  }))
}

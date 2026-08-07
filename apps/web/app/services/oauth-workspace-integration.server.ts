import { nanoid } from 'nanoid'
import { sql, type Compilable, type Kysely } from 'kysely'
import {
  isPublicEmailDomain,
  normalizeEmailDomain,
} from '~/lib/workspace-domains'
import { nowIso } from '~/lib/datetime'
import { decodeBase64Url } from '~/lib/base64url'
import type { DB } from '~/types/db'

export type OAuthWorkspaceIntegrationSource = 'google_hd'

const UTF8_DECODER = new TextDecoder()

export interface OAuthWorkspaceIntegrationPlan {
  planId: string
  input: {
    domain: string
    email: string
    source: OAuthWorkspaceIntegrationSource
  }
  claim: {
    domain: string
    source: OAuthWorkspaceIntegrationSource
    workspaceId: string | null
    willCreate: boolean
  }
  sourceWorkspace: { id: string; name: string; plan: string } | null
  targetWorkspace: {
    id: string
    name: string
    plan: string
    willCreate: boolean
  } | null
  user: {
    id: string
    email: string
    sourceWorkspaceId: string
    targetWorkspaceId: string
    beforeWorkspaceId: string
    afterWorkspaceId: string
  } | null
  shareables: OAuthWorkspaceIntegrationShareable[]
  containers: OAuthWorkspaceIntegrationContainer[]
  projects: OAuthWorkspaceIntegrationProject[]
  artifactKeys: OAuthWorkspaceIntegrationArtifactKey[]
  cliRefreshCredentialCount: number
  storageBytes: number
  blockingResources: {
    projectCount: number
    commentCount: number
    apiTokenCount: number
    adminMembershipCount: number
  }
  requiredConfirmations: {
    shareables: Array<{
      id: string
      before: { workspaceId: string; visibility: string }
      after: { workspaceId: string; visibility: string }
    }>
    projects: OAuthWorkspaceIntegrationProjectConfirmation[]
    preserveCliRefreshCredentials: boolean
  }
  stopReasons: string[]
  executable: boolean
  fingerprint: string
}

export interface OAuthWorkspaceIntegrationShareable {
  id: string
  ownerUserId: string
  slug: string | null
  visibility: string
  before: { workspaceId: string; visibility: string }
  after: { workspaceId: string; visibility: string }
  containerId: string | null
  grants: Array<{ email: string; grantedAt: string; grantedBy: string }>
}

export interface OAuthWorkspaceIntegrationArtifactKey {
  id: string
  workspaceId: string
  ownerUserId: string
  containerId: string
  stableKey: string
  shareableId: string
}

export interface OAuthWorkspaceIntegrationContainer {
  id: string
  kind: 'inbox' | 'project'
  beforeWorkspaceId: string
  afterWorkspaceId: string
  shareableIds: string[]
}
export interface OAuthWorkspaceIntegrationProject {
  id: string
  name: string
  baseVisibility: string
  beforeWorkspaceId: string
  afterWorkspaceId: string
  memberDefaults: Array<{
    id: string
    email: string
    role: string
    displayName: string | null
  }>
  shareableIds: string[]
  beforeTeamAdminAudience: Array<{ userId: string; email: string }>
  afterTeamAdminAudience: Array<{ userId: string; email: string }>
}
export type OAuthWorkspaceIntegrationProjectConfirmation =
  OAuthWorkspaceIntegrationProject

export interface OAuthWorkspaceIntegrationApplyConfirmations {
  confirmShareables?: Array<{
    id: string
    before: string
    after: string
  }>
  confirmProjects?: Array<OAuthWorkspaceIntegrationProjectConfirmation>
  preserveCliRefreshCredentials?: boolean
  actorUserId?: string | null
}

export type OAuthWorkspaceIntegrationApplyResult =
  | { kind: 'applied'; planId: string; auditEventId: string }
  | { kind: 'already-applied'; planId: string; auditEventId: string }
  | { kind: 'blocked'; plan: OAuthWorkspaceIntegrationPlan; reasons: string[] }

type PlanBuildOptions = {
  planId?: string
  proposedTargetWorkspaceId?: string
}

type ExecutableQuery = {
  compile: () => unknown
  execute: () => Promise<unknown>
}

export type OAuthWorkspaceIntegrationBatch = (
  ...queries: ExecutableQuery[]
) => Promise<void>

type PlanSnapshot = {
  input: OAuthWorkspaceIntegrationPlan['input']
  claim: OAuthWorkspaceIntegrationPlan['claim']
  sourceWorkspace: OAuthWorkspaceIntegrationPlan['sourceWorkspace']
  targetWorkspace: OAuthWorkspaceIntegrationPlan['targetWorkspace']
  user: OAuthWorkspaceIntegrationPlan['user']
  shareables: OAuthWorkspaceIntegrationPlan['shareables']
  containers: OAuthWorkspaceIntegrationPlan['containers']
  projects: OAuthWorkspaceIntegrationPlan['projects']
  artifactKeys: OAuthWorkspaceIntegrationPlan['artifactKeys']
  cliRefreshCredentialCount: number
  storageBytes: number
  blockingResources: OAuthWorkspaceIntegrationPlan['blockingResources']
}

/**
 * Build a safe, read-only plan for moving one OAuth user to a domain claim.
 * A missing claim is represented by a proposed workspace id; this keeps a
 * dry-run free of writes while allowing apply to create the claim atomically.
 */
export function planOAuthWorkspaceIntegration(
  db: Kysely<DB>,
  input: {
    domain: string
    email: string
    source: OAuthWorkspaceIntegrationSource
  },
): Promise<OAuthWorkspaceIntegrationPlan> {
  return buildPlan(db, input, {})
}

export async function applyOAuthWorkspaceIntegration(
  db: Kysely<DB>,
  plan: OAuthWorkspaceIntegrationPlan,
  confirmations: OAuthWorkspaceIntegrationApplyConfirmations = {},
  options: { batch?: OAuthWorkspaceIntegrationBatch } = {},
): Promise<OAuthWorkspaceIntegrationApplyResult> {
  const auditEventId = `oauth-workspace-integration:${plan.planId}`
  const existingAudit = await db
    .selectFrom('audit_events')
    .select('id')
    .where('id', '=', auditEventId)
    .executeTakeFirst()
  if (existingAudit) {
    return {
      kind: 'already-applied',
      planId: plan.planId,
      auditEventId,
    }
  }

  const current = await buildPlan(db, plan.input, {
    planId: plan.planId,
    proposedTargetWorkspaceId: plan.targetWorkspace?.id,
  })
  const reasons = [...current.stopReasons]
  if (current.fingerprint !== plan.fingerprint) reasons.push('plan_changed')
  reasons.push(...missingConfirmationReasons(plan, confirmations))
  if (reasons.length > 0 || !current.executable) {
    return {
      kind: 'blocked',
      plan: current,
      reasons: unique(reasons.length > 0 ? reasons : ['plan_not_executable']),
    }
  }

  if (!current.user || !current.sourceWorkspace || !current.targetWorkspace) {
    return {
      kind: 'blocked',
      plan: current,
      reasons: ['plan_not_executable'],
    }
  }

  const now = nowIso()
  const target = current.targetWorkspace
  const targetWasCreated = target.willCreate
  const sourceWorkspaceId = current.sourceWorkspace.id
  const targetWorkspaceId = target.id
  const userId = current.user.id
  const claimGuard = sql<boolean>`EXISTS (
    SELECT 1
    FROM workspace_domain_claims
    WHERE domain = ${current.claim.domain}
      AND workspace_id = ${targetWorkspaceId}
  )`

  const queries: Array<Compilable<unknown> & ExecutableQuery> = []
  const shareableIdList = current.shareables.length
    ? sql.join(current.shareables.map((shareable) => sql`${shareable.id}`))
    : sql`NULL`
  const projectGuard = current.projects.length
    ? sql.join(
        current.projects.map(
          (project) => sql`NOT EXISTS (
            SELECT 1 FROM artifact_containers
            WHERE id = ${project.id}
              AND workspace_id = ${project.beforeWorkspaceId}
              AND kind = 'project'
              AND name = ${project.name}
              AND base_visibility = ${project.baseVisibility}
          )`,
        ),
        sql` OR `,
      )
    : sql`0`
  const containerGuard = current.containers.flatMap((container) => [
    sql`NOT EXISTS (
      SELECT 1 FROM artifact_containers
      WHERE id = ${container.id}
        AND workspace_id = ${container.beforeWorkspaceId}
        AND kind = ${container.kind}
    )`,
    sql`(SELECT COUNT(*) FROM shareables
      WHERE container_id = ${container.id}) != ${container.shareableIds.length}`,
    ...container.shareableIds.map(
      (shareableId) => sql`NOT EXISTS (
        SELECT 1 FROM shareables
        WHERE id = ${shareableId}
          AND container_id = ${container.id}
      )`,
    ),
  ])
  const shareableGuard = current.shareables.map(
    (shareable) => sql`NOT EXISTS (
      SELECT 1 FROM shareables
      WHERE id = ${shareable.id}
        AND workspace_id = ${shareable.before.workspaceId}
        AND owner_user_id = ${shareable.ownerUserId}
        AND slug IS ${shareable.slug}
        AND visibility = ${shareable.visibility}
        AND container_id IS ${shareable.containerId}
    )`,
  )
  const projectDefaultGuard = current.projects.flatMap((project) =>
    project.memberDefaults.map(
      (member) => sql`NOT EXISTS (
        SELECT 1 FROM project_share_defaults
        WHERE id = ${member.id}
          AND project_container_id = ${project.id}
          AND email = ${member.email}
          AND role = ${member.role}
          AND display_name IS ${member.displayName}
      )`,
    ),
  )
  const shareableGrantGuard = current.shareables.flatMap((shareable) =>
    shareable.grants.map(
      (grant) => sql`NOT EXISTS (
        SELECT 1 FROM shareable_grants
        WHERE shareable_id = ${shareable.id}
          AND granted_email = ${grant.email}
          AND granted_at = ${grant.grantedAt}
          AND granted_by = ${grant.grantedBy}
      )`,
    ),
  )
  const artifactKeyGuard = current.artifactKeys.map(
    (key) => sql`NOT EXISTS (
      SELECT 1 FROM artifact_keys
      WHERE id = ${key.id}
        AND workspace_id = ${key.workspaceId}
        AND owner_user_id = ${key.ownerUserId}
        AND container_id = ${key.containerId}
        AND stable_key = ${key.stableKey}
        AND shareable_id = ${key.shareableId}
    )`,
  )
  const expectedDefaultCount = current.projects.reduce(
    (count, project) => count + project.memberDefaults.length,
    0,
  )
  const expectedGrantCount = current.shareables.reduce(
    (count, shareable) => count + shareable.grants.length,
    0,
  )
  const expectedOwnedShareableCount = current.shareables.filter(
    (shareable) => shareable.ownerUserId === userId,
  ).length
  const expectedProjectShareableCount = current.projects.reduce(
    (count, project) => count + project.shareableIds.length,
    0,
  )
  const beforeTeamAdminAudience =
    current.projects[0]?.beforeTeamAdminAudience ?? []
  const afterTeamAdminAudience =
    current.projects[0]?.afterTeamAdminAudience ?? []
  const teamAdminAudienceGuard = (
    workspaceId: string,
    audience: Array<{ userId: string; email: string }>,
  ) =>
    audience.map(
      (admin) => sql`NOT EXISTS (
      SELECT 1 FROM workspace_members
      INNER JOIN users ON users.id = workspace_members.user_id
      WHERE workspace_members.workspace_id = ${workspaceId}
        AND workspace_members.user_id = ${admin.userId}
        AND workspace_members.status = 'active'
        AND workspace_members.role IN ('owner', 'admin')
        AND users.email = ${admin.email}
    )`,
    )
  const beforeTeamAdminGuard = teamAdminAudienceGuard(
    sourceWorkspaceId,
    beforeTeamAdminAudience,
  )
  const afterTeamAdminGuard = teamAdminAudienceGuard(
    targetWorkspaceId,
    afterTeamAdminAudience,
  )
  const resourceGuard = sql`
    INSERT INTO audit_events (
      id, workspace_id, action, subject_type, subject_id, created_at
    )
    SELECT
      ${`${auditEventId}:resource-guard`},
      ${sourceWorkspaceId},
      NULL,
      'user',
      ${userId},
      ${now}
    WHERE
      NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = ${userId}
          AND workspace_id = ${sourceWorkspaceId}
          AND email_verified = 1
      )
      OR NOT EXISTS (
        SELECT 1 FROM workspace_domain_claims
        WHERE domain = ${current.claim.domain}
          AND workspace_id = ${targetWorkspaceId}
      )
      OR ${projectGuard}
      OR (${containerGuard.length ? sql.join(containerGuard, sql` OR `) : sql`0`})
      OR (${shareableGuard.length ? sql.join(shareableGuard, sql` OR `) : sql`0`})
      OR (SELECT COUNT(*) FROM artifact_containers
          WHERE id IN (${current.projects.length ? sql.join(current.projects.map((project) => sql`${project.id}`)) : sql`NULL`})) != ${current.projects.length}
      OR (${projectDefaultGuard.length ? sql.join(projectDefaultGuard, sql` OR `) : sql`0`})
      OR (SELECT COUNT(*) FROM project_share_defaults
          WHERE project_container_id IN (${current.projects.length ? sql.join(current.projects.map((project) => sql`${project.id}`)) : sql`NULL`})) != ${expectedDefaultCount}
      OR (${shareableGrantGuard.length ? sql.join(shareableGrantGuard, sql` OR `) : sql`0`})
      OR (SELECT COUNT(*) FROM shareable_grants
          WHERE shareable_id IN (${shareableIdList})) != ${expectedGrantCount}
      OR (SELECT COUNT(*) FROM shareables
          WHERE workspace_id = ${sourceWorkspaceId}
            AND owner_user_id = ${userId}) != ${expectedOwnedShareableCount}
      OR (SELECT COUNT(*) FROM shareables
          WHERE container_id IN (${current.projects.length ? sql.join(current.projects.map((project) => sql`${project.id}`)) : sql`NULL`})) != ${expectedProjectShareableCount}
      OR (${artifactKeyGuard.length ? sql.join(artifactKeyGuard, sql` OR `) : sql`0`})
      OR (SELECT COUNT(*) FROM artifact_keys
          WHERE shareable_id IN (${shareableIdList})) != ${current.artifactKeys.length}
      OR (${beforeTeamAdminGuard.length ? sql.join(beforeTeamAdminGuard, sql` OR `) : sql`0`})
      OR (
        ${current.projects.length > 0 && current.sourceWorkspace?.plan === 'team' ? sql`(SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ${sourceWorkspaceId} AND status = 'active' AND role IN ('owner', 'admin')) != ${beforeTeamAdminAudience.length}` : sql`0`}
      )
      OR (${afterTeamAdminGuard.length ? sql.join(afterTeamAdminGuard, sql` OR `) : sql`0`})
      OR (
        ${current.projects.length > 0 && current.targetWorkspace?.plan === 'team' ? sql`(SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ${targetWorkspaceId} AND status = 'active' AND role IN ('owner', 'admin')) != ${afterTeamAdminAudience.length}` : sql`0`}
      )
      OR EXISTS (SELECT 1 FROM comment_threads WHERE created_by_id = ${userId})
      OR EXISTS (SELECT 1 FROM comment_messages WHERE created_by_id = ${userId})
      OR EXISTS (SELECT 1 FROM api_tokens WHERE user_id = ${userId})
      OR EXISTS (
        SELECT 1 FROM workspace_members
        WHERE user_id = ${userId}
          AND status = 'active'
          AND role IN ('owner', 'admin')
          AND workspace_id != ${sourceWorkspaceId}
      )
      OR EXISTS (
        SELECT 1 FROM workspace_members
        WHERE user_id = ${userId}
          AND workspace_id = ${targetWorkspaceId}
          AND (
            status = 'removed'
            OR (status = 'active' AND role != 'member')
          )
      )
      OR
      (SELECT COUNT(*) FROM shareables
       WHERE workspace_id = ${sourceWorkspaceId}
         AND id IN (${shareableIdList})) != ${current.shareables.length}
      OR COALESCE((
        SELECT SUM(versions.size_bytes)
        FROM versions
        INNER JOIN shareables ON shareables.id = versions.shareable_id
        WHERE shareables.id IN (${shareableIdList})
          AND shareables.workspace_id = ${sourceWorkspaceId}
      ), 0) != ${current.storageBytes}
  `
  if (targetWasCreated) {
    queries.push(
      db
        .insertInto('workspaces')
        .values({
          id: targetWorkspaceId,
          hd:
            current.claim.source === 'google_hd' ? current.claim.domain : null,
          ms_tenant_id: null,
          email_domain: current.claim.domain,
          name: target.name,
          created_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing()),
    )
  }
  queries.push(
    db
      .insertInto('workspace_domain_claims')
      .values({
        domain: current.claim.domain,
        workspace_id: targetWorkspaceId,
        source: current.claim.source,
        provider_tenant_id: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('domain').doNothing()),
  )
  queries.push({
    compile: () => resourceGuard.compile(db),
    execute: () => resourceGuard.execute(db),
  })

  const memberInsert = db
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
        .selectFrom('workspace_domain_claims')
        .where('domain', '=', current.claim.domain)
        .where('workspace_id', '=', targetWorkspaceId)
        .select([
          eb.val(targetWorkspaceId).as('workspace_id'),
          eb.val(userId).as('user_id'),
          eb.val(targetWasCreated ? 'owner' : 'member').as('role'),
          eb.val('active').as('status'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'user_id']).doUpdateSet({
        role: sql<'admin' | 'member' | 'owner'>`
          CASE WHEN role IN ('owner', 'admin') THEN role ELSE ${targetWasCreated ? 'owner' : 'member'} END
        `,
        status: 'active',
        removed_at: null,
        removed_by: null,
        updated_at: now,
      }),
    )
  queries.push(memberInsert)

  queries.push(
    db
      .updateTable('users')
      .set({ workspace_id: targetWorkspaceId })
      .where('id', '=', userId)
      .where('workspace_id', '=', sourceWorkspaceId)
      .where(claimGuard)
      .where('email_verified', '=', 1),
  )
  queries.push(
    db
      .updateTable('workspace_members')
      .set({
        status: 'removed',
        removed_at: now,
        removed_by: userId,
        pending_uploads: 0,
        updated_at: now,
      })
      .where('workspace_id', '=', sourceWorkspaceId)
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('users')
            .select('id')
            .where('id', '=', userId)
            .where('workspace_id', '=', targetWorkspaceId),
        ),
      ),
  )

  for (const container of current.containers) {
    queries.push(
      db
        .updateTable('artifact_containers')
        .set({ workspace_id: targetWorkspaceId, updated_at: now })
        .where('id', '=', container.id)
        .where('workspace_id', '=', sourceWorkspaceId)
        .where(claimGuard),
    )
  }
  for (const shareable of current.shareables) {
    queries.push(
      db
        .updateTable('shareables')
        .set({ workspace_id: targetWorkspaceId, updated_at: now })
        .where('id', '=', shareable.id)
        .where('workspace_id', '=', sourceWorkspaceId)
        .where(claimGuard),
    )
  }
  if (current.storageBytes > 0) {
    queries.push(
      db
        .updateTable('workspaces')
        .set({
          storage_used_bytes: sql<number>`max(0, storage_used_bytes - ${current.storageBytes})`,
          storage_updated_at: now,
        })
        .where('id', '=', sourceWorkspaceId)
        .where(claimGuard),
      db
        .updateTable('workspaces')
        .set({
          storage_used_bytes: sql<number>`storage_used_bytes + ${current.storageBytes}`,
          storage_updated_at: now,
        })
        .where('id', '=', targetWorkspaceId)
        .where(claimGuard),
    )
  }
  for (const key of current.artifactKeys) {
    queries.push(
      db
        .updateTable('artifact_keys')
        .set({ workspace_id: targetWorkspaceId, updated_at: now })
        .where('id', '=', key.id)
        .where('container_id', '=', key.containerId)
        .where('workspace_id', '=', sourceWorkspaceId)
        .where('owner_user_id', '=', key.ownerUserId)
        .where('shareable_id', '=', key.shareableId),
    )
  }

  const detail = JSON.stringify({
    plan_id: current.planId,
    source_workspace_id: sourceWorkspaceId,
    target_workspace_id: targetWorkspaceId,
    user_id: userId,
    shareables: current.shareables.map((shareable) => ({
      id: shareable.id,
      before: shareable.before,
      after: shareable.after,
    })),
    projects: current.projects,
    cli_refresh_credentials_count: current.cliRefreshCredentialCount,
  })
  queries.push(
    db
      .insertInto('audit_events')
      .columns([
        'id',
        'workspace_id',
        'actor_user_id',
        'action',
        'subject_type',
        'subject_id',
        'detail',
        'created_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('users')
          .where('users.id', '=', userId)
          .where('users.workspace_id', '=', targetWorkspaceId)
          .where(claimGuard)
          .select([
            eb.val(auditEventId).as('id'),
            eb.val(targetWorkspaceId).as('workspace_id'),
            eb.val(confirmations.actorUserId ?? null).as('actor_user_id'),
            eb.val('workspace.integration.apply').as('action'),
            eb.val('user').as('subject_type'),
            eb.val(userId).as('subject_id'),
            eb.val(detail).as('detail'),
            eb.val(now).as('created_at'),
          ]),
      )
      .onConflict((oc) => oc.column('id').doNothing()),
  )

  if (options.batch) {
    await options.batch(...queries)
  } else {
    for (const query of queries) await query.execute()
  }

  const audit = await db
    .selectFrom('audit_events')
    .select('id')
    .where('id', '=', auditEventId)
    .executeTakeFirst()
  if (!audit) {
    return {
      kind: 'blocked',
      plan: current,
      reasons: ['plan_changed_during_apply'],
    }
  }
  return { kind: 'applied', planId: current.planId, auditEventId }
}

async function buildPlan(
  db: Kysely<DB>,
  rawInput: {
    domain: string
    email: string
    source: OAuthWorkspaceIntegrationSource
  },
  options: PlanBuildOptions,
): Promise<OAuthWorkspaceIntegrationPlan> {
  const planId = options.planId ?? nanoid(16)
  const email = rawInput.email.trim().toLowerCase()
  const domain = normalizeEmailDomain(rawInput.domain)
  const emailDomain = normalizeEmailDomain(email)
  const input = {
    domain: domain ?? rawInput.domain.trim().toLowerCase(),
    email,
    source: rawInput.source,
  } as const
  const stopReasons: string[] = []

  if (!domain || !emailDomain || !email.includes('@')) {
    stopReasons.push('invalid_email_or_domain')
  }
  if (domain && isPublicEmailDomain(domain))
    stopReasons.push('public_email_domain')
  if (rawInput.source !== 'google_hd') stopReasons.push('untrusted_source')

  const claimRow = domain
    ? await db
        .selectFrom('workspace_domain_claims')
        .select(['domain', 'workspace_id', 'source'])
        .where('domain', '=', domain)
        .executeTakeFirst()
    : undefined
  if (claimRow && claimRow.source !== rawInput.source) {
    stopReasons.push('claim_source_mismatch')
  }

  const userRow = emailDomain
    ? await db
        .selectFrom('users')
        .select(['id', 'email', 'workspace_id', 'email_verified'])
        .where(sql<boolean>`lower(email) = ${email}`)
        .executeTakeFirst()
    : undefined
  if (!userRow) stopReasons.push('user_not_found')
  if (userRow && userRow.email_verified !== 1)
    stopReasons.push('email_not_verified')

  const googleAccount = userRow
    ? await db
        .selectFrom('accounts')
        .select('id_token')
        .where('user_id', '=', userRow.id)
        .where('provider_id', '=', 'google')
        .where('id_token', 'is not', null)
        .executeTakeFirst()
    : undefined
  const trustedGoogleClaim = decodeStoredGoogleClaim(googleAccount?.id_token)
  if (
    !trustedGoogleClaim ||
    trustedGoogleClaim.emailVerified !== true ||
    trustedGoogleClaim.email !== email ||
    trustedGoogleClaim.domain !== domain
  ) {
    stopReasons.push('google_hd_not_verified')
  }

  const sourceWorkspace = userRow
    ? await db
        .selectFrom('workspaces')
        .select(['id', 'name', 'plan'])
        .where('id', '=', userRow.workspace_id)
        .executeTakeFirst()
    : undefined
  if (userRow && !sourceWorkspace)
    stopReasons.push('source_workspace_not_found')

  const targetId =
    claimRow?.workspace_id ?? options.proposedTargetWorkspaceId ?? nanoid()
  const proposedTargetWorkspace =
    !claimRow && domain
      ? { id: targetId, name: domain, plan: 'free', willCreate: true }
      : undefined
  const existingTargetWorkspace = claimRow
    ? await db
        .selectFrom('workspaces')
        .select(['id', 'name', 'plan'])
        .where('id', '=', claimRow.workspace_id)
        .executeTakeFirst()
    : undefined
  const resolvedTargetWorkspace = existingTargetWorkspace
    ? { ...existingTargetWorkspace, willCreate: false }
    : proposedTargetWorkspace
  if (claimRow && !resolvedTargetWorkspace)
    stopReasons.push('claim_workspace_not_found')

  const ownedShareableRows = userRow
    ? await db
        .selectFrom('shareables')
        .select([
          'id',
          'slug',
          'workspace_id',
          'visibility',
          'container_id',
          'owner_user_id',
        ])
        .where('owner_user_id', '=', userRow.id)
        .where('workspace_id', '=', userRow.workspace_id)
        .orderBy('id')
        .execute()
    : []
  const projectRows = userRow
    ? await db
        .selectFrom('artifact_containers')
        .select(['id', 'name', 'workspace_id', 'base_visibility', 'kind'])
        .where('kind', '=', 'project')
        .where('workspace_id', '=', userRow.workspace_id)
        .where((eb) =>
          eb.or([
            eb('owner_user_id', '=', userRow.id),
            eb('created_by_id', '=', userRow.id),
          ]),
        )
        .orderBy('id')
        .execute()
    : []
  const projectIds = projectRows.map((row) => row.id)
  const projectShareableRows = projectIds.length
    ? await db
        .selectFrom('shareables')
        .select([
          'id',
          'slug',
          'workspace_id',
          'visibility',
          'container_id',
          'owner_user_id',
        ])
        .where('container_id', 'in', projectIds)
        .orderBy('id')
        .execute()
    : []
  const shareableRows = [
    ...ownedShareableRows,
    ...projectShareableRows.filter(
      (row) => !ownedShareableRows.some((owned) => owned.id === row.id),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id))
  if (shareableRows.some((row) => !row.container_id))
    stopReasons.push('shareable_container_missing')

  const containerIds = shareableRows
    .map((row) => row.container_id)
    .filter((id): id is string => Boolean(id))
  const referencedContainerRows =
    containerIds.length > 0
      ? await db
          .selectFrom('artifact_containers')
          .select(['id', 'workspace_id', 'kind'])
          .where('id', 'in', containerIds)
          .orderBy('id')
          .execute()
      : []
  const containerRows = [
    ...referencedContainerRows,
    ...projectRows.filter(
      (project) =>
        !referencedContainerRows.some(
          (container) => container.id === project.id,
        ),
    ),
  ].sort((left, right) => left.id.localeCompare(right.id))
  if (referencedContainerRows.length !== new Set(containerIds).size)
    stopReasons.push('container_not_found')
  if (containerRows.some((row) => row.workspace_id !== userRow?.workspace_id))
    stopReasons.push('container_workspace_mismatch')

  const containerShareableRows =
    containerIds.length > 0
      ? await db
          .selectFrom('shareables')
          .select(['id', 'owner_user_id', 'workspace_id', 'container_id'])
          .where('container_id', 'in', containerIds)
          .orderBy('id')
          .execute()
      : []
  const expectedShareableIds = new Set(shareableRows.map((row) => row.id))
  const containerHasUnexpectedShareable = containerShareableRows.some(
    (row) =>
      row.workspace_id !== userRow?.workspace_id ||
      !expectedShareableIds.has(row.id),
  )
  if (
    containerHasUnexpectedShareable ||
    containerShareableRows.length !== expectedShareableIds.size
  ) {
    stopReasons.push('container_shareable_mismatch')
  }
  const containerArtifactKeyRows =
    containerIds.length > 0
      ? await db
          .selectFrom('artifact_keys')
          .select([
            'id',
            'owner_user_id',
            'workspace_id',
            'container_id',
            'stable_key',
            'shareable_id',
          ])
          .where('container_id', 'in', containerIds)
          .orderBy('shareable_id')
          .execute()
      : []
  if (
    containerArtifactKeyRows.some(
      (row) =>
        row.workspace_id !== userRow?.workspace_id ||
        !expectedShareableIds.has(row.shareable_id),
    )
  ) {
    stopReasons.push('container_shareable_mismatch')
  }

  const grantRows =
    shareableRows.length > 0
      ? await db
          .selectFrom('shareable_grants')
          .select(['shareable_id', 'granted_email', 'granted_at', 'granted_by'])
          .where(
            'shareable_id',
            'in',
            shareableRows.map((row) => row.id),
          )
          .orderBy('shareable_id')
          .orderBy('granted_email')
          .execute()
      : []

  const grantsByShareable = new Map<
    string,
    Array<{ email: string; grantedAt: string; grantedBy: string }>
  >()
  for (const grant of grantRows) {
    const grants = grantsByShareable.get(grant.shareable_id) ?? []
    grants.push({
      email: grant.granted_email,
      grantedAt: grant.granted_at,
      grantedBy: grant.granted_by,
    })
    grantsByShareable.set(grant.shareable_id, grants)
  }
  const shareables = shareableRows.map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    slug: row.slug,
    visibility: row.visibility,
    before: { workspaceId: row.workspace_id, visibility: row.visibility },
    after: {
      workspaceId: resolvedTargetWorkspace?.id ?? targetId,
      visibility: row.visibility,
    },
    containerId: row.container_id,
    grants: grantsByShareable.get(row.id) ?? [],
  }))
  const artifactKeys = containerArtifactKeyRows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    containerId: row.container_id,
    stableKey: row.stable_key,
    shareableId: row.shareable_id,
  }))
  const shareableIdsByContainer = new Map<string, string[]>()
  for (const shareable of shareables) {
    if (!shareable.containerId) continue
    const ids = shareableIdsByContainer.get(shareable.containerId) ?? []
    ids.push(shareable.id)
    shareableIdsByContainer.set(shareable.containerId, ids)
  }
  const containers = containerRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    beforeWorkspaceId: row.workspace_id,
    afterWorkspaceId: resolvedTargetWorkspace?.id ?? targetId,
    shareableIds: shareableIdsByContainer.get(row.id) ?? [],
  }))

  const storageRow =
    shareableRows.length > 0
      ? await db
          .selectFrom('versions')
          .select(({ fn }) => fn.sum<number>('size_bytes').as('bytes'))
          .where(
            'shareable_id',
            'in',
            shareableRows.map((row) => row.id),
          )
          .executeTakeFirst()
      : undefined
  const storageBytes = Number(storageRow?.bytes ?? 0)

  const blockingResources = userRow
    ? await countBlockingResources(db, userRow.id, userRow.workspace_id)
    : {
        projectCount: 0,
        commentCount: 0,
        apiTokenCount: 0,
        adminMembershipCount: 0,
        sourceOrphanRiskCount: 0,
      }
  if (blockingResources.commentCount > 0)
    stopReasons.push('comment_data_present')
  if (blockingResources.apiTokenCount > 0) stopReasons.push('api_token_present')
  if (blockingResources.adminMembershipCount > 0)
    stopReasons.push('admin_or_owner_membership_present')
  if (blockingResources.sourceOrphanRiskCount > 0)
    stopReasons.push('source_workspace_would_be_ownerless')

  const credentialCount = userRow
    ? await db
        .selectFrom('cli_refresh_credentials')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('user_id', '=', userRow.id)
        .executeTakeFirst()
    : undefined
  const cliRefreshCredentialCount = Number(credentialCount?.count ?? 0)

  if (
    userRow &&
    resolvedTargetWorkspace &&
    userRow.workspace_id === resolvedTargetWorkspace.id
  )
    stopReasons.push('already_in_target_workspace')
  if (claimRow && resolvedTargetWorkspace && userRow) {
    const targetMembership = await db
      .selectFrom('workspace_members')
      .select(['role', 'status'])
      .where('workspace_id', '=', resolvedTargetWorkspace.id)
      .where('user_id', '=', userRow.id)
      .executeTakeFirst()
    if (targetMembership?.status === 'removed')
      stopReasons.push('target_membership_removed')
    if (
      targetMembership?.status === 'active' &&
      targetMembership.role !== 'member'
    )
      stopReasons.push('target_membership_role_conflict')
  }

  if (resolvedTargetWorkspace && userRow) {
    const targetInbox = await db
      .selectFrom('artifact_containers')
      .select('id')
      .where('workspace_id', '=', resolvedTargetWorkspace.id)
      .where('kind', '=', 'inbox')
      .where('owner_user_id', '=', userRow.id)
      .executeTakeFirst()
    if (
      targetInbox &&
      containers.some((container) => container.kind === 'inbox')
    )
      stopReasons.push('target_inbox_conflict')
  }

  const targetShareableSlugs = await findTargetSlugConflicts(
    db,
    resolvedTargetWorkspace?.id,
    shareables,
  )
  if (targetShareableSlugs.length > 0)
    stopReasons.push('target_shareable_slug_conflict')

  const requiredConfirmations = {
    shareables: shareables.map((shareable) => ({
      id: shareable.id,
      before: shareable.before,
      after: shareable.after,
    })),
    preserveCliRefreshCredentials: cliRefreshCredentialCount > 0,
    projects: [] as OAuthWorkspaceIntegrationProjectConfirmation[],
  }
  const loadTeamAdminAudience = (
    workspace: { id: string; plan: string } | undefined,
  ) => {
    if (!workspace || workspace.plan !== 'team') return []
    return db
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select(['users.id as userId', 'users.email'])
      .where('workspace_members.workspace_id', '=', workspace.id)
      .where('workspace_members.status', '=', 'active')
      .where('workspace_members.role', 'in', ['owner', 'admin'])
      .orderBy('users.id')
      .execute()
  }
  const [beforeTeamAdminAudience, afterTeamAdminAudience] = await Promise.all([
    loadTeamAdminAudience(sourceWorkspace),
    loadTeamAdminAudience(resolvedTargetWorkspace),
  ])
  const projectDefaultRows =
    projectIds.length > 0
      ? await db
          .selectFrom('project_share_defaults')
          .select([
            'id',
            'project_container_id',
            'email',
            'role',
            'display_name',
          ])
          .where('project_container_id', 'in', projectIds)
          .orderBy('project_container_id')
          .orderBy('id')
          .execute()
      : []
  const defaultsByProject = new Map<
    string,
    OAuthWorkspaceIntegrationProject['memberDefaults']
  >()
  for (const member of projectDefaultRows) {
    const defaults = defaultsByProject.get(member.project_container_id) ?? []
    defaults.push({
      id: member.id,
      email: member.email,
      role: member.role,
      displayName: member.display_name,
    })
    defaultsByProject.set(member.project_container_id, defaults)
  }
  const projects: OAuthWorkspaceIntegrationProject[] = []
  for (const project of projectRows) {
    projects.push({
      id: project.id,
      name: project.name,
      baseVisibility: project.base_visibility,
      beforeWorkspaceId: project.workspace_id,
      afterWorkspaceId: resolvedTargetWorkspace?.id ?? targetId,
      memberDefaults: defaultsByProject.get(project.id) ?? [],
      shareableIds: shareableIdsByContainer.get(project.id) ?? [],
      beforeTeamAdminAudience,
      afterTeamAdminAudience,
    })
  }
  requiredConfirmations.projects = projects

  const claim = {
    domain: domain ?? input.domain,
    source: rawInput.source,
    workspaceId: claimRow?.workspace_id ?? (domain ? targetId : null),
    willCreate: Boolean(domain && !claimRow),
  }
  const snapshot: PlanSnapshot = {
    input,
    claim,
    sourceWorkspace: sourceWorkspace ?? null,
    targetWorkspace: resolvedTargetWorkspace ?? null,
    user: userRow
      ? {
          id: userRow.id,
          email: userRow.email,
          sourceWorkspaceId: userRow.workspace_id,
          targetWorkspaceId: resolvedTargetWorkspace?.id ?? targetId,
          beforeWorkspaceId: userRow.workspace_id,
          afterWorkspaceId: resolvedTargetWorkspace?.id ?? targetId,
        }
      : null,
    shareables,
    containers,
    projects,
    artifactKeys,
    cliRefreshCredentialCount,
    storageBytes,
    blockingResources,
  }
  const executable = stopReasons.length === 0
  return {
    planId,
    ...snapshot,
    requiredConfirmations,
    stopReasons: unique(stopReasons),
    executable,
    fingerprint: JSON.stringify(snapshot),
  }
}

async function countBlockingResources(
  db: Kysely<DB>,
  userId: string,
  sourceWorkspaceId: string,
) {
  const [
    projects,
    commentThreads,
    commentMessages,
    apiTokens,
    admins,
    sourceOrphanRisk,
  ] = await Promise.all([
    db
      .selectFrom('artifact_containers')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('kind', '=', 'project')
      .where((eb) =>
        eb.or([
          eb('owner_user_id', '=', userId),
          eb('created_by_id', '=', userId),
        ]),
      )
      .executeTakeFirst(),
    db
      .selectFrom('comment_threads')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('created_by_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('comment_messages')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('created_by_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('api_tokens')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('workspace_members')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where('role', 'in', ['owner', 'admin'])
      .where('workspace_id', '!=', sourceWorkspaceId)
      .executeTakeFirst(),
    db
      .selectFrom('workspace_members')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('workspace_id', '=', sourceWorkspaceId)
      .where('user_id', '!=', userId)
      .where('status', '=', 'active')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('workspace_members as migrating_member')
            .select('migrating_member.user_id')
            .where('migrating_member.workspace_id', '=', sourceWorkspaceId)
            .where('migrating_member.user_id', '=', userId)
            .where('migrating_member.status', '=', 'active')
            .where('migrating_member.role', 'in', ['owner', 'admin']),
        ),
      )
      .executeTakeFirst(),
  ])
  return {
    projectCount: Number(projects?.count ?? 0),
    commentCount:
      Number(commentThreads?.count ?? 0) + Number(commentMessages?.count ?? 0),
    apiTokenCount: Number(apiTokens?.count ?? 0),
    adminMembershipCount: Number(admins?.count ?? 0),
    sourceOrphanRiskCount: Number(sourceOrphanRisk?.count ?? 0),
  }
}

function decodeStoredGoogleClaim(idToken: string | null | undefined): {
  email: string | null
  emailVerified: boolean
  domain: string | null
} | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1]
    if (!payload) return null
    const parsed = JSON.parse(
      UTF8_DECODER.decode(decodeBase64Url(payload)),
    ) as {
      email?: unknown
      email_verified?: unknown
      hd?: unknown
    }
    return {
      email:
        typeof parsed.email === 'string' ? parsed.email.toLowerCase() : null,
      emailVerified: parsed.email_verified === true,
      domain:
        typeof parsed.hd === 'string' ? normalizeEmailDomain(parsed.hd) : null,
    }
  } catch {
    return null
  }
}

async function findTargetSlugConflicts(
  db: Kysely<DB>,
  targetWorkspaceId: string | undefined,
  shareables: OAuthWorkspaceIntegrationShareable[],
): Promise<string[]> {
  if (!targetWorkspaceId) return []
  const slugs = shareables
    .map((shareable) => shareable.slug)
    .filter((slug): slug is string => Boolean(slug))
  if (slugs.length === 0) return []
  const rows = await db
    .selectFrom('shareables')
    .select('slug')
    .where('workspace_id', '=', targetWorkspaceId)
    .where('slug', 'in', slugs)
    .where('slug', 'is not', null)
    .execute()
  return rows
    .map((row) => row.slug)
    .filter((slug): slug is string => Boolean(slug))
}

function missingConfirmationReasons(
  plan: OAuthWorkspaceIntegrationPlan,
  confirmations: OAuthWorkspaceIntegrationApplyConfirmations,
): string[] {
  const duplicateShareables =
    (confirmations.confirmShareables ?? []).length !==
    new Set(
      (confirmations.confirmShareables ?? []).map(
        (confirmation) => confirmation.id,
      ),
    ).size
  const provided = new Map(
    (confirmations.confirmShareables ?? []).map((confirmation) => [
      confirmation.id,
      confirmation,
    ]),
  )
  const providedProjects = new Map(
    (confirmations.confirmProjects ?? []).map((project) => [
      project.id,
      project,
    ]),
  )
  const duplicateProjects =
    (confirmations.confirmProjects ?? []).length !== providedProjects.size
  const projectReasons = (plan.requiredConfirmations.projects ?? []).flatMap(
    (project) => {
      const confirmation = providedProjects.get(project.id)
      return !confirmation
        ? [`missing_project_confirmation:${project.id}`]
        : JSON.stringify(confirmation) !== JSON.stringify(project)
          ? [`project_confirmation_mismatch:${project.id}`]
          : []
    },
  )
  const expectedProjectIds = new Set(
    (plan.requiredConfirmations.projects ?? []).map((project) => project.id),
  )
  const unknownProjects: string[] = []
  for (const project of confirmations.confirmProjects ?? []) {
    if (!expectedProjectIds.has(project.id))
      unknownProjects.push(`unknown_project_confirmation:${project.id}`)
  }
  const expectedShareableConfirmationIds = new Set(
    plan.requiredConfirmations.shareables.map((shareable) => shareable.id),
  )
  const unknownShareables: string[] = []
  for (const confirmation of confirmations.confirmShareables ?? []) {
    if (!expectedShareableConfirmationIds.has(confirmation.id))
      unknownShareables.push(
        `unknown_shareable_confirmation:${confirmation.id}`,
      )
  }
  const missingShareables = plan.requiredConfirmations.shareables.filter(
    (shareable) => {
      const confirmation = provided.get(shareable.id)
      return (
        !confirmation ||
        confirmation.before !==
          `${shareable.before.workspaceId}:${shareable.before.visibility}` ||
        confirmation.after !==
          `${shareable.after.workspaceId}:${shareable.after.visibility}`
      )
    },
  )
  const reasons = [
    ...projectReasons,
    ...(duplicateProjects ? ['duplicate_project_confirmation'] : []),
    ...unknownProjects,
    ...(duplicateShareables ? ['duplicate_shareable_confirmation'] : []),
    ...unknownShareables,
    ...missingShareables.map(
      (shareable) => `missing_shareable_confirmation:${shareable.id}`,
    ),
  ]
  if (
    plan.requiredConfirmations.preserveCliRefreshCredentials &&
    confirmations.preserveCliRefreshCredentials !== true
  ) {
    reasons.push('missing_cli_credential_preservation_confirmation')
  }
  return reasons
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

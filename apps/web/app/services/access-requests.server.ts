import { nanoid } from 'nanoid'
import { sql, type Compilable, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import { MAX_GRANT_EMAILS, normalizeGrantEmail } from '~/lib/grant-emails'
import { nowIso } from '~/lib/datetime'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import { runD1Batch } from '~/lib/d1-batch.server'
import { isExternalPostingEnabledForWorkspace } from '~/lib/project-external-posting.server'
import { canEditProjectContainer } from './projects.server'
import { viewerDisplayCheck } from './access.server'

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected'
export type AccessRequestScope = 'artifact' | 'project'

export interface SentAccessRequest {
  id: string
  status: AccessRequestStatus
  createdAt: string
  updatedAt: string
}

export interface ReceivedAccessRequest {
  id: string
  requesterName: string | null
  requesterEmail: string
  shareableId: string
  shareableTitle: string
  projectId: string | null
  projectName: string | null
  canGrantArtifact: boolean
  canGrantProject: boolean
  createdAt: string
}

export interface AccessRequestApprover {
  userId: string
  email: string
  locale: string | null
}

interface RequestContext {
  requestId: string
  status: AccessRequestStatus
  handlerUserId: string | null
  resolvedByUserId: string | null
  shareableId: string
  workspaceId: string
  visibility: string
  ownerUserId: string
  ownerEmail: string
  ownerKind: 'human' | 'bot'
  containerId: string | null
  containerKind: 'inbox' | 'project' | null
  projectCreatorUserId: string | null
  containerArchivedAt: string | null
  projectName: string | null
  shareableTitle: string
  requesterUserId: string
  requesterName: string | null
  requesterEmail: string
  requesterEmailVerified: boolean
  createdAt: string
}

export async function createAccessRequest(
  db: Kysely<DB>,
  shareableId: string,
  user: SessionUser,
  attempt = 0,
): Promise<
  | {
      kind: 'created'
      requestId: string
      approverEmails: string[]
      approvers: AccessRequestApprover[]
      shareableTitle: string
      workspaceId: string
    }
  | { kind: 'pending'; requestId: string }
  | { kind: 'email-unverified' }
  | { kind: 'not-available' }
  | { kind: 'not-found' }
  | { kind: 'not-denied' }
> {
  if (!user.emailVerified) return { kind: 'email-unverified' }

  const target = await db
    .selectFrom('shareables as s')
    .innerJoin('users as owner', 'owner.id', 's.owner_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .select([
      's.id',
      's.workspace_id',
      's.owner_user_id',
      's.name',
      's.derived_title',
      's.title_override',
      's.visibility',
      'c.id as container_id',
      'c.kind as container_kind',
      'c.base_visibility as container_base_visibility',
      'c.created_by_id as container_created_by_id',
      'c.archived_at as container_archived_at',
      'c.name as container_name',
      'owner.email as owner_email',
      'owner.kind as owner_kind',
    ])
    .where('s.id', '=', shareableId)
    .executeTakeFirst()
  if (!target) return { kind: 'not-found' }

  const access = await viewerDisplayCheck(
    db,
    target.visibility,
    user.id,
    {
      id: target.id,
      name: target.name,
      mimeType: 'text/html',
      modifiedTime: null,
      ownerEmail: target.owner_email,
    },
    {
      shareableId: target.id,
      ownerUserId: target.owner_user_id,
      artifactWorkspaceId: target.workspace_id,
      viewerWorkspaceId: user.workspaceId,
      viewerEmail: user.email,
      viewerEmailVerified: user.emailVerified,
      containerId: target.container_id,
      containerKind: target.container_kind,
      containerBaseVisibility: target.container_base_visibility,
    },
  )
  if (access.kind !== 'access-denied') return { kind: 'not-denied' }

  const existing = await pendingRequestFor(db, shareableId, user.id)
  if (existing) return { kind: 'pending', requestId: existing.id }

  const id = nanoid()
  const now = nowIso()
  const requestContext: RequestContext = {
    requestId: id,
    status: 'pending',
    handlerUserId: null,
    resolvedByUserId: null,
    shareableId: target.id,
    workspaceId: target.workspace_id,
    visibility: target.visibility,
    ownerUserId: target.owner_user_id,
    ownerEmail: target.owner_email,
    ownerKind: target.owner_kind,
    containerId: target.container_id,
    containerKind: target.container_kind,
    projectCreatorUserId: target.container_created_by_id,
    containerArchivedAt: target.container_archived_at,
    projectName: target.container_name,
    shareableTitle:
      target.title_override ?? target.derived_title ?? target.name,
    requesterUserId: user.id,
    requesterName: user.name,
    requesterEmail: user.email,
    requesterEmailVerified: user.emailVerified,
    createdAt: now,
  }
  const handler = await resolveAccessRequestHandler(db, requestContext)
  if (!handler) return { kind: 'not-available' }

  try {
    const inserted = await db
      .insertInto('access_requests')
      .columns([
        'id',
        'shareable_id',
        'requester_user_id',
        'handler_user_id',
        'status',
        'resolved_by_user_id',
        'resolution_scope',
        'created_at',
        'updated_at',
        'resolved_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('shareables as s')
          .innerJoin('users as owner', 'owner.id', 's.owner_user_id')
          .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
          .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
          .select([
            eb.val(id).as('id'),
            eb.val(shareableId).as('shareable_id'),
            eb.val(user.id).as('requester_user_id'),
            eb.val(handler.userId).as('handler_user_id'),
            sql<AccessRequestStatus>`'pending'`.as('status'),
            sql<string | null>`NULL`.as('resolved_by_user_id'),
            sql<AccessRequestScope | null>`NULL`.as('resolution_scope'),
            eb.val(now).as('created_at'),
            eb.val(now).as('updated_at'),
            sql<string | null>`NULL`.as('resolved_at'),
          ])
          .where('s.id', '=', shareableId)
          .where(currentAccessRequestHandlerPredicate(handler.userId)),
      )
      .returning('id')
      .executeTakeFirst()
    if (!inserted) {
      const raced = await pendingRequestFor(db, shareableId, user.id)
      if (raced) return { kind: 'pending', requestId: raced.id }
      return attempt < 2
        ? await createAccessRequest(db, shareableId, user, attempt + 1)
        : { kind: 'not-available' }
    }
  } catch (error) {
    const raced = await pendingRequestFor(db, shareableId, user.id)
    if (raced) return { kind: 'pending', requestId: raced.id }
    throw error
  }

  return {
    kind: 'created',
    requestId: id,
    approverEmails: [handler.email],
    approvers: [handler],
    shareableTitle: requestContext.shareableTitle,
    workspaceId: target.workspace_id,
  }
}

export async function getRequesterAccessRequestStatus(
  db: Kysely<DB>,
  shareableId: string,
  requesterUserId: string,
): Promise<AccessRequestStatus | null> {
  const row = await db
    .selectFrom('access_requests')
    .select('status')
    .where('shareable_id', '=', shareableId)
    .where('requester_user_id', '=', requesterUserId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst()
  return row?.status ?? null
}

export async function listSentAccessRequests(
  db: Kysely<DB>,
  requesterUserId: string,
): Promise<SentAccessRequest[]> {
  const rows = await db
    .selectFrom('access_requests')
    .select(['id', 'status', 'created_at', 'updated_at'])
    .where('requester_user_id', '=', requesterUserId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(50)
    .execute()
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function countReceivedAccessRequests(
  db: Kysely<DB>,
  user: SessionUser,
): Promise<number> {
  const row = await receivedBaseQuery(db, user)
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

export async function listReceivedAccessRequests(
  db: Kysely<DB>,
  user: SessionUser,
): Promise<ReceivedAccessRequest[]> {
  const rows = await receivedBaseQuery(db, user)
    .select([
      'ar.id',
      'ar.created_at',
      'requester.name as requester_name',
      'requester.email as requester_email',
      's.id as shareable_id',
      's.name as shareable_name',
      's.derived_title',
      's.title_override',
      'c.id as project_id',
      'c.name as project_name',
    ])
    .orderBy('ar.created_at', 'asc')
    .orderBy('ar.id', 'asc')
    .limit(50)
    .execute()

  return await Promise.all(
    rows.map(async (row) => {
      const capabilities = await getAccessRequestCapabilities(db, row.id, user)
      return {
        id: row.id,
        requesterName: row.requester_name,
        requesterEmail: row.requester_email,
        shareableId: row.shareable_id,
        shareableTitle:
          row.title_override ?? row.derived_title ?? row.shareable_name,
        projectId: row.project_id,
        projectName: row.project_name,
        canGrantArtifact: capabilities.canGrantArtifact,
        canGrantProject: capabilities.canGrantProject,
        createdAt: row.created_at,
      }
    }),
  )
}

export async function processAccessRequest(
  db: Kysely<DB>,
  requestId: string,
  user: SessionUser,
  decision:
    | { kind: 'reject' }
    | {
        kind: 'approve'
        scope: AccessRequestScope
        expectedProjectId: string | null
      },
): Promise<
  | { kind: 'processed'; status: 'approved' | 'rejected' }
  | { kind: 'already-processed'; status: 'approved' | 'rejected' }
  | { kind: 'forbidden' }
  | { kind: 'email-unverified' }
  | { kind: 'location-changed' }
  | { kind: 'too-many-grants' }
> {
  const context = await loadRequestContext(db, requestId)
  if (!context) return { kind: 'forbidden' }
  if (context.status !== 'pending') {
    if (context.resolvedByUserId === user.id) {
      return { kind: 'already-processed', status: context.status }
    }
    const capabilities = await capabilitiesForContext(db, context, user)
    return capabilities.canGrantArtifact || capabilities.canGrantProject
      ? { kind: 'already-processed', status: context.status }
      : { kind: 'forbidden' }
  }
  const handler = await resolveAccessRequestHandler(db, context)
  if (handler?.userId !== user.id) return { kind: 'forbidden' }
  const capabilities = await capabilitiesForContext(db, context, user)
  if (!capabilities.canGrantArtifact && !capabilities.canGrantProject) {
    return { kind: 'forbidden' }
  }
  if (decision.kind === 'reject') {
    return await commitRejected(db, context, user)
  }
  if (!context.requesterEmailVerified) return { kind: 'email-unverified' }
  if (decision.scope === 'artifact' && !capabilities.canGrantArtifact) {
    return { kind: 'forbidden' }
  }
  if (decision.scope === 'project') {
    if (!capabilities.canGrantProject) {
      return { kind: 'forbidden' }
    }
    if (
      !decision.expectedProjectId ||
      context.containerId !== decision.expectedProjectId ||
      context.containerKind !== 'project'
    ) {
      return { kind: 'location-changed' }
    }
  }

  return await commitApproved(db, context, user, decision.scope)
}

async function pendingRequestFor(
  db: Kysely<DB>,
  shareableId: string,
  requesterUserId: string,
) {
  return await db
    .selectFrom('access_requests')
    .select('id')
    .where('shareable_id', '=', shareableId)
    .where('requester_user_id', '=', requesterUserId)
    .where('status', '=', 'pending')
    .executeTakeFirst()
}

function receivedBaseQuery(db: Kysely<DB>, user: SessionUser) {
  return db
    .selectFrom('access_requests as ar')
    .innerJoin('shareables as s', 's.id', 'ar.shareable_id')
    .innerJoin('users as owner', 'owner.id', 's.owner_user_id')
    .innerJoin('users as requester', 'requester.id', 'ar.requester_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
    .where('ar.status', '=', 'pending')
    .where(currentAccessRequestHandlerPredicate(user.id))
}

function currentAccessRequestHandlerPredicate(userId: string) {
  const verifiedHuman = (alias: string) =>
    sql<boolean>`${sql.ref(`${alias}.kind`)} = 'human' AND ${sql.ref(`${alias}.email_verified`)} = 1`
  return sql<boolean>`
    CASE
      WHEN owner.kind = 'human' AND owner.email_verified = 1
        THEN s.owner_user_id
      WHEN owner.kind = 'human'
        AND s.visibility = 'project'
        AND c.kind = 'project'
        AND c.archived_at IS NULL
        THEN coalesce(
          (
            SELECT workspace_owner.user_id
            FROM workspace_members workspace_owner
            JOIN users owner_user ON owner_user.id = workspace_owner.user_id
            WHERE workspace_owner.workspace_id = s.workspace_id
              AND workspace_owner.role = 'owner'
              AND workspace_owner.status = 'active'
              AND (
                w.plan = 'team'
                OR workspace_owner.user_id = c.created_by_id
              )
              AND ${verifiedHuman('owner_user')}
            LIMIT 1
          ),
          (
            SELECT workspace_admin.user_id
            FROM workspace_members workspace_admin
            JOIN users admin_user ON admin_user.id = workspace_admin.user_id
            WHERE workspace_admin.workspace_id = s.workspace_id
              AND workspace_admin.role = 'admin'
              AND workspace_admin.status = 'active'
              AND (
                w.plan = 'team'
                OR workspace_admin.user_id = c.created_by_id
              )
              AND ${verifiedHuman('admin_user')}
            ORDER BY workspace_admin.created_at, workspace_admin.user_id
            LIMIT 1
          )
        )
      WHEN owner.kind = 'bot'
        AND s.visibility = 'project'
        AND c.kind = 'project'
        AND c.archived_at IS NULL
        THEN coalesce(
          (
            SELECT creator.id
            FROM users creator
            JOIN workspace_members creator_member
              ON creator_member.workspace_id = s.workspace_id
             AND creator_member.user_id = creator.id
            WHERE creator.id = c.created_by_id
              AND creator_member.status = 'active'
              AND ${verifiedHuman('creator')}
            LIMIT 1
          ),
          (
            SELECT workspace_owner.user_id
            FROM workspace_members workspace_owner
            JOIN users owner_user ON owner_user.id = workspace_owner.user_id
            WHERE workspace_owner.workspace_id = s.workspace_id
              AND workspace_owner.role = 'owner'
              AND workspace_owner.status = 'active'
              AND w.plan = 'team'
              AND ${verifiedHuman('owner_user')}
            LIMIT 1
          ),
          (
            SELECT workspace_admin.user_id
            FROM workspace_members workspace_admin
            JOIN users admin_user ON admin_user.id = workspace_admin.user_id
            WHERE workspace_admin.workspace_id = s.workspace_id
              AND workspace_admin.role = 'admin'
              AND workspace_admin.status = 'active'
              AND w.plan = 'team'
              AND ${verifiedHuman('admin_user')}
            ORDER BY workspace_admin.created_at, workspace_admin.user_id
            LIMIT 1
          ),
          (
            SELECT manager_user.id
            FROM project_share_defaults manager_grant
            JOIN users manager_user
              ON ${lowerEmail('manager_user.email')} = ${lowerEmail('manager_grant.email')}
            WHERE manager_grant.project_container_id = c.id
              AND manager_grant.role = 'manager'
              AND w.plan <> 'free'
              AND w.external_posting_enabled = 1
              AND ${verifiedHuman('manager_user')}
            ORDER BY manager_grant.created_at, manager_grant.id
            LIMIT 1
          )
        )
      WHEN owner.kind = 'bot' AND c.kind = 'inbox'
        THEN coalesce(
          (
            SELECT workspace_owner.user_id
            FROM workspace_members workspace_owner
            JOIN users owner_user ON owner_user.id = workspace_owner.user_id
            WHERE workspace_owner.workspace_id = s.workspace_id
              AND workspace_owner.role = 'owner'
              AND workspace_owner.status = 'active'
              AND ${verifiedHuman('owner_user')}
            LIMIT 1
          ),
          (
            SELECT workspace_admin.user_id
            FROM workspace_members workspace_admin
            JOIN users admin_user ON admin_user.id = workspace_admin.user_id
            WHERE workspace_admin.workspace_id = s.workspace_id
              AND workspace_admin.role = 'admin'
              AND workspace_admin.status = 'active'
              AND ${verifiedHuman('admin_user')}
            ORDER BY workspace_admin.created_at, workspace_admin.user_id
            LIMIT 1
          )
        )
      ELSE NULL
    END = ${userId}
  `
}

async function loadRequestContext(
  db: Kysely<DB>,
  requestId: string,
): Promise<RequestContext | null> {
  const row = await db
    .selectFrom('access_requests as ar')
    .innerJoin('shareables as s', 's.id', 'ar.shareable_id')
    .innerJoin('users as owner', 'owner.id', 's.owner_user_id')
    .innerJoin('users as requester', 'requester.id', 'ar.requester_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .select([
      'ar.id as request_id',
      'ar.status',
      'ar.handler_user_id',
      'ar.resolved_by_user_id',
      'ar.created_at',
      's.id as shareable_id',
      's.workspace_id',
      's.visibility',
      's.owner_user_id',
      'owner.email as owner_email',
      's.name as shareable_name',
      's.derived_title',
      's.title_override',
      'owner.kind as owner_kind',
      'c.id as container_id',
      'c.kind as container_kind',
      'c.created_by_id as project_creator_user_id',
      'c.base_visibility as container_base_visibility',
      'c.archived_at as container_archived_at',
      'c.name as project_name',
      'requester.id as requester_user_id',
      'requester.name as requester_name',
      'requester.email as requester_email',
      'requester.email_verified as requester_email_verified',
    ])
    .where('ar.id', '=', requestId)
    .executeTakeFirst()
  if (!row) return null
  return {
    requestId: row.request_id,
    status: row.status,
    handlerUserId: row.handler_user_id,
    resolvedByUserId: row.resolved_by_user_id,
    shareableId: row.shareable_id,
    workspaceId: row.workspace_id,
    visibility: row.visibility,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    ownerKind: row.owner_kind,
    containerId: row.container_id,
    containerKind: row.container_kind,
    projectCreatorUserId: row.project_creator_user_id,
    containerArchivedAt: row.container_archived_at,
    projectName: row.project_name,
    shareableTitle:
      row.title_override ?? row.derived_title ?? row.shareable_name,
    requesterUserId: row.requester_user_id,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    requesterEmailVerified: row.requester_email_verified === 1,
    createdAt: row.created_at,
  }
}

export async function getAccessRequestCapabilities(
  db: Kysely<DB>,
  requestId: string,
  user: SessionUser,
): Promise<{ canGrantArtifact: boolean; canGrantProject: boolean }> {
  const context = await loadRequestContext(db, requestId)
  if (!context || context.status !== 'pending') {
    return { canGrantArtifact: false, canGrantProject: false }
  }
  return await capabilitiesForContext(db, context, user)
}

async function capabilitiesForContext(
  db: Kysely<DB>,
  context: RequestContext,
  user: SessionUser,
): Promise<{ canGrantArtifact: boolean; canGrantProject: boolean }> {
  const canGrantArtifact =
    (context.ownerKind === 'human' && context.ownerUserId === user.id) ||
    (context.ownerKind === 'bot' &&
      context.containerKind === 'inbox' &&
      (await isActiveWorkspaceAdmin(db, context.workspaceId, user.id)))

  let canGrantProject = false
  if (
    context.containerId &&
    context.containerKind === 'project' &&
    context.visibility === 'project' &&
    context.containerArchivedAt === null
  ) {
    const managerRoleEnabled = await isExternalPostingEnabledForWorkspace(
      db,
      context.workspaceId,
    )
    canGrantProject = await canEditProjectContainer(
      db,
      context.workspaceId,
      context.containerId,
      user,
      { managerRoleEnabled },
    )
  }
  return { canGrantArtifact, canGrantProject }
}

async function isActiveWorkspaceAdmin(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('role', 'in', ['owner', 'admin'])
    .where('status', '=', 'active')
    .executeTakeFirst()
  return Boolean(row)
}

async function resolveAccessRequestHandler(
  db: Kysely<DB>,
  context: RequestContext,
): Promise<AccessRequestApprover | null> {
  const candidates: NonNullable<Awaited<ReturnType<typeof userById>>>[] = []
  const candidateIds = new Set<string>()
  const addCandidate = (
    candidate:
      | NonNullable<Awaited<ReturnType<typeof userById>>>
      | null
      | undefined,
  ) => {
    if (!candidate || candidateIds.has(candidate.id)) return
    candidateIds.add(candidate.id)
    candidates.push(candidate)
  }

  if (context.ownerKind === 'human') {
    addCandidate(await userById(db, context.ownerUserId))
  }
  if (
    context.ownerKind === 'bot' &&
    context.containerKind === 'project' &&
    context.projectCreatorUserId
  ) {
    addCandidate(
      await activeWorkspaceUserById(
        db,
        context.workspaceId,
        context.projectCreatorUserId,
      ),
    )
  }
  for (const role of ['owner', 'admin'] as const) {
    const roleCandidates = await activeWorkspaceUsersByRole(
      db,
      context.workspaceId,
      role,
    )
    for (const candidate of roleCandidates) addCandidate(candidate)
  }
  if (
    context.ownerKind === 'bot' &&
    context.containerId &&
    context.containerKind === 'project'
  ) {
    const managers = await activeProjectManagerUsers(db, context.containerId)
    for (const manager of managers) addCandidate(manager)
  }

  for (const candidate of candidates) {
    const capabilities = await capabilitiesForContext(db, context, {
      id: candidate.id,
      email: candidate.email,
      emailVerified: true,
      name: candidate.name,
      image: candidate.image,
      workspaceId: candidate.workspace_id,
      hd: null,
      msTenantId: null,
      locale: null,
      kind: 'human',
    })
    if (capabilities.canGrantArtifact || capabilities.canGrantProject) {
      return {
        userId: candidate.id,
        email: normalizeGrantEmail(candidate.email),
        locale: candidate.locale,
      }
    }
  }
  return null
}

async function userById(db: Kysely<DB>, id: string) {
  return await db
    .selectFrom('users')
    .select(['id', 'email', 'workspace_id', 'name', 'image', 'locale'])
    .where('id', '=', id)
    .where('kind', '=', 'human')
    .where('email_verified', '=', 1)
    .executeTakeFirst()
}

async function activeWorkspaceUserById(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
) {
  return await db
    .selectFrom('workspace_members as member')
    .innerJoin('users as candidate', 'candidate.id', 'member.user_id')
    .select([
      'candidate.id',
      'candidate.email',
      'candidate.workspace_id',
      'candidate.name',
      'candidate.image',
      'candidate.locale',
    ])
    .where('member.workspace_id', '=', workspaceId)
    .where('member.user_id', '=', userId)
    .where('member.status', '=', 'active')
    .where('candidate.kind', '=', 'human')
    .where('candidate.email_verified', '=', 1)
    .executeTakeFirst()
}

async function activeWorkspaceUsersByRole(
  db: Kysely<DB>,
  workspaceId: string,
  role: 'owner' | 'admin',
) {
  return await db
    .selectFrom('workspace_members as member')
    .innerJoin('users as candidate', 'candidate.id', 'member.user_id')
    .select([
      'candidate.id',
      'candidate.email',
      'candidate.workspace_id',
      'candidate.name',
      'candidate.image',
      'candidate.locale',
    ])
    .where('member.workspace_id', '=', workspaceId)
    .where('member.role', '=', role)
    .where('member.status', '=', 'active')
    .where('candidate.kind', '=', 'human')
    .where('candidate.email_verified', '=', 1)
    .orderBy('member.created_at', 'asc')
    .orderBy('member.user_id', 'asc')
    .execute()
}

async function activeProjectManagerUsers(
  db: Kysely<DB>,
  projectContainerId: string,
) {
  return await db
    .selectFrom('project_share_defaults as manager')
    .innerJoin('users as candidate', (join) =>
      join.on(lowerEmail('candidate.email'), '=', lowerEmail('manager.email')),
    )
    .select([
      'candidate.id',
      'candidate.email',
      'candidate.workspace_id',
      'candidate.name',
      'candidate.image',
      'candidate.locale',
    ])
    .where('manager.project_container_id', '=', projectContainerId)
    .where('manager.role', '=', 'manager')
    .where('candidate.kind', '=', 'human')
    .where('candidate.email_verified', '=', 1)
    .orderBy('manager.created_at', 'asc')
    .orderBy('manager.id', 'asc')
    .execute()
}

async function commitRejected(
  db: Kysely<DB>,
  context: RequestContext,
  user: SessionUser,
) {
  const now = nowIso()
  const update = db
    .updateTable('access_requests')
    .set({
      status: 'rejected',
      handler_user_id: user.id,
      resolved_by_user_id: user.id,
      resolution_scope: null,
      resolved_at: now,
      updated_at: now,
    })
    .where('id', '=', context.requestId)
    .where('status', '=', 'pending')
    .where(({ exists }) =>
      exists(currentHandlerQuery(db, context.shareableId, user.id)),
    )
    .where(processingCapabilityPredicate(context, user))
  try {
    await runD1Batch(
      db,
      update,
      terminalGuard(db, context, user.id, now, 'rejected'),
    )
    return { kind: 'processed' as const, status: 'rejected' as const }
  } catch (error) {
    return await settledAfterRace(db, context, user, error, { kind: 'reject' })
  }
}

async function commitApproved(
  db: Kysely<DB>,
  context: RequestContext,
  user: SessionUser,
  scope: AccessRequestScope,
) {
  const now = nowIso()
  const email = normalizeGrantEmail(context.requesterEmail)
  const update = db
    .updateTable('access_requests')
    .set({
      status: 'approved',
      handler_user_id: user.id,
      resolved_by_user_id: user.id,
      resolution_scope: scope,
      resolved_at: now,
      updated_at: now,
    })
    .where('id', '=', context.requestId)
    .where('status', '=', 'pending')
    .where(({ exists }) =>
      exists(currentHandlerQuery(db, context.shareableId, user.id)),
    )
    .where(scopeCapabilityPredicate(context, user, scope))
    .where(grantCapacityPredicate(context, scope, email))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('users')
          .select('users.id')
          .where('users.id', '=', context.requesterUserId)
          .where('users.email_verified', '=', 1)
          .where(lowerEmail('users.email'), '=', email),
      ),
    )

  const grant: Compilable<unknown> =
    scope === 'artifact'
      ? db
          .insertInto('shareable_grants')
          .values({
            shareable_id: context.shareableId,
            granted_email: email,
            granted_at: now,
            granted_by: user.id,
          })
          .onConflict((oc) =>
            oc.columns(['shareable_id', 'granted_email']).doNothing(),
          )
      : db
          .insertInto('project_share_defaults')
          .values({
            id: nanoid(),
            project_container_id: context.containerId!,
            email,
            role: 'viewer',
            display_name: context.requesterName,
            created_by_id: user.id,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.columns(['project_container_id', 'email']).doNothing(),
          )

  try {
    await runD1Batch(
      db,
      update,
      grant,
      grantGuard(db, context, user.id, now, scope, email),
    )
    return { kind: 'processed' as const, status: 'approved' as const }
  } catch (error) {
    return await settledAfterRace(db, context, user, error, {
      kind: 'approve',
      scope,
    })
  }
}

function terminalGuard(
  db: Kysely<DB>,
  context: RequestContext,
  actorId: string,
  resolvedAt: string,
  status: 'approved' | 'rejected',
) {
  return db
    .insertInto('access_requests')
    .columns([
      'id',
      'shareable_id',
      'requester_user_id',
      'handler_user_id',
      'status',
      'resolved_by_user_id',
      'resolution_scope',
      'created_at',
      'updated_at',
      'resolved_at',
    ])
    .expression(() =>
      db
        .selectNoFrom([
          sql<string>`${context.requestId}`.as('id'),
          sql<string>`${context.shareableId}`.as('shareable_id'),
          sql<string>`${context.requesterUserId}`.as('requester_user_id'),
          sql<string | null>`${actorId}`.as('handler_user_id'),
          sql<AccessRequestStatus>`'pending'`.as('status'),
          sql<string | null>`NULL`.as('resolved_by_user_id'),
          sql<AccessRequestScope | null>`NULL`.as('resolution_scope'),
          sql<string>`${context.createdAt}`.as('created_at'),
          sql<string>`${resolvedAt}`.as('updated_at'),
          sql<string | null>`NULL`.as('resolved_at'),
        ])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('access_requests')
                .select('id')
                .where('id', '=', context.requestId)
                .where('status', '=', status)
                .where('resolved_by_user_id', '=', actorId)
                .where('resolved_at', '=', resolvedAt),
            ),
          ),
        ),
    )
}

function grantGuard(
  db: Kysely<DB>,
  context: RequestContext,
  actorId: string,
  resolvedAt: string,
  scope: AccessRequestScope,
  email: string,
) {
  const grantExists =
    scope === 'artifact'
      ? sql<boolean>`EXISTS (
          SELECT 1 FROM shareable_grants
          WHERE shareable_id = ${context.shareableId}
            AND ${lowerEmail('granted_email')} = ${email}
        )`
      : sql<boolean>`EXISTS (
          SELECT 1 FROM project_share_defaults
          WHERE project_container_id = ${context.containerId}
            AND ${lowerEmail('email')} = ${email}
        )`
  return db
    .insertInto('access_requests')
    .columns([
      'id',
      'shareable_id',
      'requester_user_id',
      'handler_user_id',
      'status',
      'resolved_by_user_id',
      'resolution_scope',
      'created_at',
      'updated_at',
      'resolved_at',
    ])
    .expression(() =>
      db
        .selectNoFrom([
          sql<string>`${context.requestId}`.as('id'),
          sql<string>`${context.shareableId}`.as('shareable_id'),
          sql<string>`${context.requesterUserId}`.as('requester_user_id'),
          sql<string | null>`${actorId}`.as('handler_user_id'),
          sql<AccessRequestStatus>`'pending'`.as('status'),
          sql<string | null>`NULL`.as('resolved_by_user_id'),
          sql<AccessRequestScope | null>`NULL`.as('resolution_scope'),
          sql<string>`${context.createdAt}`.as('created_at'),
          sql<string>`${resolvedAt}`.as('updated_at'),
          sql<string | null>`NULL`.as('resolved_at'),
        ])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('access_requests')
                .select('id')
                .where('id', '=', context.requestId)
                .where('status', '=', 'approved')
                .where('resolution_scope', '=', scope)
                .where('resolved_by_user_id', '=', actorId)
                .where('resolved_at', '=', resolvedAt)
                .where(grantExists),
            ),
          ),
        ),
    )
}

function processingCapabilityPredicate(
  context: RequestContext,
  user: SessionUser,
) {
  return sql<boolean>`(
    ${scopeCapabilityPredicate(context, user, 'artifact')}
    OR ${scopeCapabilityPredicate(context, user, 'project')}
  )`
}

function currentHandlerQuery(
  db: Kysely<DB>,
  shareableId: string,
  userId: string,
) {
  return db
    .selectFrom('shareables as s')
    .innerJoin('users as owner', 'owner.id', 's.owner_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .innerJoin('workspaces as w', 'w.id', 's.workspace_id')
    .select('s.id')
    .where('s.id', '=', shareableId)
    .where(currentAccessRequestHandlerPredicate(userId))
}

function scopeCapabilityPredicate(
  context: RequestContext,
  user: SessionUser,
  scope: AccessRequestScope,
) {
  if (scope === 'artifact') {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM shareables current_shareable
      INNER JOIN users current_owner
        ON current_owner.id = current_shareable.owner_user_id
      LEFT JOIN artifact_containers current_container
        ON current_container.id = current_shareable.container_id
      WHERE current_shareable.id = ${context.shareableId}
        AND (
          (
            current_owner.kind = 'human'
            AND current_shareable.owner_user_id = ${user.id}
          )
          OR (
            current_owner.kind = 'bot'
            AND current_container.kind = 'inbox'
            AND EXISTS (
              SELECT 1 FROM workspace_members current_admin
              WHERE current_admin.workspace_id = current_shareable.workspace_id
                AND current_admin.user_id = ${user.id}
                AND current_admin.role IN ('owner', 'admin')
                AND current_admin.status = 'active'
            )
          )
        )
    )`
  }

  const managerEmail = user.emailVerified
    ? normalizeGrantEmail(user.email)
    : null
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM shareables current_shareable
    INNER JOIN artifact_containers current_project
      ON current_project.id = current_shareable.container_id
    INNER JOIN workspaces current_workspace
      ON current_workspace.id = current_project.workspace_id
    WHERE current_shareable.id = ${context.shareableId}
      AND current_project.id = ${context.containerId}
      AND current_shareable.visibility = 'project'
      AND current_project.kind = 'project'
      AND current_project.archived_at IS NULL
      AND (
        current_project.created_by_id = ${user.id}
        OR EXISTS (
          SELECT 1 FROM workspace_members current_project_admin
          WHERE current_project_admin.workspace_id = current_project.workspace_id
            AND current_project_admin.user_id = ${user.id}
            AND current_project_admin.role IN ('owner', 'admin')
            AND current_project_admin.status = 'active'
            AND current_workspace.plan = 'team'
        )
        OR (
          current_workspace.plan <> 'free'
          AND current_workspace.external_posting_enabled = 1
          AND ${managerEmail} IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM project_share_defaults current_manager
            WHERE current_manager.project_container_id = current_project.id
              AND current_manager.role = 'manager'
              AND ${lowerEmail('current_manager.email')} = ${managerEmail}
          )
        )
      )
  )`
}

function grantCapacityPredicate(
  context: RequestContext,
  scope: AccessRequestScope,
  email: string,
) {
  return scope === 'artifact'
    ? sql<boolean>`(
        EXISTS (
          SELECT 1 FROM shareable_grants capacity_existing
          WHERE capacity_existing.shareable_id = ${context.shareableId}
            AND ${lowerEmail('capacity_existing.granted_email')} = ${email}
        )
        OR (
          SELECT COUNT(DISTINCT ${lowerEmail('capacity_count.granted_email')})
          FROM shareable_grants capacity_count
          WHERE capacity_count.shareable_id = ${context.shareableId}
            AND ${lowerEmail('capacity_count.granted_email')} <> COALESCE((
              SELECT ${lowerEmail('capacity_owner.email')}
              FROM shareables capacity_shareable
              INNER JOIN users capacity_owner
                ON capacity_owner.id = capacity_shareable.owner_user_id
              WHERE capacity_shareable.id = ${context.shareableId}
            ), '')
        ) < ${MAX_GRANT_EMAILS}
      )`
    : sql<boolean>`(
        EXISTS (
          SELECT 1 FROM project_share_defaults capacity_existing
          WHERE capacity_existing.project_container_id = ${context.containerId}
            AND ${lowerEmail('capacity_existing.email')} = ${email}
        )
        OR (
          SELECT COUNT(DISTINCT ${lowerEmail('capacity_count.email')})
          FROM project_share_defaults capacity_count
          WHERE capacity_count.project_container_id = ${context.containerId}
        ) < ${MAX_GRANT_EMAILS}
      )`
}

async function settledAfterRace(
  db: Kysely<DB>,
  original: RequestContext,
  user: SessionUser,
  error: unknown,
  decision: { kind: 'reject' } | { kind: 'approve'; scope: AccessRequestScope },
) {
  const current = await loadRequestContext(db, original.requestId)
  if (!current) return { kind: 'forbidden' as const }
  if (current.status === 'approved' || current.status === 'rejected') {
    return { kind: 'already-processed' as const, status: current.status }
  }
  const handler = await resolveAccessRequestHandler(db, current)
  if (handler?.userId !== user.id) return { kind: 'forbidden' as const }
  const capabilities = await capabilitiesForContext(db, current, user)
  if (decision.kind === 'reject') {
    if (!capabilities.canGrantArtifact && !capabilities.canGrantProject) {
      return { kind: 'forbidden' as const }
    }
    throw error
  }
  if (!current.requesterEmailVerified) {
    return { kind: 'email-unverified' as const }
  }
  if (
    decision.scope === 'project' &&
    (current.containerId !== original.containerId ||
      current.containerKind !== 'project')
  ) {
    return { kind: 'location-changed' as const }
  }
  if (
    (decision.scope === 'artifact' && !capabilities.canGrantArtifact) ||
    (decision.scope === 'project' && !capabilities.canGrantProject)
  ) {
    return { kind: 'forbidden' as const }
  }
  if (
    !(await hasGrantCapacity(
      db,
      current,
      decision.scope,
      normalizeGrantEmail(current.requesterEmail),
    ))
  ) {
    return { kind: 'too-many-grants' as const }
  }
  throw error
}

async function hasGrantCapacity(
  db: Kysely<DB>,
  context: RequestContext,
  scope: AccessRequestScope,
  email: string,
): Promise<boolean> {
  const rows =
    scope === 'artifact'
      ? await db
          .selectFrom('shareable_grants')
          .select('granted_email as email')
          .where('shareable_id', '=', context.shareableId)
          .execute()
      : await db
          .selectFrom('project_share_defaults')
          .select('email')
          .where('project_container_id', '=', context.containerId!)
          .execute()
  const ownerEmail = normalizeGrantEmail(context.ownerEmail)
  const emails = new Set<string>()
  for (const row of rows) {
    const candidate = normalizeGrantEmail(row.email)
    if (scope === 'artifact' && candidate === ownerEmail) continue
    emails.add(candidate)
  }
  return emails.has(email) || emails.size < MAX_GRANT_EMAILS
}

import {
  expressionBuilder,
  sql,
  type Compilable,
  type Expression,
  type Kysely,
  type SqlBool,
} from 'kysely'
import { nanoid } from 'nanoid'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-plan.server'
import { isVisibility } from '~/lib/shareable-types'
import { parsePageParam } from '~/lib/pagination'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { isSqliteConstraintError } from '~/lib/d1-errors.server'
import {
  MEMBERS_PAGE_SIZE,
  AUDIT_EVENTS_PAGE_SIZE,
  INVENTORY_PAGE_SIZE,
  WORKSPACE_NAME_MAX_LENGTH,
  type MembersPageFilters,
  type MembersPageResult,
  type AuditEventsPageResult,
  type SettingsShellData,
  type TeamContributor,
  type TeamMember,
  type RemovedTeamMember,
  type TeamMutationResult,
  type TeamWorkspace,
  type WorkspaceMemberRole,
  type InventoryArtifactsFilters,
  type InventoryProjectEntry,
  type InventoryArtifactEntry,
} from '~/lib/team-management'
import { INBOX_CONTAINER_NAME } from '~/services/projects.server'
import { workspaceAdminQuery } from '~/services/access.server'
import { revokeAllCliRefreshCredentialFamiliesForMember as revokeMemberCliFamilies } from '~/services/cli-refresh-credentials.server'
import type { DB } from '~/types/db'

export { WORKSPACE_NAME_MAX_LENGTH } from '~/lib/team-management'
export type {
  TeamContributor,
  TeamMember,
  RemovedTeamMember,
  TeamMutationResult,
  TeamWorkspace,
  WorkspaceMemberRole,
  InventoryArtifactsFilters,
  InventoryProjectEntry,
  InventoryArtifactEntry,
} from '~/lib/team-management'

export async function revokeWorkspaceMemberCliSessions(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized
  return { kind: await revokeMemberCliFamilies(db, actor, targetUserId) }
}

const PERSONAL_WORKSPACE_DEFAULTS = {
  plan: 'free',
  self_upload_enabled: 1,
  storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
} as const

export async function loadSettingsShell(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
): Promise<SettingsShellData> {
  const [workspace, currentMembership] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select([
        'id',
        'name',
        'hd',
        'plan',
        'storage_used_bytes',
        'storage_quota_bytes',
      ])
      .where('id', '=', user.workspaceId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', user.workspaceId)
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  ])

  const currentUserRole = (currentMembership?.role ??
    'member') as WorkspaceMemberRole

  return {
    kind: workspace.plan === 'team' ? 'team' : 'upgrade',
    workspace: {
      id: workspace.id,
      name: workspace.name,
      hd: workspace.hd,
      plan: workspace.plan,
      storageUsedBytes: workspace.storage_used_bytes,
      storageQuotaBytes: workspace.storage_quota_bytes,
    },
    currentUserIsAdmin: currentUserRole !== 'member',
    currentUserRole,
  }
}

export function parseMembersPageFilters(
  searchParams: URLSearchParams,
): MembersPageFilters {
  const role = searchParams.get('role')
  const activity = searchParams.get('activity')
  return {
    query: searchParams.get('q')?.trim() ?? '',
    role:
      role === 'owner' || role === 'admin' || role === 'member' ? role : 'all',
    activity:
      activity === 'active' || activity === 'inactive' ? activity : 'all',
    page: parsePageParam(searchParams),
  }
}

export function parseInventoryArtifactsFilters(
  searchParams: URLSearchParams,
): InventoryArtifactsFilters {
  const visibility = searchParams.get('visibility')
  const sort = searchParams.get('sort')
  return {
    visibility: isVisibility(visibility) ? visibility : 'all',
    sort: sort === 'size' ? 'size' : 'updated',
    page: parsePageParam(searchParams),
  }
}

export async function loadWorkspaceInventoryProjectsPage(
  db: Kysely<DB>,
  workspaceId: string,
  requestedPage: number,
): Promise<{ projects: InventoryProjectEntry[]; total: number; page: number }> {
  const base = db
    .selectFrom('artifact_containers as c')
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
  const countRow = await base
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  const total = Number(countRow.count)
  if (!total) return { projects: [], total: 0, page: 1 }
  const pageCount = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE))
  const page = Math.min(
    Number.isFinite(requestedPage) && requestedPage >= 1 ? requestedPage : 1,
    pageCount,
  )
  const rows = await base
    .select([
      'c.id',
      'c.name',
      'c.archived_at',
      'c.base_visibility',
      'c.updated_at',
      sql<number>`(SELECT COUNT(DISTINCT s.id) FROM shareables s WHERE s.container_id = c.id AND s.workspace_id = c.workspace_id)`.as(
        'artifact_count',
      ),
      sql<
        number | null
      >`(SELECT SUM(v.size_bytes) FROM shareables s JOIN versions v ON v.shareable_id = s.id AND v.status = 'published' WHERE s.container_id = c.id AND s.workspace_id = c.workspace_id)`.as(
        'size_bytes',
      ),
    ])
    .orderBy(sql`COALESCE(size_bytes, 0)`, 'desc')
    .orderBy('c.id', 'asc')
    .limit(INVENTORY_PAGE_SIZE)
    .offset((page - 1) * INVENTORY_PAGE_SIZE)
    .execute()
  return {
    total,
    page,
    projects: rows.map((row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archived_at,
      baseVisibility: row.base_visibility,
      artifactCount: Number(row.artifact_count),
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      updatedAt: row.updated_at,
    })),
  }
}

export async function loadWorkspaceInventoryArtifactsPage(
  db: Kysely<DB>,
  workspaceId: string,
  filters: InventoryArtifactsFilters,
): Promise<{
  artifacts: InventoryArtifactEntry[]
  total: number
  page: number
}> {
  const base = db
    .selectFrom('shareables as s')
    .innerJoin('users as u', 'u.id', 's.owner_user_id')
    .innerJoin('artifact_containers as c', (join) =>
      join
        .onRef('c.id', '=', 's.container_id')
        .on('c.workspace_id', '=', workspaceId),
    )
    .where('s.workspace_id', '=', workspaceId)
  const filtered =
    filters.visibility === 'all'
      ? base
      : base.where('s.visibility', '=', filters.visibility)
  const countRow = await filtered
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  const total = Number(countRow.count)
  if (!total) return { artifacts: [], total: 0, page: 1 }
  const pageCount = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE))
  const page = Math.min(filters.page, pageCount)
  const rows = await filtered
    .select([
      's.id',
      sql<string>`coalesce(s.title_override, s.derived_title, s.name)`.as(
        'name',
      ),
      'u.name as owner_name',
      'u.email as owner_email',
      'c.kind as location_kind',
      'c.name as location_name',
      's.visibility',
      's.updated_at',
      sql<
        number | null
      >`(SELECT SUM(v.size_bytes) FROM versions v WHERE v.shareable_id = s.id AND v.status = 'published')`.as(
        'size_bytes',
      ),
    ])
    .orderBy(
      filters.sort === 'size' ? sql`COALESCE(size_bytes, 0)` : 's.updated_at',
      'desc',
    )
    .orderBy('s.id', 'asc')
    .limit(INVENTORY_PAGE_SIZE)
    .offset((page - 1) * INVENTORY_PAGE_SIZE)
    .execute()
  return {
    total,
    page,
    artifacts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      owner: { name: row.owner_name, email: row.owner_email },
      location: { kind: row.location_kind, name: row.location_name },
      visibility: row.visibility,
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      updatedAt: row.updated_at,
    })),
  }
}

export interface MembersPageData {
  membersPage: MembersPageResult
  removedMembers: RemovedTeamMember[]
  currentUserRole: WorkspaceMemberRole
  currentUserIsAdmin: boolean
}

export async function loadMembersPageData(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  filters: MembersPageFilters,
): Promise<MembersPageData> {
  const adminId = await ensureWorkspaceAdmin(db, user.workspaceId, nowIso())
  const [membersPage, currentMembership] = await Promise.all([
    loadWorkspaceMembersPage(db, user.workspaceId, adminId, filters),
    db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', user.workspaceId)
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  ])
  const currentUserRole = (currentMembership?.role ??
    'member') as WorkspaceMemberRole
  const currentUserIsAdmin = currentUserRole !== 'member'
  const removedMembers = currentUserIsAdmin
    ? await loadRemovedWorkspaceMembers(db, user.workspaceId)
    : []

  return {
    membersPage,
    removedMembers,
    currentUserRole,
    currentUserIsAdmin,
  }
}

export async function loadWorkspaceOwner(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<TeamMember> {
  const ownerId = await ensureWorkspaceAdmin(db, workspaceId, nowIso())
  return db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['users.id', 'users.email', 'users.name', 'users.image'])
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', ownerId)
    .where('workspace_members.role', '=', 'owner')
    .where('workspace_members.status', '=', 'active')
    .executeTakeFirstOrThrow()
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// SQLite の lower() は ASCII のみ折り畳む。非 ASCII の大文字小文字は一致しない。
function nameOrEmailCondition(query: string): Expression<SqlBool> {
  const eb = expressionBuilder<DB, 'users'>()
  const pattern = `%${escapeLikePattern(query.toLowerCase())}%`
  return eb.or([
    eb(
      sql<string>`lower(users.email)`,
      'like',
      sql<string>`${pattern} ESCAPE '\\'`,
    ),
    eb(
      sql<string>`lower(coalesce(users.name, ''))`,
      'like',
      sql<string>`${pattern} ESCAPE '\\'`,
    ),
  ])
}

function memberFilterConditions(
  filters: Pick<MembersPageFilters, 'query' | 'role' | 'activity'>,
): Expression<SqlBool>[] {
  const eb = expressionBuilder<DB, 'workspace_members' | 'users'>()
  const conditions: Expression<SqlBool>[] = []
  if (filters.query) {
    conditions.push(nameOrEmailCondition(filters.query))
  }
  if (filters.role !== 'all') {
    conditions.push(eb('workspace_members.role', '=', filters.role))
  }
  if (filters.activity === 'active') {
    conditions.push(
      eb.or([
        eb('workspace_members.first_contributed_at', 'is not', null),
        eb('workspace_members.pending_uploads', '>', 0),
      ]),
    )
  }
  if (filters.activity === 'inactive') {
    conditions.push(
      eb.and([
        eb('workspace_members.first_contributed_at', 'is', null),
        eb('workspace_members.pending_uploads', '=', 0),
      ]),
    )
  }
  return conditions
}

export async function loadWorkspaceMembersPage(
  db: Kysely<DB>,
  workspaceId: string,
  adminUserId: string,
  filters: MembersPageFilters,
): Promise<MembersPageResult> {
  const base = db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('users.workspace_id', '=', workspaceId)
    .where('workspace_members.status', '!=', 'removed')
    .where((eb) => eb.and(memberFilterConditions(filters)))

  const totalRow = await base
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  const total = Number(totalRow.count)
  if (total === 0) return { members: [], total: 0, page: 1 }
  const pageCount = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE))
  const page = Math.min(filters.page, pageCount)

  const rows = await base
    .select([
      'users.id',
      'users.email',
      'users.name',
      'users.image',
      'workspace_members.first_contributed_at',
      'workspace_members.last_contributed_at',
      'workspace_members.pending_uploads',
      'workspace_members.role',
    ])
    .orderBy('workspace_members.last_contributed_at', 'desc')
    .orderBy('users.email', 'asc')
    .limit(MEMBERS_PAGE_SIZE)
    .offset((page - 1) * MEMBERS_PAGE_SIZE)
    .execute()

  return {
    members: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      image: row.image,
      firstContributedAt: row.first_contributed_at,
      lastContributedAt: row.last_contributed_at,
      pendingUploads: row.pending_uploads,
      isAdmin: row.id === adminUserId,
      role: row.role as WorkspaceMemberRole,
    })),
    total,
    page,
  }
}

export async function loadAuditEventsPage(
  db: Kysely<DB>,
  workspaceId: string,
  requestedPage: number,
): Promise<AuditEventsPageResult> {
  const base = db
    .selectFrom('audit_events')
    .leftJoin('users as actor', 'actor.id', 'audit_events.actor_user_id')
    .leftJoin('users as subject', (join) =>
      join
        .onRef('subject.id', '=', 'audit_events.subject_id')
        .on('audit_events.subject_type', '=', 'user'),
    )
    .where('audit_events.workspace_id', '=', workspaceId)
  const totalRow = await base
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow()
  const total = Number(totalRow.count)
  if (total === 0) return { events: [], total: 0, page: 1 }
  const pageCount = Math.max(1, Math.ceil(total / AUDIT_EVENTS_PAGE_SIZE))
  const page = Math.min(
    Number.isFinite(requestedPage) && requestedPage >= 1 ? requestedPage : 1,
    pageCount,
  )
  const rows = await base
    .select([
      'audit_events.id',
      'audit_events.action',
      'audit_events.detail',
      'audit_events.created_at',
      'actor.id as actor_id',
      'actor.email as actor_email',
      'actor.name as actor_name',
      'actor.image as actor_image',
      'subject.id as subject_id',
      'subject.email as subject_email',
      'subject.name as subject_name',
      'subject.image as subject_image',
    ])
    .orderBy('audit_events.created_at', 'desc')
    .orderBy('audit_events.id', 'desc')
    .limit(AUDIT_EVENTS_PAGE_SIZE)
    .offset((page - 1) * AUDIT_EVENTS_PAGE_SIZE)
    .execute()
  return {
    total,
    page,
    events: rows.map((row) => {
      const raw = row.detail
        ? (() => {
            try {
              return JSON.parse(row.detail) as Record<string, unknown>
            } catch {
              return null
            }
          })()
        : null
      const stringValue = (key: string) =>
        typeof raw?.[key] === 'string' ? (raw[key] as string) : null
      const count =
        typeof raw?.artifact_count === 'number' ? raw.artifact_count : null
      return {
        id: row.id,
        action: row.action,
        createdAt: row.created_at,
        actor: row.actor_id
          ? {
              id: row.actor_id,
              email: row.actor_email!,
              name: row.actor_name,
              image: row.actor_image,
            }
          : null,
        subject: row.subject_id
          ? {
              id: row.subject_id,
              email: row.subject_email!,
              name: row.subject_name,
              image: row.subject_image,
            }
          : null,
        detail: {
          name: stringValue('name'),
          email: stringValue('email'),
          from: stringValue('from'),
          to: stringValue('to'),
          fromRole: stringValue('from_role'),
          toRole: stringValue('to_role'),
          recipientEmail: stringValue('recipient_email'),
          artifactCount: count,
        },
      }
    }),
  }
}

export async function countWorkspaceContributors(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<number> {
  const row = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('users.workspace_id', '=', workspaceId)
    .where('workspace_members.status', '!=', 'removed')
    .where((eb) =>
      eb.or([
        eb('workspace_members.first_contributed_at', 'is not', null),
        eb('workspace_members.pending_uploads', '>', 0),
      ]),
    )
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

export const RECIPIENT_SEARCH_LIMIT = 20

export async function searchAssetTransferRecipients(
  db: Kysely<DB>,
  workspaceId: string,
  options: { query: string; excludeUserIds?: string[] },
): Promise<{ recipients: TeamMember[]; total: number }> {
  let base = db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.status', '=', 'active')
    .where('users.workspace_id', '=', workspaceId)
  const excludeUserIds = options.excludeUserIds?.filter(Boolean) ?? []
  if (excludeUserIds.length > 0) {
    base = base.where('users.id', 'not in', excludeUserIds)
  }
  if (options.query) {
    base = base.where(() => nameOrEmailCondition(options.query))
  }

  const [totalRow, recipients] = await Promise.all([
    base
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow(),
    base
      .select(['users.id', 'users.email', 'users.name', 'users.image'])
      .orderBy('users.email', 'asc')
      .limit(RECIPIENT_SEARCH_LIMIT)
      .execute(),
  ])

  return { recipients, total: Number(totalRow.count) }
}

function removedMemberGuard(
  db: Kysely<DB>,
  workspaceId: string,
  targetUserId: string,
  actorId: string,
) {
  return db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', targetUserId)
    .where('status', '=', 'removed')
    .where(({ exists }) =>
      exists(workspaceAdminQuery(db, actorId, workspaceId)),
    )
}

function eligibleAssetRecipient(
  db: Kysely<DB>,
  workspaceId: string,
  recipientUserId: string,
) {
  return db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('users.id')
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.user_id', '=', recipientUserId)
    .where('workspace_members.status', '=', 'active')
    .where('users.workspace_id', '=', workspaceId)
}

export async function transferRemovedMemberAssets(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
  recipientUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized

  const [target, recipient, owned] = await Promise.all([
    db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', actor.workspaceId)
      .where('user_id', '=', targetUserId)
      .where('status', '=', 'removed')
      .executeTakeFirst(),
    eligibleAssetRecipient(
      db,
      actor.workspaceId,
      recipientUserId,
    ).executeTakeFirst(),
    db
      .selectFrom('shareables')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('workspace_id', '=', actor.workspaceId)
      .where('owner_user_id', '=', targetUserId)
      .executeTakeFirstOrThrow(),
  ])
  if (!target || !recipient) {
    return { kind: 'not-found' }
  }
  if (Number(owned.count) === 0) return { kind: 'ok' }

  const now = nowIso()
  const inboxId = nanoid()
  const commonGuard = () =>
    removedMemberGuard(db, actor.workspaceId, targetUserId, actor.id)

  await runD1Batch(
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
          .where('id', '=', recipientUserId)
          .where(({ exists }) => exists(commonGuard()))
          .where(({ exists }) =>
            exists(
              eligibleAssetRecipient(db, actor.workspaceId, recipientUserId),
            ),
          )
          .where(({ exists }) =>
            exists(
              db
                .selectFrom('shareables')
                .select('id')
                .where('workspace_id', '=', actor.workspaceId)
                .where('owner_user_id', '=', targetUserId),
            ),
          )
          .select([
            eb.val(nanoid(16)).as('id'),
            eb.val(actor.workspaceId).as('workspace_id'),
            eb.val(actor.id).as('actor_user_id'),
            eb.val('assets.transfer').as('action'),
            eb.val('user').as('subject_type'),
            eb.val(targetUserId).as('subject_id'),
            sql<string>`json_object('recipient_user_id', ${recipientUserId}, 'recipient_email', users.email, 'artifact_count', (SELECT COUNT(*) FROM shareables WHERE workspace_id = ${actor.workspaceId} AND owner_user_id = ${targetUserId}))`.as(
              'detail',
            ),
            eb.val(now).as('created_at'),
          ]),
      ),
    db
      .insertInto('artifact_containers')
      .columns([
        'id',
        'workspace_id',
        'kind',
        'owner_user_id',
        'created_by_id',
        'name',
        'created_at',
        'updated_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('users')
          .where('id', '=', recipientUserId)
          .where(({ exists }) => exists(commonGuard()))
          .where(({ exists }) =>
            exists(
              eligibleAssetRecipient(db, actor.workspaceId, recipientUserId),
            ),
          )
          .where(({ exists }) =>
            exists(
              db
                .selectFrom('shareables')
                .innerJoin(
                  'artifact_containers',
                  'artifact_containers.id',
                  'shareables.container_id',
                )
                .select('shareables.id')
                .where('shareables.workspace_id', '=', actor.workspaceId)
                .where('shareables.owner_user_id', '=', targetUserId)
                .where('artifact_containers.kind', '=', 'inbox')
                .where('artifact_containers.owner_user_id', '=', targetUserId),
            ),
          )
          .where(({ not, exists }) =>
            not(
              exists(
                db
                  .selectFrom('artifact_containers')
                  .select('id')
                  .where('workspace_id', '=', actor.workspaceId)
                  .where('kind', '=', 'inbox')
                  .where('owner_user_id', '=', recipientUserId),
              ),
            ),
          )
          .select([
            eb.val(inboxId).as('id'),
            eb.val(actor.workspaceId).as('workspace_id'),
            eb.val('inbox').as('kind'),
            eb.val(recipientUserId).as('owner_user_id'),
            eb.val(recipientUserId).as('created_by_id'),
            eb.val(INBOX_CONTAINER_NAME).as('name'),
            eb.val(now).as('created_at'),
            eb.val(now).as('updated_at'),
          ]),
      ),
    db
      .deleteFrom('artifact_keys')
      .where('owner_user_id', '=', targetUserId)
      .where('workspace_id', '=', actor.workspaceId)
      .where(
        'shareable_id',
        'in',
        db
          .selectFrom('shareables')
          .select('id')
          .where('owner_user_id', '=', targetUserId)
          .where('workspace_id', '=', actor.workspaceId),
      )
      .where(({ exists }) => exists(commonGuard()))
      .where(({ exists }) =>
        exists(eligibleAssetRecipient(db, actor.workspaceId, recipientUserId)),
      ),
    db
      .updateTable('shareables')
      .set({
        container_id: sql<string>`(SELECT id FROM artifact_containers WHERE workspace_id = ${actor.workspaceId} AND kind = 'inbox' AND owner_user_id = ${recipientUserId})`,
        updated_at: now,
      })
      .where('workspace_id', '=', actor.workspaceId)
      .where('owner_user_id', '=', targetUserId)
      .where(
        'container_id',
        'in',
        db
          .selectFrom('artifact_containers')
          .select('id')
          .where('workspace_id', '=', actor.workspaceId)
          .where('kind', '=', 'inbox')
          .where('owner_user_id', '=', targetUserId),
      )
      .where(({ exists }) => exists(commonGuard()))
      .where(({ exists }) =>
        exists(eligibleAssetRecipient(db, actor.workspaceId, recipientUserId)),
      ),
    db
      .updateTable('shareables')
      .set({ owner_user_id: recipientUserId, updated_at: now })
      .where('workspace_id', '=', actor.workspaceId)
      .where('owner_user_id', '=', targetUserId)
      .where(({ exists }) => exists(commonGuard()))
      .where(({ exists }) =>
        exists(eligibleAssetRecipient(db, actor.workspaceId, recipientUserId)),
      ),
  )

  const remaining = await db
    .selectFrom('shareables')
    .select('id')
    .where('workspace_id', '=', actor.workspaceId)
    .where('owner_user_id', '=', targetUserId)
    .executeTakeFirst()
  return remaining ? { kind: 'not-found' } : { kind: 'ok' }
}

export async function restoreWorkspaceMember(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized
  const target = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['users.workspace_id', 'users.email', 'users.name'])
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .where('workspace_members.status', '=', 'removed')
    .executeTakeFirst()
  if (!target) {
    const alreadyRestored = await db
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select('workspace_members.user_id')
      .where('workspace_members.workspace_id', '=', actor.workspaceId)
      .where('workspace_members.user_id', '=', targetUserId)
      .where('workspace_members.status', '=', 'active')
      .where('users.workspace_id', '=', actor.workspaceId)
      .executeTakeFirst()
    return alreadyRestored ? { kind: 'ok' } : { kind: 'not-found' }
  }

  const sourceWorkspaceId = target.workspace_id
  const now = nowIso()
  const restoreGuard = () =>
    workspaceMemberRestoreGuard(db, actor, targetUserId, sourceWorkspaceId)
  const detail = JSON.stringify({ email: target.email, name: target.name })
  await runD1Batch(
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
          .where('id', '=', targetUserId)
          .where(restoreGuard())
          .select([
            eb.val(nanoid(16)).as('id'),
            eb.val(actor.workspaceId).as('workspace_id'),
            eb.val(actor.id).as('actor_user_id'),
            eb.val('member.restore').as('action'),
            eb.val('user').as('subject_type'),
            eb.val(targetUserId).as('subject_id'),
            eb.val(detail).as('detail'),
            eb.val(now).as('created_at'),
          ]),
      ),
    db
      .updateTable('users')
      .set({ workspace_id: actor.workspaceId, updated_at: now })
      .where('id', '=', targetUserId)
      .where('workspace_id', '=', sourceWorkspaceId)
      .where(restoreGuard()),
    db
      .updateTable('workspace_members')
      .set({
        status: 'active',
        removed_at: null,
        removed_by: null,
        updated_at: now,
      })
      .where('workspace_id', '=', actor.workspaceId)
      .where('user_id', '=', targetUserId)
      .where('status', '=', 'removed')
      .where(restoreGuard()),
  )
  const restored = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.status')
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .where('users.workspace_id', '=', actor.workspaceId)
    .executeTakeFirst()
  return restored?.status === 'active' ? { kind: 'ok' } : { kind: 'not-found' }
}

function workspaceMemberRestoreGuard(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
  sourceWorkspaceId: string,
): Expression<SqlBool> {
  const eb = expressionBuilder<DB>()
  return eb.and([
    eb.exists(workspaceAdminQuery(db, actor.id, actor.workspaceId)),
    eb.exists(
      db
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', actor.workspaceId)
        .where('user_id', '=', targetUserId)
        .where('status', '=', 'removed'),
    ),
    eb.not(
      eb.exists(
        db
          .selectFrom('users')
          .select('id')
          .where('workspace_id', '=', sourceWorkspaceId)
          .where('id', '!=', targetUserId),
      ),
    ),
    eb.exists(
      db
        .selectFrom('users')
        .select('id')
        .where('id', '=', targetUserId)
        .where('workspace_id', 'in', [sourceWorkspaceId, actor.workspaceId]),
    ),
  ])
}

export async function updateWorkspaceName(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  name: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized

  const trimmed = name.trim()
  if (!trimmed || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    return { kind: 'invalid' }
  }

  await db
    .updateTable('workspaces')
    .set({ name: trimmed })
    .where('id', '=', actor.workspaceId)
    .execute()

  return { kind: 'ok' }
}

export async function transferWorkspaceOwner(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceOwner(db, actor)
  if (authorized.kind !== 'ok') return authorized
  if (targetUserId === actor.id) return { kind: 'self-forbidden' }
  const now = nowIso()
  const auditId = nanoid(16)
  const transferDetail = JSON.stringify({
    from_user_id: actor.id,
    to_user_id: targetUserId,
  })
  const targetBeforeTransfer = await db
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', targetUserId)
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (
    !targetBeforeTransfer ||
    !['member', 'admin'].includes(targetBeforeTransfer.role)
  ) {
    return { kind: 'not-found' }
  }
  const auditInsert = db
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
        .selectFrom('workspace_members')
        .where('workspace_id', '=', actor.workspaceId)
        .where('user_id', '=', targetUserId)
        .where('status', '=', 'active')
        .where(({ exists }) =>
          exists(activeWorkspaceOwnerQuery(db, actor.id, actor.workspaceId)),
        )
        .where(({ exists }) =>
          exists(eligibleAdminTarget(db, actor, targetUserId)),
        )
        .where(({ eb: condition }) =>
          condition('role', 'in', ['member', 'admin']),
        )
        .select([
          eb.val(auditId).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('owner.transfer').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(targetUserId).as('subject_id'),
          eb.val(transferDetail).as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )
  const demoteActor = db
    .updateTable('workspace_members')
    .set({ role: 'admin', updated_at: now })
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', actor.id)
    .where('role', '=', 'owner')
    .where(({ exists }) =>
      exists(activeWorkspaceOwnerQuery(db, actor.id, actor.workspaceId)),
    )
    .where(({ exists }) => exists(eligibleAdminTarget(db, actor, targetUserId)))
  const promoteTarget = db
    .updateTable('workspace_members')
    .set({ role: 'owner', updated_at: now })
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', targetUserId)
    .where('status', '=', 'active')
    .where('role', 'in', ['member', 'admin'])
    .where(({ exists }) => exists(eligibleAdminTarget(db, actor, targetUserId)))
    .where(({ exists }) =>
      exists(
        db
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', actor.workspaceId)
          .where('user_id', '=', actor.id)
          .where('role', '=', 'admin'),
      ),
    )
    .where(({ exists }) =>
      exists(
        db
          .selectFrom('audit_events')
          .select('id')
          .where('id', '=', auditId)
          .where('workspace_id', '=', actor.workspaceId)
          .where('actor_user_id', '=', actor.id)
          .where('action', '=', 'owner.transfer'),
      ),
    )

  await runD1Batch(auditInsert, demoteActor, promoteTarget)

  const [promoted, audited] = await Promise.all([
    db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', actor.workspaceId)
      .where('user_id', '=', targetUserId)
      .where('role', '=', 'owner')
      .executeTakeFirst(),
    db
      .selectFrom('audit_events')
      .select('id')
      .where('id', '=', auditId)
      .executeTakeFirst(),
  ])
  if (!promoted || !audited) {
    const stillOwner = await activeWorkspaceOwnerQuery(
      db,
      actor.id,
      actor.workspaceId,
    ).executeTakeFirst()
    if (!stillOwner) return { kind: 'forbidden' }
    const stillAdmin = await requireWorkspaceAdmin(db, actor)
    return stillAdmin.kind === 'ok' ? { kind: 'not-found' } : stillAdmin
  }
  return { kind: 'ok' }
}

function removableMembershipGuard(
  db: Kysely<DB>,
  workspaceId: string,
  targetUserId: string,
  actorId: string,
) {
  return db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', targetUserId)
    .where('role', '=', 'member')
    .where('status', '!=', 'removed')
    .where(({ exists }) =>
      exists(workspaceAdminQuery(db, actorId, workspaceId)),
    )
}

export async function removeWorkspaceMember(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceAdmin(db, actor)
  if (authorized.kind !== 'ok') return authorized

  const target = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'workspace_members.role',
      'workspace_members.status',
      'users.email',
      'users.name',
      'users.workspace_id',
    ])
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .executeTakeFirst()

  if (!target) return { kind: 'not-found' }
  if (
    target.status === 'removed' &&
    target.workspace_id !== actor.workspaceId
  ) {
    return { kind: 'not-found' }
  }
  if (targetUserId === actor.id) return { kind: 'self-forbidden' }
  if (target.role === 'owner' || target.role === 'admin') {
    return { kind: 'not-found' }
  }

  const oldWorkspaceId = actor.workspaceId
  const now = nowIso()
  const targetCurrentlyInWorkspace = target.workspace_id === oldWorkspaceId

  if (targetCurrentlyInWorkspace) {
    const newWorkspaceId = nanoid()
    const workspaceName = `${target.email}'s workspace`
    await runD1Batch(
      db
        .insertInto('workspaces')
        .columns([
          'id',
          'hd',
          'name',
          'created_at',
          'plan',
          'storage_quota_bytes',
          'self_upload_enabled',
        ])
        .expression((eb) =>
          eb
            .selectFrom('users')
            .where('id', '=', targetUserId)
            .where('workspace_id', '=', oldWorkspaceId)
            .where(({ exists }) =>
              exists(
                db
                  .selectFrom('workspace_members')
                  .select('user_id')
                  .where('workspace_id', '=', oldWorkspaceId)
                  .where('user_id', '=', targetUserId)
                  .where('role', '=', 'member')
                  .where('status', '!=', 'removed'),
              ),
            )
            .where(({ exists }) =>
              exists(workspaceAdminQuery(db, actor.id, oldWorkspaceId)),
            )
            .select([
              eb.val(newWorkspaceId).as('id'),
              eb.val(null).as('hd'),
              eb.val(workspaceName).as('name'),
              eb.val(now).as('created_at'),
              eb.val(PERSONAL_WORKSPACE_DEFAULTS.plan).as('plan'),
              eb
                .val(PERSONAL_WORKSPACE_DEFAULTS.storage_quota_bytes)
                .as('storage_quota_bytes'),
              eb
                .val(PERSONAL_WORKSPACE_DEFAULTS.self_upload_enabled)
                .as('self_upload_enabled'),
            ]),
        ),
      db
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
            .where('id', '=', targetUserId)
            .where('workspace_id', '=', oldWorkspaceId)
            .where(({ exists }) =>
              exists(
                db
                  .selectFrom('workspace_members')
                  .select('user_id')
                  .where('workspace_id', '=', oldWorkspaceId)
                  .where('user_id', '=', targetUserId)
                  .where('role', '=', 'member')
                  .where('status', '!=', 'removed'),
              ),
            )
            .where(({ exists }) =>
              exists(workspaceAdminQuery(db, actor.id, oldWorkspaceId)),
            )
            .select([
              eb.val(newWorkspaceId).as('workspace_id'),
              eb.val(targetUserId).as('user_id'),
              eb.val('owner').as('role'),
              eb.val('active').as('status'),
              eb.val(now).as('created_at'),
              eb.val(now).as('updated_at'),
            ]),
        ),
      db
        .updateTable('users')
        .set({ workspace_id: newWorkspaceId, updated_at: now })
        .where('id', '=', targetUserId)
        .where('workspace_id', '=', oldWorkspaceId)
        .where(({ exists }) =>
          exists(
            db
              .selectFrom('workspace_members')
              .select('user_id')
              .where('workspace_id', '=', oldWorkspaceId)
              .where('user_id', '=', targetUserId)
              .where('role', '=', 'member')
              .where('status', '!=', 'removed'),
          ),
        )
        .where(({ exists }) =>
          exists(workspaceAdminQuery(db, actor.id, oldWorkspaceId)),
        ),
    )
  }

  const removalDetail = JSON.stringify({
    email: target.email,
    name: target.name,
  })
  const removalBatch: Compilable<unknown>[] = [
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
          .selectFrom('workspace_members')
          .where('workspace_id', '=', oldWorkspaceId)
          .where('user_id', '=', targetUserId)
          .where('role', '=', 'member')
          .where('status', '!=', 'removed')
          .where(({ exists }) =>
            exists(workspaceAdminQuery(db, actor.id, oldWorkspaceId)),
          )
          .select([
            eb.val(nanoid(16)).as('id'),
            eb.val(oldWorkspaceId).as('workspace_id'),
            eb.val(actor.id).as('actor_user_id'),
            eb.val('member.remove').as('action'),
            eb.val('user').as('subject_type'),
            eb.val(targetUserId).as('subject_id'),
            eb.val(removalDetail).as('detail'),
            eb.val(now).as('created_at'),
          ]),
      ),
  ]
  if (targetCurrentlyInWorkspace) {
    removalBatch.push(
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
            .selectFrom('cli_refresh_credentials as credential')
            .where('credential.user_id', '=', targetUserId)
            .where('credential.family_id', 'is not', null)
            .where('credential.revoked_at', 'is', null)
            .where('credential.expires_at', '>', now)
            .where(({ exists }) =>
              exists(
                removableMembershipGuard(
                  db,
                  oldWorkspaceId,
                  targetUserId,
                  actor.id,
                ),
              ),
            )
            .groupBy('credential.family_id')
            .select([
              sql<string>`lower(hex(randomblob(16)))`.as('id'),
              eb.val(oldWorkspaceId).as('workspace_id'),
              eb.val(actor.id).as('actor_user_id'),
              eb.val('cli.refresh_credential.revoke').as('action'),
              eb.val('cli_refresh_credential').as('subject_type'),
              'credential.family_id as subject_id',
              sql<string>`json_object(
                'credential_kind', 'cli_refresh',
                'family_id', credential.family_id,
                'target_user_id', ${targetUserId},
                'reason', 'member_removal'
              )`.as('detail'),
              eb.val(now).as('created_at'),
            ]),
        ),
      db
        .updateTable('cli_refresh_credentials')
        .set({ revoked_at: now })
        .where('user_id', '=', targetUserId)
        .where('family_id', 'is not', null)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .where(({ exists }) =>
          exists(
            removableMembershipGuard(
              db,
              oldWorkspaceId,
              targetUserId,
              actor.id,
            ),
          ),
        ),
      db
        .deleteFrom('sessions')
        .where('user_id', '=', targetUserId)
        .where(({ exists }) =>
          exists(
            removableMembershipGuard(
              db,
              oldWorkspaceId,
              targetUserId,
              actor.id,
            ),
          ),
        ),
    )
  }
  removalBatch.push(
    db
      .updateTable('workspace_members')
      .set({
        status: 'removed',
        removed_at: now,
        removed_by: actor.id,
        pending_uploads: 0,
        updated_at: now,
      })
      .where('workspace_id', '=', oldWorkspaceId)
      .where('user_id', '=', targetUserId)
      .where('role', '=', 'member')
      .where('status', '!=', 'removed')
      .where(({ exists }) =>
        exists(workspaceAdminQuery(db, actor.id, oldWorkspaceId)),
      ),
  )
  await runD1Batch(...removalBatch)

  const removed = await db
    .selectFrom('workspace_members')
    .select('status')
    .where('workspace_id', '=', oldWorkspaceId)
    .where('user_id', '=', targetUserId)
    .executeTakeFirst()
  if (removed?.status !== 'removed') {
    const stillAdmin = await requireWorkspaceAdmin(db, actor)
    return stillAdmin.kind === 'ok' ? { kind: 'not-found' } : stillAdmin
  }
  return { kind: 'ok' }
}

export async function ensureActiveWorkspaceMembership(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
  now: string,
  options: { reactivateRemoved?: boolean } = {},
): Promise<void> {
  const query = db
    .insertInto('workspace_members')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      role: 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      options.reactivateRemoved
        ? oc.columns(['workspace_id', 'user_id']).doUpdateSet({
            role: sql<
              'admin' | 'member' | 'owner'
            >`CASE WHEN status = 'removed' THEN 'member' ELSE role END`,
            status: 'active',
            removed_at: null,
            removed_by: null,
            updated_at: now,
          })
        : oc.columns(['workspace_id', 'user_id']).doNothing(),
    )
  await query.execute()
}

export async function ensureWorkspaceAdmin(
  db: Kysely<DB>,
  workspaceId: string,
  now: string,
): Promise<string> {
  const existing = await db
    .selectFrom('workspace_members')
    .select(['user_id', 'role'])
    .where('workspace_id', '=', workspaceId)
    .where('role', 'in', ['owner', 'admin'])
    .where('status', '=', 'active')
    .orderBy(sql<number>`CASE WHEN role = 'owner' THEN 0 ELSE 1 END`)
    .executeTakeFirst()
  if (existing) {
    if (existing.role === 'admin') {
      try {
        await db
          .updateTable('workspace_members')
          .set({ role: 'owner', updated_at: now })
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', existing.user_id)
          .where('role', '=', 'admin')
          .where('status', '=', 'active')
          .execute()
      } catch (err) {
        if (!isSqliteConstraintError(err)) throw err
        const concurrentOwner = await db
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', workspaceId)
          .where('role', '=', 'owner')
          .where('status', '=', 'active')
          .executeTakeFirst()
        if (concurrentOwner) return concurrentOwner.user_id
        throw err
      }
    }
    return existing.user_id
  }

  const fallbackAdmin = await db
    .selectFrom('users')
    .leftJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.user_id', '=', 'users.id')
        .onRef('workspace_members.workspace_id', '=', 'users.workspace_id'),
    )
    .select('users.id')
    .where('users.workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.or([
        eb('workspace_members.status', 'is', null),
        eb('workspace_members.status', '=', 'active'),
      ]),
    )
    .orderBy(
      sql<number>`CASE WHEN workspace_members.first_contributed_at IS NULL THEN 1 ELSE 0 END`,
      'asc',
    )
    .orderBy('workspace_members.first_contributed_at', 'asc')
    .orderBy('users.created_at', 'asc')
    .orderBy('users.id', 'asc')
    .executeTakeFirstOrThrow()

  const updated = await db
    .updateTable('workspace_members')
    .set({ role: 'owner', updated_at: now })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', fallbackAdmin.id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows) === 0) {
    try {
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: workspaceId,
          user_id: fallbackAdmin.id,
          role: 'owner',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute()
    } catch (err) {
      if (!isSqliteConstraintError(err)) throw err
      // Concurrent bootstrap may hit workspace_members_single_owner; re-read below.
    }
  }

  const created = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'owner')
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow()
  return created.user_id
}

function eligibleAdminTarget(
  db: Kysely<DB>,
  actor: { workspaceId: string },
  targetUserId: string,
) {
  return db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('users.id')
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .where('users.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.status', '=', 'active')
}

export async function requireWorkspaceAdmin(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
): Promise<TeamMutationResult> {
  const actorMembership = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', actor.id)
    .where('role', 'in', ['owner', 'admin'])
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (actorMembership) return { kind: 'ok' }

  const anyAdmin = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', actor.workspaceId)
    .where('role', 'in', ['owner', 'admin'])
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (anyAdmin) return { kind: 'forbidden' }

  const bootstrappedAdmin = await ensureWorkspaceAdmin(
    db,
    actor.workspaceId,
    nowIso(),
  )
  if (bootstrappedAdmin !== actor.id) return { kind: 'forbidden' }
  return { kind: 'ok' }
}

export async function requireWorkspaceOwner(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
): Promise<TeamMutationResult> {
  const owner = await activeWorkspaceOwnerQuery(
    db,
    actor.id,
    actor.workspaceId,
  ).executeTakeFirst()
  return owner ? { kind: 'ok' } : { kind: 'forbidden' }
}

export async function grantWorkspaceAdmin(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceOwner(db, actor)
  if (authorized.kind !== 'ok') return authorized
  const target = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['workspace_members.role', 'workspace_members.status'])
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .where('users.workspace_id', '=', actor.workspaceId)
    .executeTakeFirst()
  if (target?.status === 'active' && target.role === 'admin')
    return { kind: 'ok' }
  if (!target || target.status !== 'active' || target.role !== 'member') {
    return { kind: 'not-found' }
  }
  return runRoleMutationBatch(
    db,
    actor,
    targetUserId,
    'admin.grant',
    'member',
    'admin',
  )
}

export async function revokeWorkspaceAdmin(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
): Promise<TeamMutationResult> {
  const authorized = await requireWorkspaceOwner(db, actor)
  if (authorized.kind !== 'ok') return authorized
  const target = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['workspace_members.role', 'workspace_members.status'])
    .where('workspace_members.workspace_id', '=', actor.workspaceId)
    .where('workspace_members.user_id', '=', targetUserId)
    .where('users.workspace_id', '=', actor.workspaceId)
    .executeTakeFirst()
  if (target?.status === 'active' && target.role === 'member')
    return { kind: 'ok' }
  if (!target || target.status !== 'active' || target.role !== 'admin') {
    return { kind: 'not-found' }
  }
  return runRoleMutationBatch(
    db,
    actor,
    targetUserId,
    'admin.revoke',
    'admin',
    'member',
  )
}

async function runRoleMutationBatch(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  targetUserId: string,
  action: 'admin.grant' | 'admin.revoke',
  fromRole: 'member' | 'admin',
  toRole: 'admin' | 'member',
): Promise<TeamMutationResult> {
  const now = nowIso()
  const auditId = nanoid(16)
  const detail = JSON.stringify({
    from_role: fromRole,
    to_role: toRole,
    target_user_id: targetUserId,
  })
  const audit = db
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
        .selectFrom('workspace_members')
        .where('workspace_id', '=', actor.workspaceId)
        .where('user_id', '=', targetUserId)
        .where('role', '=', fromRole)
        .where('status', '=', 'active')
        .where(({ exists }) =>
          exists(activeWorkspaceOwnerQuery(db, actor.id, actor.workspaceId)),
        )
        .where(({ exists }) =>
          exists(eligibleAdminTarget(db, actor, targetUserId)),
        )
        .select([
          eb.val(auditId).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val(action).as('action'),
          eb.val('user').as('subject_type'),
          eb.val(targetUserId).as('subject_id'),
          eb.val(detail).as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )
  const update = db
    .updateTable('workspace_members')
    .set({ role: toRole, updated_at: now })
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', targetUserId)
    .where('role', '=', fromRole)
    .where('status', '=', 'active')
    .where(({ exists }) =>
      exists(
        db.selectFrom('audit_events').select('id').where('id', '=', auditId),
      ),
    )
  await runD1Batch(audit, update)
  const changed = await db
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', targetUserId)
    .where('status', '=', 'active')
    .executeTakeFirst()
  if (changed?.role === toRole) return { kind: 'ok' }
  const stillOwner = (await requireWorkspaceOwner(db, actor)).kind === 'ok'
  if (!stillOwner) return { kind: 'forbidden' }
  return { kind: 'not-found' }
}

function activeWorkspaceOwnerQuery(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
) {
  return db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('role', '=', 'owner')
    .where('status', '=', 'active')
}

export async function requireWorkspaceBillingOwner(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
): Promise<TeamMutationResult> {
  const owner = await activeWorkspaceOwnerQuery(
    db,
    actor.id,
    actor.workspaceId,
  ).executeTakeFirst()
  if (owner) return { kind: 'ok' }

  return { kind: 'forbidden' }
}

async function requireTeamAdmin(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
): Promise<TeamMutationResult> {
  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', actor.workspaceId)
    .executeTakeFirst()
  if (workspace?.plan !== 'team') return { kind: 'not-team' }

  return requireWorkspaceAdmin(db, actor)
}

async function loadUser(db: Kysely<DB>, userId: string): Promise<TeamMember> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'image'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  return row
}

export async function loadRemovedWorkspaceMembers(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<RemovedTeamMember[]> {
  const rows = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['users.id', 'users.email', 'users.name', 'users.image'])
    .select((eb) =>
      eb
        .selectFrom('shareables')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .whereRef('shareables.owner_user_id', '=', 'users.id')
        .where('shareables.workspace_id', '=', workspaceId)
        .as('owned_artifact_count'),
    )
    .where('workspace_members.workspace_id', '=', workspaceId)
    .where('workspace_members.status', '=', 'removed')
    .orderBy('users.email', 'asc')
    .execute()

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    ownedArtifactCount: Number(row.owned_artifact_count),
  }))
}

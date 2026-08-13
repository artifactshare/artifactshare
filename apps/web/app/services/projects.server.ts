import {
  expressionBuilder,
  sql,
  type Compilable,
  type ExpressionBuilder,
  type Kysely,
} from 'kysely'
import { nanoid } from 'nanoid'
import {
  isExternalEmail,
  isValidGrantEmail,
  MAX_GRANT_EMAILS,
  normalizeGrantEmail,
  normalizeGrantEmailList,
} from '~/lib/grant-emails'
import { lowerEmail } from '~/lib/grant-emails.server'
import { nowIso } from '~/lib/datetime'
import { runD1Batch } from '~/lib/d1-batch.server'
import type {
  ProjectBaseVisibility,
  ProjectShareRole,
} from '~/lib/shareable-types'
import {
  grantMatchEmail,
  isTeamWorkspaceAdmin,
  workspaceScopedProjectVisibility,
} from '~/services/access.server'
import { projectLimitForPlan } from '~/lib/billing-plan.server'
import { isExternalPostingAllowedForWorkspace } from '~/lib/project-external-posting.server'
import { resolveGrantUsersByEmail } from '~/services/grant-users.server'
import type { DB } from '~/types/db'

export const INBOX_CONTAINER_NAME = '未整理'

export async function countActiveProjects(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<number> {
  const row = await db
    .selectFrom('artifact_containers')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.count)
}

export type ProjectSummary = {
  id: string
  name: string
  description: string | null
  baseVisibility: ProjectBaseVisibility
  fileCount: number
  createdById: string | null
  createdByName: string | null
  createdByEmail: string | null
  createdByImage: string | null
  fileUpdatedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

// 別組織から関係者として共有されたプロジェクト。社内向けの ProjectSummary と違い、
// 公開範囲チップや作成者など社内向けの内部情報は持たず、共有元組織だけを添える。
export type SharedProjectSummary = {
  id: string
  workspaceId: string
  sourceWorkspaceHd: string | null
  sourceWorkspaceName: string
  // 共有元プロジェクトの作成者メール。hd の無い個人ワークスペースで投稿者の社外
  // 判定の基準 (本人) に使う。
  createdByEmail: string | null
  name: string
  description: string | null
  baseVisibility: ProjectBaseVisibility
  fileCount: number
  fileUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ProjectShareDefault = {
  id: string
  email: string
  createdAt: string
  role: ProjectShareRole
  // 未登録 email = 招待済み
  invited: boolean
  isExternal: boolean
  // 関係者がワークスペースのユーザーなら、アバターと名前を出すために持つ。
  user: {
    id: string
    name: string | null
    image: string | null
    kind: 'human' | 'bot'
  } | null
}

type ProjectSummaryRow = {
  id: string
  name: string
  description: string | null
  base_visibility: ProjectBaseVisibility
  created_by_id: string | null
  created_by_name: string | null
  created_by_email: string | null
  created_by_image: string | null
  file_count: number | string | bigint | null
  file_updated_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

type ProjectShareDefaultRow = {
  id: string
  email: string
  created_at: string
  role: ProjectShareRole
  user_id: string | null
  user_name: string | null
  user_image: string | null
  user_kind?: 'human' | 'bot' | null
}

type SharedProjectSummaryRow = {
  id: string
  workspace_id: string
  source_workspace_hd: string | null
  source_workspace_name: string
  created_by_email: string | null
  name: string
  description: string | null
  base_visibility: ProjectBaseVisibility
  file_count: number | string | bigint | null
  file_updated_at: string | null
  created_at: string
  updated_at: string
}

export type ShareableViewer = {
  id: string
  email: string
  emailVerified: boolean
}

function validLinkExpirySql(
  expiresAt: ReturnType<typeof sql.ref>,
  now: string,
) {
  return sql<boolean>`(
    ${expiresAt} IS NULL OR (
      (
        strftime('%Y-%m-%dT%H:%M:%fZ', ${expiresAt}) = ${expiresAt}
        OR strftime('%Y-%m-%dT%H:%M:%SZ', ${expiresAt}) = ${expiresAt}
      )
      AND julianday(${expiresAt}) > julianday(${now})
    )
  )`
}

export function shareableLinkAccessToViewer(
  eb: ExpressionBuilder<DB, 'shareables'>,
  now = nowIso(),
) {
  return eb.and([
    eb('shareables.visibility', '=', 'link'),
    eb.exists(
      eb
        .selectFrom('workspaces')
        .select('workspaces.id')
        .whereRef('workspaces.id', '=', 'shareables.workspace_id')
        .where('workspaces.plan', 'in', ['plus', 'team'])
        .where('workspaces.link_sharing_enabled', '=', 1),
    ),
    validLinkExpirySql(sql.ref('shareables.link_expires_at'), now),
  ])
}

// MUST: callers scope by shareables.workspace_id. This predicate alone admits
// link/workspace rows from other workspaces.
export function visibleShareableToViewer(
  eb: ExpressionBuilder<DB, 'shareables'>,
  viewer: ShareableViewer,
  now = nowIso(),
) {
  return eb.or([
    shareableLinkAccessToViewer(eb, now),
    eb('shareables.visibility', '=', 'workspace'),
    eb('shareables.owner_user_id', '=', viewer.id),
    eb.exists(
      eb
        .selectFrom('shareable_grants')
        .select('shareable_grants.shareable_id')
        .whereRef('shareable_grants.shareable_id', '=', 'shareables.id')
        .where(
          lowerEmail('shareable_grants.granted_email'),
          '=',
          grantMatchEmail(viewer),
        ),
    ),
    workspaceScopedProjectVisibility(eb, viewer),
    eb.and([
      eb('shareables.visibility', '=', 'link'),
      eb.exists(
        eb
          .selectFrom('workspace_members')
          .innerJoin(
            'workspaces',
            'workspaces.id',
            'workspace_members.workspace_id',
          )
          .select('workspace_members.user_id')
          .whereRef(
            'workspace_members.workspace_id',
            '=',
            'shareables.workspace_id',
          )
          .where('workspace_members.user_id', '=', viewer.id)
          .where('workspace_members.role', 'in', ['owner', 'admin'])
          .where('workspace_members.status', '=', 'active')
          .where('workspaces.plan', '=', 'team'),
      ),
    ]),
  ])
}

export function visibleShareableToViewerSql(
  viewer: ShareableViewer,
  now = nowIso(),
) {
  const expression = visibleShareableToViewer(
    expressionBuilder<DB, 'shareables'>(),
    viewer,
    now,
  )
  return sql<boolean>`${expression}`
}

// ワークスペース外の関係者がプロジェクトを開いたときに見える成果物。
// visibleShareableToViewer は visibility='workspace' を無条件に含み「見る人の
// ワークスペースで絞り込み済み」を前提にするため、組織外の集計には流用できない
// (別組織の社内向けが漏れる)。ここでは関係者として見える visibility='project' と、
// 自分への個別共有だけに限る。プロジェクトに到達できている時点で関係者なので、
// このプロジェクト配下の 'project' 成果物はすべて見える。
export function visibleSharedProjectShareableToViewer(
  eb: ExpressionBuilder<DB, 'shareables'>,
  viewer: { email: string; emailVerified: boolean },
) {
  return eb.or([
    eb('shareables.visibility', '=', 'project'),
    eb.exists(
      eb
        .selectFrom('shareable_grants')
        .select('shareable_grants.shareable_id')
        .whereRef('shareable_grants.shareable_id', '=', 'shareables.id')
        .where(
          lowerEmail('shareable_grants.granted_email'),
          '=',
          grantMatchEmail(viewer),
        ),
    ),
  ])
}

export function visibleSharedProjectShareableToViewerSql(viewer: {
  email: string
  emailVerified: boolean
}) {
  const expression = visibleSharedProjectShareableToViewer(
    expressionBuilder<DB, 'shareables'>(),
    viewer,
  )
  return sql<boolean>`${expression}`
}

export function normalizeProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 120) : null
}

export function normalizeProjectDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null
}

// フォーム値からプロジェクトの公開範囲を読む。不明な値は社内全員に倒す。
export function parseProjectBaseVisibility(
  value: unknown,
): ProjectBaseVisibility {
  return value === 'private' ? 'private' : 'workspace'
}

function toProjectSummary(row: ProjectSummaryRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseVisibility: row.base_visibility,
    fileCount: Number(row.file_count ?? 0),
    createdById: row.created_by_id,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    createdByImage: row.created_by_image,
    fileUpdatedAt: row.file_updated_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSharedProjectSummary(
  row: SharedProjectSummaryRow,
): SharedProjectSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceWorkspaceHd: row.source_workspace_hd,
    sourceWorkspaceName: row.source_workspace_name,
    createdByEmail: row.created_by_email,
    name: row.name,
    description: row.description,
    baseVisibility: row.base_visibility,
    fileCount: Number(row.file_count ?? 0),
    fileUpdatedAt: row.file_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toProjectShareDefault(
  row: ProjectShareDefaultRow,
  workspaceHd?: string | null,
): ProjectShareDefault {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    role: row.role,
    invited: row.user_id === null,
    isExternal: isExternalEmail(row.email, workspaceHd),
    user: row.user_id
      ? {
          id: row.user_id,
          name: row.user_name,
          image: row.user_image,
          kind: row.user_kind ?? 'human',
        }
      : null,
  }
}

export function insertInboxContainerQuery(
  db: Kysely<DB>,
  id: string,
  workspaceId: string,
  ownerUserId: string,
  now: string,
) {
  return db
    .insertInto('artifact_containers')
    .values({
      id,
      workspace_id: workspaceId,
      kind: 'inbox',
      owner_user_id: ownerUserId,
      created_by_id: ownerUserId,
      name: INBOX_CONTAINER_NAME,
      description: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.doNothing())
}

export async function getOrCreateInboxContainerId(
  db: Kysely<DB>,
  workspaceId: string,
  ownerUserId: string,
  now: string,
): Promise<string> {
  const existing = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'inbox')
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst()
  if (existing) return existing.id

  const id = nanoid()
  const inserted = await insertInboxContainerQuery(
    db,
    id,
    workspaceId,
    ownerUserId,
    now,
  )
    .returning('id')
    .executeTakeFirst()
  if (inserted) return inserted.id

  const created = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'inbox')
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirstOrThrow()
  return created.id
}

// Shared base query for project summaries: the select list plus the per-viewer
// visible file count / last-update subqueries, scoped to the workspace's
// projects. Non-archived by default; pass archived = true for the archive view,
// or 'any' to read a project regardless of its archive state (used when a single
// edit_project call both edits and archives, so the response can still read it).
// Callers add the id/slug discriminator and ordering.
function projectSummaryQuery(
  db: Kysely<DB>,
  workspaceId: string,
  viewer?: ShareableViewer,
  archived: boolean | 'any' = false,
) {
  return db
    .selectFrom('artifact_containers as c')
    .leftJoin('users as u', 'u.id', 'c.created_by_id')
    .select((eb) => [
      'c.id',
      'c.name',
      'c.description',
      'c.base_visibility',
      'c.created_by_id',
      'c.archived_at',
      'c.created_at',
      'c.updated_at',
      'u.name as created_by_name',
      'u.email as created_by_email',
      'u.image as created_by_image',
      eb
        .selectFrom('shareables')
        .select((sqb) => sqb.fn.count<number>('shareables.id').as('count'))
        .whereRef('shareables.container_id', '=', 'c.id')
        .where('shareables.workspace_id', '=', workspaceId)
        .where('shareables.visibility', 'in', [
          'private',
          'workspace',
          'project',
        ])
        .$if(Boolean(viewer), (qb) =>
          qb.where((predicateEb) =>
            visibleShareableToViewer(predicateEb, viewer!),
          ),
        )
        .as('file_count'),
      eb
        .selectFrom('shareables')
        .select((sqb) =>
          sqb.fn.max<string>('shareables.updated_at').as('updated_at'),
        )
        .whereRef('shareables.container_id', '=', 'c.id')
        .where('shareables.workspace_id', '=', workspaceId)
        .where('shareables.visibility', 'in', [
          'private',
          'workspace',
          'project',
        ])
        .$if(Boolean(viewer), (qb) =>
          qb.where((predicateEb) =>
            visibleShareableToViewer(predicateEb, viewer!),
          ),
        )
        .as('file_updated_at'),
    ])
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .$if(archived !== 'any', (qb) =>
      qb.where('c.archived_at', archived ? 'is not' : 'is', null),
    )
}

export async function listWorkspaceProjects(
  db: Kysely<DB>,
  workspaceId: string,
  viewer: ShareableViewer,
): Promise<ProjectSummary[]> {
  const rows = await projectSummaryQuery(db, workspaceId, viewer)
    .orderBy('file_updated_at', 'desc')
    .orderBy('c.created_at', 'desc')
    .execute()

  return rows.map(toProjectSummary)
}

export async function listMyProjects(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
  limit?: number,
): Promise<{ id: string; name: string }[]> {
  let query = db
    .selectFrom('artifact_containers as c')
    .select(['c.id', 'c.name'])
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where('c.created_by_id', '=', userId)
    .orderBy('c.updated_at', 'desc')
  if (limit !== undefined) query = query.limit(limit)
  return await query.execute()
}

export async function listArchivedWorkspaceProjects(
  db: Kysely<DB>,
  workspaceId: string,
  viewer: ShareableViewer,
): Promise<ProjectSummary[]> {
  const rows = await projectSummaryQuery(db, workspaceId, viewer, true)
    .orderBy('c.archived_at', 'desc')
    .orderBy('c.created_at', 'desc')
    .execute()

  return rows.map(toProjectSummary)
}

export async function findWorkspaceProject(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  viewer?: ShareableViewer,
): Promise<ProjectSummary | null> {
  const row = await projectSummaryQuery(db, workspaceId, viewer)
    .where('c.id', '=', projectId)
    .executeTakeFirst()

  return row ? toProjectSummary(row) : null
}

// Like findWorkspaceProject but resolves the project whether or not it is
// archived. Used by the MCP edit_project tool so a combined edit-and-archive
// call can still report the resulting state (the archived flag comes from
// ProjectSummary.archivedAt).
export async function findWorkspaceProjectAnyState(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  viewer?: ShareableViewer,
): Promise<ProjectSummary | null> {
  const row = await projectSummaryQuery(db, workspaceId, viewer, 'any')
    .where('c.id', '=', projectId)
    .executeTakeFirst()

  return row ? toProjectSummary(row) : null
}

// Shared base query for projects reached as an audience member (cross-workspace).
// Scoped to non-archived projects where the viewer's email is in
// project_share_defaults; the visible file count / last-update use the
// audience-only predicate so another org's workspace-visible files never leak.
// Callers add the workspace-exclusion (list) or id (single) discriminator.
function sharedProjectSummaryQuery(
  db: Kysely<DB>,
  viewer: { email: string; emailVerified: boolean },
) {
  return db
    .selectFrom('artifact_containers as c')
    .innerJoin('workspaces as w', 'w.id', 'c.workspace_id')
    .leftJoin('users as creator', 'creator.id', 'c.created_by_id')
    .select((eb) => [
      'c.id',
      'c.workspace_id',
      'c.name',
      'c.description',
      'c.base_visibility',
      'c.created_at',
      'c.updated_at',
      'w.hd as source_workspace_hd',
      'creator.email as created_by_email',
      sql<string>`coalesce(w.name, w.hd)`.as('source_workspace_name'),
      eb
        .selectFrom('shareables')
        .select((sqb) => sqb.fn.count<number>('shareables.id').as('count'))
        .whereRef('shareables.container_id', '=', 'c.id')
        .where((predicateEb) =>
          visibleSharedProjectShareableToViewer(predicateEb, viewer),
        )
        .as('file_count'),
      eb
        .selectFrom('shareables')
        .select((sqb) =>
          sqb.fn.max<string>('shareables.updated_at').as('updated_at'),
        )
        .whereRef('shareables.container_id', '=', 'c.id')
        .where((predicateEb) =>
          visibleSharedProjectShareableToViewer(predicateEb, viewer),
        )
        .as('file_updated_at'),
    ])
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('project_share_defaults as d')
          .select('d.id')
          .whereRef('d.project_container_id', '=', 'c.id')
          .where(lowerEmail('d.email'), '=', grantMatchEmail(viewer)),
      ),
    )
}

// Projects from other workspaces that the viewer reaches as an audience member.
// Excludes the viewer's own workspace so in-workspace projects are not listed
// twice (they already come from listWorkspaceProjects).
export async function listSharedProjects(
  db: Kysely<DB>,
  viewer: { email: string; emailVerified: boolean; workspaceId: string },
): Promise<SharedProjectSummary[]> {
  const rows = await sharedProjectSummaryQuery(db, viewer)
    .where('c.workspace_id', '!=', viewer.workspaceId)
    .orderBy('file_updated_at', 'desc')
    .orderBy('c.created_at', 'desc')
    .execute()

  return rows.map(toSharedProjectSummary)
}

// Resolve a single project by id for an audience member, regardless of which
// workspace it belongs to. Returns null unless the viewer is an audience member.
// The project page tries findWorkspaceProject first, so this only resolves the
// cross-workspace case in practice.
export async function findSharedProjectForViewer(
  db: Kysely<DB>,
  projectId: string,
  viewer: { email: string; emailVerified: boolean },
): Promise<SharedProjectSummary | null> {
  const row = await sharedProjectSummaryQuery(db, viewer)
    .where('c.id', '=', projectId)
    .executeTakeFirst()

  return row ? toSharedProjectSummary(row) : null
}

export async function getProjectShareRoleForEmail(
  db: Kysely<DB>,
  projectId: string,
  email: string,
): Promise<ProjectShareRole | null> {
  const row = await db
    .selectFrom('project_share_defaults as d')
    .innerJoin('artifact_containers as c', 'c.id', 'd.project_container_id')
    .select('d.role')
    .where('d.project_container_id', '=', projectId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where(lowerEmail('d.email'), '=', normalizeGrantEmail(email))
    .executeTakeFirst()

  return row?.role ?? null
}

// 関係者の増減が見える範囲を変える成果物 (visibility='project') の件数。
// 関係者編集の確認に出す影響範囲を、社内向け / 共有向けの loader で共有する。
export async function countProjectVisibilityArtifacts(
  db: Kysely<DB>,
  projectId: string,
): Promise<number> {
  const row = await db
    .selectFrom('shareables')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('container_id', '=', projectId)
    .where('visibility', '=', 'project')
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

export async function getProjectContainerWorkspaceId(
  db: Kysely<DB>,
  projectId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('artifact_containers')
    .select('workspace_id')
    .where('id', '=', projectId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()

  return row?.workspace_id ?? null
}

// Runs on every project page load, so the admin check is folded into the
// container read as a leftJoin to keep it a single round-trip. The rarer
// loadProjectForManagement instead calls isTeamWorkspaceAdmin (an extra query only
// for non-creators), which is why these two share-nothing on the lookup.
export async function canEditProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  user: { id: string; email: string; emailVerified: boolean },
  options?: { managerRoleEnabled?: boolean },
): Promise<boolean> {
  // The manager role is granted by email, so only a verified email can claim it
  // (creator / workspace-admin below are id-based and unaffected). null never
  // matches the join, so an unverified manager-email is ignored.
  const managerEmail = user.emailVerified
    ? normalizeGrantEmail(user.email)
    : null
  const row = await db
    .selectFrom('artifact_containers as c')
    .innerJoin('workspaces as w', 'w.id', 'c.workspace_id')
    .leftJoin('workspace_members as a', (join) =>
      join
        .onRef('a.workspace_id', '=', 'c.workspace_id')
        .on('a.user_id', '=', user.id)
        .on('a.role', 'in', ['owner', 'admin'])
        .on('a.status', '=', 'active'),
    )
    .leftJoin('project_share_defaults as m', (join) =>
      join
        .onRef('m.project_container_id', '=', 'c.id')
        .on('m.role', '=', 'manager')
        .on(lowerEmail('m.email'), '=', managerEmail),
    )
    .select([
      'c.created_by_id',
      'a.user_id as admin_user_id',
      'w.plan as workspace_plan',
      'm.id as manager_id',
    ])
    .where('c.id', '=', projectId)
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .executeTakeFirst()

  return Boolean(
    row &&
    (row.created_by_id === user.id ||
      (row.admin_user_id === user.id && row.workspace_plan === 'team') ||
      (options?.managerRoleEnabled === true && row.manager_id != null)),
  )
}

export async function listProjectShareDefaults(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  workspaceHd?: string | null,
): Promise<ProjectShareDefault[]> {
  const rows = await db
    .selectFrom('project_share_defaults as d')
    .innerJoin('artifact_containers as c', 'c.id', 'd.project_container_id')
    // 保存値の大文字小文字は DB 制約では保証されないので、user プロフィール解決の
    // join も両側を小文字化して照合する (素の等価だと大文字混じり行で user=null になる)。
    .leftJoin('users as u', (join) =>
      join.on(
        sql<boolean>`${lowerEmail('u.email')} = ${lowerEmail('d.email')}`,
      ),
    )
    .select([
      'd.id',
      'd.email',
      'd.created_at',
      'd.role',
      'u.id as user_id',
      'u.name as user_name',
      'u.image as user_image',
      'u.kind as user_kind',
    ])
    .where('d.project_container_id', '=', projectId)
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .orderBy('d.email', 'asc')
    .execute()

  return rows.map((row) => toProjectShareDefault(row, workspaceHd))
}

// 関係者の追加・削除を 1 回でまとめて反映する。上限は変更を加える前に判定して、
// 超過時に削除だけ適用されて部分的に反映される事故を避ける。
export async function saveProjectShareDefaults(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  createdById: string,
  payload: {
    addEmails?: ReadonlyArray<string>
    addEntries?: ReadonlyArray<{ email: string; role: ProjectShareRole }>
    removeEmails?: ReadonlyArray<string>
    roleChanges?: ReadonlyArray<{ email: string; role: ProjectShareRole }>
  },
  ownerEmail?: string | null,
  options?: { allowNonViewerRoles?: boolean },
): Promise<
  | 'ok'
  | 'not-found'
  | 'too-many'
  | 'role-not-allowed'
  | 'bot-stopped-grant-rejected'
  | 'bot-grant-role-invalid'
  | 'bot-grant-workspace-invalid'
  | 'grant-target-invalid'
> {
  const project = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('id', '=', projectId)
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!project) return 'not-found'

  if (options?.allowNonViewerRoles === false) {
    for (const entry of payload.addEntries ?? []) {
      if (entry.role !== 'viewer') return 'role-not-allowed'
    }
    for (const change of payload.roleChanges ?? []) {
      if (change.role !== 'viewer') return 'role-not-allowed'
    }
  }

  // 関係者の照合は live (visibility='project' の認可で都度引く) なので、保存時に
  // 小文字化して、照合側の lower 比較とずれないようにする。owner は自分を関係者に
  // 入れられないので除外する。
  const owner = normalizeGrantEmail(ownerEmail)
  const addMap = new Map<string, ProjectShareRole>()
  for (const email of normalizeGrantEmailList(
    payload.addEmails ?? [],
    ownerEmail,
  )) {
    addMap.set(email, 'viewer')
  }
  for (const entry of payload.addEntries ?? []) {
    const email = normalizeGrantEmail(entry.email)
    if (!isValidGrantEmail(email) || email === owner) continue
    addMap.set(email, entry.role)
  }
  const removeEmails = normalizeGrantEmailList(
    payload.removeEmails ?? [],
    ownerEmail,
  ).filter((email) => !addMap.has(email))

  const roleChangeMap = new Map<string, ProjectShareRole>()
  const removeSet = new Set(removeEmails)
  for (const change of payload.roleChanges ?? []) {
    const email = normalizeGrantEmail(change.email)
    if (!email || email === owner || removeSet.has(email)) continue
    roleChangeMap.set(email, change.role)
  }

  // 削除を適用する前に上限を判定する (削除後に too-many を返すと部分反映になる)。
  const existing = await db
    .selectFrom('project_share_defaults')
    .select('email')
    .where('project_container_id', '=', projectId)
    .execute()
  // 保存値の大文字小文字は保証されないので、追加・削除・件数の照合キーは
  // normalizeGrantEmail にそろえる (素の row.email だと大文字違いで論理重複行を
  // 作れる: UNIQUE(project_container_id, email) は case-sensitive)。
  // 保存値の大文字小文字は保証されないので、追加・削除・件数の照合キーは
  // normalizeGrantEmail にそろえる (素の row.email だと大文字違いで論理重複行を
  // 作れる: UNIQUE(project_container_id, email) は case-sensitive)。
  const existingEmails = new Set(
    existing.map((row) => normalizeGrantEmail(row.email)),
  )
  const remainingCount = [...existingEmails].filter(
    (email) => !removeSet.has(email),
  ).length
  const toInsert = [...addMap.keys()].filter(
    (email) => !existingEmails.has(email),
  )
  if (remainingCount + toInsert.length > MAX_GRANT_EMAILS) {
    return 'too-many'
  }

  // Bot guard: every grant mutation that targets a bot user passes through
  // these checks — a copied bot email typed directly must behave like the
  // candidate picker. Non-user emails stay allowed (sharing to non-users is
  // an existing feature).
  const grantTargets = [...new Set([...toInsert, ...roleChangeMap.keys()])]
  // Chunked: grantTargets can reach ~150 emails, past the 100-parameter
  // budget the routes were sized against.
  const botTargets: {
    email: string
    workspace_id: string
    bot_stopped_at: string | null
  }[] = []
  for (let i = 0; i < grantTargets.length; i += 80) {
    const chunk = grantTargets.slice(i, i + 80)
    botTargets.push(
      ...(await db
        .selectFrom('users')
        .select(['email', 'workspace_id', 'bot_stopped_at'])
        .where('kind', '=', 'bot')
        .where(lowerEmail('email'), 'in', chunk)
        .execute()),
    )
  }
  const botEmails = new Set(
    botTargets.map((row) => normalizeGrantEmail(row.email)),
  )
  for (const bot of botTargets) {
    const email = normalizeGrantEmail(bot.email)
    if (bot.bot_stopped_at !== null) return 'bot-stopped-grant-rejected'
    if (bot.workspace_id !== workspaceId) return 'bot-grant-workspace-invalid'
    const role = addMap.get(email) ?? roleChangeMap.get(email)
    if (role === 'manager') return 'bot-grant-role-invalid'
  }
  // A bot role change must reference an existing grant row. Validating this
  // BEFORE the batch keeps the failure from arriving after unrelated
  // statements committed (a post-batch 400 with partial effects).
  const botRoleChangeTargets = [...roleChangeMap.keys()].filter((email) =>
    botEmails.has(email),
  )
  if (botRoleChangeTargets.length > 0) {
    const currentBotRows = await db
      .selectFrom('project_share_defaults')
      .select('email')
      .where('project_container_id', '=', projectId)
      .where(lowerEmail('email'), 'in', botRoleChangeTargets)
      .execute()
    const currentBotEmails = new Set(
      currentBotRows.map((row) => normalizeGrantEmail(row.email)),
    )
    if (botRoleChangeTargets.some((email) => !currentBotEmails.has(email))) {
      return 'grant-target-invalid'
    }
  }
  // Commit-time condition: when the save targets any bot, EVERY statement in
  // the batch (bot- and human-directed alike) only lands while all bot targets
  // are still active workspace members, closing the
  // `grant pre-read → stop commit → grant write` race. One shared predicate on
  // every statement plus the D1 batch makes the bulk save all-or-nothing: a
  // concurrent stop suppresses the whole save, never a partial subset.
  const botEmailList = [...botEmails]
  const activeBotGuard =
    botEmailList.length > 0
      ? sql<boolean>`(
          SELECT COUNT(*) FROM users
          WHERE ${lowerEmail('users.email')} IN (${sql.join(botEmailList.map((email) => sql`${email}`))})
            AND users.kind = 'bot'
            AND users.bot_stopped_at IS NULL
            AND EXISTS (
              SELECT 1 FROM workspace_members
              WHERE workspace_members.user_id = users.id
                AND workspace_members.workspace_id = ${workspaceId}
                AND workspace_members.status = 'active'
            )
        ) = ${botEmailList.length}`
      : null

  const statements: Compilable<unknown>[] = []
  if (removeEmails.length > 0) {
    let remove = db
      .deleteFrom('project_share_defaults')
      .where('project_container_id', '=', projectId)
      .where(lowerEmail('email'), 'in', removeEmails)
    if (activeBotGuard) remove = remove.where(activeBotGuard)
    statements.push(remove)
  }

  if (toInsert.length > 0) {
    const now = nowIso()
    for (const email of toInsert) {
      const values = {
        id: nanoid(),
        project_container_id: projectId,
        email,
        role: addMap.get(email)!,
        display_name: null,
        created_by_id: createdById,
        created_at: now,
        updated_at: now,
      }
      const insert = activeBotGuard
        ? db
            .insertInto('project_share_defaults')
            .columns(Object.keys(values) as (keyof typeof values)[])
            .expression((eb) =>
              eb
                .selectFrom('artifact_containers')
                .where('artifact_containers.id', '=', projectId)
                .where(activeBotGuard)
                .select(
                  Object.entries(values).map(([column, value]) =>
                    eb.val(value).as(column),
                  ),
                ),
            )
        : db.insertInto('project_share_defaults').values(values)
      statements.push(
        insert.onConflict((oc) =>
          oc.columns(['project_container_id', 'email']).doNothing(),
        ),
      )
    }
  }

  if (roleChangeMap.size > 0) {
    const now = nowIso()
    for (const [email, role] of roleChangeMap) {
      let update = db
        .updateTable('project_share_defaults')
        .set({ role, updated_at: now })
        .where('project_container_id', '=', projectId)
        .where(lowerEmail('email'), '=', email)
      if (activeBotGuard) {
        update = update.where(activeBotGuard)
      }
      statements.push(update)
    }
  }

  if (statements.length > 0) await runD1Batch(...statements)

  // Detect bot-directed writes that committed 0 rows (stop won the race):
  // never report success for a grant that did not land. Existence alone is not
  // enough — a role change suppressed by the guard leaves the old row in
  // place — so verify the committed role equals the requested role (and, for
  // revokes, that the row is gone).
  if (botEmailList.length > 0) {
    const grantWrites = [
      ...new Set(
        [...toInsert, ...roleChangeMap.keys()].filter((email) =>
          botEmails.has(email),
        ),
      ),
    ]
    // The guard fires exactly when a targeted bot is stopped, and when it
    // fires it suppresses EVERY statement in the batch (including unrelated
    // human removals). Role-value comparison alone can pass coincidentally
    // (e.g. a no-op role change), so detect suppression directly from the
    // guard's own condition: a targeted bot with bot_stopped_at set.
    if (grantWrites.length > 0) {
      const stopped = await db
        .selectFrom('users')
        .select('users.id')
        .where(lowerEmail('users.email'), 'in', grantWrites)
        .where('users.kind', '=', 'bot')
        .where('users.bot_stopped_at', 'is not', null)
        .executeTakeFirst()
      if (stopped) return 'bot-stopped-grant-rejected'
      const committed = await db
        .selectFrom('project_share_defaults')
        .select(['email', 'role'])
        .where('project_container_id', '=', projectId)
        .where(lowerEmail('email'), 'in', grantWrites)
        .execute()
      const committedRoles = new Map(
        committed.map((row) => [normalizeGrantEmail(row.email), row.role]),
      )
      const mismatch = grantWrites.some((email) => {
        // The batch applies role updates AFTER inserts, so for an email in
        // both lists the update's role is the committed one.
        const expected = roleChangeMap.get(email) ?? addMap.get(email)
        return committedRoles.get(email) !== expected
      })
      // Running bot, write did not land: a no-op change on a grant row that
      // never existed, not a stop race.
      if (mismatch) return 'grant-target-invalid'
    }
  }

  return 'ok'
}

// A project's audience emails, regardless of archive state, sorted. The MCP
// edit_project response needs only the emails (no avatar / user join) and must
// read them even right after the same call archived the project, so this skips
// the active-only filter that listProjectShareDefaults applies.
export async function listProjectAudienceEmails(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('project_share_defaults as d')
    .innerJoin('artifact_containers as c', 'c.id', 'd.project_container_id')
    .select('d.email')
    .where('d.project_container_id', '=', projectId)
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .orderBy('d.email', 'asc')
    .execute()
  return rows.map((row) => row.email)
}

// ステージング中の関係者にアバターと名前を出すための email → user 解決。
// 個別共有の lookupGrantUsers に対応する、プロジェクト編集権限つきの版。
export async function lookupProjectShareDefaultUsers(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  user: { id: string; email: string; emailVerified: boolean },
  emails: ReadonlyArray<string>,
  options?: { managerRoleEnabled?: boolean },
): Promise<
  | {
      kind: 'ok'
      entries: { email: string; user: ProjectShareDefault['user'] }[]
    }
  | { kind: 'not-found' }
> {
  const canEdit = await canEditProjectContainer(
    db,
    workspaceId,
    projectId,
    user,
    options,
  )
  if (!canEdit) return { kind: 'not-found' }

  const normalized = normalizeGrantEmailList(emails)
  if (normalized.length === 0) return { kind: 'ok', entries: [] }

  return {
    kind: 'ok',
    entries: await resolveGrantUsersByEmail(db, normalized),
  }
}

export type CreateProjectContainerResult =
  | { kind: 'ok'; id: string }
  | { kind: 'project-limit-reached'; limit: number }

export async function createProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  createdById: string,
  input: {
    name: string
    description: string | null
    baseVisibility: ProjectBaseVisibility
  },
): Promise<CreateProjectContainerResult> {
  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  const limit = projectLimitForPlan(workspace?.plan)
  const now = nowIso()
  const id = nanoid()

  if (limit !== null) {
    const result = await sql`
      INSERT INTO artifact_containers (
        id,
        workspace_id,
        kind,
        owner_user_id,
        created_by_id,
        name,
        description,
        base_visibility,
        archived_at,
        created_at,
        updated_at
      )
      SELECT
        ${id},
        ${workspaceId},
        'project',
        NULL,
        ${createdById},
        ${input.name},
        ${input.description},
        ${input.baseVisibility},
        NULL,
        ${now},
        ${now}
      WHERE (
        SELECT COUNT(*)
        FROM artifact_containers
        WHERE workspace_id = ${workspaceId}
          AND kind = 'project'
          AND archived_at IS NULL
      ) < ${limit}
    `.execute(db)
    if (Number(result.numAffectedRows ?? 0n) === 0) {
      return { kind: 'project-limit-reached', limit }
    }
    await insertCreatorMembershipOrRollback(db, id, createdById, now)
    return { kind: 'ok', id }
  }

  await db
    .insertInto('artifact_containers')
    .values({
      id,
      workspace_id: workspaceId,
      kind: 'project',
      owner_user_id: null,
      created_by_id: createdById,
      name: input.name,
      description: input.description,
      base_visibility: input.baseVisibility,
      archived_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  await insertCreatorMembershipOrRollback(db, id, createdById, now)
  return { kind: 'ok', id }
}

// 作成 = 自動参加。D1 は transaction 非対応のため、参加行の INSERT に失敗したら
// 直前に作った container を削除して整合を保つ (補償)。
async function insertCreatorMembershipOrRollback(
  db: Kysely<DB>,
  containerId: string,
  createdById: string,
  now: string,
) {
  try {
    await db
      .insertInto('project_members')
      .values({
        container_id: containerId,
        user_id: createdById,
        joined_at: now,
        last_seen_at: now,
      })
      .execute()
  } catch (error) {
    await db
      .deleteFrom('artifact_containers')
      .where('id', '=', containerId)
      .execute()
      .catch(() => {})
    throw error
  }
}

export async function updateProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  input: {
    name: string
    description: string | null
    baseVisibility: ProjectBaseVisibility
  },
): Promise<ProjectSummary | null> {
  const now = nowIso()
  const result = await db
    .updateTable('artifact_containers')
    .set({
      name: input.name,
      description: input.description,
      base_visibility: input.baseVisibility,
      updated_at: now,
    })
    .where('id', '=', projectId)
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (Number(result.numUpdatedRows ?? 0n) !== 1) return null
  return await findWorkspaceProject(db, workspaceId, projectId)
}

export type ProjectArchiveResult = 'ok' | 'not-found' | 'forbidden'

export type ProjectUnarchiveResult =
  | ProjectArchiveResult
  | { kind: 'project-limit-reached'; limit: number }
export type ProjectDeleteResult =
  | 'ok'
  | 'not-found'
  | 'forbidden'
  | 'not-empty'
  | { kind: 'has-agent-credentials'; holderName: string | null }

export type EditProjectContainerSettingsInput = {
  name?: string | undefined
  description?: string | undefined
  baseVisibility?: ProjectBaseVisibility | undefined
  addEmails?: string[] | undefined
  removeEmails?: string[] | undefined
  archived?: boolean | undefined
}

export type EditProjectContainerSettingsResult =
  | { kind: 'ok'; project: ProjectSummary; audience: string[] }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'project-archived' }
  | { kind: 'project-limit-reached'; limit: number }
  | { kind: 'too-many-grants' }
  | { kind: 'validation-failed' }
  | { kind: 'bot-grant-rejected'; code: string }

export async function editProjectContainerSettings(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  user: { id: string; email: string; emailVerified: boolean },
  input: EditProjectContainerSettingsInput,
): Promise<EditProjectContainerSettingsResult> {
  const current = await findWorkspaceProjectAnyState(
    db,
    workspaceId,
    projectId,
    user,
  )
  if (!current) return { kind: 'not-found' }

  if (input.archived === false) {
    const result = await unarchiveProjectContainer(
      db,
      workspaceId,
      projectId,
      user.id,
    )
    if (result === 'not-found') return { kind: 'not-found' }
    if (result === 'forbidden') return { kind: 'forbidden' }
    if (result !== 'ok') return result
  }

  const wantsMetadata =
    input.name !== undefined ||
    input.description !== undefined ||
    input.baseVisibility !== undefined
  const wantsAudience =
    input.addEmails !== undefined || input.removeEmails !== undefined

  if (wantsMetadata || wantsAudience) {
    if (current.archivedAt !== null && input.archived !== false) {
      return { kind: 'project-archived' }
    }
    const canEdit = await canEditProjectContainer(
      db,
      workspaceId,
      projectId,
      user,
    )
    if (!canEdit) return { kind: 'forbidden' }

    if (wantsMetadata) {
      const name =
        input.name !== undefined
          ? normalizeProjectName(input.name)
          : current.name
      if (!name) return { kind: 'validation-failed' }
      const description =
        input.description !== undefined
          ? normalizeProjectDescription(input.description)
          : current.description
      const baseVisibility =
        input.baseVisibility !== undefined
          ? input.baseVisibility
          : current.baseVisibility
      const updated = await updateProjectContainer(db, workspaceId, projectId, {
        name,
        description,
        baseVisibility,
      })
      if (!updated) return { kind: 'not-found' }
    }

    if (wantsAudience) {
      const result = await saveProjectShareDefaults(
        db,
        workspaceId,
        projectId,
        user.id,
        { addEmails: input.addEmails, removeEmails: input.removeEmails },
        user.email,
      )
      if (result === 'not-found') return { kind: 'not-found' }
      if (result === 'too-many') return { kind: 'too-many-grants' }
      if (result === 'role-not-allowed') return { kind: 'validation-failed' }
      if (result !== 'ok') {
        // Bot-guard failures (stopped bot, invalid role, cross-workspace,
        // suppressed write) must not be reported as success.
        return { kind: 'bot-grant-rejected', code: result }
      }
    }
  }

  if (input.archived === true) {
    const result = await archiveProjectContainer(
      db,
      workspaceId,
      projectId,
      user.id,
    )
    if (result === 'not-found') return { kind: 'not-found' }
    if (result === 'forbidden') return { kind: 'forbidden' }
  }

  const [after, audience] = await Promise.all([
    findWorkspaceProjectAnyState(db, workspaceId, projectId, user),
    listProjectAudienceEmails(db, workspaceId, projectId),
  ])
  return { kind: 'ok', project: after ?? current, audience }
}

// Archive, unarchive, and delete target projects regardless of their archived
// state, so they cannot use canEditProjectContainer (which filters
// archived_at IS NULL). This loads the creator + admin flag + current archive
// state in one read so each mutation can gate and check preconditions itself.
async function loadProjectForManagement(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  userId: string,
): Promise<{ canManage: boolean; archivedAt: string | null } | null> {
  const row = await db
    .selectFrom('artifact_containers as c')
    .select(['c.created_by_id', 'c.archived_at'])
    .where('c.id', '=', projectId)
    .where('c.workspace_id', '=', workspaceId)
    .where('c.kind', '=', 'project')
    .executeTakeFirst()
  if (!row) return null
  const canManage =
    row.created_by_id === userId ||
    (await isTeamWorkspaceAdmin(db, { id: userId, workspaceId }, workspaceId))
  return { canManage, archivedAt: row.archived_at }
}

export async function archiveProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  userId: string,
): Promise<ProjectArchiveResult> {
  const project = await loadProjectForManagement(
    db,
    workspaceId,
    projectId,
    userId,
  )
  if (!project) return 'not-found'
  if (!project.canManage) return 'forbidden'
  if (project.archivedAt !== null) return 'ok' // already archived

  const now = nowIso()
  await db
    .updateTable('artifact_containers')
    .set({ archived_at: now, updated_at: now })
    .where('id', '=', projectId)
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  return 'ok'
}

export async function unarchiveProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  userId: string,
): Promise<ProjectUnarchiveResult> {
  const project = await loadProjectForManagement(
    db,
    workspaceId,
    projectId,
    userId,
  )
  if (!project) return 'not-found'
  if (!project.canManage) return 'forbidden'
  if (project.archivedAt === null) return 'ok' // already active

  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  const limit = projectLimitForPlan(workspace?.plan)
  const now = nowIso()

  if (limit !== null) {
    const result = await sql`
      UPDATE artifact_containers
      SET archived_at = NULL, updated_at = ${now}
      WHERE id = ${projectId}
        AND workspace_id = ${workspaceId}
        AND kind = 'project'
        AND archived_at IS NOT NULL
        AND (
          SELECT COUNT(*)
          FROM artifact_containers
          WHERE workspace_id = ${workspaceId}
            AND kind = 'project'
            AND archived_at IS NULL
        ) < ${limit}
    `.execute(db)
    if (Number(result.numAffectedRows ?? 0n) === 0) {
      return { kind: 'project-limit-reached', limit }
    }
    return 'ok'
  }

  await db
    .updateTable('artifact_containers')
    .set({ archived_at: null, updated_at: now })
    .where('id', '=', projectId)
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is not', null)
    .executeTakeFirst()
  return 'ok'
}

// The 0031 trigger aborts a delete when the container still holds shareables.
function isContainerNotEmptyTriggerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(
    'artifact_containers with shareables cannot be deleted',
  )
}

// cli_family_authorities.project_id and cli_session_authorities.project_id
// reference artifact_containers ON DELETE RESTRICT, so a lingering agent
// credential row blocks project deletion at the FK level.
function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return String(error).includes('FOREIGN KEY constraint failed')
  }
  // D1 can wrap the SQLite text so it only appears on error.cause.
  return (
    error.message.includes('FOREIGN KEY constraint failed') ||
    (error.cause instanceof Error &&
      error.cause.message.includes('FOREIGN KEY constraint failed'))
  )
}

// A family is live when it still has a usable credential or a linked live
// session — the same predicate listCliRefreshCredentialFamilies applies.
// Everything else (expired, revoked, sessionless) is non-live and must not
// keep a project undeletable.
const liveFamilySql = (now: string) => sql<number>`
  EXISTS (
    SELECT 1 FROM cli_refresh_credentials AS credential
    WHERE credential.family_id = fa.family_id
      AND credential.revoked_at IS NULL
      AND credential.expires_at > ${now}
  )
  OR EXISTS (
    SELECT 1 FROM cli_refresh_sessions AS link
    JOIN sessions ON sessions.id = link.session_id
    WHERE link.family_id = fa.family_id
      AND sessions.expires_at > ${now}
  )
`

// Name of a user whose LIVE agent credential (family or bootstrap) still
// targets the project, or null when none does. Callers are already authorized
// to delete the project, so returning the holder name does not widen access.
async function findLiveAgentCredentialHolder(
  db: Kysely<DB>,
  projectId: string,
  now: string,
): Promise<{ found: boolean; holderName: string | null }> {
  const family = await sql<{ name: string | null }>`
    SELECT users.name AS name
    FROM cli_family_authorities AS fa
    JOIN users ON users.id = fa.user_id
    WHERE fa.project_id = ${projectId}
      AND (${liveFamilySql(now)})
    LIMIT 1
  `.execute(db)
  if (family.rows.length > 0) {
    return { found: true, holderName: family.rows[0]?.name ?? null }
  }
  const bootstrap = await sql<{ name: string | null }>`
    SELECT users.name AS name
    FROM cli_session_authorities AS sa
    JOIN sessions ON sessions.id = sa.session_id
    JOIN users ON users.id = sessions.user_id
    WHERE sa.project_id = ${projectId}
      AND sa.family_id IS NULL
      AND sa.expires_at > ${now}
      AND sessions.expires_at > ${now}
    LIMIT 1
  `.execute(db)
  if (bootstrap.rows.length > 0) {
    return { found: true, holderName: bootstrap.rows[0]?.name ?? null }
  }
  return { found: false, holderName: null }
}

// Detach non-live agent credential rows from the project so the FK RESTRICT
// no longer blocks the delete. project_name_snapshot is kept so credential
// listings can still show what the credential used to target.
async function detachNonLiveAgentCredentials(
  db: Kysely<DB>,
  projectId: string,
  now: string,
): Promise<void> {
  await sql`
    UPDATE cli_family_authorities
    SET project_id = NULL
    WHERE project_id = ${projectId}
      AND NOT EXISTS (
        SELECT 1 FROM cli_family_authorities AS fa
        WHERE fa.family_id = cli_family_authorities.family_id
          AND (${liveFamilySql(now)})
      )
  `.execute(db)
  await sql`
    UPDATE cli_session_authorities
    SET project_id = NULL
    WHERE project_id = ${projectId}
      AND NOT (
        family_id IS NULL
        AND expires_at > ${now}
        AND EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.id = cli_session_authorities.session_id
            AND sessions.expires_at > ${now}
        )
      )
      AND NOT (
        family_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM cli_family_authorities AS fa
          WHERE fa.family_id = cli_session_authorities.family_id
            AND (${liveFamilySql(now)})
        )
      )
  `.execute(db)
}

export async function deleteProjectContainer(
  db: Kysely<DB>,
  workspaceId: string,
  projectId: string,
  userId: string,
): Promise<ProjectDeleteResult> {
  const project = await loadProjectForManagement(
    db,
    workspaceId,
    projectId,
    userId,
  )
  if (!project) return 'not-found'
  if (!project.canManage) return 'forbidden'

  // The emptiness gate counts every shareable in the container regardless of
  // visibility, matching the 0031 trigger. The viewer-scoped file_count in
  // summaries must not decide deletion: a manager who cannot see another user's
  // private file could otherwise delete a container that still holds it.
  const occupant = await db
    .selectFrom('shareables')
    .select('id')
    .where('container_id', '=', projectId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst()
  if (occupant) return 'not-empty'

  // Agent CLI credentials reference the project with ON DELETE RESTRICT. A
  // live credential blocks deletion with a typed error; non-live ones are
  // detached (project_id set to NULL) so they stop pinning the project. The
  // detach commits even when the later DELETE fails — accepted, since the
  // snapshot name is retained and a non-live credential cannot act anyway.
  const now = nowIso()
  const live = await findLiveAgentCredentialHolder(db, projectId, now)
  if (live.found) {
    return { kind: 'has-agent-credentials', holderName: live.holderName }
  }
  await detachNonLiveAgentCredentials(db, projectId, now)

  // project_share_defaults rows cascade with the container row.
  try {
    const result = await db
      .deleteFrom('artifact_containers')
      .where('id', '=', projectId)
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'project')
      .executeTakeFirst()
    if (Number(result.numDeletedRows ?? 0n) !== 1) return 'not-found'
    return 'ok'
  } catch (error) {
    // A shareable inserted or moved in after the check above trips the trigger.
    if (isContainerNotEmptyTriggerError(error)) return 'not-empty'
    // A credential created or rotated between the detach above and the DELETE
    // trips the FK RESTRICT; report it the same way as a live credential.
    if (isForeignKeyConstraintError(error)) {
      const raced = await findLiveAgentCredentialHolder(db, projectId, nowIso())
      return { kind: 'has-agent-credentials', holderName: raced.holderName }
    }
    throw error
  }
}

async function resolveCrossWorkspaceProjectContainer(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
  },
  containerId: string,
): Promise<
  | {
      kind: 'ok'
      containerId: string
      containerKind: 'project'
      workspaceId: string
      isExternalPosting: true
    }
  | { kind: 'invalid-container' }
> {
  // Cross-workspace posting is an email-grant (contributor/manager) authorization,
  // so only a verified email may claim it — unverified resolves to no container.
  const email = user.emailVerified ? normalizeGrantEmail(user.email) : null
  if (!email) return { kind: 'invalid-container' }

  const project = await db
    .selectFrom('artifact_containers as c')
    .select(['c.id', 'c.workspace_id'])
    .where('c.id', '=', containerId)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where('c.workspace_id', '!=', user.workspaceId)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('project_share_defaults as d')
          .select('d.id')
          .whereRef('d.project_container_id', '=', 'c.id')
          .where(lowerEmail('d.email'), '=', email)
          .where('d.role', 'in', ['contributor', 'manager']),
      ),
    )
    .executeTakeFirst()
  if (!project) return { kind: 'invalid-container' }

  if (!(await isExternalPostingAllowedForWorkspace(db, project.workspace_id))) {
    return { kind: 'invalid-container' }
  }

  return {
    kind: 'ok',
    containerId: project.id,
    containerKind: 'project',
    workspaceId: project.workspace_id,
    isExternalPosting: true,
  }
}

export async function resolveUploadContainer(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
  },
  containerId: string | null,
  now: string,
): Promise<
  | {
      kind: 'ok'
      containerId: string
      containerKind: 'inbox' | 'project'
      workspaceId: string
      isExternalPosting: boolean
    }
  | { kind: 'invalid-container' }
> {
  if (!containerId) {
    return {
      kind: 'ok',
      containerId: await getOrCreateInboxContainerId(
        db,
        user.workspaceId,
        user.id,
        now,
      ),
      containerKind: 'inbox',
      workspaceId: user.workspaceId,
      isExternalPosting: false,
    }
  }

  const project = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('id', '=', containerId)
    .where('workspace_id', '=', user.workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!project) {
    return resolveCrossWorkspaceProjectContainer(db, user, containerId)
  }

  return {
    kind: 'ok',
    containerId: project.id,
    containerKind: 'project',
    workspaceId: user.workspaceId,
    isExternalPosting: false,
  }
}

import { sql, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import { grantMatchEmail } from './access.server'
import {
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
} from './projects.server'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'

type Db = Kysely<DB>
export type MembershipResult = 'joined' | 'left' | 'not-found' | 'forbidden'
export type ProjectMembershipRow = {
  id: string
  name: string
  description: string | null
  baseVisibility: 'workspace' | 'private'
  fileCount: number
  updatedAt: string | null
  newCount: number
  hasExternal: boolean
  archivedAt: string | null
  workspaceId?: string
  shared?: boolean
}

// 社外ドメイン判定の SQL 片 (app/lib/grant-emails.ts の isExternalEmail と同じ意味)。
// d = project_share_defaults, w = workspaces の別名を前提にする。3 箇所目を作らず
// これを参照する
export const externalGrantDomainSql = sql<boolean>`w.hd is not null and w.hd <> '' and instr(d.email,'@') > 0 and lower(substr(d.email, instr(d.email,'@')+1)) <> lower(w.hd)`

// c = artifact_containers の別名を前提にする。プロジェクト一覧と、所属先を
// 返してよいか判定する resource route で同じ可視性を使う。
export function visibleProjectContainerToViewerSql(user: SessionUser) {
  return sql<boolean>`(
    c.archived_at IS NULL
    AND (
      (
        c.workspace_id = ${user.workspaceId}
        AND (
          c.base_visibility = 'workspace'
          OR c.created_by_id = ${user.id}
          OR EXISTS (
            SELECT 1 FROM project_share_defaults d
            WHERE d.project_container_id = c.id
              AND ${lowerEmail('d.email')} = ${grantMatchEmail(user)}
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_members wm
            INNER JOIN workspaces w2 ON w2.id = wm.workspace_id
            WHERE wm.workspace_id = c.workspace_id
              AND wm.user_id = ${user.id}
              AND wm.role IN ('owner', 'admin')
              AND wm.status = 'active'
              AND w2.plan = 'team'
          )
        )
      )
      OR (
        c.workspace_id <> ${user.workspaceId}
        AND EXISTS (
          SELECT 1 FROM project_share_defaults d
          WHERE d.project_container_id = c.id
            AND ${lowerEmail('d.email')} = ${grantMatchEmail(user)}
        )
      )
    )
  )`
}

async function accessibleProject(db: Db, id: string, user: SessionUser) {
  return await db
    .selectFrom('artifact_containers as c')
    .select(['c.id', 'c.workspace_id', 'c.base_visibility'])
    .where('c.id', '=', id)
    .where('c.kind', '=', 'project')
    .where(visibleProjectContainerToViewerSql(user))
    .executeTakeFirst()
}

export async function joinProject(
  db: Db,
  { containerId, user }: { containerId: string; user: SessionUser },
): Promise<MembershipResult> {
  const project = await accessibleProject(db, containerId, user)
  if (!project) return 'not-found'
  const now = new Date().toISOString()
  await db
    .insertInto('project_members')
    .values({
      container_id: containerId,
      user_id: user.id,
      joined_at: now,
      last_seen_at: now,
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
  return 'joined'
}
export async function leaveProject(
  db: Db,
  { containerId, user }: { containerId: string; user: SessionUser },
): Promise<MembershipResult> {
  const project = await accessibleProject(db, containerId, user)
  if (!project) return 'not-found'
  await db
    .deleteFrom('project_members')
    .where('container_id', '=', containerId)
    .where('user_id', '=', user.id)
    .execute()
  return 'left'
}
export async function touchProjectSeen(
  db: Db,
  { containerId, userId }: { containerId: string; userId: string },
) {
  return await db
    .updateTable('project_members')
    .set({ last_seen_at: new Date().toISOString() })
    .where('container_id', '=', containerId)
    .where('user_id', '=', userId)
    .execute()
}

export async function listProjectsForIndex(db: Db, user: SessionUser) {
  const email = grantMatchEmail(user)
  const rows = await db
    .selectFrom('artifact_containers as c')
    .select([
      'c.id',
      'c.name',
      'c.description',
      'c.base_visibility as baseVisibility',
      'c.updated_at as updatedAt',
      'c.archived_at as archivedAt',
      'c.workspace_id as workspaceId',
      // 件数は読み手に見えるファイルだけを数える (可視でない追加の存在を件数から
      // 推測させない)。自 workspace は member 述語、別 workspace は共有述語
      sql<number>`(select count(*) from shareables where shareables.container_id=c.id and ((c.workspace_id = ${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id <> ${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)})))`.as(
        'fileCount',
      ),
      sql<number>`coalesce((select count(*) from shareables where shareables.container_id=c.id and shareables.created_at > (select pm.last_seen_at from project_members pm where pm.container_id=c.id and pm.user_id=${user.id}) and shareables.owner_user_id <> ${user.id} and ((c.workspace_id = ${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id <> ${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)}))),0)`.as(
        'newCount',
      ),
      sql<number>`exists(select 1 from project_share_defaults d inner join workspaces w on w.id=c.workspace_id where d.project_container_id=c.id and ${externalGrantDomainSql})`.as(
        'hasExternal',
      ),
      sql<number>`exists(select 1 from project_members pm where pm.container_id=c.id and pm.user_id=${user.id})`.as(
        'joined',
      ),
    ])
    .where('c.kind', '=', 'project')
    .where((eb) =>
      eb.or([
        eb.and([
          eb('c.workspace_id', '=', user.workspaceId),
          eb.or([
            eb('c.base_visibility', '=', 'workspace'),
            eb('c.created_by_id', '=', user.id),
            sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
            // team workspace の owner / admin は private も見える (既存の可視性と同じ)
            sql<boolean>`exists(select 1 from workspace_members wm inner join workspaces w2 on w2.id = wm.workspace_id where wm.workspace_id=c.workspace_id and wm.user_id=${user.id} and wm.role in ('owner','admin') and wm.status='active' and w2.plan='team')`,
          ]),
        ]),
        eb.and([
          eb('c.workspace_id', '!=', user.workspaceId),
          // 別 workspace のアーカイブ済みは一覧に出さない (共有一覧・詳細 404 と同じ扱い)
          eb('c.archived_at', 'is', null),
          sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
        ]),
      ]),
    )
    .orderBy('c.updated_at', 'desc')
    .execute()
  return rows.map((r) => ({
    ...r,
    fileCount: Number(r.fileCount),
    newCount: Number(r.newCount),
    hasExternal: Boolean(r.hasExternal),
    joined: Boolean(r.joined),
  }))
}
// peek 用の単一プロジェクト解決。accessibleProject と同じ判定 + 非アーカイブのみ。
// 一覧 (listProjectsForIndex) の全走査を避け、件数は読み手に見えるファイルだけを数える
export async function getProjectForPeek(db: Db, id: string, user: SessionUser) {
  const email = grantMatchEmail(user)
  return await db
    .selectFrom('artifact_containers as c')
    .select([
      'c.id',
      'c.name',
      'c.description',
      'c.updated_at as updatedAt',
      sql<number>`(select count(*) from shareables where shareables.container_id=c.id and ((c.workspace_id = ${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id <> ${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)})))`.as(
        'fileCount',
      ),
    ])
    .where('c.id', '=', id)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('c.workspace_id', '=', user.workspaceId),
          eb.or([
            eb('c.base_visibility', '=', 'workspace'),
            eb('c.created_by_id', '=', user.id),
            sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
            sql<boolean>`exists(select 1 from workspace_members wm inner join workspaces w2 on w2.id = wm.workspace_id where wm.workspace_id=c.workspace_id and wm.user_id=${user.id} and wm.role in ('owner','admin') and wm.status='active' and w2.plan='team')`,
          ]),
        ]),
        eb.and([
          eb('c.workspace_id', '!=', user.workspaceId),
          sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
        ]),
      ]),
    )
    .executeTakeFirst()
}

export async function listJoinedProjectsForDropdown(
  db: Db,
  user: SessionUser,
  limit: number,
) {
  const email = grantMatchEmail(user)
  // 一覧全走査を避け、参加行起点で必要な列だけを SQL で limit まで取る。
  // 権限喪失した参加行は現在の閲覧権 (member / admin / 関係者) で再評価して除外
  const rows = await db
    .selectFrom('project_members as pm')
    .innerJoin('artifact_containers as c', 'c.id', 'pm.container_id')
    .innerJoin('workspaces as w', 'w.id', 'c.workspace_id')
    .select([
      'c.id',
      'c.name',
      'c.workspace_id as workspaceId',
      sql<string>`coalesce(w.name, w.hd)`.as('workspaceName'),
      'c.updated_at as updatedAt',
      sql<number>`(select count(*) from shareables where shareables.container_id=c.id and ((c.workspace_id = ${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id <> ${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)})))`.as(
        'fileCount',
      ),
      sql<number>`coalesce((select count(*) from shareables where shareables.container_id=c.id and shareables.created_at > pm.last_seen_at and shareables.owner_user_id <> ${user.id} and ((c.workspace_id = ${user.workspaceId} and ${visibleShareableToViewerSql(user)}) or (c.workspace_id <> ${user.workspaceId} and ${visibleSharedProjectShareableToViewerSql(user)}))),0)`.as(
        'newCount',
      ),
    ])
    .where('pm.user_id', '=', user.id)
    .where('c.kind', '=', 'project')
    .where('c.archived_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('c.workspace_id', '=', user.workspaceId),
          eb.or([
            eb('c.base_visibility', '=', 'workspace'),
            eb('c.created_by_id', '=', user.id),
            sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
            sql<boolean>`exists(select 1 from workspace_members wm inner join workspaces w2 on w2.id = wm.workspace_id where wm.workspace_id=c.workspace_id and wm.user_id=${user.id} and wm.role in ('owner','admin') and wm.status='active' and w2.plan='team')`,
          ]),
        ]),
        eb.and([
          eb('c.workspace_id', '!=', user.workspaceId),
          sql<boolean>`exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=${email})`,
        ]),
      ]),
    )
    .orderBy('c.updated_at', 'desc')
    .limit(limit)
    .execute()
  return rows.map((r) => ({
    ...r,
    workspaceName:
      r.workspaceId === user.workspaceId ? undefined : r.workspaceName,
    fileCount: Number(r.fileCount),
    newCount: Number(r.newCount),
  }))
}
// 現在の閲覧権を持つ参加者だけを数える: 同 workspace のメンバーは base='workspace' か
// 作成者か関係者、別 workspace の参加者は検証済みメールの関係者のみ。
export async function countProjectParticipants(db: Db, containerId: string) {
  const row = await db
    .selectFrom('project_members as pm')
    .innerJoin('users as u', 'u.id', 'pm.user_id')
    .innerJoin('artifact_containers as c', 'c.id', 'pm.container_id')
    .select(sql<number>`count(*)`.as('count'))
    .where('pm.container_id', '=', containerId)
    .where(
      sql<boolean>`(
        (u.workspace_id = c.workspace_id AND (
          c.base_visibility = 'workspace'
          OR pm.user_id = c.created_by_id
          OR exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=lower(u.email) and u.email_verified = 1)
          OR exists(select 1 from workspace_members wm inner join workspaces w2 on w2.id = wm.workspace_id where wm.workspace_id=c.workspace_id and wm.user_id=u.id and wm.role in ('owner','admin') and wm.status='active' and w2.plan='team')
        ))
        OR (u.workspace_id <> c.workspace_id AND u.email_verified = 1
          AND exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=lower(u.email)))
      )`,
    )
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

// 詳細ヘッダ用: 閲覧権を持つ参加者の先頭 limit 人 (参加の新しい順)。
export async function listProjectParticipants(
  db: Db,
  containerId: string,
  limit: number,
) {
  return await db
    .selectFrom('project_members as pm')
    .innerJoin('users as u', 'u.id', 'pm.user_id')
    .innerJoin('artifact_containers as c', 'c.id', 'pm.container_id')
    .select(['u.id', 'u.name', 'u.email', 'u.image'])
    .where('pm.container_id', '=', containerId)
    .where(
      sql<boolean>`(
        (u.workspace_id = c.workspace_id AND (
          c.base_visibility = 'workspace'
          OR pm.user_id = c.created_by_id
          OR exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=lower(u.email) and u.email_verified = 1)
          OR exists(select 1 from workspace_members wm inner join workspaces w2 on w2.id = wm.workspace_id where wm.workspace_id=c.workspace_id and wm.user_id=u.id and wm.role in ('owner','admin') and wm.status='active' and w2.plan='team')
        ))
        OR (u.workspace_id <> c.workspace_id AND u.email_verified = 1
          AND exists(select 1 from project_share_defaults d where d.project_container_id=c.id and lower(d.email)=lower(u.email)))
      )`,
    )
    .orderBy('pm.joined_at', 'desc')
    .limit(limit)
    .execute()
}

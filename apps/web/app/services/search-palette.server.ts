import { sql, type Kysely } from 'kysely'
import { listProjectsForIndex } from './project-membership.server'
import { listSharedProjects } from './projects.server'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import { recentShareableAccessPredicate } from './home.server'
import { nowIso } from '~/lib/datetime'

function normalizePaletteQuery(value: string | null) {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
}

export async function searchPalette(
  db: Kysely<DB>,
  user: SessionUser,
  rawQuery: string | null,
  now = nowIso(),
) {
  const q = normalizePaletteQuery(rawQuery)
  const title = sql<string>`coalesce(nullif(shareables.title_override,''), nullif(shareables.derived_title,''), shareables.name)`
  const ownQuery = db
    .selectFrom('shareables')
    .innerJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      title.as('title'),
      'shareables.created_at as createdAt',
      'c.kind as containerKind',
      'c.name as containerName',
    ])
    .where('shareables.owner_user_id', '=', user.id)
    .where(sql<boolean>`instr(lower(${title}), lower(${q})) > 0`)
    .orderBy('shareables.created_at', 'desc')
    .orderBy('shareables.id', 'desc')
    .limit(5)
  const recentQuery = db
    .selectFrom('shareable_viewer_recency as r')
    .innerJoin('shareables', 'shareables.id', 'r.shareable_id')
    .innerJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .innerJoin('users as owner', 'owner.id', 'shareables.owner_user_id')
    .select([
      'shareables.id',
      title.as('title'),
      'r.last_viewed_at as viewedAt',
      'owner.name as ownerName',
    ])
    .where('r.viewer_user_id', '=', user.id)
    .where(sql<boolean>`instr(lower(${title}), lower(${q})) > 0`)
    .where(recentShareableAccessPredicate(user, 'c', now))
    .orderBy('r.last_viewed_at', 'desc')
    .orderBy('shareables.id', 'asc')
    .limit(5)
  const [own, recent, indexed, shared] = await Promise.all([
    ownQuery.execute(),
    recentQuery.execute(),
    listProjectsForIndex(db, user),
    listSharedProjects(db, user),
  ])
  // プロジェクトのみ SQL LIMIT でなくメモリ内で filter/sort/slice する。到達可能
  // 集合の判定 (listProjectsForIndex / listSharedProjects) を SQL に重複させない
  // ためで、対象は 1 workspace 分のプロジェクト数に留まる
  const lowered = q.toLocaleLowerCase()
  const merged = [...indexed.filter((p) => !p.archivedAt), ...shared]
  const projects = merged
    .filter(
      (p, i) =>
        merged.findIndex((x) => x.id === p.id) === i &&
        (!q || p.name.toLocaleLowerCase().includes(lowered)),
    )
    .sort(
      (a, b) =>
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
        b.id.localeCompare(a.id),
    )
    .slice(0, 5)
  return {
    ownFiles: own,
    recent: recent,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      updatedAt: p.updatedAt,
      fileCount: p.fileCount,
    })),
  }
}

import { sql, type Compilable, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import { activeLinkExpiry, workspaceAccessRevokedSql } from '~/modules/access'
import type { DB } from '~/types/db'
import { grantMatchEmail } from './access.server'

export type DiscoveryFilters = {
  ownerUserId?: string
  containerId?: string
  includeArchived?: boolean
  date?: { field: 'updated' | 'viewed'; from?: Date; to?: Date }
}
export type DiscoveryInput = DiscoveryFilters & {
  viewerUserId: string
  now?: string
}
export type CandidateDiscoveryInput = DiscoveryInput & {
  workspaceId: string
  candidateIds: readonly string[]
}
export type DiscoveredId = { id: string; workspaceId: string }
type DiscoveryQuery = Compilable<DiscoveredId> & {
  execute(): Promise<DiscoveredId[]>
}

/** Load live identity once per operation; callers supply no session claims. */
export function loadDiscoveryViewer(db: Kysely<DB>, viewerUserId: string) {
  return db
    .selectFrom('users')
    .select(['id', 'workspace_id', 'email', 'email_verified'])
    .where('id', '=', viewerUserId)
    .executeTakeFirst()
}
type DiscoveryViewer = NonNullable<
  Awaited<ReturnType<typeof loadDiscoveryViewer>>
>

/** Fixed aliases are owned by this module, never supplied by the caller. */
function discoveryEligibility(viewer: DiscoveryViewer, now: string) {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  const live = sql<boolean>`NOT ${workspaceAccessRevokedSql(sql.ref('s.workspace_id'), viewer.id)}`
  return sql<boolean>`(
    (s.owner_user_id = ${viewer.id} AND ${live})
    OR EXISTS (SELECT 1 FROM shareable_grants g
      WHERE ${lowerEmail('g.granted_email')} = ${email} AND g.shareable_id = s.id)
    OR (s.visibility = 'workspace' AND s.workspace_id = ${viewer.workspace_id} AND ${live})
    OR (s.visibility = 'project' AND c.kind = 'project' AND (
      EXISTS (SELECT 1 FROM project_share_defaults d
        WHERE ${lowerEmail('d.email')} = ${email} AND d.project_container_id = c.id)
      OR (c.base_visibility = 'workspace' AND s.workspace_id = ${viewer.workspace_id} AND ${live})
      OR (c.created_by_id = ${viewer.id} AND ${live} AND EXISTS (
        SELECT 1 FROM project_members m WHERE m.container_id = c.id AND m.user_id = ${viewer.id}
      ))
    ))
    OR (s.visibility = 'link' AND s.link_suspended_at IS NULL
      AND ${activeLinkExpiry(now, sql.ref('s.link_expires_at'))}
      AND EXISTS (SELECT 1 FROM shareable_viewer_recency r
        WHERE r.shareable_id = s.id AND r.viewer_user_id = ${viewer.id})
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id AND w.link_sharing_enabled = 1))
  )`
}

function discoveryQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  filters: DiscoveryFilters,
  now: string,
) {
  let query = db
    .selectFrom('shareables as s')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .select(['s.id', 's.workspace_id as workspaceId'])
    .where(discoveryEligibility(viewer, now))
  // All other non-administrative opening grounds already occur above as
  // independent discovery grounds. Thus creator + live membership is the only
  // additional membership case; a join alone (even for an admin) cannot open.
  if (!filters.includeArchived)
    query = query.where(
      sql<boolean>`(c.kind IS NOT 'project' OR c.archived_at IS NULL)`,
    )
  if (filters.ownerUserId !== undefined)
    query = query.where(sql<boolean>`+s.owner_user_id = ${filters.ownerUserId}`)
  if (filters.containerId !== undefined)
    query = query.where(sql<boolean>`+s.container_id = ${filters.containerId}`)
  if (filters.date?.from !== undefined || filters.date?.to !== undefined) {
    const date = filters.date
    const value =
      date.field === 'updated'
        ? sql.ref('s.activity_at')
        : sql<string>`(
      SELECT r.last_viewed_at FROM shareable_viewer_recency r
      WHERE r.shareable_id = s.id AND r.viewer_user_id = ${viewer.id}
    )`
    // Normalize stored UTC timestamps to the bounds' millisecond precision.
    const canonicalValue = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${value})`
    if (date.from !== undefined)
      query = query.where(
        sql<boolean>`${canonicalValue} >= ${date.from.toISOString()}`,
      )
    if (date.to !== undefined)
      query = query.where(
        sql<boolean>`${canonicalValue} < ${date.to.toISOString()}`,
      )
  }
  return query
}

/** Production builder shared by execution and D1 plan/read-cost tests. */
export function buildCandidateDiscoveryQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  input: CandidateDiscoveryInput,
  now: string,
): DiscoveryQuery {
  return (
    discoveryQuery(db, viewer, input, now)
      .where(
        sql<boolean>`s.id IN (SELECT value FROM json_each(${JSON.stringify(input.candidateIds)}))`,
      )
      // Disqualify workspace-leading indexes, including when filters are present.
      .where(sql<boolean>`+s.workspace_id = ${input.workspaceId}`)
  )
}

export async function discoverCandidates(
  db: Kysely<DB>,
  input: CandidateDiscoveryInput,
): Promise<DiscoveredId[]> {
  const now = input.now ?? new Date().toISOString()
  if (!input.candidateIds.length) return []
  const viewer = await loadDiscoveryViewer(db, input.viewerUserId)
  if (!viewer) return []
  return buildCandidateDiscoveryQuery(db, viewer, input, now).execute()
}

/** Sparse domain only: active members use indexed candidates for their workspace. */
export function buildSparseDiscoveryQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  input: DiscoveryFilters,
  now: string,
): DiscoveryQuery {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  return discoveryQuery(db, viewer, input, now).where(sql<boolean>`s.id IN (
    SELECT id FROM shareables WHERE owner_user_id = ${viewer.id}
    UNION SELECT shareable_id FROM shareable_grants WHERE ${lowerEmail('shareable_grants.granted_email')} = ${email}
    UNION SELECT files.id FROM project_members m JOIN shareables files ON files.container_id = m.container_id WHERE m.user_id = ${viewer.id}
    UNION SELECT files.id FROM project_share_defaults d JOIN shareables files ON files.container_id = d.project_container_id WHERE ${lowerEmail('d.email')} = ${email} AND files.visibility = 'project'
    UNION SELECT shareable_id FROM shareable_viewer_recency WHERE viewer_user_id = ${viewer.id}
  )`)
}

export async function enumerateDiscoverableIds(
  db: Kysely<DB>,
  input: DiscoveryInput,
): Promise<Array<{ workspaceId: string; ids: string[] }>> {
  const now = input.now ?? new Date().toISOString()
  const viewer = await loadDiscoveryViewer(db, input.viewerUserId)
  if (!viewer) return []
  const rows = await buildSparseDiscoveryQuery(db, viewer, input, now).execute()
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const ids = groups.get(row.workspaceId) ?? []
    ids.push(row.id)
    groups.set(row.workspaceId, ids)
  }
  return Array.from(groups, ([workspaceId, ids]) => ({ workspaceId, ids }))
}

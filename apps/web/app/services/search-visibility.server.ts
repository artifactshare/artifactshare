import { sql } from 'kysely'
import type { Db } from './db.server'
import { grantMatchEmail } from './access.server'
import { lowerEmail } from '~/lib/grant-emails.server'
import {
  loadDiscoveryViewer,
  type DiscoveryFilters,
  type DiscoveryViewer,
} from './search-discovery.server'
import type { SearchVisibility } from './search-index/visibility'

/** Actor/email-leading relationships only; projects never join their child files. */
export async function searchVisibilitySources(
  db: Db,
  actor: string,
  filters: DiscoveryFilters,
  now: string,
  known?: DiscoveryViewer,
) {
  const viewer = known ?? (await loadDiscoveryViewer(db, actor))
  if (!viewer) return []
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  const [owned, grants, defaults, memberships, recency, identityRows] =
    await Promise.all([
      db
        .selectFrom('search_owner_workspaces')
        .select('workspace_id')
        .where('actor_id', '=', actor)
        .where('file_count', '>', 0)
        .execute(),
      db
        .selectFrom('shareable_grants as g')
        .innerJoin('shareables as s', 's.id', 'g.shareable_id')
        .select(['s.workspace_id', 's.id'])
        .where(sql<boolean>`${lowerEmail('g.granted_email')}=${email}`)
        .execute(),
      db
        .selectFrom('project_share_defaults as d')
        .innerJoin('artifact_containers as c', 'c.id', 'd.project_container_id')
        .select(['c.workspace_id', 'c.id'])
        .where(sql<boolean>`${lowerEmail('d.email')}=${email}`)
        .execute(),
      db
        .selectFrom('project_members as m')
        .innerJoin('artifact_containers as c', 'c.id', 'm.container_id')
        .select(['c.workspace_id', 'c.id'])
        .where('m.user_id', '=', actor)
        .where('c.created_by_id', '=', actor)
        .execute(),
      db
        .selectFrom('shareable_viewer_recency as r')
        .innerJoin('shareables as s', 's.id', 'r.shareable_id')
        .select([
          's.workspace_id',
          's.id',
          sql<
            string | null
          >`strftime('%Y-%m-%dT%H:%M:%fZ',r.last_viewed_at)`.as('viewed_at'),
        ])
        .where('r.viewer_user_id', '=', actor)
        .execute(),
      db
        .selectFrom('users as u')
        .leftJoin('workspace_members as m', 'm.user_id', 'u.id')
        .select(['u.kind', 'u.bot_stopped_at', 'm.workspace_id', 'm.status'])
        .where('u.id', '=', actor)
        .execute(),
    ])
  const workspaces = [
    ...new Set([
      viewer.workspace_id,
      ...[owned, grants, defaults, memberships, recency].flatMap((rows) =>
        rows.map((r) => r.workspace_id),
      ),
    ]),
  ].sort()
  const sources = []
  for (const workspaceId of workspaces) {
    if (
      filters.credentialScope &&
      (workspaceId !== filters.credentialScope.workspaceId ||
        viewer.workspace_id !== filters.credentialScope.workspaceId)
    )
      continue
    const identity =
      identityRows.length > 0 &&
      !identityRows.some(
        (row) =>
          (row.kind === 'bot' && row.bot_stopped_at !== null) ||
          (row.workspace_id === workspaceId && row.status === 'removed'),
      )
    const visibility: SearchVisibility = {
      protocol: 1,
      actor,
      identity,
      ownWorkspace: viewer.workspace_id === workspaceId,
      grants: grants
        .filter((r) => r.workspace_id === workspaceId)
        .map((r) => r.id),
      defaults: defaults
        .filter((r) => r.workspace_id === workspaceId)
        .map((r) => r.id),
      memberships: memberships
        .filter((r) => r.workspace_id === workspaceId)
        .map((r) => r.id),
      recency: recency
        .filter((r) => r.workspace_id === workspaceId)
        .map((r) => ({
          id: r.id,
          at: r.viewed_at,
        })),
      now,
      includeArchived: filters.includeArchived,
      home: filters.location?.kind === 'home',
      viewed:
        filters.date?.field === 'viewed' &&
        (filters.date.from || filters.date.to)
          ? {
              from: filters.date.from?.toISOString(),
              to: filters.date.to?.toISOString(),
            }
          : undefined,
      agent: Boolean(filters.credentialScope),
    }
    sources.push({ workspaceId, visibility })
  }
  return sources
}

import { SearchCapacityError } from './search-index/query'
import {
  sql,
  type Kysely,
  type SelectQueryBuilder,
  type Nullable,
  type CompiledQuery,
} from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import { activeLinkExpiry, workspaceAccessRevokedSql } from '~/modules/access'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'
import { agentReadableShareableSql } from './agent-scope.server'
import { grantMatchEmail } from './access.server'

export type DiscoveryFilters = {
  credentialScope?: Extract<CliAuthority, { kind: 'agent' }>
  ownerUserIds?: readonly string[]
  location?: { kind: 'home' } | { kind: 'project'; id: string }
  ownerUserId?: string
  containerId?: string
  includeArchived?: boolean
  date?: { field: 'updated' | 'viewed'; from?: Date; to?: Date }
}
export type DiscoveryInput = DiscoveryFilters & {
  viewerUserId: string
  /** The viewer row the operation already read for viewerUserId. */
  viewer?: DiscoveryViewer
  now?: string
  excludeWorkspaceId?: string
}
export type CandidateDiscoveryInput = DiscoveryInput & {
  workspaceId: string
  candidateIds: readonly string[]
}
export type DiscoveredId = { id: string; workspaceId: string }
type DiscoveryQuery = SelectQueryBuilder<
  DB & { s: DB['shareables']; c: Nullable<DB['artifact_containers']> },
  's' | 'c',
  DiscoveredId
>

function viewerQuery(db: Kysely<DB>, viewerUserId: string) {
  return db
    .selectFrom('users as u')
    .leftJoin('workspace_members as m', (join) =>
      join
        .onRef('m.workspace_id', '=', 'u.workspace_id')
        .onRef('m.user_id', '=', 'u.id'),
    )
    .select([
      'u.id',
      'u.workspace_id',
      'u.email',
      'u.email_verified',
      'm.status as member_status',
    ])
    .where('u.id', '=', viewerUserId)
}
declare const liveViewer: unique symbol
/**
 * The viewer's live identity and own-workspace membership. Only
 * this module produces it from viewerQuery, so callers cannot pass session claims.
 */
export type DiscoveryViewer = {
  id: string
  workspace_id: string
  email: string
  email_verified: number
  member_status: 'active' | 'removed' | null
} & { readonly [liveViewer]: true }
/**
 * Read the viewer from D1 on every call. An operation reads it once and
 * hands it to later checks as DiscoveryInput.viewer.
 */
export async function loadDiscoveryViewer(
  db: Kysely<DB>,
  viewerUserId: string,
): Promise<DiscoveryViewer | undefined> {
  const row: Omit<DiscoveryViewer, typeof liveViewer> | undefined =
    await viewerQuery(db, viewerUserId).executeTakeFirst()
  return row as DiscoveryViewer | undefined
}
/** Reuse the operation's viewer row; read it only when the caller has none. */
function inputViewer(
  db: Kysely<DB>,
  input: Pick<DiscoveryInput, 'viewerUserId' | 'viewer'>,
) {
  return input.viewer?.id === input.viewerUserId
    ? input.viewer
    : loadDiscoveryViewer(db, input.viewerUserId)
}

/** Fixed aliases are owned by this module, never supplied by the caller. */
function discoveryEligibility(
  viewer: DiscoveryViewer,
  now: string,
  current = false,
) {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  // Keep the existing JS email normalization, while fencing a snapshot that
  // changed during an index await. In particular SQLite lower() is ASCII-only.
  const matchEmail = current
    ? sql<string>`(SELECT CASE WHEN email_verified=1 AND email=${viewer.email} THEN ${viewer.email.toLowerCase()} ELSE NULL END FROM users WHERE id=${viewer.id})`
    : sql`${email}`
  const workspace = current
    ? sql<string>`(SELECT workspace_id FROM users WHERE id=${viewer.id})`
    : sql`${viewer.workspace_id}`
  const live = sql<boolean>`NOT ${workspaceAccessRevokedSql(sql.ref('s.workspace_id'), viewer.id)}`
  return sql<boolean>`(
    (s.owner_user_id = ${viewer.id} AND ${live})
    OR EXISTS (SELECT 1 FROM shareable_grants g
      WHERE ${lowerEmail('g.granted_email')} = ${matchEmail} AND g.shareable_id = s.id)
    OR (s.visibility = 'workspace' AND s.workspace_id = ${workspace} AND ${live})
    OR (s.visibility = 'project' AND c.kind = 'project' AND (
      EXISTS (SELECT 1 FROM project_share_defaults d
        WHERE ${lowerEmail('d.email')} = ${matchEmail} AND d.project_container_id = c.id)
      OR (c.base_visibility = 'workspace' AND s.workspace_id = ${workspace} AND ${live})
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
  current = false,
): DiscoveryQuery {
  let query = db
    .selectFrom('shareables as s')
    .leftJoin('artifact_containers as c', 'c.id', 's.container_id')
    .select(['s.id', 's.workspace_id as workspaceId'])
    .where(discoveryEligibility(viewer, now, current))
  if (filters.credentialScope)
    query = query.where(sql<boolean>`EXISTS (
      SELECT 1 FROM users AS search_viewer
      WHERE search_viewer.id = ${viewer.id}
        AND ${agentReadableShareableSql('search_viewer', filters.credentialScope, 's')}
    )`)
  // All other non-administrative opening grounds already occur above as
  // independent discovery grounds. Thus creator + live membership is the only
  // additional membership case; a join alone (even for an admin) cannot open.
  if (!filters.includeArchived)
    query = query.where(
      sql<boolean>`(c.kind IS NOT 'project' OR c.archived_at IS NULL)`,
    )
  if (filters.ownerUserIds !== undefined)
    query = query.where(
      sql<boolean>`+s.owner_user_id IN (SELECT value FROM json_each(${JSON.stringify(filters.ownerUserIds)}))`,
    )
  if (filters.location?.kind === 'home')
    query = query.where('c.kind', '=', 'inbox')
  if (filters.location?.kind === 'project')
    query = query.where(sql<boolean>`+s.container_id = ${filters.location.id}`)
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
    discoveryQuery(db, viewer, input, now, true)
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
  let viewer = await inputViewer(db, input)
  if (!viewer) return []
  // Read the current identity in the same statement as the ID-leading check.
  // Normally the request snapshot still matches, with no extra round trip. If
  // it changed during an index await, reuse the trusted row and normalize its
  // email in JS before checking once more. Repeated identity churn is capacity,
  // never an exact empty result based on stale claims.
  for (let attempt = 0; attempt < 2; attempt++) {
    const query = buildCandidateDiscoveryQuery(db, viewer, input, now)
    const result = await sql<{
      id: string | null
      workspaceId: string | null
      viewer_json: string | null
    }>`
      SELECT candidates.id,candidates.workspaceId,NULL AS viewer_json FROM (${query}) candidates
      UNION ALL SELECT NULL,NULL,json_object(
        'id',identity.id,'workspace_id',identity.workspace_id,'email',identity.email,
        'email_verified',identity.email_verified,'member_status',identity.member_status)
      FROM (${viewerQuery(db, input.viewerUserId)}) identity
    `.execute(db)
    const encoded = result.rows.find(
      (row) => row.viewer_json !== null,
    )?.viewer_json
    if (!encoded) return []
    const current = JSON.parse(encoded) as DiscoveryViewer
    if (
      current.id === viewer.id &&
      current.email === viewer.email &&
      current.email_verified === viewer.email_verified &&
      current.workspace_id === viewer.workspace_id
    )
      return result.rows.flatMap((row) =>
        row.id !== null && row.workspaceId !== null
          ? [{ id: row.id, workspaceId: row.workspaceId }]
          : [],
      )
    viewer = current
  }
  throw new SearchCapacityError()
}

/** Sparse domain only: active members use indexed candidates for their workspace. */
export function buildSparseDiscoveryQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  input: DiscoveryFilters & { excludeWorkspaceId?: string },
  now: string,
): DiscoveryQuery {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  const external = input.excludeWorkspaceId
  return discoveryQuery(db, viewer, input, now).where(sql<boolean>`s.id IN (
    SELECT id FROM shareables WHERE owner_user_id = ${viewer.id} AND (${external ?? null} IS NULL OR workspace_id <> ${external ?? null})
    UNION SELECT g.shareable_id FROM shareable_grants g JOIN shareables files ON files.id=g.shareable_id WHERE ${lowerEmail('g.granted_email')} = ${email} AND (${external ?? null} IS NULL OR files.workspace_id <> ${external ?? null})
    UNION SELECT files.id FROM project_members m JOIN shareables files ON files.container_id = m.container_id WHERE m.user_id = ${viewer.id} AND (${external ?? null} IS NULL OR files.workspace_id <> ${external ?? null})
    UNION SELECT files.id FROM project_share_defaults d JOIN shareables files ON files.container_id = d.project_container_id WHERE ${lowerEmail('d.email')} = ${email} AND files.visibility = 'project' AND (${external ?? null} IS NULL OR files.workspace_id <> ${external ?? null})
    UNION SELECT r.shareable_id FROM shareable_viewer_recency r JOIN shareables files ON files.id=r.shareable_id WHERE r.viewer_user_id = ${viewer.id} AND (${external ?? null} IS NULL OR files.workspace_id <> ${external ?? null})
  )`)
}

export async function enumerateDiscoverableIds(
  db: Kysely<DB>,
  input: DiscoveryInput,
): Promise<Array<{ workspaceId: string; ids: string[] }>> {
  const now = input.now ?? new Date().toISOString()
  const viewer = await inputViewer(db, input)
  if (!viewer) return []
  const rows = await drainDiscoveryIds(
    buildSparseDiscoveryQuery(db, viewer, input, now),
  )
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const ids = groups.get(row.workspaceId) ?? []
    ids.push(row.id)
    groups.set(row.workspaceId, ids)
  }
  return Array.from(groups, ([workspaceId, ids]) => ({ workspaceId, ids }))
}

export const SUGGESTION_SOURCE_LIMIT = 2000
type SuggestionSourceQuery = {
  execute(): Promise<Array<{ id: string }>>
  compile(): CompiledQuery<{ id: string }>
  clearLimit(): SuggestionSourceQuery
}
export function buildSuggestionSourceQueries(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  filters: DiscoveryFilters = {},
  now = new Date().toISOString(),
): SuggestionSourceQuery[] {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  const base = discoveryQuery(db, viewer, filters, now)
    .clearSelect()
    .select('s.id')
  return [
    base
      .where('s.owner_user_id', '=', viewer.id)
      .orderBy('s.activity_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(SUGGESTION_SOURCE_LIMIT),
    base
      .innerJoin('shareable_viewer_recency as r', 'r.shareable_id', 's.id')
      .where('r.viewer_user_id', '=', viewer.id)
      .orderBy('r.last_viewed_at', 'desc')
      .limit(SUGGESTION_SOURCE_LIMIT),
    base
      .innerJoin('shareable_grants as g', 'g.shareable_id', 's.id')
      .where(sql<boolean>`${lowerEmail('g.granted_email')} = ${email}`)
      .orderBy('g.granted_at', 'desc')
      .limit(SUGGESTION_SOURCE_LIMIT),
    base
      .where(sql<boolean>`s.id IN (
        SELECT ids.value FROM project_members m, json_each((
          SELECT json_group_array(id) FROM (${base
            .where(sql<boolean>`s.container_id=m.container_id`)
            .orderBy('s.activity_at', 'desc')
            .orderBy('s.id', 'desc')
            .limit(SUGGESTION_SOURCE_LIMIT)})
        )) ids WHERE m.user_id=${viewer.id}
      )`)
      .orderBy('s.activity_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(SUGGESTION_SOURCE_LIMIT),
    base
      .where(sql<boolean>`s.id IN (
        SELECT ids.value FROM project_share_defaults d, json_each((
          SELECT json_group_array(id) FROM (${base
            .where(sql<boolean>`s.container_id=d.project_container_id`)
            .where('s.visibility', '=', 'project')
            .orderBy('s.activity_at', 'desc')
            .orderBy('s.id', 'desc')
            .limit(SUGGESTION_SOURCE_LIMIT)})
        )) ids WHERE ${lowerEmail('d.email')}=${email}
      )`)
      .orderBy('s.activity_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(SUGGESTION_SOURCE_LIMIT),
  ]
}

export async function enumerateSuggestionIds(
  db: Kysely<DB>,
  input: DiscoveryInput,
) {
  const viewer = await inputViewer(db, input)
  if (!viewer) return []
  const sources = await Promise.all(
    buildSuggestionSourceQueries(db, viewer, input, input.now).map((query) =>
      query.execute(),
    ),
  )
  const ids = [...new Set(sources.flat().map((row) => row.id))]
  const groups = new Map<string, string[]>()
  for (let offset = 0; offset < ids.length; offset += SUGGESTION_SOURCE_LIMIT) {
    const rows = await db
      .selectFrom('shareables')
      .select(['id', 'workspace_id'])
      .where(
        sql<boolean>`id IN (SELECT value FROM json_each(${JSON.stringify(ids.slice(offset, offset + SUGGESTION_SOURCE_LIMIT))}))`,
      )
      .execute()
    for (const row of rows) {
      const group = groups.get(row.workspace_id) ?? []
      group.push(row.id)
      groups.set(row.workspace_id, group)
    }
  }
  const domain: Array<{ workspaceId: string; ids: string[] }> = []
  for (const [workspaceId, candidates] of groups) {
    const accepted: string[] = []
    for (
      let offset = 0;
      offset < candidates.length;
      offset += SUGGESTION_SOURCE_LIMIT
    ) {
      const rows = await discoverSuggestionCandidates(db, {
        ...input,
        workspaceId,
        candidateIds: candidates.slice(
          offset,
          offset + SUGGESTION_SOURCE_LIMIT,
        ),
      })
      accepted.push(...rows.map((row) => row.id))
    }
    if (accepted.length) domain.push({ workspaceId, ids: accepted })
  }
  return domain
}

/** Full-inventory oracle; full-text request paths never use this enumeration. */
export function buildMemberDiscoveryQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  input: DiscoveryFilters,
  now: string,
): DiscoveryQuery {
  return discoveryQuery(db, viewer, input, now).where(
    's.workspace_id',
    '=',
    viewer.workspace_id,
  )
}
export async function enumerateMemberDiscoverableIds(
  db: Kysely<DB>,
  input: DiscoveryInput,
): Promise<DiscoveredId[]> {
  const viewer = await inputViewer(db, input)
  if (viewer?.member_status !== 'active') return []
  return drainDiscoveryIds(
    buildMemberDiscoveryQuery(
      db,
      viewer,
      input,
      input.now ?? new Date().toISOString(),
    ),
  )
}

/** Bound every D1 response while preserving the full eligible universe. */
async function drainDiscoveryIds(
  query: DiscoveryQuery,
): Promise<DiscoveredId[]> {
  const rows: DiscoveredId[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await query
      .$if(cursor !== undefined, (q) => q.where('s.id', '>', cursor!))
      .orderBy('s.id')
      .limit(2000)
      .execute()
    rows.push(...page)
    if (page.length < 2000) return rows
    cursor = page[page.length - 1].id
  }
}

/** Candidates for typeahead retain the narrower owned/viewed/shared domain. */
export async function discoverSuggestionCandidates(
  db: Kysely<DB>,
  input: CandidateDiscoveryInput,
): Promise<DiscoveredId[]> {
  const viewer = await inputViewer(db, input)
  if (!viewer || !input.candidateIds.length) return []
  return buildCandidateDiscoveryQuery(
    db,
    viewer,
    input,
    input.now ?? new Date().toISOString(),
  )
    .where(suggestionEligibility(viewer))
    .execute()
}

function suggestionEligibility(viewer: DiscoveryViewer) {
  const email = grantMatchEmail({
    email: viewer.email,
    emailVerified: viewer.email_verified === 1,
  })
  return sql<boolean>`(s.owner_user_id=${viewer.id}
      OR EXISTS (SELECT 1 FROM shareable_grants g WHERE g.shareable_id=s.id AND ${lowerEmail('g.granted_email')}=${email})
      OR EXISTS (SELECT 1 FROM project_members m WHERE m.container_id=s.container_id AND m.user_id=${viewer.id})
      OR (s.visibility='project' AND EXISTS (SELECT 1 FROM project_share_defaults d WHERE d.project_container_id=s.container_id AND ${lowerEmail('d.email')}=${email}))
      OR EXISTS (SELECT 1 FROM shareable_viewer_recency r WHERE r.shareable_id=s.id AND r.viewer_user_id=${viewer.id}))`
}

export async function suggestionOwners(
  db: Kysely<DB>,
  input: DiscoveryInput,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const viewer = await inputViewer(db, input)
  if (!viewer) return []
  return buildSuggestionOwnersQuery(db, viewer, input, query).execute()
}

export function buildSuggestionOwnersQuery(
  db: Kysely<DB>,
  viewer: DiscoveryViewer,
  input: DiscoveryInput,
  query: string,
): SelectQueryBuilder<
  DB & { owner: DB['users'] },
  'owner',
  { id: string; name: string }
> {
  const eligible = discoveryQuery(
    db,
    viewer,
    input,
    input.now ?? new Date().toISOString(),
  )
    .where(sql<boolean>`s.owner_user_id=owner.id`)
    .where(suggestionEligibility(viewer))
  return db
    .selectFrom('users as owner')
    .select(['owner.id', sql<string>`coalesce(owner.name,'')`.as('name')])
    .where(
      sql<boolean>`instr(lower(coalesce(owner.name,'')),lower(${query}))>0`,
    )
    .where(sql<boolean>`EXISTS ${eligible}`)
    .orderBy('owner.id')
    .limit(3)
}

/** Selected labels are resolved from live discoverable files, never from history snapshots. */
export async function resolveSearchSelections(
  db: Kysely<DB>,
  actor: string,
  ownerIds: string[],
  projectIds: string[],
  credentialScope?: DiscoveryFilters['credentialScope'],
  knownViewer?: DiscoveryViewer,
) {
  const viewer = await inputViewer(db, {
    viewerUserId: actor,
    viewer: knownViewer,
  })
  if (!viewer) return { owners: [], projects: [] }
  const eligible = discoveryQuery(
    db,
    viewer,
    { includeArchived: true, credentialScope },
    new Date().toISOString(),
  )
  const [owners, projects] = await Promise.all([
    ownerIds.length
      ? db
          .selectFrom('users as selected_owner')
          .select([
            'selected_owner.id',
            sql<string>`coalesce(selected_owner.name,'')`.as('name'),
          ])
          .where(
            sql<boolean>`selected_owner.id IN (SELECT value FROM json_each(${JSON.stringify(ownerIds)}))`,
          )
          .where(
            sql<boolean>`EXISTS ${eligible.where(sql<boolean>`s.owner_user_id=selected_owner.id`)}`,
          )
          .execute()
      : [],
    projectIds.length
      ? db
          .selectFrom('artifact_containers as selected_project')
          .select(['selected_project.id', 'selected_project.name'])
          .where('selected_project.kind', '=', 'project')
          .where(
            sql<boolean>`selected_project.id IN (SELECT value FROM json_each(${JSON.stringify(projectIds)}))`,
          )
          .where(
            sql<boolean>`EXISTS ${eligible.where(sql<boolean>`s.container_id=selected_project.id`)}`,
          )
          .execute()
      : [],
  ])
  return {
    owners,
    projects: projects.map((row) => ({ ...row, name: row.name ?? '' })),
  }
}

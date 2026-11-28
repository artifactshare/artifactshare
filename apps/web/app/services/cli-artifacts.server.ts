import { SearchDailyLimitError } from './search-quota.server'
import type { ArtifactsListQuery } from '@artifactshare/contract'
import { SearchCapacityError } from './search-index/query'
import { parseSearchInput } from './search-input'
import { search, type SearchIndexes } from './search.server'
import { loadArtifactVersionSummaries } from './artifact-version-summary.server'
import { sql, type Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import type { ArtifactKind } from '~/lib/shareable-types'
import { isArtifactKind } from '~/lib/shareable-types'
import { displayTitle } from '~/lib/display-title'
import { shareUrl } from '~/services/artifact-readback.server'
import {
  findSharedProjectForViewer,
  findWorkspaceProject,
  visibleSharedProjectShareableToViewerSql,
  visibleShareableToViewerSql,
} from '~/services/projects.server'
import { listOwnedShareables } from '~/services/shareables.server'
import { agentReadableShareableSql } from '~/services/agent-scope.server'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'

export const CLI_ARTIFACTS_LIST_LIMIT = 50

export type CliArtifactsListResult =
  | { kind: 'ok'; data: CliArtifactsListData }
  | { kind: 'invalid-project' }
  | { kind: 'invalid-cursor' }

export type AgentArtifactsListResult =
  | CliArtifactsListResult
  | { kind: 'missing-viewer' }

export type CliArtifactsListData = {
  artifacts: Array<{
    id: string
    title: string
    share_url: string
    visibility: string
    link_expires_at: string | null
    updated_at: string
    project_id: string | null
    owner_user_id?: string
    owner_email?: string
    retain_versions?: number | null
    version_count?: number
    total_size_bytes?: number
    /**
     * Left out when the stored `artifact_kind` is not one this build knows.
     * `shareables.artifact_kind` is plain TEXT, and the list response declares
     * the field optional, so an unreadable kind drops out of the one entry
     * instead of failing the whole page in the route's response parse.
     */
    artifact_kind?: ArtifactKind
    excerpt?: string
    group_size?: number
    group_size_relation?: 'eq' | 'gte'
  }>
  total?: { value: number; relation: 'eq' | 'gte' }
  search_hint?: string
  limit: number
  has_more: boolean
  next_cursor: string | null
}

export async function listCliArtifacts(
  db: Kysely<DB>,
  user: SessionUser,
  args: {
    baseUrl: string
    projectId?: string
    query?: string
    cursor?: string
    includeVersionSummaries?: boolean
  },
): Promise<CliArtifactsListResult> {
  const fingerprint = JSON.stringify({
    project_id: args.projectId ?? null,
    query: args.query ?? null,
    home: args.projectId === '',
  })
  const decoded = args.cursor ? decodeCursor(args.cursor) : null
  if (args.cursor && (!decoded || decoded.filter !== fingerprint)) {
    return { kind: 'invalid-cursor' }
  }

  if (args.projectId) {
    const projectId = args.projectId
    const project = await findWorkspaceProject(
      db,
      user.workspaceId,
      projectId,
      user,
    )
    const shared = project
      ? null
      : await findSharedProjectForViewer(db, projectId, user)
    if (!project && !shared) return { kind: 'invalid-project' }

    const workspaceId = project ? user.workspaceId : shared!.workspaceId
    const visible = project
      ? visibleShareableToViewerSql(user)
      : visibleSharedProjectShareableToViewerSql(user)
    let qb = db
      .selectFrom('shareables')
      .innerJoin('users as u', 'u.id', 'shareables.owner_user_id')
      .innerJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
      .select([
        'shareables.id as id',
        'shareables.name as name',
        'shareables.derived_title as derived_title',
        'shareables.title_override as title_override',
        'shareables.visibility as visibility',
        'shareables.artifact_kind as artifact_kind',
        'shareables.link_expires_at as link_expires_at',
        'shareables.updated_at as updated_at',
        'shareables.activity_at',
        'u.email as owner_email',
      ])
      .where('shareables.workspace_id', '=', workspaceId)
      .where('shareables.container_id', '=', projectId)
      .where('c.kind', '=', 'project')
      .where(sql<boolean>`${visible}`)
    if (args.query) {
      const term = args.query.toLowerCase()
      qb = qb.where(
        sql<boolean>`instr(lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)), ${term}) > 0`,
      )
    }
    if (decoded) {
      qb = qb.where(
        sql<boolean>`(shareables.activity_at < ${decoded.updated_at} OR (shareables.activity_at = ${decoded.updated_at} AND shareables.id < ${decoded.id}))`,
      )
    }
    const rows = await qb
      .orderBy('shareables.activity_at', 'desc')
      .orderBy('shareables.id', 'desc')
      .limit(CLI_ARTIFACTS_LIST_LIMIT + 1)
      .execute()
    const hasMore = rows.length > CLI_ARTIFACTS_LIST_LIMIT
    const shown = hasMore ? rows.slice(0, CLI_ARTIFACTS_LIST_LIMIT) : rows
    const summaries = args.includeVersionSummaries
      ? await loadArtifactVersionSummaries(
          db,
          shown.map((item) => item.id),
        )
      : new Map()
    const last = shown.at(-1)
    return {
      kind: 'ok',
      data: {
        artifacts: shown.map((item) => ({
          id: item.id,
          ...summaries.get(item.id)!,
          title: displayTitle({
            name: item.name,
            derivedTitle: item.derived_title,
            titleOverride: item.title_override,
          }),
          share_url: shareUrl(args.baseUrl, item.id, item.visibility),
          visibility: item.visibility,
          link_expires_at: item.link_expires_at,
          updated_at: item.updated_at,
          project_id: projectId,
          owner_email: item.owner_email,
          artifact_kind: isArtifactKind(item.artifact_kind)
            ? item.artifact_kind
            : undefined,
        })),
        limit: CLI_ARTIFACTS_LIST_LIMIT,
        has_more: hasMore,
        next_cursor:
          hasMore && last
            ? encodeCursor({
                updated_at: last.activity_at,
                id: last.id,
                filter: fingerprint,
              })
            : null,
      },
    }
  }

  const items = await listOwnedShareables(db, user, {
    limit: CLI_ARTIFACTS_LIST_LIMIT + 1,
    projectId: args.projectId,
    query: args.query,
    cursor: decoded
      ? { updatedAt: decoded.updated_at, id: decoded.id }
      : undefined,
  })
  const hasMore = items.length > CLI_ARTIFACTS_LIST_LIMIT
  const shown = hasMore ? items.slice(0, CLI_ARTIFACTS_LIST_LIMIT) : items
  const summaries = args.includeVersionSummaries
    ? await loadArtifactVersionSummaries(
        db,
        shown.map((item) => item.id),
      )
    : new Map()
  return {
    kind: 'ok',
    data: {
      artifacts: shown.map((item) => ({
        id: item.id,
        ...summaries.get(item.id)!,
        title: item.title,
        share_url: shareUrl(args.baseUrl, item.id, item.visibility),
        visibility: item.visibility,
        link_expires_at: item.linkExpiresAt,
        updated_at: item.updatedAt,
        project_id: item.projectId,
        // The list entry declares artifact_kind optional, so a row whose
        // stored kind this build cannot read is listed without one.
        artifact_kind: item.artifactKind ?? undefined,
      })),
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
            updated_at: shown.at(-1)!.activityAt,
            id: shown.at(-1)!.id,
            filter: fingerprint,
          })
        : null,
    },
  }
}

export async function listAgentReadableArtifacts(
  db: Kysely<DB>,
  user: SessionUser,
  authority: Extract<CliAuthority, { kind: 'agent' }>,
  args: {
    baseUrl: string
    projectId?: string
    query?: string
    cursor?: string
  },
): Promise<AgentArtifactsListResult> {
  const fingerprint = JSON.stringify({
    agent: true,
    authority_family_id: authority.familyId,
    authority_project_id: authority.projectId,
    project_id: args.projectId ?? null,
    query: args.query ?? null,
  })
  const decoded = args.cursor ? decodeCursor(args.cursor) : null
  const invalidCursor = Boolean(
    args.cursor && (!decoded || decoded.filter !== fingerprint),
  )
  const result = await db
    .with(
      (cte) => cte('access_viewer').materialized(),
      (cteDb) =>
        cteDb
          .selectFrom('users')
          .select(['id', 'workspace_id', 'email', 'email_verified'])
          .where('id', '=', user.id),
    )
    .with('artifact_page', (cteDb) => {
      let query = cteDb
        .selectFrom('shareables')
        .innerJoin('users as u', 'u.id', 'shareables.owner_user_id')
        .crossJoin('access_viewer')
        .select([
          'shareables.id',
          'shareables.name',
          'shareables.derived_title',
          'shareables.title_override',
          'shareables.visibility',
          'shareables.artifact_kind',
          'shareables.link_expires_at',
          'shareables.updated_at',
          'shareables.activity_at',
          'shareables.container_id',
          'u.email as owner_email',
        ])
        .where(agentReadableShareableSql('access_viewer', authority))
        .where(sql<boolean>`${invalidCursor ? 0 : 1} = 1`)
      if (args.projectId !== undefined && args.projectId !== null) {
        query = query.where('shareables.container_id', '=', args.projectId)
      }
      if (args.query) {
        const term = args.query.toLowerCase()
        query = query.where(
          sql<boolean>`instr(lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)), ${term}) > 0`,
        )
      }
      if (decoded) {
        query = query.where(
          sql<boolean>`(shareables.activity_at < ${decoded.updated_at} OR (shareables.activity_at = ${decoded.updated_at} AND shareables.id < ${decoded.id}))`,
        )
      }
      return query
        .orderBy('shareables.activity_at', 'desc')
        .orderBy('shareables.id', 'desc')
        .limit(CLI_ARTIFACTS_LIST_LIMIT + 1)
    })
    .selectFrom('access_viewer')
    .leftJoin('artifact_page', (join) => join.onTrue())
    .selectAll('artifact_page')
    .select('access_viewer.workspace_id as viewer_workspace_id')
    .orderBy('artifact_page.activity_at', 'desc')
    .orderBy('artifact_page.id', 'desc')
    .execute()
  const viewer = result[0]
  if (!viewer) return { kind: 'missing-viewer' }
  if (viewer.viewer_workspace_id !== authority.workspaceId) {
    return { kind: 'invalid-project' }
  }
  if (invalidCursor) return { kind: 'invalid-cursor' }
  const rows = result.filter(
    (
      row,
    ): row is typeof row & {
      id: string
      name: string
      visibility: NonNullable<typeof row.visibility>
      artifact_kind: NonNullable<typeof row.artifact_kind>
      updated_at: string
      activity_at: string
      owner_email: string
    } => row.id !== null,
  )
  const hasMore = rows.length > CLI_ARTIFACTS_LIST_LIMIT
  const shown = rows.slice(0, CLI_ARTIFACTS_LIST_LIMIT)
  const summaries = await loadArtifactVersionSummaries(
    db,
    shown.map((item) => item.id),
  )
  const last = shown.at(-1)
  return {
    kind: 'ok',
    data: {
      artifacts: shown.map((item) => ({
        id: item.id,
        ...summaries.get(item.id)!,
        title: displayTitle({
          name: item.name,
          derivedTitle: item.derived_title,
          titleOverride: item.title_override,
        }),
        share_url: shareUrl(args.baseUrl, item.id, item.visibility),
        visibility: item.visibility,
        link_expires_at: item.link_expires_at,
        updated_at: item.updated_at,
        project_id: item.container_id,
        owner_email: item.owner_email,
        artifact_kind: isArtifactKind(item.artifact_kind)
          ? item.artifact_kind
          : undefined,
      })),
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? encodeCursor({
              updated_at: last.activity_at,
              id: last.id,
              filter: fingerprint,
            })
          : null,
    },
  }
}

type Cursor = { updated_at: string; id: string; filter: string }
// The filter fingerprint carries the raw --query text, so the JSON must be
// base64-encoded as UTF-8 bytes: btoa alone throws on non-Latin-1 queries.
function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function decodeCursor(value: string): Cursor | null {
  try {
    const binary = atob(
      value.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (value.length % 4)) % 4),
    )
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
      ),
    )
    if (
      typeof decoded.updated_at !== 'string' ||
      typeof decoded.id !== 'string' ||
      typeof decoded.filter !== 'string'
    )
      return null
    return decoded as Cursor
  } catch {
    return null
  }
}

export function isArtifactsSearch(args: ArtifactsListQuery) {
  return [
    args.q,
    args.owner_user_ids,
    args.date_field,
    args.days,
    args.from,
    args.to,
  ].some((value) => value !== undefined)
}

export async function searchCliArtifacts(
  db: Kysely<DB>,
  indexes: SearchIndexes,
  user: Pick<SessionUser, 'id'>,
  args: ArtifactsListQuery & {
    baseUrl: string
    source: 'cli' | 'mcp'
    authority?: Extract<CliAuthority, { kind: 'agent' }>
    includeVersionSummaries?: boolean
  },
): Promise<
  | CliArtifactsListResult
  | { kind: 'invalid-input' }
  | { kind: 'capacity-exceeded' }
  | { kind: 'daily-limit'; limit: SearchDailyLimitError }
> {
  if (args.query !== undefined) return { kind: 'invalid-input' }
  const params = new URLSearchParams({ q: args.q ?? '', pageSize: '50' })
  for (const owner of args.owner_user_ids ?? []) params.append('owner', owner)
  if (args.project_id !== undefined) {
    params.set('location', args.project_id === '' ? 'home' : 'project')
    if (args.project_id) params.set('projectId', args.project_id)
  }
  if (args.date_field !== undefined) params.set('dateField', args.date_field)
  for (const key of ['days', 'from', 'to'] as const)
    if (args[key] !== undefined) params.set(key, args[key])
  const input = parseSearchInput(params)
  if ('error' in input) return { kind: 'invalid-input' }
  input.cursor = args.cursor
  if (args.authority) input.filters.credentialScope = args.authority
  let result
  try {
    result = await search(db, indexes, user.id, input, args.source)
  } catch (error) {
    if (error instanceof SearchDailyLimitError)
      return { kind: 'daily-limit', limit: error }
    if (error instanceof SearchCapacityError)
      return { kind: 'capacity-exceeded' }
    throw error
  }
  if ('error' in result) return { kind: 'invalid-cursor' }
  const ids = result.items.map((item) => item.id)
  const rows = ids.length
    ? await db
        .selectFrom('shareables')
        .innerJoin('users', 'users.id', 'shareables.owner_user_id')
        .select([
          'shareables.id',
          'shareables.link_expires_at',
          'shareables.updated_at',
          'users.email',
        ])
        .where('shareables.id', 'in', ids)
        .execute()
    : []
  const metadata = new Map(rows.map((row) => [row.id, row]))
  const summaries =
    args.includeVersionSummaries && !args.authority
      ? await loadArtifactVersionSummaries(db, ids)
      : new Map()
  return {
    kind: 'ok',
    data: {
      artifacts: result.items.map((item) => ({
        id: item.id,
        title: item.title,
        share_url: shareUrl(args.baseUrl, item.id, item.visibility),
        visibility: item.visibility,
        link_expires_at: metadata.get(item.id)?.link_expires_at ?? null,
        updated_at: metadata.get(item.id)!.updated_at,
        owner_user_id: item.ownerId,
        project_id: item.project?.id ?? null,
        ...(args.authority || args.project_id
          ? { owner_email: metadata.get(item.id)?.email }
          : {}),
        ...summaries.get(item.id),
        artifact_kind: item.artifactKind ?? undefined,
        excerpt: item.excerpt,
        group_size: item.groupSize,
        group_size_relation: item.groupSizeRelation,
      })),
      total: result.total,
      ...(result.total.value === 0
        ? {
            search_hint:
              'Rephrase the query and search again before concluding that nothing exists.',
          }
        : result.tier === 'any'
          ? {
              search_hint:
                'No documents matched all query terms. These results match any of the terms. Rephrase the query and search again.',
            }
          : {}),
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: result.nextCursor !== null,
      next_cursor: result.nextCursor,
    },
  }
}

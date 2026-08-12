import { sql, type Kysely } from 'kysely'
import type { SessionUser } from '~/lib/user'
import { displayTitle } from '~/lib/display-title'
import { shareUrl } from '~/services/artifact-readback.server'
import {
  findSharedProjectForViewer,
  findWorkspaceProject,
  visibleSharedProjectShareableToViewerSql,
  visibleShareableToViewerSql,
} from '~/services/projects.server'
import { listOwnedShareables } from '~/services/shareables.server'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'

export const CLI_ARTIFACTS_LIST_LIMIT = 50

export type CliArtifactsListResult =
  | { kind: 'ok'; data: CliArtifactsListData }
  | { kind: 'invalid-project' }
  | { kind: 'invalid-cursor' }

export type CliArtifactsListData = {
  artifacts: Array<{
    id: string
    title: string
    share_url: string
    visibility: string
    link_expires_at: string | null
    updated_at: string
    project_id: string | null
    owner_email?: string
    artifact_kind: string
  }>
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

    // The visibility predicates reference the unaliased `shareables` table, so
    // this query must not alias it. The workspace boundary is applied before
    // the visibility predicate; audience members from other workspaces only
    // see 'project' visibility and their own grants.
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
        'u.email as owner_email',
      ])
      .where('shareables.workspace_id', '=', workspaceId)
      .where('shareables.container_id', '=', projectId)
      .where('c.kind', '=', 'project')
      .where(sql<boolean>`${visible}`)
    if (args.query) {
      const term = `%${args.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
      qb = qb.where(
        sql<boolean>`lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)) like ${term} escape '\\'`,
      )
    }
    if (decoded) {
      qb = qb.where(
        sql<boolean>`(shareables.updated_at < ${decoded.updated_at} OR (shareables.updated_at = ${decoded.updated_at} AND shareables.id < ${decoded.id}))`,
      )
    }
    const rows = await qb
      .orderBy('shareables.updated_at', 'desc')
      .orderBy('shareables.id', 'desc')
      .limit(CLI_ARTIFACTS_LIST_LIMIT + 1)
      .execute()
    const hasMore = rows.length > CLI_ARTIFACTS_LIST_LIMIT
    const shown = hasMore ? rows.slice(0, CLI_ARTIFACTS_LIST_LIMIT) : rows
    const last = shown.at(-1)
    return {
      kind: 'ok',
      data: {
        artifacts: shown.map((item) => ({
          id: item.id,
          title: displayTitle({
            name: item.name,
            derivedTitle: item.derived_title,
            titleOverride: item.title_override,
          }),
          share_url: shareUrl(args.baseUrl, item.id),
          visibility: item.visibility,
          link_expires_at: item.link_expires_at,
          updated_at: item.updated_at,
          project_id: projectId,
          owner_email: item.owner_email,
          artifact_kind: item.artifact_kind,
        })),
        limit: CLI_ARTIFACTS_LIST_LIMIT,
        has_more: hasMore,
        next_cursor:
          hasMore && last
            ? encodeCursor({
                updated_at: last.updated_at,
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
  return {
    kind: 'ok',
    data: {
      artifacts: shown.map((item) => ({
        id: item.id,
        title: item.title,
        share_url: shareUrl(args.baseUrl, item.id),
        visibility: item.visibility,
        link_expires_at: item.linkExpiresAt,
        updated_at: item.updatedAt,
        project_id: item.projectId,
        artifact_kind: item.artifactKind,
      })),
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
            updated_at: shown.at(-1)!.updatedAt,
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
): Promise<CliArtifactsListResult> {
  const fingerprint = JSON.stringify({
    agent: true,
    project_id: args.projectId ?? null,
    query: args.query ?? null,
  })
  const decoded = args.cursor ? decodeCursor(args.cursor) : null
  if (args.cursor && (!decoded || decoded.filter !== fingerprint)) {
    return { kind: 'invalid-cursor' }
  }
  const normalizedEmail = user.email.toLowerCase()
  let query = db
    .selectFrom('shareables')
    .innerJoin('users as u', 'u.id', 'shareables.owner_user_id')
    .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
    .select([
      'shareables.id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.visibility',
      'shareables.artifact_kind',
      'shareables.link_expires_at',
      'shareables.updated_at',
      'shareables.container_id',
      'u.email as owner_email',
    ])
    .where('shareables.workspace_id', '=', authority.workspaceId)
    .where('shareables.container_id', '=', authority.projectId)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('shareables.visibility', '=', 'workspace'),
          eb.or([
            eb('shareables.container_id', 'is', null),
            eb('c.archived_at', 'is', null),
          ]),
        ]),
        eb.and([
          eb('shareables.visibility', '=', 'project'),
          eb('c.kind', '=', 'project'),
          eb('c.archived_at', 'is', null),
          eb.or([
            eb('c.base_visibility', '=', 'workspace'),
            sql<boolean>`exists (
              select 1 from project_share_defaults psd
              where psd.project_container_id = shareables.container_id
                and lower(psd.email) = ${normalizedEmail}
            )`,
          ]),
        ]),
      ]),
    )
  if (args.projectId) {
    query = query.where('shareables.container_id', '=', args.projectId)
  }
  if (args.query) {
    const term = `%${args.query.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    query = query.where(
      sql<boolean>`lower(coalesce(shareables.title_override, shareables.derived_title, shareables.name)) like ${term} escape '\\'`,
    )
  }
  if (decoded) {
    query = query.where(
      sql<boolean>`(shareables.updated_at < ${decoded.updated_at} OR (shareables.updated_at = ${decoded.updated_at} AND shareables.id < ${decoded.id}))`,
    )
  }
  const rows = await query
    .orderBy('shareables.updated_at', 'desc')
    .orderBy('shareables.id', 'desc')
    .limit(CLI_ARTIFACTS_LIST_LIMIT + 1)
    .execute()
  const hasMore = rows.length > CLI_ARTIFACTS_LIST_LIMIT
  const shown = rows.slice(0, CLI_ARTIFACTS_LIST_LIMIT)
  const last = shown.at(-1)
  return {
    kind: 'ok',
    data: {
      artifacts: shown.map((item) => ({
        id: item.id,
        title: displayTitle({
          name: item.name,
          derivedTitle: item.derived_title,
          titleOverride: item.title_override,
        }),
        share_url: shareUrl(args.baseUrl, item.id),
        visibility: item.visibility,
        link_expires_at: item.link_expires_at,
        updated_at: item.updated_at,
        project_id: item.container_id,
        owner_email: item.owner_email,
        artifact_kind: item.artifact_kind,
      })),
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? encodeCursor({
              updated_at: last.updated_at,
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

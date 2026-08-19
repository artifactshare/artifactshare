import { type ExpressionBuilder, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import type { SessionUser } from '~/lib/user'
import { loadShareableViewAccess } from '~/services/comments.server'
import { d1DatabaseFor } from '~/services/db.server'
import type { DB } from '~/types/db'

// Who viewed (viewer list): shared disclosure rule and its two consumers.
//
// A user is disclosed in (and eligible to see) the viewer list of a shareable
// exactly when all three hold:
//   1. users.workspace_id = shareables.workspace_id
//   2. users.kind = 'human'
//   3. an active (status != 'removed') workspace_members row EXISTS for that
//      workspace
// Eligibility (the requester side) additionally requires view access to the
// file itself (loadShareableViewAccess). This module is the only place the
// predicate is implemented; listing, counting, and requester checks all go
// through it.

export const VIEWER_LIST_DEFAULT_LIMIT = 50
export const VIEWER_LIST_MAX_LIMIT = 100

export interface ViewerListRow {
  userId: string
  // Raw stored value; normalization (unknown-user label, initials) is UI-side.
  name: string | null
  image: string | null
  lastViewedAt: string
  isSelf: boolean
  isExternal: boolean
}

export type ListShareableViewersResult =
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'invalid-cursor' }
  | { kind: 'invalid-limit' }
  | {
      kind: 'ok'
      rows: ViewerListRow[]
      nextCursor: string | null
      totalViewers: number
    }

function internalAudienceCondition(
  eb: ExpressionBuilder<DB & { u: DB['users'] }, 'u'>,
  shareableId: string,
) {
  return eb.exists(
    eb
      .selectFrom('shareables as audience_shareable')
      .innerJoin('workspace_members as audience_member', (join) =>
        join
          .onRef(
            'audience_member.workspace_id',
            '=',
            'audience_shareable.workspace_id',
          )
          .onRef('audience_member.user_id', '=', 'u.id'),
      )
      .select('audience_member.user_id')
      .where('audience_shareable.id', '=', shareableId)
      .whereRef('u.workspace_id', '=', 'audience_shareable.workspace_id')
      .where('audience_member.status', '!=', 'removed'),
  )
}

// One audience predicate shared by requester checks, listing, and counting.
function audienceConditions(
  eb: ExpressionBuilder<DB & { u: DB['users'] }, 'u'>,
  shareableId: string,
) {
  return eb.and([
    eb('u.kind', '=', 'human'),
    eb.or([
      internalAudienceCondition(eb, shareableId),
      eb.and([
        eb('u.email_verified', '=', 1),
        eb.exists(
          eb
            .selectFrom('shareable_grants as audience_grant')
            .select('audience_grant.shareable_id')
            .where('audience_grant.shareable_id', '=', shareableId)
            .where(
              lowerEmail('audience_grant.granted_email'),
              '=',
              lowerEmail('u.email'),
            ),
        ),
      ]),
      eb.and([
        eb('u.email_verified', '=', 1),
        eb.exists(
          eb
            .selectFrom('shareables as audience_shareable')
            .innerJoin(
              'artifact_containers as audience_container',
              'audience_container.id',
              'audience_shareable.container_id',
            )
            .innerJoin(
              'project_share_defaults as audience_default',
              'audience_default.project_container_id',
              'audience_container.id',
            )
            .select('audience_shareable.id')
            .where('audience_shareable.id', '=', shareableId)
            .where('audience_shareable.visibility', '=', 'project')
            .where('audience_container.kind', '=', 'project')
            .where(
              lowerEmail('audience_default.email'),
              '=',
              lowerEmail('u.email'),
            ),
        ),
      ]),
    ]),
  ])
}

// Shared query builder: the disclosed viewer rows of one shareable.
function disclosedViewersQuery(db: Kysely<DB>, shareableId: string) {
  return db
    .selectFrom('shareable_viewer_recency as r')
    .innerJoin('users as u', 'u.id', 'r.viewer_user_id')
    .where('r.shareable_id', '=', shareableId)
    .where((eb) => audienceConditions(eb, shareableId))
}

// The audience predicate applied to one requester (or, without the id filter,
// to every user).
function audienceUsersQuery(db: Kysely<DB>, shareableId: string) {
  return db
    .selectFrom('users as u')
    .where((eb) => audienceConditions(eb, shareableId))
}

// Run read queries in one D1 batch when the Workers binding is present.
// Service tests use an in-process Kysely database without a binding and fall
// back to sequential execution.
async function runReadBatch(
  db: Kysely<DB>,
  queries: Array<{
    compile(): { sql: string; parameters: ReadonlyArray<unknown> }
    execute(): Promise<unknown[]>
  }>,
): Promise<unknown[][]> {
  const database = d1DatabaseFor(db)
  if (!database) {
    return await Promise.all(queries.map((query) => query.execute()))
  }
  const results = await database.batch(
    queries.map((query) => {
      const compiled = query.compile()
      return database.prepare(compiled.sql).bind(...compiled.parameters)
    }),
  )
  return results.map((result) => (result.results ?? []) as unknown[])
}

// Loader-side stats: the caller (a/:id loader) has already resolved view
// access, so this does not repeat it. One D1 batch.
export async function countShareableViewers(
  db: Kysely<DB>,
  input: {
    shareableId: string
    requesterUserId: string
  },
): Promise<{
  requesterEligible: boolean
  viewerCount: number
}> {
  const { shareableId, requesterUserId } = input
  const requesterQuery = audienceUsersQuery(db, shareableId)
    .select('u.id')
    .where('u.id', '=', requesterUserId)
  const viewerCountQuery = disclosedViewersQuery(db, shareableId).select((eb) =>
    eb.fn.countAll<number>().as('count'),
  )

  const [requesterRows, viewerCountRows] = (await runReadBatch(db, [
    requesterQuery,
    viewerCountQuery,
  ])) as [Array<{ id: string }>, Array<{ count: number }>]

  return {
    requesterEligible: requesterRows.length > 0,
    viewerCount: Number(viewerCountRows[0]?.count ?? 0),
  }
}

interface ViewerCursor {
  last_viewed_at: string
  viewer_user_id: string
}

function encodeViewerCursor(cursor: ViewerCursor & { filter: string }): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

// Opaque base64url JSON cursor. Validation is shape-only: exactly the three
// string keys, and `filter` must match the requested shareable. There is
// deliberately no length cap and no datetime-format validation — the column
// carries no format/length constraint, so accepting anything we issued keeps
// the re-acceptance guarantee and paging completeness unconditional; size
// defense is the platform request limit.
function decodeViewerCursor(
  raw: string,
  shareableId: string,
): ViewerCursor | 'invalid' {
  try {
    const base64 = raw.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(base64)
    const json = new TextDecoder().decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'invalid'
    }
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).length !== 3) return 'invalid'
    const { last_viewed_at, viewer_user_id, filter } = record
    if (
      typeof last_viewed_at !== 'string' ||
      typeof viewer_user_id !== 'string' ||
      typeof filter !== 'string'
    ) {
      return 'invalid'
    }
    if (filter !== shareableId) return 'invalid'
    return { last_viewed_at, viewer_user_id }
  } catch {
    return 'invalid'
  }
}

function parseViewerListLimit(raw: string | null): number | 'invalid' {
  if (raw === null || raw === undefined) return VIEWER_LIST_DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value)) return 'invalid'
  if (value < 1 || value > VIEWER_LIST_MAX_LIMIT) return 'invalid'
  return value
}

// API-side listing. Owns existence + view access, requester eligibility, and
// raw parameter parsing, in that order — an unauthorized caller never learns
// whether an id exists from a parameter 400.
export async function listShareableViewers(
  db: Kysely<DB>,
  input: {
    user: SessionUser
    shareableId: string
    cursor: string | null
    limit: string | null
  },
): Promise<ListShareableViewersResult> {
  const { user, shareableId } = input

  const access = await loadShareableViewAccess(db, user, shareableId)
  if (!access) return { kind: 'not-found' }

  // Eligibility: the requester must satisfy the shared audience predicate.
  // Bots and link-only viewers fail it; removed members can still qualify via
  // a verified file or project audience.
  const [requesterRow] = await audienceUsersQuery(db, shareableId)
    .select('u.id')
    .where('u.id', '=', user.id)
    .execute()
  if (!requesterRow) return { kind: 'forbidden' }

  const limit = parseViewerListLimit(input.limit)
  if (limit === 'invalid') return { kind: 'invalid-limit' }
  const cursor =
    input.cursor === null ? null : decodeViewerCursor(input.cursor, shareableId)
  if (cursor === 'invalid') return { kind: 'invalid-cursor' }

  let rowsQuery = disclosedViewersQuery(db, shareableId)
    .select((eb) => [
      'u.id as user_id',
      'u.name as name',
      'u.image as image',
      'r.last_viewed_at as last_viewed_at',
      eb
        .case()
        .when(internalAudienceCondition(eb, shareableId))
        .then(0)
        .else(1)
        .end()
        .as('is_external'),
    ])
    .orderBy('r.last_viewed_at', 'desc')
    .orderBy('r.viewer_user_id', 'desc')
    .limit(limit + 1)
  if (cursor) {
    rowsQuery = rowsQuery.where(({ eb, or, and }) =>
      or([
        eb('r.last_viewed_at', '<', cursor.last_viewed_at),
        and([
          eb('r.last_viewed_at', '=', cursor.last_viewed_at),
          eb('r.viewer_user_id', '<', cursor.viewer_user_id),
        ]),
      ]),
    )
  }
  // totalViewers is a separate COUNT over the same builder (not derived from
  // the page query); a ±1 divergence against paging is accepted.
  const totalQuery = disclosedViewersQuery(db, shareableId).select((eb) =>
    eb.fn.countAll<number>().as('count'),
  )

  const [pageRows, totalRows] = (await runReadBatch(db, [
    rowsQuery,
    totalQuery,
  ])) as [
    Array<{
      user_id: string
      name: string | null
      image: string | null
      last_viewed_at: string
      is_external: number
    }>,
    Array<{ count: number }>,
  ]

  // limit + 1 lookahead: a next cursor is issued only when a surplus row
  // proves another page exists (exactly `limit` remaining rows → null).
  const hasMore = pageRows.length > limit
  const visible = hasMore ? pageRows.slice(0, limit) : pageRows
  const lastVisible = visible[visible.length - 1]
  const nextCursor =
    hasMore && lastVisible
      ? encodeViewerCursor({
          last_viewed_at: lastVisible.last_viewed_at,
          viewer_user_id: lastVisible.user_id,
          filter: shareableId,
        })
      : null

  return {
    kind: 'ok',
    rows: visible.map((row) => ({
      userId: row.user_id,
      name: row.name,
      image: row.image,
      lastViewedAt: row.last_viewed_at,
      isSelf: row.user_id === user.id,
      isExternal: Boolean(row.is_external),
    })),
    nextCursor,
    totalViewers: Number(totalRows[0]?.count ?? 0),
  }
}

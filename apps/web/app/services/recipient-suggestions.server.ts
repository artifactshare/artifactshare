import { sql, type Kysely } from 'kysely'
import {
  isReservedBotEmail,
  normalizeGrantEmail,
  normalizeGrantEmailList,
} from '~/lib/grant-emails'
import {
  RECIPIENT_SUGGESTION_LIMIT,
  type RecipientSuggestion,
  type RecipientSuggestionContext,
} from '~/lib/recipient-suggestions'
import { isExternalPostingEnabledForWorkspace } from '~/lib/project-external-posting.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import {
  canEditProjectContainer,
  getProjectContainerWorkspaceId,
} from '~/services/projects.server'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'

type Candidate = RecipientSuggestion & {
  source: 'workspace' | 'history'
  lastUsedAt: string | null
}

export type RecipientSuggestionsResult =
  | { kind: 'ok'; candidates: RecipientSuggestion[] }
  | { kind: 'forbidden' }

export async function suggestRecipients(
  db: Kysely<DB>,
  user: SessionUser,
  context: RecipientSuggestionContext,
  rawQuery: string,
  pendingEmails: ReadonlyArray<string>,
): Promise<RecipientSuggestionsResult> {
  if (!(await canUseSuggestionContext(db, user, context))) {
    return { kind: 'forbidden' }
  }

  const query = rawQuery.trim().toLowerCase()
  const excluded = new Set(normalizeGrantEmailList(pendingEmails))
  excluded.add(normalizeGrantEmail(user.email))
  for (const email of await currentTargetEmails(db, context)) {
    excluded.add(normalizeGrantEmail(email))
  }

  const [workspaceRows, grantRows, projectRows] = await Promise.all([
    db
      .selectFrom('workspace_members as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.name', 'u.image'])
      .where('m.workspace_id', '=', user.workspaceId)
      .where('m.status', '=', 'active')
      .where('u.kind', '=', 'human')
      .where((eb) =>
        eb.or([
          sql<boolean>`instr(lower(u.email), ${query}) > 0`,
          sql<boolean>`instr(lower(coalesce(u.name, '')), ${query}) > 0`,
        ]),
      )
      .orderBy(
        sql<number>`CASE WHEN instr(lower(u.email), ${query}) = 1 OR instr(lower(coalesce(u.name, '')), ${query}) = 1 THEN 0 ELSE 1 END`,
      )
      .orderBy('u.email', 'asc')
      .limit(32)
      .execute(),
    db
      .selectFrom('shareable_grants as g')
      .leftJoin('users as u', (join) =>
        join.on(sql<boolean>`lower(u.email) = lower(g.granted_email)`),
      )
      .select(['g.granted_email as email', 'g.granted_at as used_at'])
      .where('g.granted_by', '=', user.id)
      .where((eb) =>
        eb.or([
          sql<boolean>`instr(lower(g.granted_email), ${query}) > 0`,
          sql<boolean>`instr(lower(coalesce(u.name, '')), ${query}) > 0`,
        ]),
      )
      .orderBy('g.granted_at', 'desc')
      .limit(32)
      .execute(),
    db
      .selectFrom('project_share_defaults as d')
      .leftJoin('users as u', (join) =>
        join.on(sql<boolean>`lower(u.email) = lower(d.email)`),
      )
      .select(['d.email', 'd.display_name', 'd.updated_at as used_at'])
      .where('d.created_by_id', '=', user.id)
      .where((eb) =>
        eb.or([
          sql<boolean>`instr(lower(d.email), ${query}) > 0`,
          sql<boolean>`instr(lower(coalesce(d.display_name, '')), ${query}) > 0`,
          sql<boolean>`instr(lower(coalesce(u.name, '')), ${query}) > 0`,
        ]),
      )
      .orderBy('d.updated_at', 'desc')
      .limit(32)
      .execute(),
  ])

  const historyByEmail = new Map<
    string,
    { email: string; displayName: string | null; lastUsedAt: string }
  >()
  for (const row of grantRows) {
    rememberHistory(historyByEmail, row.email, null, row.used_at)
  }
  for (const row of projectRows) {
    rememberHistory(historyByEmail, row.email, row.display_name, row.used_at)
  }

  const historyEmails = Array.from(historyByEmail.keys())
  const resolvedUsers =
    historyEmails.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select(['id', 'email', 'name', 'image', 'workspace_id', 'kind'])
          .where(
            sql<boolean>`lower(email) IN (${sql.join(historyEmails.map((email) => sql`${email}`))})`,
          )
          .execute()
  const usersByEmail = new Map(
    resolvedUsers.map((row) => [normalizeGrantEmail(row.email), row]),
  )
  const resolvedUserIds = resolvedUsers.map((row) => row.id)
  const activeUsers = new Set(
    resolvedUserIds.length === 0
      ? []
      : (
          await db
            .selectFrom('workspace_members')
            .select(['workspace_id', 'user_id'])
            .where('status', '=', 'active')
            .where('user_id', 'in', resolvedUserIds)
            .execute()
        ).map((row) => `${row.workspace_id}:${row.user_id}`),
  )

  const candidates = new Map<string, Candidate>()
  for (const row of workspaceRows) {
    const email = normalizeGrantEmail(row.email)
    if (excluded.has(email)) continue
    candidates.set(email, {
      email,
      user: { id: row.id, name: row.name, image: row.image },
      displayName: row.name,
      source: 'workspace',
      lastUsedAt: null,
    })
  }
  for (const [email, history] of historyByEmail) {
    if (
      excluded.has(email) ||
      candidates.has(email) ||
      isReservedBotEmail(email)
    ) {
      continue
    }
    const resolved = usersByEmail.get(email)
    if (resolved?.kind === 'bot') continue
    if (
      resolved &&
      !activeUsers.has(`${resolved.workspace_id}:${resolved.id}`)
    ) {
      continue
    }
    candidates.set(email, {
      email,
      user: resolved
        ? { id: resolved.id, name: resolved.name, image: resolved.image }
        : null,
      displayName: resolved?.name ?? history.displayName,
      source: 'history',
      lastUsedAt: history.lastUsedAt,
    })
  }

  return {
    kind: 'ok',
    candidates: Array.from(candidates.values())
      .sort((a, b) => compareCandidates(a, b, query))
      .slice(0, RECIPIENT_SUGGESTION_LIMIT)
      .map(
        ({ source: _source, lastUsedAt: _lastUsedAt, ...candidate }) =>
          candidate,
      ),
  }
}

async function canUseSuggestionContext(
  db: Kysely<DB>,
  user: SessionUser,
  context: RecipientSuggestionContext,
): Promise<boolean> {
  if (context.kind === 'upload') {
    const member = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', user.workspaceId)
      .where('user_id', '=', user.id)
      .where('status', '=', 'active')
      .executeTakeFirst()
    return Boolean(member) && (await checkUploadAccess(user)).kind === 'allowed'
  }
  if (context.kind === 'shareable') {
    return Boolean(
      await db
        .selectFrom('shareables')
        .select('id')
        .where('id', '=', context.id)
        .where('owner_user_id', '=', user.id)
        .executeTakeFirst(),
    )
  }
  const workspaceId = await getProjectContainerWorkspaceId(db, context.id)
  if (!workspaceId) return false
  const managerRoleEnabled = await isExternalPostingEnabledForWorkspace(
    db,
    workspaceId,
  )
  return await canEditProjectContainer(db, workspaceId, context.id, user, {
    managerRoleEnabled,
  })
}

async function currentTargetEmails(
  db: Kysely<DB>,
  context: RecipientSuggestionContext,
): Promise<string[]> {
  if (context.kind === 'upload') return []
  if (context.kind === 'shareable') {
    return (
      await db
        .selectFrom('shareable_grants')
        .select('granted_email')
        .where('shareable_id', '=', context.id)
        .execute()
    ).map((row) => row.granted_email)
  }
  return (
    await db
      .selectFrom('project_share_defaults')
      .select('email')
      .where('project_container_id', '=', context.id)
      .execute()
  ).map((row) => row.email)
}

function rememberHistory(
  map: Map<
    string,
    { email: string; displayName: string | null; lastUsedAt: string }
  >,
  rawEmail: string,
  displayName: string | null,
  usedAt: string,
) {
  const email = normalizeGrantEmail(rawEmail)
  const current = map.get(email)
  if (!current || usedAt > current.lastUsedAt) {
    map.set(email, { email, displayName, lastUsedAt: usedAt })
  }
}

function compareCandidates(a: Candidate, b: Candidate, query: string): number {
  const aPrefix = candidateMatchesPrefix(a, query) ? 0 : 1
  const bPrefix = candidateMatchesPrefix(b, query) ? 0 : 1
  if (aPrefix !== bPrefix) return aPrefix - bPrefix
  if (a.source !== b.source) return a.source === 'workspace' ? -1 : 1
  if (a.lastUsedAt !== b.lastUsedAt) {
    return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')
  }
  return a.email.localeCompare(b.email)
}

function candidateMatchesPrefix(candidate: RecipientSuggestion, query: string) {
  return (
    candidate.email.startsWith(query) ||
    (candidate.user?.name ?? candidate.displayName ?? '')
      .toLowerCase()
      .startsWith(query)
  )
}

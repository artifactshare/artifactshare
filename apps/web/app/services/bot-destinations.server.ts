import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { nowIso } from '~/lib/datetime'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { lowerEmail } from '~/lib/grant-emails.server'
import { runD1Batch } from '~/lib/d1-batch.server'
import type { DB } from '~/types/db'
import {
  placementAssertionQueries,
  projectPlacementSql,
} from './projects.server'

type Actor = { id: string; workspaceId: string }

export function normalizeBotDestinations(
  primary: string,
  ids: unknown,
): string[] | null {
  if (
    !primary ||
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== 'string' || !id.trim())
  )
    return null
  const result = [...new Set(ids as string[])]
  return result.includes(primary) ? result : null
}

export function botDestinationPlacementSql(
  actor: Actor,
  projectId: string,
  email: string,
) {
  return sql<boolean>`${projectPlacementSql(actor, projectId)} AND EXISTS (
    SELECT 1 FROM artifact_containers p WHERE p.id = ${projectId} AND p.workspace_id = ${actor.workspaceId}
      AND (p.base_visibility = 'workspace' OR EXISTS (
        SELECT 1 FROM project_share_defaults g WHERE g.project_container_id = p.id
          AND ${lowerEmail('g.email')} = ${email.toLowerCase()} AND g.role IN ('contributor', 'manager')
      ) OR (NOT EXISTS (
        SELECT 1 FROM project_share_defaults g WHERE g.project_container_id = p.id AND ${lowerEmail('g.email')} = ${email.toLowerCase()}
      ) AND (SELECT count(*) FROM project_share_defaults g WHERE g.project_container_id = p.id) < ${MAX_GRANT_EMAILS}))
  )`
}

export function botDestinationGrant(
  db: Kysely<DB>,
  actor: Actor,
  bot: { id: string; email: string; name: string | null },
  projectId: string,
  now: string,
) {
  return db
    .insertInto('project_share_defaults')
    .columns([
      'id',
      'project_container_id',
      'email',
      'role',
      'display_name',
      'created_by_id',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('artifact_containers as p')
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(projectId).as('project_container_id'),
          eb.val(bot.email).as('email'),
          eb.val('contributor' as const).as('role'),
          eb.val(bot.name).as('display_name'),
          eb.val(actor.id).as('created_by_id'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ])
        .where('p.id', '=', projectId)
        .where('p.base_visibility', '=', 'private')
        .where(sql<boolean>`EXISTS (SELECT 1 FROM users WHERE id = ${bot.id})`)
        .where(
          sql<boolean>`NOT EXISTS (SELECT 1 FROM project_share_defaults g WHERE g.project_container_id = ${projectId} AND ${lowerEmail('g.email')} = ${bot.email.toLowerCase()})`,
        ),
    )
}

export async function updateWorkspaceBotDestinations(
  db: Kysely<DB>,
  actor: Actor,
  input: {
    botUserId: string
    projectId: string
    projectIds: unknown
    revision: string
  },
): Promise<{
  kind:
    | 'ok'
    | 'forbidden'
    | 'not-found'
    | 'bot-stopped'
    | 'bot-destination-invalid'
    | 'bot-conflict'
}> {
  if (
    !(await db
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select('users.id')
      .where('users.id', '=', actor.id)
      .where('users.kind', '=', 'human')
      .where('workspace_members.workspace_id', '=', actor.workspaceId)
      .where('workspace_members.status', '=', 'active')
      .where('workspace_members.role', 'in', ['owner', 'admin'])
      .executeTakeFirst())
  )
    return { kind: 'forbidden' }
  const ids = normalizeBotDestinations(input.projectId, input.projectIds)
  if (!ids) return { kind: 'bot-destination-invalid' }
  const bot = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'updated_at', 'bot_stopped_at'])
    .where('id', '=', input.botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'bot')
    .where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM bridge_authorities b WHERE b.bot_user_id = users.id)`,
    )
    .executeTakeFirst()
  if (!bot) return { kind: 'not-found' }
  if (bot.bot_stopped_at) return { kind: 'bot-stopped' }
  if (bot.updated_at !== input.revision) return { kind: 'bot-conflict' }
  const families = await db
    .selectFrom('cli_family_authorities')
    .select(['family_id', 'project_id', 'updated_at'])
    .where('user_id', '=', bot.id)
    .where('status', '=', 'active')
    .where('preset', '=', 'agent')
    .where('bridge_authority_id', 'is', null)
    .execute()
  if (!families.length) return { kind: 'bot-destination-invalid' }
  const existing = await db
    .selectFrom('bot_destination_projects')
    .select('project_id')
    .where('family_id', '=', families[0]!.family_id)
    .execute()
  const added = ids.filter((id) => !existing.some((p) => p.project_id === id))
  const validate = [
    ...new Set([
      ...added,
      ...(input.projectId !== families[0]!.project_id ? [input.projectId] : []),
    ]),
  ]
  for (const id of validate) {
    if (
      !(await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', actor.id)
        .where(botDestinationPlacementSql(actor, id, bot.email))
        .executeTakeFirst())
    )
      return { kind: 'bot-destination-invalid' }
  }
  const now = nowIso()
  const marker = `${now.slice(0, -1)}${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b % 10).join('')}Z`
  const adminAndBot = sql<boolean>`EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = ${actor.id} AND m.workspace_id = ${actor.workspaceId} AND m.status = 'active' AND m.role IN ('owner', 'admin'))
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${bot.id} AND u.workspace_id = ${actor.workspaceId} AND u.bot_stopped_at IS NULL AND u.updated_at = ${input.revision})`
  const assertions = [
    adminAndBot,
    ...families.map(
      (f) =>
        sql<boolean>`EXISTS (SELECT 1 FROM cli_family_authorities WHERE family_id = ${f.family_id} AND status = 'active' AND updated_at = ${f.updated_at})`,
    ),
    ...validate.map((id) => botDestinationPlacementSql(actor, id, bot.email)),
  ]
  const queries = assertions.flatMap((predicate) =>
    placementAssertionQueries(db, actor.workspaceId, nanoid(), predicate, now),
  )
  queries.push(
    db
      .updateTable('users')
      .set({ updated_at: marker })
      .where('id', '=', bot.id),
  )
  for (const id of validate)
    queries.push(botDestinationGrant(db, actor, bot, id, now))
  for (const family of families) {
    queries.push(
      db
        .deleteFrom('bot_destination_projects')
        .where('family_id', '=', family.family_id),
    )
    for (const id of ids)
      queries.push(
        db
          .insertInto('bot_destination_projects')
          .columns([
            'family_id',
            'project_id',
            'project_name_snapshot',
            'created_at',
          ])
          .expression((eb) =>
            eb
              .selectFrom('artifact_containers')
              .where('id', '=', id)
              .select([
                eb.val(family.family_id).as('family_id'),
                'id as project_id',
                'name as project_name_snapshot',
                eb.val(now).as('created_at'),
              ]),
          ),
      )
    queries.push(
      db
        .updateTable('cli_family_authorities')
        .set({
          project_id: input.projectId,
          project_name_snapshot: sql<string>`(SELECT name FROM artifact_containers WHERE id = ${input.projectId})`,
          updated_at: marker,
        })
        .where('family_id', '=', family.family_id),
      // Sessions resolve authorization through the family, but their placement
      // metadata must not keep a removed primary pinned by its foreign key.
      db
        .updateTable('cli_session_authorities')
        .set({ project_id: input.projectId })
        .where('family_id', '=', family.family_id),
    )
  }
  queries.push(
    db.insertInto('audit_events').values({
      id: nanoid(),
      workspace_id: actor.workspaceId,
      actor_user_id: actor.id,
      action: 'bot.destinations.update',
      subject_type: 'user',
      subject_id: bot.id,
      detail: JSON.stringify({
        name: bot.name,
        project_id: input.projectId,
        project_ids: ids,
      }),
      created_at: now,
    }),
  )
  try {
    await runD1Batch(db, ...queries)
  } catch {
    return { kind: 'bot-conflict' }
  }
  return { kind: 'ok' }
}

import { sql, type Expression, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import {
  BOT_TOKEN_PREFIX,
  generateBotEmail,
  normalizeBotDisplayName,
} from '~/lib/bot-account'
import { encodeBase64Url } from '~/lib/base64url'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { computeTextSha256Hex } from '~/lib/sha256'
import { requireWorkspaceAdmin } from '~/services/team-management.server'
import type { DB } from '~/types/db'

// Bots are outside the contributor guardrail, so an unlimited count would be
// the cheapest billing bypass. Free workspaces (which have the guardrail) get
// one active bot; paid workspaces get ten.
export const FREE_PLAN_ACTIVE_BOT_LIMIT = 1
export const ACTIVE_BOT_LIMIT = 10

const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000

export type WorkspaceBotRow = {
  id: string
  name: string | null
  email: string
  botStoppedAt: string | null
  projectId: string | null
  projectName: string | null
  projectNameSnapshot: string | null
  credentialLive: boolean
  lastAuthAt: string | null
  cancelable: boolean
}

export type CreateWorkspaceBotResult =
  | { kind: 'ok'; botUserId: string; email: string; token: string }
  | { kind: 'forbidden' }
  | { kind: 'bot-name-invalid' }
  | { kind: 'bot-destination-invalid' }
  | { kind: 'bot-limit-reached' }
  | { kind: 'bot-conflict' }

export type StopWorkspaceBotResult =
  | { kind: 'ok' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }

export type CancelWorkspaceBotResult =
  | { kind: 'ok' }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'bot-used' }

export type ReissueWorkspaceBotResult =
  | { kind: 'ok'; token: string }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'bot-stopped' }
  | { kind: 'bot-destination-invalid' }
  | { kind: 'bot-conflict' }

type Actor = { id: string; workspaceId: string }

/**
 * Request-unique ISO timestamp: the stop CAS marker. Appending random digits
 * to the fractional seconds makes each stop request's marker distinct, so
 * follow-up statements conditioned on `bot_stopped_at = marker` are 0-row for
 * every request that lost the CAS.
 */
export function uniqueStopMarker(now = new Date()): string {
  const base = now.toISOString() // ...ss.mmmZ
  let digits = ''
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  for (const byte of bytes) digits += String(byte % 10)
  return `${base.slice(0, -1)}${digits}Z`
}

function generateBotToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return BOT_TOKEN_PREFIX + encodeBase64Url(bytes)
}

function activeBotCountQuery(db: Kysely<DB>, workspaceId: string) {
  return db
    .selectFrom('users')
    .select(sql<number>`count(*)`.as('count'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'bot')
    .where('bot_stopped_at', 'is', null)
}

/**
 * Cancellation is deliberately narrower than "no visible posts". A bot is
 * unused only while its credential has never authenticated and no durable
 * record can be attributed to either the bot user or its agent profile.
 * Keeping this as one SQL predicate lets every statement in the cancellation
 * batch re-check the same condition at commit time.
 */
function botCancellationEligible(botUserId: string | Expression<unknown>) {
  return sql<boolean>`
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = ${botUserId} AND u.kind = 'bot'
    )
    AND NOT EXISTS (
      SELECT 1 FROM cli_refresh_credentials c
      WHERE c.user_id = ${botUserId}
        AND c.last_used_at IS NOT NULL
    )
    AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = ${botUserId})
    AND NOT EXISTS (
      SELECT 1 FROM artifact_containers c
      WHERE c.owner_user_id = ${botUserId} OR c.created_by_id = ${botUserId}
    )
    AND NOT EXISTS (SELECT 1 FROM shareables s WHERE s.owner_user_id = ${botUserId})
    AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.created_by_id = ${botUserId})
    AND NOT EXISTS (SELECT 1 FROM comment_threads t WHERE t.created_by_id = ${botUserId})
    AND NOT EXISTS (SELECT 1 FROM comment_messages m WHERE m.created_by_id = ${botUserId})
    AND NOT EXISTS (SELECT 1 FROM artifact_keys k WHERE k.owner_user_id = ${botUserId})
    AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.actor_user_id = ${botUserId})
    AND NOT EXISTS (
      SELECT 1 FROM shareables s
      JOIN agent_profiles p ON p.id = s.created_by_agent_profile_id
      WHERE p.user_id = ${botUserId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM comment_messages m
      JOIN agent_profiles p ON p.id = m.created_by_agent_profile_id
      WHERE p.user_id = ${botUserId}
    )
  `
}

export async function listWorkspaceBots(
  db: Kysely<DB>,
  workspaceId: string,
  now: string = nowIso(),
): Promise<WorkspaceBotRow[]> {
  const rows = await db
    .selectFrom('users')
    // Join the LATEST authority regardless of status: stop revokes them all,
    // and the stopped row must still show its destination snapshot.
    .leftJoin('cli_family_authorities as authority', (join) =>
      join.onRef('authority.user_id', '=', 'users.id').on(
        'authority.created_at',
        '=',
        sql`(
          select max(a2.created_at) from cli_family_authorities a2
          where a2.user_id = users.id
        )`,
      ),
    )
    .leftJoin(
      'artifact_containers as project',
      'project.id',
      'authority.project_id',
    )
    .select(({ exists, selectFrom }) => [
      'users.id',
      'users.name',
      'users.email',
      'users.bot_stopped_at as botStoppedAt',
      sql<string | null>`max(authority.project_id)`.as('projectId'),
      sql<string | null>`max(project.name)`.as('projectName'),
      sql<string | null>`max(authority.project_name_snapshot)`.as(
        'projectNameSnapshot',
      ),
      exists(
        selectFrom('cli_refresh_credentials as credential')
          .select('credential.id')
          .whereRef('credential.family_id', '=', 'authority.family_id')
          .where('credential.revoked_at', 'is', null)
          .where('credential.expires_at', '>', now),
      ).as('credentialLive'),
      selectFrom('cli_refresh_credentials as any_credential')
        .select(sql<string | null>`max(any_credential.last_used_at)`.as('m'))
        .whereRef('any_credential.user_id', '=', 'users.id')
        .as('lastAuthAt'),
      botCancellationEligible(sql.ref('users.id')).as('cancelable'),
    ])
    .where('users.workspace_id', '=', workspaceId)
    .where('users.kind', '=', 'bot')
    .groupBy('users.id')
    .orderBy('users.created_at', 'desc')
    .execute()
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    botStoppedAt: row.botStoppedAt,
    projectId: row.projectId,
    projectName: row.projectName,
    projectNameSnapshot: row.projectNameSnapshot,
    credentialLive: Boolean(row.credentialLive),
    lastAuthAt: row.lastAuthAt,
    cancelable: Boolean(row.cancelable),
  }))
}

/**
 * Create a bot member with its agent credential family in a single D1 batch.
 * The head `users` INSERT is the serialization point: the plan-aware active
 * bot cap is its SELECT predicate, and the active-bot-name unique index (or
 * users.email UNIQUE) makes concurrent-create losers fail the whole batch.
 */
export async function createWorkspaceBot(
  db: Kysely<DB>,
  actor: Actor,
  input: { name: string; projectId: string },
): Promise<CreateWorkspaceBotResult> {
  const admin = await requireWorkspaceAdmin(db, actor)
  if (admin.kind !== 'ok') return { kind: 'forbidden' }
  const name = normalizeBotDisplayName(input.name)
  if (!name) return { kind: 'bot-name-invalid' }

  // Pre-validation: the destination must be a non-archived project in the
  // admin's workspace; a private destination must have grant headroom for the
  // bot's contributor grant. The batch re-checks both as INSERT...SELECT
  // guards to cover the pre-check → batch race.
  const project = await db
    .selectFrom('artifact_containers')
    .select(({ selectFrom }) => [
      'id',
      'name',
      'base_visibility',
      selectFrom('project_share_defaults')
        .select(sql<number>`count(*)`.as('c'))
        .whereRef('project_container_id', '=', 'artifact_containers.id')
        .as('grantCount'),
    ])
    .where('id', '=', input.projectId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!project) return { kind: 'bot-destination-invalid' }
  const privateDestination = project.base_visibility !== 'workspace'
  if (privateDestination && (project.grantCount ?? 0) >= MAX_GRANT_EMAILS) {
    return { kind: 'bot-destination-invalid' }
  }

  const botUserId = nanoid()
  const email = generateBotEmail()
  const profileId = nanoid()
  const familyId = nanoid()
  const credentialId = familyId
  const token = generateBotToken()
  const tokenHash = await computeTextSha256Hex(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()

  const botRowExists = sql<boolean>`EXISTS (SELECT 1 FROM users WHERE id = ${botUserId})`

  const userInsert = db
    .insertInto('users')
    .columns([
      'id',
      'email',
      'email_verified',
      'name',
      'image',
      'created_at',
      'updated_at',
      'workspace_id',
      'locale',
      'kind',
      'bot_stopped_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('workspaces')
        .where('workspaces.id', '=', actor.workspaceId)
        .where(
          activeBotCountQuery(db, actor.workspaceId),
          '<',
          sql<number>`CASE WHEN workspaces.plan = 'free' THEN ${FREE_PLAN_ACTIVE_BOT_LIMIT} ELSE ${ACTIVE_BOT_LIMIT} END`,
        )
        .select([
          eb.val(botUserId).as('id'),
          eb.val(email).as('email'),
          // email_verified=1: audience matching (verified email equality) is
          // the explicit-share mechanism and there is no verification flow to
          // run against an unobtainable domain.
          eb.val(1).as('email_verified'),
          eb.val(name).as('name'),
          eb.val(null).as('image'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(null).as('locale'),
          eb.val('bot' as const).as('kind'),
          eb.val(null).as('bot_stopped_at'),
        ]),
    )

  const memberInsert = db
    .insertInto('workspace_members')
    .columns([
      'workspace_id',
      'user_id',
      'role',
      'status',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('users.id', '=', botUserId)
        .select([
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(botUserId).as('user_id'),
          eb.val('member' as const).as('role'),
          eb.val('active' as const).as('status'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )

  const profileInsert = db
    .insertInto('agent_profiles')
    .columns(['id', 'user_id', 'workspace_id', 'created_at'])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('users.id', '=', botUserId)
        .select([
          eb.val(profileId).as('id'),
          eb.val(botUserId).as('user_id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(now).as('created_at'),
        ]),
    )

  const familyInsert = db
    .insertInto('cli_family_authorities')
    .columns([
      'family_id',
      'user_id',
      'preset',
      'workspace_id',
      'project_id',
      'project_name_snapshot',
      'agent_profile_id',
      'approved_at',
      'device_name',
      'status',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .innerJoin('artifact_containers as project', (join) =>
          join
            .on('project.id', '=', input.projectId)
            .on('project.workspace_id', '=', actor.workspaceId)
            .on('project.kind', '=', 'project')
            .on(sql<boolean>`project.archived_at IS NULL`),
        )
        .where('users.id', '=', botUserId)
        .select([
          eb.val(familyId).as('family_id'),
          eb.val(botUserId).as('user_id'),
          eb.val('agent' as const).as('preset'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(input.projectId).as('project_id'),
          'project.name as project_name_snapshot',
          eb.val(profileId).as('agent_profile_id'),
          eb.val(now).as('approved_at'),
          eb.val(null).as('device_name'),
          eb.val('active' as const).as('status'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )

  const credentialInsert = db
    .insertInto('cli_refresh_credentials')
    .columns([
      'id',
      'user_id',
      'token_hash',
      'expires_at',
      'revoked_at',
      'created_at',
      'last_used_at',
      'family_id',
      'replaced_by_id',
      'rotation_request_hash',
      'rotation_retry_until',
      'rotation_session_id',
      'device_name',
      'device_id',
      'revocation_batch_id',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_family_authorities')
        .where('family_id', '=', familyId)
        .where('status', '=', 'active')
        .select([
          eb.val(credentialId).as('id'),
          eb.val(botUserId).as('user_id'),
          eb.val(tokenHash).as('token_hash'),
          eb.val(expiresAt).as('expires_at'),
          eb.val(null).as('revoked_at'),
          eb.val(now).as('created_at'),
          eb.val(null).as('last_used_at'),
          eb.val(familyId).as('family_id'),
          eb.val(null).as('replaced_by_id'),
          eb.val(null).as('rotation_request_hash'),
          eb.val(null).as('rotation_retry_until'),
          eb.val(null).as('rotation_session_id'),
          eb.val(null).as('device_name'),
          eb.val(null).as('device_id'),
          eb.val(null).as('revocation_batch_id'),
        ]),
    )

  // The contributor grant is part of every create batch and self-gated on the
  // destination's visibility AT WRITE TIME (not the pre-read): if the project
  // flips workspace→private between the pre-read and the batch, the grant
  // still lands; if it is workspace-visible at commit, the SELECT yields no
  // row and nothing is inserted.
  const grantInsert = db
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
        .selectFrom('artifact_containers as project')
        .where('project.id', '=', input.projectId)
        .where('project.base_visibility', '=', 'private')
        // Gate on the head users INSERT having landed: when it no-ops (bot
        // cap reached, raced workspace delete) the grant must not commit as
        // an orphan audience slot for a user row that does not exist.
        .where(botRowExists)
        .where(
          db
            .selectFrom('project_share_defaults')
            .select(sql<number>`count(*)`.as('c'))
            .where('project_container_id', '=', input.projectId),
          '<',
          MAX_GRANT_EMAILS,
        )
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(input.projectId).as('project_container_id'),
          eb.val(email).as('email'),
          eb.val('contributor' as const).as('role'),
          eb.val(name).as('display_name'),
          eb.val(actor.id).as('created_by_id'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )

  // The create audit is conditioned on the user row only (not the authority):
  // if the tiny race window leaves an incomplete bot, the recovery stop below
  // pairs it with a bot.stop event.
  const auditInsert = db
    .insertInto('audit_events')
    .columns([
      'id',
      'workspace_id',
      'actor_user_id',
      'action',
      'subject_type',
      'subject_id',
      'detail',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('users.id', '=', botUserId)
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('bot.create').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(botUserId).as('subject_id'),
          eb
            .val(
              JSON.stringify({
                name,
                project_id: input.projectId,
                project_name: project.name,
              }),
            )
            .as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )

  try {
    await runD1Batch(
      userInsert,
      memberInsert,
      profileInsert,
      familyInsert,
      credentialInsert,
      grantInsert,
      auditInsert,
    )
  } catch {
    // Constraint failure rolled the batch back; classify deterministically.
    return await classifyCreateFailure(db, actor.workspaceId, name)
  }

  const created = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', botUserId)
    .executeTakeFirst()
  if (!created) {
    // Head INSERT selected 0 rows: the cap predicate (or a raced workspace
    // delete) blocked it without an SQL error.
    return await classifyCreateFailure(db, actor.workspaceId, name)
  }

  const complete = await db
    .selectFrom('cli_family_authorities')
    .select(({ exists, selectFrom }) => [
      'family_id',
      exists(
        selectFrom('cli_refresh_credentials')
          .select('id')
          .where('id', '=', credentialId)
          .where('revoked_at', 'is', null),
      ).as('credentialPresent'),
      exists(
        selectFrom('project_share_defaults')
          .select('id')
          .where('project_container_id', '=', input.projectId)
          .where(sql<boolean>`lower(email) = ${email.toLowerCase()}`),
      ).as('grantPresent'),
      // Completeness must judge against the CURRENT visibility, not the
      // pre-read: a workspace→private flip during the batch must classify a
      // grant-less bot as incomplete so the stop path reclaims it.
      exists(
        selectFrom('artifact_containers')
          .select('id')
          .where('id', '=', input.projectId)
          .where('base_visibility', '=', 'private'),
      ).as('privateDestinationNow'),
    ])
    .where('family_id', '=', familyId)
    .where('status', '=', 'active')
    .where('project_id', '=', input.projectId)
    .executeTakeFirst()
  const authorityComplete = Boolean(
    complete?.credentialPresent &&
    (!complete.privateDestinationNow || complete.grantPresent),
  )
  if (!authorityComplete) {
    // The race window (e.g. the project was archived between pre-check and
    // batch) produced a token that could never post. Reclaim via the standard
    // stop path — a defined outcome: bot.create and bot.stop both remain, the
    // stopped bot row stays in the bot section, and the name is released.
    await stopWorkspaceBot(db, actor, botUserId)
    return { kind: 'bot-destination-invalid' }
  }

  return { kind: 'ok', botUserId, email, token }
}

async function classifyCreateFailure(
  db: Kysely<DB>,
  workspaceId: string,
  name: string,
): Promise<CreateWorkspaceBotResult> {
  const sameName = await db
    .selectFrom('users')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'bot')
    .where('bot_stopped_at', 'is', null)
    .where('name', '=', name)
    .executeTakeFirst()
  if (sameName) return { kind: 'bot-name-invalid' }
  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  const cap =
    workspace?.plan === 'free' ? FREE_PLAN_ACTIVE_BOT_LIMIT : ACTIVE_BOT_LIMIT
  const activeCount = await activeBotCountQuery(
    db,
    workspaceId,
  ).executeTakeFirst()
  if ((activeCount?.count ?? 0) >= cap) return { kind: 'bot-limit-reached' }
  // Anything else is the (vanishingly rare) generated-email UNIQUE collision;
  // a retry regenerates the address.
  return { kind: 'bot-conflict' }
}

/**
 * Permanently cancel a bot that has never authenticated or authored data.
 * The D1 batch is atomic. If first authentication commits before this batch,
 * the repeated eligibility guards make every delete a no-op; if cancellation
 * commits first, deleting the authority makes authentication fail closed.
 */
export async function cancelWorkspaceBot(
  db: Kysely<DB>,
  actor: Actor,
  botUserId: string,
): Promise<CancelWorkspaceBotResult> {
  const admin = await requireWorkspaceAdmin(db, actor)
  if (admin.kind !== 'ok') return { kind: 'forbidden' }
  const bot = await db
    .selectFrom('users')
    .select(['id', 'email', 'name'])
    .where('id', '=', botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'bot')
    .executeTakeFirst()
  if (!bot) return { kind: 'not-found' }

  const eligible = botCancellationEligible(botUserId)
  const now = nowIso()
  const audit = db
    .insertInto('audit_events')
    .columns([
      'id',
      'workspace_id',
      'actor_user_id',
      'action',
      'subject_type',
      'subject_id',
      'detail',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('id', '=', botUserId)
        .where('workspace_id', '=', actor.workspaceId)
        .where('kind', '=', 'bot')
        .where(eligible)
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('bot.cancel').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(botUserId).as('subject_id'),
          eb.val(JSON.stringify({ name: bot.name })).as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )
  const deleteGrants = db
    .deleteFrom('project_share_defaults')
    .where(sql<boolean>`lower(email) = ${bot.email.toLowerCase()}`)
    .where(eligible)
  const deleteShareableGrants = db
    .deleteFrom('shareable_grants')
    .where(sql<boolean>`lower(granted_email) = ${bot.email.toLowerCase()}`)
    .where(eligible)
  const deleteCredentials = db
    .deleteFrom('cli_refresh_credentials')
    .where('user_id', '=', botUserId)
    .where(eligible)
  const deleteAuthorities = db
    .deleteFrom('cli_family_authorities')
    .where('user_id', '=', botUserId)
    .where(eligible)
  const deleteMemberships = db
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', botUserId)
    .where(eligible)
  const deleteProfile = db
    .deleteFrom('agent_profiles')
    .where('user_id', '=', botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where(eligible)
  const deleteUser = db
    .deleteFrom('users')
    .where('id', '=', botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'bot')
    .where(eligible)

  await runD1Batch(
    audit,
    deleteGrants,
    deleteShareableGrants,
    deleteCredentials,
    deleteAuthorities,
    deleteMemberships,
    deleteProfile,
    deleteUser,
  )
  const remains = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', botUserId)
    .executeTakeFirst()
  return remains ? { kind: 'bot-used' } : { kind: 'ok' }
}

/**
 * Stop a bot (soft, final). The head statement is a CAS on
 * `users.bot_stopped_at` with a request-unique marker; every follow-up
 * statement is conditioned on `bot_stopped_at = marker`, so a request that
 * lost the CAS performs no writes (stop is idempotent, one audit total).
 * Statement order: credential revocation and session deletion before member
 * removal; grant deletion last. Everything is keyed off the bot user id, not
 * off active families, so expired-family debris is cleaned up too.
 */
export async function stopWorkspaceBot(
  db: Kysely<DB>,
  actor: Actor,
  botUserId: string,
): Promise<StopWorkspaceBotResult> {
  const admin = await requireWorkspaceAdmin(db, actor)
  if (admin.kind !== 'ok') return { kind: 'forbidden' }
  const bot = await db
    .selectFrom('users')
    .select(['id', 'email', 'name', 'bot_stopped_at'])
    .where('id', '=', botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'bot')
    .executeTakeFirst()
  if (!bot) return { kind: 'not-found' }

  const marker = uniqueStopMarker()
  const stoppedNow = sql<boolean>`EXISTS (SELECT 1 FROM users WHERE id = ${botUserId} AND bot_stopped_at = ${marker})`

  const cas = db
    .updateTable('users')
    .set({ bot_stopped_at: marker, updated_at: marker })
    .where('id', '=', botUserId)
    .where('kind', '=', 'bot')
    .where('bot_stopped_at', 'is', null)

  // One revoke audit per family that still holds an unrevoked, unexpired
  // credential (matches the user-id-based revocation statement below; a bot
  // whose credentials all expired gets bot.stop only).
  const revokeAudits = db
    .insertInto('audit_events')
    .columns([
      'id',
      'workspace_id',
      'actor_user_id',
      'action',
      'subject_type',
      'subject_id',
      'detail',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_refresh_credentials as credential')
        .where('credential.user_id', '=', botUserId)
        .where('credential.revoked_at', 'is', null)
        .where('credential.expires_at', '>', marker)
        .where('credential.family_id', 'is not', null)
        .where(stoppedNow)
        .groupBy('credential.family_id')
        .select([
          sql<string>`lower(hex(randomblob(16)))`.as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('cli.refresh_credential.revoke').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(botUserId).as('subject_id'),
          sql<string>`json_object(
            'credential_kind', 'cli_refresh',
            'family_id', credential.family_id,
            'target_user_id', ${botUserId},
            'reason', 'admin'
          )`.as('detail'),
          eb.val(marker).as('created_at'),
        ]),
    )

  const revokeCredentials = db
    .updateTable('cli_refresh_credentials')
    .set({ revoked_at: marker })
    .where('user_id', '=', botUserId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', marker)
    .where(stoppedNow)

  // Bots hold only bearer CLI sessions; deleting them all also cascades the
  // cli_session_authorities and cli_refresh_sessions rows.
  const deleteSessions = db
    .deleteFrom('sessions')
    .where('user_id', '=', botUserId)
    .where(stoppedNow)

  const revokeAuthorities = db
    .updateTable('cli_family_authorities')
    .set({ status: 'revoked', updated_at: marker })
    .where('user_id', '=', botUserId)
    .where('status', '=', 'active')
    .where(stoppedNow)

  const removeMember = db
    .updateTable('workspace_members')
    .set({
      status: 'removed',
      removed_at: marker,
      removed_by: actor.id,
      updated_at: marker,
    })
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', botUserId)
    .where('status', '=', 'active')
    .where(stoppedNow)

  const deleteGrants = db
    .deleteFrom('project_share_defaults')
    .where(sql<boolean>`lower(email) = ${bot.email.toLowerCase()}`)
    .where(stoppedNow)

  const stopAudit = db
    .insertInto('audit_events')
    .columns([
      'id',
      'workspace_id',
      'actor_user_id',
      'action',
      'subject_type',
      'subject_id',
      'detail',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('users.id', '=', botUserId)
        .where('users.bot_stopped_at', '=', marker)
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('bot.stop').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(botUserId).as('subject_id'),
          eb.val(JSON.stringify({ name: bot.name })).as('detail'),
          eb.val(marker).as('created_at'),
        ]),
    )

  await runD1Batch(
    cas,
    revokeAudits,
    revokeCredentials,
    deleteSessions,
    revokeAuthorities,
    removeMember,
    deleteGrants,
    stopAudit,
  )
  const remains = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', botUserId)
    .executeTakeFirst()
  return remains ? { kind: 'ok' } : { kind: 'not-found' }
}

/**
 * Reissue the bot's credential: supersede ALL active families (set-based),
 * revoke their credentials and delete their sessions, then insert one new
 * active family guarded by NOT EXISTS(active family). Every statement carries
 * `bot_stopped_at IS NULL`, so a concurrent stop wins and the reissue reports
 * bot-stopped after re-reading.
 */
export async function reissueWorkspaceBotCredential(
  db: Kysely<DB>,
  actor: Actor,
  botUserId: string,
): Promise<ReissueWorkspaceBotResult> {
  const admin = await requireWorkspaceAdmin(db, actor)
  if (admin.kind !== 'ok') return { kind: 'forbidden' }
  const bot = await db
    .selectFrom('users')
    .select(['id', 'name', 'bot_stopped_at'])
    .where('id', '=', botUserId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'bot')
    .executeTakeFirst()
  if (!bot) return { kind: 'not-found' }
  if (bot.bot_stopped_at !== null) return { kind: 'bot-stopped' }

  // The destination is not revalidated (archived is fine), with one
  // exception: a deleted destination project (project_id NULL or the row
  // gone) would mint a family whose every request 401s — a silently dead
  // bot. The fix for a deleted destination is a new bot.
  const source = await db
    .selectFrom('cli_family_authorities as authority')
    .leftJoin(
      'artifact_containers as project',
      'project.id',
      'authority.project_id',
    )
    .select([
      'authority.project_id',
      'authority.agent_profile_id',
      'project.name as project_name',
    ])
    .where('authority.user_id', '=', botUserId)
    .where('authority.status', '=', 'active')
    .orderBy('authority.created_at', 'desc')
    .executeTakeFirst()
  if (
    !source ||
    !source.project_id ||
    !source.project_name ||
    !source.agent_profile_id
  ) {
    return { kind: 'bot-destination-invalid' }
  }

  const familyId = nanoid()
  const credentialId = familyId
  const token = generateBotToken()
  const tokenHash = await computeTextSha256Hex(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString()
  const botActive = sql<boolean>`EXISTS (SELECT 1 FROM users WHERE id = ${botUserId} AND kind = 'bot' AND bot_stopped_at IS NULL)`

  const supersede = db
    .updateTable('cli_family_authorities')
    .set({ status: 'superseded', updated_at: now })
    .where('user_id', '=', botUserId)
    .where('status', '=', 'active')
    .where(botActive)

  // Immediate invalidation of the old token even when unused: without the
  // revocation an unrotated old credential would stay family-live for up to
  // 180 days.
  const revokeOldCredentials = db
    .updateTable('cli_refresh_credentials')
    .set({ revoked_at: now })
    .where('user_id', '=', botUserId)
    .where('revoked_at', 'is', null)
    .where('id', '!=', credentialId)
    .where(botActive)

  const deleteOldSessions = db
    .deleteFrom('sessions')
    .where('user_id', '=', botUserId)
    .where(botActive)

  const familyInsert = db
    .insertInto('cli_family_authorities')
    .columns([
      'family_id',
      'user_id',
      'preset',
      'workspace_id',
      'project_id',
      'project_name_snapshot',
      'agent_profile_id',
      'approved_at',
      'device_name',
      'status',
      'created_at',
      'updated_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('users')
        .where('users.id', '=', botUserId)
        .where('users.bot_stopped_at', 'is', null)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('cli_family_authorities')
                .select('family_id')
                .where('user_id', '=', botUserId)
                .where('status', '=', 'active'),
            ),
          ),
        )
        .select([
          eb.val(familyId).as('family_id'),
          eb.val(botUserId).as('user_id'),
          eb.val('agent' as const).as('preset'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(source.project_id).as('project_id'),
          eb.val(source.project_name).as('project_name_snapshot'),
          eb.val(source.agent_profile_id).as('agent_profile_id'),
          eb.val(now).as('approved_at'),
          eb.val(null).as('device_name'),
          eb.val('active' as const).as('status'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ]),
    )

  const credentialInsert = db
    .insertInto('cli_refresh_credentials')
    .columns([
      'id',
      'user_id',
      'token_hash',
      'expires_at',
      'revoked_at',
      'created_at',
      'last_used_at',
      'family_id',
      'replaced_by_id',
      'rotation_request_hash',
      'rotation_retry_until',
      'rotation_session_id',
      'device_name',
      'device_id',
      'revocation_batch_id',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_family_authorities')
        .where('family_id', '=', familyId)
        .where('status', '=', 'active')
        .select([
          eb.val(credentialId).as('id'),
          eb.val(botUserId).as('user_id'),
          eb.val(tokenHash).as('token_hash'),
          eb.val(expiresAt).as('expires_at'),
          eb.val(null).as('revoked_at'),
          eb.val(now).as('created_at'),
          eb.val(null).as('last_used_at'),
          eb.val(familyId).as('family_id'),
          eb.val(null).as('replaced_by_id'),
          eb.val(null).as('rotation_request_hash'),
          eb.val(null).as('rotation_retry_until'),
          eb.val(null).as('rotation_session_id'),
          eb.val(null).as('device_name'),
          eb.val(null).as('device_id'),
          eb.val(null).as('revocation_batch_id'),
        ]),
    )

  const reissueAudit = db
    .insertInto('audit_events')
    .columns([
      'id',
      'workspace_id',
      'actor_user_id',
      'action',
      'subject_type',
      'subject_id',
      'detail',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('cli_family_authorities')
        .where('family_id', '=', familyId)
        .where('status', '=', 'active')
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('bot.credential.reissue').as('action'),
          eb.val('user').as('subject_type'),
          eb.val(botUserId).as('subject_id'),
          eb.val(JSON.stringify({ name: bot.name })).as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )

  try {
    await runD1Batch(
      supersede,
      revokeOldCredentials,
      deleteOldSessions,
      familyInsert,
      credentialInsert,
      reissueAudit,
    )
  } catch {
    // The batch rolled back. Re-read state to classify instead of guessing:
    // only a genuinely missing/deleted destination is "create a new bot" —
    // a transient D1 error must surface as retryable.
    const destination = await db
      .selectFrom('artifact_containers')
      .select('id')
      .where('id', '=', source.project_id ?? '')
      .executeTakeFirst()
    if (!destination) return { kind: 'bot-destination-invalid' }
    return { kind: 'bot-conflict' }
  }

  const committed = await db
    .selectFrom('cli_refresh_credentials')
    .select('id')
    .where('id', '=', credentialId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (!committed) {
    const after = await db
      .selectFrom('users')
      .select('bot_stopped_at')
      .where('id', '=', botUserId)
      .executeTakeFirst()
    if (!after) return { kind: 'not-found' }
    if (after.bot_stopped_at) return { kind: 'bot-stopped' }
    return { kind: 'bot-destination-invalid' }
  }
  return { kind: 'ok', token }
}

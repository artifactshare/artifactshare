import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { projectLimitForPlan } from '~/lib/billing-plan.server'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import type { DB } from '~/types/db'
import type { CliAuthority } from './cli-authority.server'
import {
  readLiveBridgeAuthority,
  type BridgeAuthorityBinding,
} from './bridge-authorities.server'
import type { TrustedBridgeContext } from './bridge-request-validation.server'

const PROJECT_NAME_ATTEMPTS = 3

type BridgeAuthority = Extract<CliAuthority, { kind: 'bridge' }>
type LiveAuthority = BridgeAuthorityBinding & {
  fallbackName: string
  fallbackVisibility: 'workspace' | 'private'
}

export interface BridgeConversationBinding {
  id: string
  projectId: string
  projectName: string
  privacyCeiling: 'workspace' | 'private'
  archived: boolean
}

export type BoundBridgeRequest = {
  authority: LiveAuthority
  routingClass: 'channel' | 'dm'
  mapping: BridgeConversationBinding | null
  mappingCreated: boolean
  projectCreated: boolean
}

export type BindBridgeRequestResult =
  | { kind: 'ok'; binding: BoundBridgeRequest }
  | {
      kind:
        | 'unsupported-authority'
        | 'fallback-invalid'
        | 'requester-mismatch'
        | 'mapping-archived'
        | 'conversation-identity-conflict'
        | 'project-limit-reached'
        | 'project-name-conflict'
        | 'internal-error'
    }

/**
 * Establishes only host-owned routing state. This intentionally runs before
 * model-owned intent validation, digest calculation, replay, or upload staging.
 */
export async function bindTrustedBridgeRequest(
  db: Kysely<DB>,
  authority: BridgeAuthority,
  context: TrustedBridgeContext,
): Promise<BindBridgeRequestResult> {
  const live = await readLiveBridgeAuthority(db, authority.bridgeAuthorityId)
  if (live.kind !== 'ok') return { kind: live.kind }

  const routingClass =
    context.conversation.kind === 'dm' ? ('dm' as const) : ('channel' as const)
  let mapping: BridgeConversationBinding | null = null
  if (routingClass === 'channel') {
    const resolved = await resolveConversation(
      db,
      live.id,
      context.conversation.ids,
    )
    if (resolved.kind !== 'ok') return resolved
    mapping = resolved.mapping
  }

  const privateChannel = context.conversation.kind === 'private_channel'
  let mappingCreated = false
  let projectCreated = false
  if (privateChannel && mapping === null) {
    const created = await createPrivateConversationBarrier(db, live, context)
    if (created.kind === 'project-limit-reached') return created
    if (created.kind === 'project-name-conflict') return created
    if (created.kind === 'internal-error') return created
    if (created.kind === 'concurrent') {
      const resolved = await resolveConversation(
        db,
        live.id,
        context.conversation.ids,
      )
      if (resolved.kind !== 'ok') return resolved
      if (resolved.mapping === null) return { kind: 'internal-error' }
      mapping = resolved.mapping
    } else {
      mapping = created.mapping
      mappingCreated = true
      projectCreated = true
    }
  }

  if (privateChannel && mapping !== null) {
    const narrowed = await narrowConversationBarrier(db, live, mapping)
    if (narrowed.kind !== 'ok') return narrowed
    mapping = narrowed.mapping
  }

  if (mapping?.archived) return { kind: 'mapping-archived' }
  if (mapping !== null) {
    const aliases = await attachConversationAliases(
      db,
      live.id,
      mapping.id,
      context.conversation.ids,
    )
    if (!aliases) return { kind: 'conversation-identity-conflict' }
  }

  const request = await insertOrVerifyRequestBinding(db, {
    authorityId: live.id,
    requestId: context.requestId,
    routingClass,
    conversationIds: context.conversation.ids,
    mappingId: mapping?.id ?? null,
    requesterStableId: context.requester.stableId,
    requesterVerifiedEmail: context.requester.verifiedEmail,
  })
  if (request !== 'ok') return { kind: request }

  return {
    kind: 'ok',
    binding: {
      authority: live,
      routingClass,
      mapping,
      mappingCreated,
      projectCreated,
    },
  }
}

export async function resolveConversation(
  db: Kysely<DB>,
  authorityId: string,
  ids: readonly string[],
): Promise<
  | { kind: 'ok'; mapping: BridgeConversationBinding | null }
  | { kind: 'conversation-identity-conflict' }
> {
  const rows = await db
    .selectFrom('bridge_conversation_ids as identity')
    .innerJoin(
      'bridge_conversations as mapping',
      'mapping.id',
      'identity.mapping_id',
    )
    .innerJoin(
      'artifact_containers as project',
      'project.id',
      'mapping.project_id',
    )
    .select([
      'mapping.id',
      'mapping.project_id',
      'mapping.privacy_ceiling',
      'project.name',
      'project.archived_at',
    ])
    .where('identity.bridge_authority_id', '=', authorityId)
    .where('identity.external_conversation_id', 'in', [...ids])
    .execute()
  const distinct = new Map(rows.map((row) => [row.id, row]))
  if (distinct.size > 1) return { kind: 'conversation-identity-conflict' }
  const row = distinct.values().next().value
  return {
    kind: 'ok',
    mapping: row
      ? {
          id: row.id,
          projectId: row.project_id,
          projectName: row.name,
          privacyCeiling: row.privacy_ceiling,
          archived: row.archived_at !== null,
        }
      : null,
  }
}

async function createPrivateConversationBarrier(
  db: Kysely<DB>,
  authority: LiveAuthority,
  context: TrustedBridgeContext,
): Promise<
  | { kind: 'ok'; mapping: BridgeConversationBinding }
  | { kind: 'concurrent' }
  | { kind: 'project-limit-reached' }
  | { kind: 'project-name-conflict' }
  | { kind: 'internal-error' }
> {
  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', authority.workspaceId)
    .executeTakeFirst()
  if (!workspace) return { kind: 'internal-error' }
  const projectLimit = projectLimitForPlan(workspace.plan)

  for (let attempt = 0; attempt < PROJECT_NAME_ATTEMPTS; attempt += 1) {
    const mappingId = nanoid()
    const projectId = nanoid()
    const projectName = conversationProjectName(
      context.conversation.name,
      projectId,
    )
    const now = nowIso()
    const projectInsert = db
      .insertInto('artifact_containers')
      .columns([
        'id',
        'workspace_id',
        'kind',
        'owner_user_id',
        'created_by_id',
        'name',
        'description',
        'archived_at',
        'created_at',
        'updated_at',
        'base_visibility',
      ])
      .expression((eb) => {
        let query = eb
          .selectFrom('workspaces')
          .select([
            eb.val(projectId).as('id'),
            eb.val(authority.workspaceId).as('workspace_id'),
            eb.val('project' as const).as('kind'),
            eb.val(null).as('owner_user_id'),
            eb.val(authority.botUserId).as('created_by_id'),
            eb.val(projectName).as('name'),
            eb.val(null).as('description'),
            eb.val(null).as('archived_at'),
            eb.val(now).as('created_at'),
            eb.val(now).as('updated_at'),
            eb.val('private' as const).as('base_visibility'),
          ])
          .where('workspaces.id', '=', authority.workspaceId)
          .where(
            sql<boolean>`EXISTS (
              SELECT 1
              FROM bridge_authorities AS live_authority
              INNER JOIN users AS live_bot
                ON live_bot.id = live_authority.bot_user_id
              INNER JOIN artifact_containers AS live_fallback
                ON live_fallback.id = live_authority.fallback_project_id
              WHERE live_authority.id = ${authority.id}
                AND live_authority.workspace_id = ${authority.workspaceId}
                AND live_authority.bot_user_id = ${authority.botUserId}
                AND live_bot.workspace_id = live_authority.workspace_id
                AND live_bot.kind = 'bot'
                AND live_bot.bot_stopped_at IS NULL
                AND live_fallback.workspace_id = live_authority.workspace_id
                AND live_fallback.kind = 'project'
                AND live_fallback.archived_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM bridge_conversations
                  WHERE project_id = live_fallback.id
                )
            )`,
          )
        if (projectLimit !== null) {
          query = query.where(
            sql<boolean>`(
              SELECT COUNT(*) FROM artifact_containers
              WHERE workspace_id = ${authority.workspaceId}
                AND kind = 'project'
                AND archived_at IS NULL
            ) < ${projectLimit}`,
          )
        }
        return query
      })
    const mappingInsert = db.insertInto('bridge_conversations').values({
      id: mappingId,
      bridge_authority_id: authority.id,
      project_id: projectId,
      conversation_kind: 'private_channel',
      conversation_name: context.conversation.name,
      privacy_ceiling: 'private',
      privacy_epoch: 1,
      created_at: now,
      updated_at: now,
    })
    const identityInsert = db.insertInto('bridge_conversation_ids').values(
      context.conversation.ids.map((id) => ({
        mapping_id: mappingId,
        bridge_authority_id: authority.id,
        external_conversation_id: id,
        created_at: now,
      })),
    )
    try {
      await runD1Batch(db, projectInsert, mappingInsert, identityInsert)
      return {
        kind: 'ok',
        mapping: {
          id: mappingId,
          projectId,
          projectName,
          privacyCeiling: 'private',
          archived: false,
        },
      }
    } catch {
      await deleteEmptyProject(db, projectId)
      const concurrent = await resolveConversation(
        db,
        authority.id,
        context.conversation.ids,
      )
      if (concurrent.kind === 'ok' && concurrent.mapping !== null) {
        return { kind: 'concurrent' }
      }
      const atLimit = await activeProjectCountAtLimit(
        db,
        authority.workspaceId,
        projectLimit,
      )
      if (atLimit) return { kind: 'project-limit-reached' }
      const nameTaken = await db
        .selectFrom('artifact_containers')
        .select('id')
        .where('workspace_id', '=', authority.workspaceId)
        .where('kind', '=', 'project')
        .where('archived_at', 'is', null)
        .where(sql<boolean>`name = ${projectName} COLLATE NOCASE`)
        .executeTakeFirst()
      if (!nameTaken) return { kind: 'internal-error' }
    }
  }
  return { kind: 'project-name-conflict' }
}

async function narrowConversationBarrier(
  db: Kysely<DB>,
  authority: LiveAuthority,
  mapping: BridgeConversationBinding,
): Promise<
  | { kind: 'ok'; mapping: BridgeConversationBinding }
  | { kind: 'mapping-archived' | 'internal-error' }
> {
  if (mapping.archived) return { kind: 'mapping-archived' }
  const now = nowIso()
  try {
    await runD1Batch(
      db,
      db
        .updateTable('bridge_conversations')
        .set({
          conversation_kind: 'private_channel',
          privacy_ceiling: 'private',
          privacy_epoch: 1,
          updated_at: now,
        })
        .where('id', '=', mapping.id)
        .where('bridge_authority_id', '=', authority.id),
      db
        .updateTable('artifact_containers')
        .set({ base_visibility: 'private', updated_at: now })
        .where('id', '=', mapping.projectId)
        .where('workspace_id', '=', authority.workspaceId)
        .where('kind', '=', 'project')
        .where('archived_at', 'is', null),
      db
        .updateTable('shareables')
        .set({ visibility: 'private', link_expires_at: null, updated_at: now })
        .where('container_id', '=', mapping.projectId)
        .where('workspace_id', '=', authority.workspaceId)
        .where('visibility', '!=', 'private'),
    )
  } catch {
    return { kind: 'internal-error' }
  }
  const resolved = await resolveConversation(db, authority.id, [
    ...(await mappedConversationIds(db, authority.id, mapping.id)),
  ])
  if (resolved.kind !== 'ok' || resolved.mapping === null) {
    return { kind: 'internal-error' }
  }
  if (resolved.mapping.archived) return { kind: 'mapping-archived' }
  if (resolved.mapping.privacyCeiling !== 'private') {
    return { kind: 'internal-error' }
  }
  return { kind: 'ok', mapping: resolved.mapping }
}

async function mappedConversationIds(
  db: Kysely<DB>,
  authorityId: string,
  mappingId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('bridge_conversation_ids')
    .select('external_conversation_id')
    .where('bridge_authority_id', '=', authorityId)
    .where('mapping_id', '=', mappingId)
    .execute()
  return rows.map((row) => row.external_conversation_id)
}

async function attachConversationAliases(
  db: Kysely<DB>,
  authorityId: string,
  mappingId: string,
  ids: readonly string[],
): Promise<boolean> {
  const now = nowIso()
  try {
    await db
      .insertInto('bridge_conversation_ids')
      .values(
        ids.map((id) => ({
          mapping_id: mappingId,
          bridge_authority_id: authorityId,
          external_conversation_id: id,
          created_at: now,
        })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute()
  } catch {
    return false
  }
  const rows = await db
    .selectFrom('bridge_conversation_ids')
    .select(['external_conversation_id', 'mapping_id'])
    .where('bridge_authority_id', '=', authorityId)
    .where('external_conversation_id', 'in', [...ids])
    .execute()
  return (
    rows.length === ids.length &&
    rows.every((row) => row.mapping_id === mappingId)
  )
}

async function insertOrVerifyRequestBinding(
  db: Kysely<DB>,
  input: {
    authorityId: string
    requestId: string
    routingClass: 'channel' | 'dm'
    conversationIds: readonly string[]
    mappingId: string | null
    requesterStableId: string
    requesterVerifiedEmail: string
  },
): Promise<'ok' | 'requester-mismatch' | 'conversation-identity-conflict'> {
  const idsJson = JSON.stringify([...input.conversationIds].sort())
  const now = nowIso()
  await db
    .insertInto('bridge_requests')
    .values({
      bridge_authority_id: input.authorityId,
      request_id: input.requestId,
      routing_class: input.routingClass,
      conversation_ids_json: idsJson,
      mapping_id: input.mappingId,
      requester_stable_id: input.requesterStableId,
      requester_verified_email: input.requesterVerifiedEmail,
      stable_digest: null,
      status: 'binding',
      lease_generation: null,
      lease_expires_at: null,
      result_artifact_id: null,
      result_version_id: null,
      mapping_created: 0,
      project_created: 0,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute()
  if (input.mappingId !== null) {
    await db
      .updateTable('bridge_requests')
      .set({ mapping_id: input.mappingId, updated_at: now })
      .where('bridge_authority_id', '=', input.authorityId)
      .where('request_id', '=', input.requestId)
      .where('routing_class', '=', input.routingClass)
      .where('conversation_ids_json', '=', idsJson)
      .where('requester_stable_id', '=', input.requesterStableId)
      .where('requester_verified_email', '=', input.requesterVerifiedEmail)
      .where('mapping_id', 'is', null)
      .where('status', '!=', 'completed')
      .execute()
  }
  const row = await db
    .selectFrom('bridge_requests')
    .select([
      'routing_class',
      'conversation_ids_json',
      'mapping_id',
      'requester_stable_id',
      'requester_verified_email',
    ])
    .where('bridge_authority_id', '=', input.authorityId)
    .where('request_id', '=', input.requestId)
    .executeTakeFirst()
  if (
    !row ||
    row.routing_class !== input.routingClass ||
    row.conversation_ids_json !== idsJson ||
    row.mapping_id !== input.mappingId
  ) {
    return 'conversation-identity-conflict'
  }
  if (
    row.requester_stable_id !== input.requesterStableId ||
    row.requester_verified_email !== input.requesterVerifiedEmail
  ) {
    return 'requester-mismatch'
  }
  return 'ok'
}

export function conversationProjectName(
  name: string | null,
  projectId: string,
) {
  const label = name ?? 'Shared conversation'
  const suffix = projectId.slice(-6)
  const maxLabelLength = Math.max(1, 117 - suffix.length)
  const boundaryCodeUnit = label.charCodeAt(maxLabelLength - 1)
  const safeLabelLength =
    boundaryCodeUnit >= 0xd800 && boundaryCodeUnit <= 0xdbff
      ? maxLabelLength - 1
      : maxLabelLength
  return `${label.slice(0, safeLabelLength)} · ${suffix}`
}

export async function activeProjectCountAtLimit(
  db: Kysely<DB>,
  workspaceId: string,
  limit: number | null,
) {
  if (limit === null) return false
  const row = await db
    .selectFrom('artifact_containers')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirstOrThrow()
  return Number(row.count) >= limit
}

export async function deleteEmptyProject(db: Kysely<DB>, projectId: string) {
  try {
    await db
      .deleteFrom('artifact_containers')
      .where('id', '=', projectId)
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM bridge_conversations WHERE project_id = ${projectId}
        )`,
      )
      .where(
        sql<boolean>`NOT EXISTS (
          SELECT 1 FROM shareables WHERE container_id = ${projectId}
        )`,
      )
      .execute()
  } catch {
    // A surviving reference means the failed path converged elsewhere.
  }
}

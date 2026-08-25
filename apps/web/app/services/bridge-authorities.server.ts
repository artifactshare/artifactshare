import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { runD1Batch } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { requireWorkspaceAdmin } from '~/services/team-management.server'
import type { DB } from '~/types/db'

const SOURCE_KIND_MAX = 80
const SOURCE_ID_MAX = 200

export interface BridgeAuthorityBinding {
  id: string
  workspaceId: string
  botUserId: string
  agentProfileId: string
  sourceKind: string
  sourceInstallationId: string
  externalWorkspaceId: string
  fallbackProjectId: string
}

export type CreateBridgeAuthorityResult =
  | { kind: 'ok'; authority: BridgeAuthorityBinding }
  | { kind: 'forbidden' }
  | { kind: 'invalid-input' }
  | { kind: 'bot-invalid' }
  | { kind: 'fallback-invalid' }
  | { kind: 'namespace-conflict' }
  | { kind: 'conflict' }

type Actor = { id: string; workspaceId: string }

export async function createBridgeAuthorityForBot(
  db: Kysely<DB>,
  actor: Actor,
  input: {
    botUserId: string
    fallbackProjectId: string
    sourceKind: string
    sourceInstallationId: string
    externalWorkspaceId: string
  },
): Promise<CreateBridgeAuthorityResult> {
  const admin = await requireWorkspaceAdmin(db, actor)
  if (admin.kind !== 'ok') return { kind: 'forbidden' }
  const sourceKind = normalized(input.sourceKind, SOURCE_KIND_MAX)
  const sourceInstallationId = normalized(
    input.sourceInstallationId,
    SOURCE_ID_MAX,
  )
  const externalWorkspaceId = normalized(
    input.externalWorkspaceId,
    SOURCE_ID_MAX,
  )
  if (!sourceKind || !sourceInstallationId || !externalWorkspaceId) {
    return { kind: 'invalid-input' }
  }

  const family = await db
    .selectFrom('users as bot')
    .innerJoin('agent_profiles as profile', (join) =>
      join
        .onRef('profile.user_id', '=', 'bot.id')
        .onRef('profile.workspace_id', '=', 'bot.workspace_id'),
    )
    .innerJoin('cli_family_authorities as family', (join) =>
      join
        .onRef('family.user_id', '=', 'bot.id')
        .onRef('family.agent_profile_id', '=', 'profile.id'),
    )
    .select([
      'profile.id as agentProfileId',
      'family.family_id as familyId',
      'family.project_id as projectId',
      'family.bridge_authority_id as bridgeAuthorityId',
    ])
    .where('bot.id', '=', input.botUserId)
    .where('bot.workspace_id', '=', actor.workspaceId)
    .where('bot.kind', '=', 'bot')
    .where('bot.bot_stopped_at', 'is', null)
    .where('family.status', '=', 'active')
    .where('family.preset', '=', 'agent')
    .executeTakeFirst()
  if (!family || family.bridgeAuthorityId !== null) {
    return { kind: 'bot-invalid' }
  }
  if (family.projectId !== input.fallbackProjectId) {
    return { kind: 'fallback-invalid' }
  }

  const fallback = await db
    .selectFrom('artifact_containers')
    .select(['id', 'name'])
    .where('id', '=', input.fallbackProjectId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('kind', '=', 'project')
    .where('archived_at', 'is', null)
    .executeTakeFirst()
  if (!fallback) return { kind: 'fallback-invalid' }

  const authorityId = nanoid()
  const now = nowIso()
  const insertAuthority = db.insertInto('bridge_authorities').values({
    id: authorityId,
    workspace_id: actor.workspaceId,
    bot_user_id: input.botUserId,
    agent_profile_id: family.agentProfileId,
    source_kind: sourceKind,
    source_installation_id: sourceInstallationId,
    external_workspace_id: externalWorkspaceId,
    fallback_project_id: fallback.id,
    created_at: now,
    updated_at: now,
  })
  const attachFamily = db
    .updateTable('cli_family_authorities')
    .set({ bridge_authority_id: authorityId, updated_at: now })
    .where('family_id', '=', family.familyId)
    .where('status', '=', 'active')
    .where('bridge_authority_id', 'is', null)
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
        .selectFrom('bridge_authorities')
        .where('id', '=', authorityId)
        .where(
          sql<boolean>`EXISTS (
            SELECT 1 FROM cli_family_authorities
            WHERE family_id = ${family.familyId}
              AND bridge_authority_id = ${authorityId}
          )`,
        )
        .select([
          eb.val(nanoid()).as('id'),
          eb.val(actor.workspaceId).as('workspace_id'),
          eb.val(actor.id).as('actor_user_id'),
          eb.val('bridge.authority.create').as('action'),
          eb.val('bridge_authority').as('subject_type'),
          eb.val(authorityId).as('subject_id'),
          eb
            .val(
              JSON.stringify({
                bot_user_id: input.botUserId,
                fallback_project_id: fallback.id,
                fallback_project_name: fallback.name,
                source_kind: sourceKind,
              }),
            )
            .as('detail'),
          eb.val(now).as('created_at'),
        ]),
    )

  try {
    await runD1Batch(db, insertAuthority, attachFamily, audit)
  } catch {
    const duplicate = await db
      .selectFrom('bridge_authorities')
      .select('id')
      .where('workspace_id', '=', actor.workspaceId)
      .where('source_kind', '=', sourceKind)
      .where('source_installation_id', '=', sourceInstallationId)
      .where('external_workspace_id', '=', externalWorkspaceId)
      .executeTakeFirst()
    return duplicate ? { kind: 'namespace-conflict' } : { kind: 'conflict' }
  }

  const attached = await db
    .selectFrom('bridge_authorities')
    .innerJoin(
      'cli_family_authorities',
      'cli_family_authorities.bridge_authority_id',
      'bridge_authorities.id',
    )
    .select('bridge_authorities.id')
    .where('bridge_authorities.id', '=', authorityId)
    .where('cli_family_authorities.family_id', '=', family.familyId)
    .executeTakeFirst()
  if (!attached) return { kind: 'conflict' }
  return {
    kind: 'ok',
    authority: {
      id: authorityId,
      workspaceId: actor.workspaceId,
      botUserId: input.botUserId,
      agentProfileId: family.agentProfileId,
      sourceKind,
      sourceInstallationId,
      externalWorkspaceId,
      fallbackProjectId: fallback.id,
    },
  }
}

export async function readLiveBridgeAuthority(
  db: Kysely<DB>,
  authorityId: string,
): Promise<
  | ({ kind: 'ok' } & BridgeAuthorityBinding & {
        fallbackName: string
        fallbackVisibility: 'workspace' | 'private'
      })
  | { kind: 'unsupported-authority' }
  | { kind: 'fallback-invalid' }
> {
  const row = await db
    .selectFrom('bridge_authorities as authority')
    .innerJoin('users as bot', 'bot.id', 'authority.bot_user_id')
    .leftJoin(
      'artifact_containers as fallback',
      'fallback.id',
      'authority.fallback_project_id',
    )
    .select(({ exists, selectFrom }) => [
      'authority.id',
      'authority.workspace_id',
      'authority.bot_user_id',
      'authority.agent_profile_id',
      'authority.source_kind',
      'authority.source_installation_id',
      'authority.external_workspace_id',
      'authority.fallback_project_id',
      'fallback.name as fallback_name',
      'fallback.base_visibility as fallback_visibility',
      'fallback.kind as fallback_kind',
      'fallback.workspace_id as fallback_workspace_id',
      'fallback.archived_at as fallback_archived_at',
      'bot.bot_stopped_at',
      exists(
        selectFrom('bridge_conversations')
          .select('id')
          .whereRef(
            'bridge_conversations.project_id',
            '=',
            'authority.fallback_project_id',
          ),
      ).as('fallback_mapped'),
    ])
    .where('authority.id', '=', authorityId)
    .executeTakeFirst()
  if (!row || row.bot_stopped_at !== null) {
    return { kind: 'unsupported-authority' }
  }
  if (
    !row.fallback_name ||
    row.fallback_kind !== 'project' ||
    (row.fallback_visibility !== 'workspace' &&
      row.fallback_visibility !== 'private') ||
    row.fallback_workspace_id !== row.workspace_id ||
    row.fallback_archived_at !== null ||
    row.fallback_mapped
  ) {
    return { kind: 'fallback-invalid' }
  }
  return {
    kind: 'ok',
    id: row.id,
    workspaceId: row.workspace_id,
    botUserId: row.bot_user_id,
    agentProfileId: row.agent_profile_id,
    sourceKind: row.source_kind,
    sourceInstallationId: row.source_installation_id,
    externalWorkspaceId: row.external_workspace_id,
    fallbackProjectId: row.fallback_project_id,
    fallbackName: row.fallback_name,
    fallbackVisibility: row.fallback_visibility,
  }
}

function normalized(value: string, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > max ||
    trimmed !== value ||
    Array.from(trimmed).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    return null
  }
  return trimmed
}

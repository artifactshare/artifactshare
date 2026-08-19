import type { Compilable, Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { normalizePlan } from '~/lib/billing-plan.server'
import {
  canUseLinkSharing,
  isValidUtcIso,
  normalizeWorkspaceLinkPolicy,
  resolveLinkExpiry,
  validateLinkExpiryPolicy,
  type WorkspaceLinkPolicy,
} from '~/lib/link-sharing-policy'
import { nowIso } from '~/lib/datetime'
import type { Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'

export { canUseLinkSharing } from '~/lib/link-sharing-policy'

export type LinkSharingWriteFailure =
  | { kind: 'link-sharing-plan-required' }
  | { kind: 'link-sharing-disabled' }
  | { kind: 'link-expiry-invalid' }

export type LinkSharingWriteResult =
  | { kind: 'ok'; linkExpiresAt: string | null }
  | LinkSharingWriteFailure

export async function resolveLinkSharingWrite(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    currentVisibility: Visibility | null
    currentLinkExpiresAt: string | null
    nextVisibility: Visibility
    requestedLinkExpiresAt?: string | null
    now?: string
  },
): Promise<LinkSharingWriteResult> {
  if (args.nextVisibility !== 'link') {
    return args.requestedLinkExpiresAt === undefined
      ? { kind: 'ok', linkExpiresAt: null }
      : { kind: 'link-expiry-invalid' }
  }

  const policy = await loadWorkspaceLinkPolicy(db, args.workspaceId)
  if (!policy || policy.plan === 'free') {
    return { kind: 'link-sharing-plan-required' }
  }
  if (!canUseLinkSharing(policy)) {
    return { kind: 'link-sharing-disabled' }
  }

  if (
    args.currentVisibility === 'link' &&
    args.requestedLinkExpiresAt === undefined
  ) {
    return { kind: 'ok', linkExpiresAt: args.currentLinkExpiresAt }
  }

  const resolved = resolveLinkExpiry(
    policy,
    args.requestedLinkExpiresAt,
    args.now ?? nowIso(),
  )
  return resolved.kind === 'ok' ? resolved : { kind: 'link-expiry-invalid' }
}

export type LinkAccessResult =
  | {
      kind: 'allowed'
      policy: WorkspaceLinkPolicy
      linkExpiresAt: string | null
    }
  | { kind: 'not-found' }
  | { kind: 'plan-required' }
  | { kind: 'disabled' }
  | { kind: 'expired' }

export async function loadWorkspaceLinkPolicy(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<WorkspaceLinkPolicy | null> {
  const row = await db
    .selectFrom('workspaces')
    .select([
      'id',
      'plan',
      'link_sharing_enabled',
      'external_posting_enabled',
      'link_expiry_default_days',
      'link_expiry_max_days',
    ])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return row ? normalizeWorkspaceLinkPolicy(row) : null
}

export async function checkAnonymousLinkAccess(
  db: Kysely<DB>,
  shareableId: string,
  now: string = nowIso(),
): Promise<LinkAccessResult> {
  const row = await db
    .selectFrom('shareables')
    .innerJoin('workspaces', 'workspaces.id', 'shareables.workspace_id')
    .select([
      'shareables.visibility',
      'shareables.link_expires_at',
      'workspaces.id',
      'workspaces.plan',
      'workspaces.link_sharing_enabled',
      'workspaces.external_posting_enabled',
      'workspaces.link_expiry_default_days',
      'workspaces.link_expiry_max_days',
    ])
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
  if (!row) return { kind: 'not-found' }

  const policy = normalizeWorkspaceLinkPolicy(row)
  if (row.visibility !== 'link') return { kind: 'disabled' }
  if (!canUseLinkSharing(policy)) {
    return policy.plan === 'free'
      ? { kind: 'plan-required' }
      : { kind: 'disabled' }
  }
  const linkExpiresAt = row.link_expires_at ?? null
  if (
    linkExpiresAt !== null &&
    (!isValidUtcIso(linkExpiresAt) ||
      !isValidUtcIso(now) ||
      Date.parse(linkExpiresAt) <= Date.parse(now))
  ) {
    return { kind: 'expired' }
  }
  return { kind: 'allowed', policy, linkExpiresAt }
}

export type WorkspaceExternalAccessPatch = Partial<{
  linkSharingEnabled: boolean
  externalPostingEnabled: boolean
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
}>

export type ReopenExpiredLinkResult =
  | { kind: 'ok'; linkExpiresAt: string | null }
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'plan-required' }
  | { kind: 'disabled' }
  | { kind: 'invalid-policy' }

export async function reopenExpiredLink(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  shareableId: string,
  at: string = nowIso(),
): Promise<ReopenExpiredLinkResult> {
  const shareable = await db
    .selectFrom('shareables')
    .select(['workspace_id', 'owner_user_id', 'visibility', 'link_expires_at'])
    .where('id', '=', shareableId)
    .executeTakeFirst()
  if (!shareable || shareable.workspace_id !== actor.workspaceId) {
    return { kind: 'not-found' }
  }
  if (shareable.visibility !== 'link') return { kind: 'forbidden' }
  if (
    shareable.link_expires_at === null ||
    (isValidUtcIso(shareable.link_expires_at) &&
      Date.parse(shareable.link_expires_at) > Date.parse(at))
  ) {
    return { kind: 'forbidden' }
  }

  const policy = await loadWorkspaceLinkPolicy(db, shareable.workspace_id)
  if (!policy || policy.plan === 'free') return { kind: 'plan-required' }
  if (!canUseLinkSharing(policy)) return { kind: 'disabled' }

  const membership = await db
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', shareable.workspace_id)
    .where('user_id', '=', actor.id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  const allowed =
    shareable.owner_user_id === actor.id ||
    (policy.plan === 'team' &&
      (membership?.role === 'owner' || membership?.role === 'admin'))
  if (!allowed) return { kind: 'forbidden' }

  const resolved = resolveLinkExpiry(policy, undefined, at)
  if (resolved.kind !== 'ok') return { kind: 'invalid-policy' }

  const update = db
    .updateTable('shareables')
    .set({ link_expires_at: resolved.linkExpiresAt })
    .where('id', '=', shareableId)
    .where('workspace_id', '=', actor.workspaceId)
    .where('visibility', '=', 'link')
  const audit = db.insertInto('audit_events').values({
    id: nanoid(16),
    workspace_id: actor.workspaceId,
    actor_user_id: actor.id,
    action: 'shareable.link.reopen',
    subject_type: 'shareable',
    subject_id: shareableId,
    detail: JSON.stringify({
      before_link_expires_at: shareable.link_expires_at,
      after_link_expires_at: resolved.linkExpiresAt,
    }),
    created_at: at,
  })
  const { runD1Batch } = await import('~/lib/d1-batch.server')
  await runD1Batch(db, update, audit)
  return { kind: 'ok', linkExpiresAt: resolved.linkExpiresAt }
}

export type WorkspaceExternalAccessMutationResult =
  | { kind: 'ok'; policy: WorkspaceLinkPolicy; shortenedLinkCount: number }
  | { kind: 'forbidden' }
  | { kind: 'not-found' }
  | { kind: 'plan-required' }
  | { kind: 'invalid-policy'; field: 'default' | 'max' | 'relationship' }
  | { kind: 'invalid-patch' }

export async function updateWorkspaceExternalAccessPolicy(
  db: Kysely<DB>,
  actor: { id: string; workspaceId: string },
  patch: WorkspaceExternalAccessPatch,
  at: string = nowIso(),
): Promise<WorkspaceExternalAccessMutationResult> {
  if (Object.keys(patch).length === 0) return { kind: 'invalid-patch' }
  if (
    (patch.linkSharingEnabled !== undefined &&
      typeof patch.linkSharingEnabled !== 'boolean') ||
    (patch.externalPostingEnabled !== undefined &&
      typeof patch.externalPostingEnabled !== 'boolean')
  ) {
    return { kind: 'invalid-patch' }
  }

  const workspace = await db
    .selectFrom('workspaces')
    .select([
      'id',
      'plan',
      'link_sharing_enabled',
      'external_posting_enabled',
      'link_expiry_default_days',
      'link_expiry_max_days',
    ])
    .where('id', '=', actor.workspaceId)
    .executeTakeFirst()
  if (!workspace) return { kind: 'not-found' }

  const current = normalizeWorkspaceLinkPolicy(workspace)
  if (current.plan === 'free') return { kind: 'plan-required' }

  const membership = await db
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', actor.workspaceId)
    .where('user_id', '=', actor.id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  const allowedRole =
    current.plan === 'team'
      ? membership?.role === 'owner' || membership?.role === 'admin'
      : membership?.role === 'owner'
  if (!allowedRole) return { kind: 'forbidden' }

  if (current.plan !== 'team') {
    const onlyResumesDisabledPlusPolicy =
      current.plan === 'plus' &&
      (patch.linkSharingEnabled === undefined ||
        (patch.linkSharingEnabled === true && !current.linkSharingEnabled)) &&
      (patch.externalPostingEnabled === undefined ||
        (patch.externalPostingEnabled === true &&
          !current.externalPostingEnabled))
    if (!onlyResumesDisabledPlusPolicy) return { kind: 'forbidden' }
  }

  const next: WorkspaceLinkPolicy = {
    plan: normalizePlan(current.plan),
    linkSharingEnabled:
      patch.linkSharingEnabled !== undefined
        ? patch.linkSharingEnabled
        : current.linkSharingEnabled,
    externalPostingEnabled:
      patch.externalPostingEnabled !== undefined
        ? patch.externalPostingEnabled
        : current.externalPostingEnabled,
    linkExpiryDefaultDays:
      patch.linkExpiryDefaultDays !== undefined
        ? patch.linkExpiryDefaultDays
        : current.linkExpiryDefaultDays,
    linkExpiryMaxDays:
      patch.linkExpiryMaxDays !== undefined
        ? patch.linkExpiryMaxDays
        : current.linkExpiryMaxDays,
  }
  const validation = validateLinkExpiryPolicy(next)
  if (validation.kind !== 'ok') {
    return { kind: 'invalid-policy', field: validation.field }
  }

  const maxWasShortened =
    next.linkExpiryMaxDays !== null &&
    (current.linkExpiryMaxDays === null ||
      next.linkExpiryMaxDays < current.linkExpiryMaxDays)
  let shortenedLinkCount = 0
  if (maxWasShortened) {
    const row = await db
      .selectFrom('shareables')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('workspace_id', '=', actor.workspaceId)
      .where('visibility', '=', 'link')
      .where((eb) =>
        eb.or([
          eb('link_expires_at', 'is', null),
          eb('link_expires_at', '>', addDays(at, next.linkExpiryMaxDays!)),
        ]),
      )
      .executeTakeFirstOrThrow()
    shortenedLinkCount = Number(row.count)
  }

  const workspaceSet = {
    link_sharing_enabled: next.linkSharingEnabled ? 1 : 0,
    external_posting_enabled: next.externalPostingEnabled ? 1 : 0,
    link_expiry_default_days: next.linkExpiryDefaultDays,
    link_expiry_max_days: next.linkExpiryMaxDays,
  }
  const queries: Compilable<unknown>[] = [
    db
      .updateTable('workspaces')
      .set(workspaceSet)
      .where('id', '=', actor.workspaceId),
  ]
  if (maxWasShortened) {
    const cutoff = addDays(at, next.linkExpiryMaxDays!)
    queries.push(
      db
        .updateTable('shareables')
        .set({ link_expires_at: cutoff })
        .where('workspace_id', '=', actor.workspaceId)
        .where('visibility', '=', 'link')
        .where((eb) =>
          eb.or([
            eb('link_expires_at', 'is', null),
            eb('link_expires_at', '>', cutoff),
          ]),
        ),
    )
  }
  queries.push(
    db.insertInto('audit_events').values({
      id: nanoid(16),
      workspace_id: actor.workspaceId,
      actor_user_id: actor.id,
      action: 'workspace.external_access.change',
      subject_type: 'workspace',
      subject_id: actor.workspaceId,
      detail: JSON.stringify({
        before: current,
        after: next,
        shortened_link_count: shortenedLinkCount,
      }),
      created_at: at,
    }),
  )
  const { runD1Batch } = await import('~/lib/d1-batch.server')
  await runD1Batch(db, ...queries)
  return { kind: 'ok', policy: next, shortenedLinkCount }
}

export async function isLinkSharingAllowedByPolicy(
  db: Kysely<DB>,
  workspaceId: string,
): Promise<boolean> {
  const policy = await loadWorkspaceLinkPolicy(db, workspaceId)
  return policy ? canUseLinkSharing(policy) : false
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

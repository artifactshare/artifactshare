import { sql } from 'kysely'
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
import {
  LINK_PUBLISH_RATE_WINDOW_MS,
  isLinkPublishLimitedWorkspace,
  isLinkPublishRateLimited,
  linkPublishRateLimitFromEnv,
  type LinkPublishRateLimit,
} from '~/lib/link-trust-policy'
import type { startLinkAbuseJudgment } from './link-abuse-signals.server'
import type { Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'

export { canUseLinkSharing } from '~/lib/link-sharing-policy'

export type LinkSharingWriteFailure =
  | { kind: 'link-sharing-plan-required' }
  | { kind: 'link-sharing-disabled' }
  | { kind: 'link-expiry-invalid' }
  | {
      kind: 'link-publish-rate-limited'
      limit: number
      retryAfterSeconds: number
    }

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
    /** Test seams: the limit (default from env) and the judgment starter. */
    rateLimit?: LinkPublishRateLimit
    judge?: typeof startLinkAbuseJudgment
  },
): Promise<LinkSharingWriteResult> {
  if (args.nextVisibility !== 'link') {
    return args.requestedLinkExpiresAt === undefined
      ? { kind: 'ok', linkExpiresAt: null }
      : { kind: 'link-expiry-invalid' }
  }

  const policy = await loadWorkspaceLinkPolicy(db, args.workspaceId)
  if (!policy) return { kind: 'link-sharing-disabled' }
  if (!canUseLinkSharing(policy)) {
    return { kind: 'link-sharing-disabled' }
  }

  if (
    args.currentVisibility === 'link' &&
    args.requestedLinkExpiresAt === undefined
  ) {
    return { kind: 'ok', linkExpiresAt: args.currentLinkExpiresAt }
  }

  if (args.currentVisibility !== 'link') {
    // The Worker bindings are loaded only on this path, so callers that
    // never publish a link (and their tests) do not need the runtime module.
    const [{ env }, { startLinkAbuseJudgment }] = await Promise.all([
      import('cloudflare:workers'),
      import('./link-abuse-signals.server'),
    ])
    const limited = await checkLinkPublishRateLimit(db, {
      workspaceId: args.workspaceId,
      plan: policy.plan,
      now: args.now ?? nowIso(),
      rateLimit: args.rateLimit ?? linkPublishRateLimitFromEnv(env),
      judge: args.judge ?? startLinkAbuseJudgment,
      env,
    })
    if (limited) return limited
  }

  const resolved = resolveLinkExpiry(
    policy,
    args.requestedLinkExpiresAt,
    args.now ?? nowIso(),
  )
  return resolved.kind === 'ok' ? resolved : { kind: 'link-expiry-invalid' }
}

/**
 * A new Free workspace may publish only a bounded number of links per rolling
 * day. A publication is a `visibility_changed` event to `link` or a shareable
 * created with link visibility that still has it (uploads emit no event), one
 * per shareable in the window. Hitting the limit refuses the write and
 * starts an abuse judgment on the newest link of the burst; the judgment never
 * blocks or alters the write. The count and the write are not atomic:
 * concurrent publishes can each pass, which a review then sees.
 */
async function checkLinkPublishRateLimit(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    plan: string
    now: string
    rateLimit: LinkPublishRateLimit
    judge: typeof startLinkAbuseJudgment
    env: Parameters<typeof startLinkAbuseJudgment>[1]
  },
): Promise<Extract<
  LinkSharingWriteFailure,
  { kind: 'link-publish-rate-limited' }
> | null> {
  const nowMs = Date.parse(args.now)
  if (!Number.isFinite(nowMs)) return null
  const workspace = await db
    .selectFrom('workspaces')
    .select('created_at')
    .where('id', '=', args.workspaceId)
    .executeTakeFirst()
  if (!workspace) return null
  const policyInput = {
    plan: args.plan,
    workspaceCreatedAt: workspace.created_at,
    now: args.now,
    limit: args.rateLimit,
  }
  // The cheap discriminators (plan, age, disabled limit) run before the scan.
  if (!isLinkPublishLimitedWorkspace(policyInput)) return null
  const windowStart = new Date(
    nowMs - LINK_PUBLISH_RATE_WINDOW_MS,
  ).toISOString()
  const publications = db
    .selectFrom('events')
    .select(['shareable_id', 'created_at'])
    .where('workspace_id', '=', args.workspaceId)
    .where('type', '=', 'visibility_changed')
    .where(sql<boolean>`json_extract(payload, '$.to') = 'link'`)
    .where('created_at', '>', windowStart)
    .union(
      db
        .selectFrom('shareables')
        .select(['id as shareable_id', 'created_at'])
        .where('workspace_id', '=', args.workspaceId)
        .where('visibility', '=', 'link')
        .where('created_at', '>', windowStart),
    )
    .as('publications')
  // One row per shareable (an upload flipped inside the window is one
  // publication), newest first, bounded by the limit: the last row fetched is
  // the one whose leaving the window makes room again.
  const published = await db
    .selectFrom(publications)
    .select(['shareable_id', sql<string>`max(created_at)`.as('created_at')])
    .groupBy('shareable_id')
    .orderBy('created_at', 'desc')
    .limit(args.rateLimit.dailyLimit)
    .execute()
  if (
    !isLinkPublishRateLimited({
      ...policyInput,
      publishedInWindow: published.length,
    })
  )
    return null
  const newest = published[0]!
  const oldestCounted = published.at(-1)!
  // The window check is exclusive, so the boundary itself makes room.
  const oldestMs = Date.parse(oldestCounted.created_at)
  const retryAfterSeconds = Number.isFinite(oldestMs)
    ? Math.max(
        1,
        Math.ceil((oldestMs + LINK_PUBLISH_RATE_WINDOW_MS - nowMs) / 1000),
      )
    : Math.ceil(LINK_PUBLISH_RATE_WINDOW_MS / 1000)
  // Human review decides; the limit itself never stops existing links.
  await args.judge(db, args.env, {
    shareableId: newest.shareable_id,
    trigger: 'publish_burst',
    detail: `At least ${published.length} link publications in 24h by a workspace younger than ${args.rateLimit.accountAgeDays} days (limit ${args.rateLimit.dailyLimit})`,
  })
  return {
    kind: 'link-publish-rate-limited',
    limit: args.rateLimit.dailyLimit,
    retryAfterSeconds,
  }
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
  | { kind: 'suspended'; reason: string | null; expired: boolean }

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
      'shareables.link_suspended_at',
      'shareables.link_suspended_reason',
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
  if (!canUseLinkSharing(policy)) return { kind: 'disabled' }
  const linkExpiresAt = row.link_expires_at ?? null
  const expired =
    linkExpiresAt !== null &&
    (!isValidUtcIso(linkExpiresAt) ||
      !isValidUtcIso(now) ||
      Date.parse(linkExpiresAt) <= Date.parse(now))
  // An operator pause outranks expiry for viewers; the owner still learns
  // both from the `expired` flag.
  if (row.link_suspended_at)
    return {
      kind: 'suspended',
      reason: row.link_suspended_reason ?? null,
      expired,
    }
  if (expired) return { kind: 'expired' }
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
  if (!policy) return { kind: 'not-found' }
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
    // Free and Plus owners can only resume a switch that a previous Team
    // policy turned off; external posting stays unavailable on Free.
    const onlyResumesDisabledPolicy =
      (patch.linkSharingEnabled === undefined ||
        (patch.linkSharingEnabled === true && !current.linkSharingEnabled)) &&
      (patch.externalPostingEnabled === undefined ||
        (current.plan === 'plus' &&
          patch.externalPostingEnabled === true &&
          !current.externalPostingEnabled))
    if (!onlyResumesDisabledPolicy) return { kind: 'forbidden' }
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
    // Free clamps external posting to off in the policy view; leave the stored
    // flag alone there so a later upgrade restores what the workspace had.
    ...(current.plan !== 'free' && {
      external_posting_enabled: next.externalPostingEnabled ? 1 : 0,
    }),
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

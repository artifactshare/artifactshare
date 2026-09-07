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
    shareableId?: string
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
      shareableId: args.shareableId,
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
 * A new Free workspace may publish only a bounded number of artifacts per
 * rolling day. The durable ledger keeps the latest publication for each
 * workspace/artifact pair even after the artifact is hidden or deleted. This
 * read-only check avoids unnecessary upload work; the mutation trigger remains
 * authoritative when concurrent writers race for the remaining capacity.
 */
async function checkLinkPublishRateLimit(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    shareableId?: string
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
  const published = await db
    .selectFrom('link_publications')
    .select(['shareable_id', 'latest_published_at'])
    .where('workspace_id', '=', args.workspaceId)
    .where('latest_published_at', '>', windowStart)
    .orderBy('latest_published_at', 'desc')
    .orderBy('shareable_id')
    .limit(args.rateLimit.dailyLimit)
    .execute()
  if (published.length < args.rateLimit.dailyLimit) return null
  return await buildLinkPublishRateLimitFailure(db, {
    workspaceId: args.workspaceId,
    refusedShareableId: args.shareableId ?? '',
    now: args.now,
    rateLimit: args.rateLimit,
    judge: args.judge,
    env: args.env,
    published,
  })
}

export async function buildLinkPublishRateLimitFailure(
  db: Kysely<DB>,
  args: {
    workspaceId: string
    refusedShareableId: string
    now: string
    rateLimit?: LinkPublishRateLimit
    judge?: typeof startLinkAbuseJudgment
    env?: Parameters<typeof startLinkAbuseJudgment>[1]
    published?: ReadonlyArray<{
      shareable_id: string
      latest_published_at: string
    }>
  },
): Promise<
  Extract<LinkSharingWriteFailure, { kind: 'link-publish-rate-limited' }>
> {
  const rateLimit =
    args.rateLimit ??
    linkPublishRateLimitFromEnv((await import('cloudflare:workers')).env)
  const nowMs = Date.parse(args.now)
  const windowStart = Number.isFinite(nowMs)
    ? new Date(nowMs - LINK_PUBLISH_RATE_WINDOW_MS).toISOString()
    : args.now
  const published =
    args.published ??
    (await db
      .selectFrom('link_publications')
      .select(['shareable_id', 'latest_published_at'])
      .where('workspace_id', '=', args.workspaceId)
      .where('latest_published_at', '>', windowStart)
      .orderBy('latest_published_at', 'desc')
      .orderBy('shareable_id')
      .limit(rateLimit.dailyLimit)
      .execute())
  const oldestMs =
    published.length >= rateLimit.dailyLimit
      ? Date.parse(published.at(-1)?.latest_published_at ?? '')
      : Number.NaN
  const retryAfterSeconds = Number.isFinite(oldestMs)
    ? Math.max(
        1,
        Math.ceil((oldestMs + LINK_PUBLISH_RATE_WINDOW_MS - nowMs) / 1000),
      )
    : 1
  const judgmentCandidate = await db
    .selectFrom('link_publications as publication')
    .innerJoin('shareables', (join) =>
      join
        .onRef('shareables.id', '=', 'publication.shareable_id')
        .onRef('shareables.workspace_id', '=', 'publication.workspace_id'),
    )
    .select('publication.shareable_id')
    .where('publication.workspace_id', '=', args.workspaceId)
    .where('publication.latest_published_at', '>', windowStart)
    .where('publication.shareable_id', '<>', args.refusedShareableId)
    .orderBy('publication.latest_published_at', 'desc')
    .orderBy('publication.shareable_id')
    .executeTakeFirst()
  if (judgmentCandidate) {
    const runtime = args.env ?? (await import('cloudflare:workers')).env
    const judge =
      args.judge ??
      (await import('./link-abuse-signals.server')).startLinkAbuseJudgment
    try {
      await judge(db, runtime, {
        shareableId: judgmentCandidate.shareable_id,
        trigger: 'publish_burst',
        detail: `At least ${published.length} link publications in 24h by a workspace younger than ${rateLimit.accountAgeDays} days (limit ${rateLimit.dailyLimit})`,
      })
    } catch (err) {
      console.error('link_publish_burst_judgment_failed', {
        shareable_id: judgmentCandidate.shareable_id,
        err,
      })
    }
  }
  return {
    kind: 'link-publish-rate-limited',
    limit: rateLimit.dailyLimit,
    retryAfterSeconds,
  }
}

export async function linkPublicationAttemptValues(
  db: Kysely<DB>,
  args: { workspaceId: string; shareableId: string; now: string },
) {
  const rateLimit = linkPublishRateLimitFromEnv(
    (await import('cloudflare:workers')).env,
  )
  const workspace = await db
    .selectFrom('workspaces')
    .select(['plan', 'created_at'])
    .where('id', '=', args.workspaceId)
    .executeTakeFirst()
  const limitApplies =
    workspace !== undefined &&
    Number.isFinite(Date.parse(args.now)) &&
    isLinkPublishLimitedWorkspace({
      plan: workspace.plan,
      workspaceCreatedAt: workspace.created_at,
      now: args.now,
      limit: rateLimit,
    })
  return {
    workspace_id: args.workspaceId,
    shareable_id: args.shareableId,
    published_at: args.now,
    window_start: Number.isFinite(Date.parse(args.now))
      ? new Date(
          Date.parse(args.now) - LINK_PUBLISH_RATE_WINDOW_MS,
        ).toISOString()
      : args.now,
    daily_limit: rateLimit.dailyLimit,
    limit_applies: limitApplies ? 1 : 0,
    consumed: 0,
  }
}

export function isLinkPublicationError(
  err: unknown,
  message:
    | 'link publication quota exceeded'
    | 'link publication mutation missing',
): boolean {
  if (!(err instanceof Error)) return false
  return [
    err.message,
    err.cause instanceof Error ? err.cause.message : '',
  ].some((candidate) => candidate.includes(message))
}

export async function cleanupExpiredLinkPublications(
  db: Kysely<DB>,
  now: string,
): Promise<void> {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return
  await db
    .deleteFrom('link_publications')
    .where(
      'latest_published_at',
      '<=',
      new Date(nowMs - LINK_PUBLISH_RATE_WINDOW_MS).toISOString(),
    )
    .execute()
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

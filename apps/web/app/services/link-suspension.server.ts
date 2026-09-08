import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import { nanoid } from 'nanoid'
import { runD1Batch, runD1BatchWithResults } from '~/lib/d1-batch.server'
import { nowIso } from '~/lib/datetime'
import { APEX_HOST } from '~/lib/hosts'
import { constantTimeEqual, hmacSha256 } from '~/lib/hmac'
import type { LinkOpsTokenPayload } from '~/lib/link-ops-token'
import type { DB } from '~/types/db'

// An operator pauses a link share while reviewing it (from the Slack judgment
// notification) and resumes it afterwards; the owner is told by email and by
// a banner on the file, and can appeal from that banner. Nothing here runs
// without a person: the judgment workflow only announces, and the pause is
// an explicit operator action on the signed ops page.

export const LINK_SUSPENSION_REASON_MAX = 300
export const LINK_APPEAL_MESSAGE_MAX = 1000
const APPEAL_COOLDOWN_MS = 60 * 60 * 1000

export type LinkSuspensionState = {
  shareableId: string
  workspaceId: string
  visibility: string
  title: string
  suspendedAt: string | null
  suspendedReason: string | null
}

export type OwnerNotice = {
  kind: 'suspended' | 'resumed'
  shareableId: string
  title: string
  ownerEmail: string
  reason: string | null
  includeReasonAndAppeal: boolean
  includeManageUrl: boolean
}

export type OwnerNoticeOutcome = 'sent' | 'skipped' | 'failed'

export type LinkSuspensionResult =
  | { kind: 'suspended' | 'resumed'; ownerNotice: OwnerNoticeOutcome }
  | { kind: 'already' | 'not-link' | 'not-found' }

export type LinkAppealResult =
  | { kind: 'appealed' }
  | { kind: 'not-found' | 'forbidden' | 'not-suspended' | 'cooldown' }

export async function linkSuspensionState(
  db: Kysely<DB>,
  shareableId: string,
): Promise<LinkSuspensionState | null> {
  const row = await db
    .selectFrom('shareables')
    .select([
      'id',
      'workspace_id',
      'visibility',
      'name',
      'derived_title',
      'title_override',
      'link_suspended_at',
      'link_suspended_reason',
    ])
    .where('id', '=', shareableId)
    .executeTakeFirst()
  if (!row) return null
  return {
    shareableId: row.id,
    workspaceId: row.workspace_id,
    visibility: row.visibility,
    title: row.title_override ?? row.derived_title ?? row.name,
    suspendedAt: row.link_suspended_at,
    suspendedReason: row.link_suspended_reason,
  }
}

function ownerOf(db: Kysely<DB>, shareableId: string) {
  return db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.visibility',
      'shareables.link_suspended_at',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'users.email as owner_email',
      'users.kind as owner_kind',
      'users.id as owner_id',
    ])
    .innerJoin('workspaces', 'workspaces.id', 'shareables.workspace_id')
    .select('workspaces.plan as workspace_plan')
    .where('shareables.id', '=', shareableId)
    .executeTakeFirst()
}

/** Clip to `max` code points so a surrogate pair is never split. */
function clipCodePoints(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join('')
}

type OwnerRow = NonNullable<Awaited<ReturnType<typeof ownerOf>>>

type RecipientSnapshot = {
  userId: string
  emailHash: string
  relationship: 'artifact_owner' | 'workspace_owner'
  requiresVerified: boolean
  includeReasonAndAppeal: boolean
  includeManageUrl: boolean
}

type TransitionPayload = {
  actor: { kind: 'operator_credential'; credentialId: string }
  source: LinkOpsTokenPayload['source']
  reason: string | null
  notify: boolean
  recipients: RecipientSnapshot[]
}

async function emailHash(userId: string, email: string): Promise<string> {
  const digest = await hmacSha256(
    env.BETTER_AUTH_SECRET,
    `link-notice\0${userId}\0${email}`,
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function notificationRecipients(
  db: Kysely<DB>,
  row: OwnerRow,
): Promise<RecipientSnapshot[]> {
  if (row.owner_kind === 'human')
    return [
      {
        userId: row.owner_id,
        emailHash: await emailHash(row.owner_id, row.owner_email),
        relationship: 'artifact_owner',
        requiresVerified: false,
        includeReasonAndAppeal: true,
        includeManageUrl: true,
      },
    ]
  const owner = await db
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(['users.id', 'users.email'])
    .where('workspace_members.workspace_id', '=', row.workspace_id)
    .where('workspace_members.role', '=', 'owner')
    .where('workspace_members.status', '=', 'active')
    .where('users.kind', '=', 'human')
    .where('users.email_verified', '=', 1)
    .executeTakeFirst()
  if (!owner) return []
  return [
    {
      userId: owner.id,
      emailHash: await emailHash(owner.id, owner.email),
      relationship: 'workspace_owner',
      requiresVerified: true,
      includeReasonAndAppeal: false,
      includeManageUrl: row.workspace_plan === 'team',
    },
  ]
}

/**
 * Pause or resume in one D1 batch: the event is inserted only while the
 * shareable is in the state the move leaves, the flag update carries the same
 * guard, and an audit row records the operator action (no actor: the signed
 * token names the judgment, not a person). Whether the event landed decides
 * "already". `updated_at` is left alone: a moderation action is not an edit
 * and must not reorder the owner's lists.
 */
async function transitionLink(
  db: Kysely<DB>,
  row: OwnerRow,
  move: 'suspend' | 'resume',
  args: {
    reason: string | null
    credentialId: string
    source: LinkOpsTokenPayload['source']
    now: string
    notify: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const suspending = move === 'suspend'
  const eventId = nanoid()
  const recipients = await notificationRecipients(db, row)
  const shouldNotify = suspending || row.visibility === 'link'
  const payload: TransitionPayload = {
    actor: { kind: 'operator_credential', credentialId: args.credentialId },
    source: args.source,
    reason: suspending ? args.reason : null,
    notify: shouldNotify,
    recipients,
  }
  const serializedPayload = JSON.stringify(payload)
  await runD1Batch(
    db,
    db
      .insertInto('events')
      .columns([
        'id',
        'workspace_id',
        'type',
        'shareable_id',
        'actor_user_id',
        'subject_id',
        'payload',
        'created_at',
      ])
      .expression((eb) =>
        eb
          .selectFrom('shareables')
          .select([
            eb.val(eventId).as('id'),
            eb.val(row.workspace_id).as('workspace_id'),
            eb.val(suspending ? 'link_suspended' : 'link_resumed').as('type'),
            eb.val(row.id).as('shareable_id'),
            eb.val(null).as('actor_user_id'),
            eb.val(nanoid()).as('subject_id'),
            eb.val(serializedPayload).as('payload'),
            eb.val(args.now).as('created_at'),
          ])
          .where('id', '=', row.id)
          .$if(suspending, (q) =>
            q
              .where('visibility', '=', 'link')
              .where('link_suspended_at', 'is', null),
          )
          .$if(!suspending, (q) =>
            q.where('link_suspended_at', 'is not', null),
          ),
      ),
    // Read the event written by the preceding statement. D1 executes batch
    // statements sequentially in one transaction, so a losing transition
    // has no event and therefore no audit row.
    db
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
          .selectFrom('events')
          .select([
            eb.val(nanoid(16)).as('id'),
            'events.workspace_id',
            eb.val(null).as('actor_user_id'),
            eb
              .val(
                suspending ? 'shareable.link.suspend' : 'shareable.link.resume',
              )
              .as('action'),
            eb.val('shareable').as('subject_type'),
            'events.shareable_id as subject_id',
            sql<string>`json_remove(events.payload, '$.recipients')`.as(
              'detail',
            ),
            'events.created_at',
          ])
          .where('events.id', '=', eventId),
      ),
    db
      .updateTable('shareables')
      .set(
        suspending
          ? { link_suspended_at: args.now, link_suspended_reason: args.reason }
          : { link_suspended_at: null, link_suspended_reason: null },
      )
      .where('id', '=', row.id)
      .where(
        'id',
        'in',
        db
          .selectFrom('events')
          .select('shareable_id')
          .where('id', '=', eventId),
      ),
  )
  const recorded = await db
    .selectFrom('events')
    .select('id')
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!recorded) return { kind: 'already' }
  const committed = payload
  const outcomes: OwnerNoticeOutcome[] = committed.notify
    ? await Promise.all(
        committed.recipients.map(async (recipient) => {
          try {
            const current = await db
              .selectFrom('users')
              .select(['id', 'email', 'email_verified'])
              .where('id', '=', recipient.userId)
              .where((eb) =>
                recipient.relationship === 'artifact_owner'
                  ? eb.exists(
                      eb
                        .selectFrom('shareables')
                        .select('id')
                        .where('id', '=', row.id)
                        .where('owner_user_id', '=', recipient.userId),
                    )
                  : eb.exists(
                      eb
                        .selectFrom('workspace_members')
                        .innerJoin(
                          'shareables',
                          'shareables.workspace_id',
                          'workspace_members.workspace_id',
                        )
                        .innerJoin(
                          'users as artifact_owner',
                          'artifact_owner.id',
                          'shareables.owner_user_id',
                        )
                        .select('workspace_members.user_id')
                        .where('shareables.id', '=', row.id)
                        .where(
                          'workspace_members.user_id',
                          '=',
                          recipient.userId,
                        )
                        .where('workspace_members.role', '=', 'owner')
                        .where('workspace_members.status', '=', 'active')
                        .where('artifact_owner.kind', '=', 'bot'),
                    ),
              )
              .executeTakeFirst()
            if (
              !current ||
              (recipient.requiresVerified && current.email_verified !== 1) ||
              !constantTimeEqual(
                await emailHash(recipient.userId, current.email),
                recipient.emailHash,
              )
            ) {
              return 'skipped'
            }
            return await args.notify({
              kind: suspending ? 'suspended' : 'resumed',
              shareableId: row.id,
              title: row.title_override ?? row.derived_title ?? row.name,
              ownerEmail: current.email,
              reason: committed.reason,
              includeReasonAndAppeal: recipient.includeReasonAndAppeal,
              includeManageUrl: recipient.includeManageUrl,
            })
          } catch {
            return 'failed'
          }
        }),
      )
    : []
  if (outcomes.length === 0) outcomes.push('skipped')
  const counts = {
    sent: outcomes.filter((value) => value === 'sent').length,
    failed: outcomes.filter((value) => value === 'failed').length,
    skipped: outcomes.filter((value) => value === 'skipped').length,
  }
  const ownerNotice: OwnerNoticeOutcome = counts.failed
    ? 'failed'
    : counts.sent
      ? 'sent'
      : 'skipped'
  console.warn('artifactshare_link_suspension', {
    action: move,
    shareableId: row.id,
    workspaceId: row.workspace_id,
    source: committed.source,
    notifications: counts,
  })
  return { kind: suspending ? 'suspended' : 'resumed', ownerNotice }
}

export async function suspendLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    reason: string
    credentialId: string
    source: LinkOpsTokenPayload['source']
    now?: string
    notify?: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (row.visibility !== 'link') return { kind: 'not-link' }
  if (row.link_suspended_at) return { kind: 'already' }
  const reason = clipCodePoints(args.reason, LINK_SUSPENSION_REASON_MAX)
  return transitionLink(db, row, 'suspend', {
    reason: reason || null,
    credentialId: args.credentialId,
    source: args.source,
    now: args.now ?? nowIso(),
    notify: args.notify ?? sendOwnerNotice,
  })
}

export async function resumeLink(
  db: Kysely<DB>,
  args: {
    shareableId: string
    credentialId: string
    source: LinkOpsTokenPayload['source']
    now?: string
    notify?: (notice: OwnerNotice) => Promise<OwnerNoticeOutcome>
  },
): Promise<LinkSuspensionResult> {
  const row = await ownerOf(db, args.shareableId)
  if (!row) return { kind: 'not-found' }
  if (!row.link_suspended_at) return { kind: 'already' }
  return transitionLink(db, row, 'resume', {
    reason: null,
    credentialId: args.credentialId,
    source: args.source,
    now: args.now ?? nowIso(),
    notify: args.notify ?? sendOwnerNotice,
  })
}

export async function appealLinkSuspension(
  db: Kysely<DB>,
  user: { id: string },
  args: { shareableId: string; message: string; now?: string },
): Promise<LinkAppealResult> {
  const now = args.now ?? nowIso()
  const since = new Date(Date.parse(now) - APPEAL_COOLDOWN_MS).toISOString()
  const message = clipCodePoints(args.message, LINK_APPEAL_MESSAGE_MAX)
  const eventId = nanoid()
  const insert = db
    .insertInto('events')
    .columns([
      'id',
      'workspace_id',
      'type',
      'shareable_id',
      'actor_user_id',
      'subject_id',
      'payload',
      'created_at',
    ])
    .expression((eb) =>
      eb
        .selectFrom('shareables')
        .select([
          eb.val(eventId).as('id'),
          'shareables.workspace_id',
          eb.val('link_appealed').as('type'),
          'shareables.id as shareable_id',
          eb.val(user.id).as('actor_user_id'),
          eb.val(nanoid()).as('subject_id'),
          eb.val(JSON.stringify({ message })).as('payload'),
          eb.val(now).as('created_at'),
        ])
        .where('id', '=', args.shareableId)
        .where('owner_user_id', '=', user.id)
        .where('link_suspended_at', 'is not', null)
        .where(
          sql<boolean>`NOT EXISTS (
            SELECT 1 FROM events AS recent
            WHERE recent.shareable_id = shareables.id
              AND recent.type = 'link_appealed'
              AND recent.created_at >= ${since}
          )`,
        ),
    )
  const classification = db.selectNoFrom([
    sql<number>`EXISTS(SELECT 1 FROM events WHERE id = ${eventId})`.as(
      'inserted',
    ),
    sql<number>`EXISTS(SELECT 1 FROM shareables WHERE id = ${args.shareableId})`.as(
      'found',
    ),
    sql<number>`EXISTS(SELECT 1 FROM shareables WHERE id = ${args.shareableId} AND owner_user_id = ${user.id})`.as(
      'owned',
    ),
    sql<number>`EXISTS(SELECT 1 FROM shareables WHERE id = ${args.shareableId} AND link_suspended_at IS NOT NULL)`.as(
      'suspended',
    ),
    sql<
      string | null
    >`(SELECT workspace_id FROM shareables WHERE id = ${args.shareableId})`.as(
      'workspace_id',
    ),
  ])
  const results = await runD1BatchWithResults(db, insert, classification)
  let classified = appealClassificationRow(results[1])
  if (!classified) {
    const recorded = await db
      .selectFrom('events')
      .select('workspace_id')
      .where('id', '=', eventId)
      .executeTakeFirst()
    if (!recorded)
      throw new Error('Unexpected D1 appeal classification result shape')
    classified = {
      inserted: 1,
      found: 1,
      owned: 1,
      suspended: 1,
      workspace_id: recorded.workspace_id,
    }
  }
  if (!classified.inserted) {
    if (!classified.found) return { kind: 'not-found' }
    if (!classified.owned) return { kind: 'forbidden' }
    if (!classified.suspended) return { kind: 'not-suspended' }
    return { kind: 'cooldown' }
  }
  // The alerts worker creates the signed operator credential. Keeping the
  // token out of this marker prevents the app invocation log from recording
  // the query string before redaction can be applied downstream.
  console.warn('artifactshare_link_appeal', {
    shareableId: args.shareableId,
    workspaceId: classified.workspace_id,
    manageUrl: `https://${APEX_HOST}/a/${args.shareableId}`,
    message: clipCodePoints(message, 300),
    source: { kind: 'appeal', id: eventId },
  })
  return { kind: 'appealed' }
}

type AppealClassificationRow = {
  inserted: number
  found: number
  owned: number
  suspended: number
  workspace_id: string | null
}

function appealClassificationRow(
  result: unknown,
): AppealClassificationRow | null {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'results' in result
      ? (result as { results?: unknown }).results
      : null
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== 'object')
    return null
  const row = rows[0] as Record<string, unknown>
  return {
    inserted: Number(row.inserted) || 0,
    found: Number(row.found) || 0,
    owned: Number(row.owned) || 0,
    suspended: Number(row.suspended) || 0,
    workspace_id:
      typeof row.workspace_id === 'string' ? row.workspace_id : null,
  }
}

/** Email the owner; a delivery failure is logged and never fails the action. */
export async function sendOwnerNotice(
  notice: OwnerNotice,
): Promise<OwnerNoticeOutcome> {
  const email: SendEmail | undefined = env.EMAIL
  if (!email) return 'skipped'
  const manageUrl = `https://${APEX_HOST}/a/${notice.shareableId}`
  const title = notice.title.replace(/[\r\n]+/g, ' ')
  const reason = notice.reason?.replace(/[\r\n]+/g, ' ') ?? null
  const subject =
    notice.kind === 'suspended'
      ? `リンク共有を一時停止しました / Link sharing paused: ${title}`
      : `リンク共有を再開しました / Link sharing resumed: ${title}`
  const text =
    notice.kind === 'suspended'
      ? [
          `「${title}」のリンク共有を、運営が確認のため一時停止しました。`,
          `Link sharing for “${title}” was paused by the operators while they review it.`,
          '',
          notice.includeReasonAndAppeal && reason
            ? `理由 / Reason: ${reason}`
            : null,
          notice.includeReasonAndAppeal && reason ? '' : null,
          notice.includeReasonAndAppeal && notice.includeManageUrl
            ? `停止中もあなたと個別共有の相手は開けます。異議はファイルのページから送れます: ${manageUrl}`
            : null,
          notice.includeReasonAndAppeal && notice.includeManageUrl
            ? `You and the people you shared it with can still open it. You can appeal from the file's page: ${manageUrl}`
            : null,
          !notice.includeReasonAndAppeal && notice.includeManageUrl
            ? `管理 / Manage: ${manageUrl}`
            : null,
        ]
      : [
          `「${title}」のリンク共有を再開しました。`,
          `Link sharing for “${title}” has been resumed.`,
          '',
          notice.includeManageUrl ? `ファイル: ${manageUrl}` : null,
          notice.includeManageUrl ? `File: ${manageUrl}` : null,
        ]
  try {
    await email.send({
      to: notice.ownerEmail,
      from: `noreply@${APEX_HOST}`,
      subject,
      text: text.filter((line) => line !== null).join('\n'),
    })
    return 'sent'
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'link_suspension_email_failed',
        shareableId: notice.shareableId,
        kind: notice.kind,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return 'failed'
  }
}
